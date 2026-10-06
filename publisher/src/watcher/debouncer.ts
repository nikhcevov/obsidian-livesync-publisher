import { config } from "../config.js";
import { log } from "../logger.js";

type DocHandler = (docId: string) => Promise<void>;
type BuildHandler = () => Promise<void>;

export class Debouncer {
  private docTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingDocs = new Set<string>();
  private processingDocs = new Set<string>();
  private buildTimer: ReturnType<typeof setTimeout> | null = null;
  private buildRunning = false;
  private buildQueued = false;

  constructor(
    private onDoc: DocHandler,
    private onBuild: BuildHandler,
  ) {}

  scheduleDoc(docId: string): void {
    this.pendingDocs.add(docId);
    const existing = this.docTimers.get(docId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.docTimers.delete(docId);
      void this.flushDoc(docId);
    }, config.debounceMs);

    this.docTimers.set(docId, timer);
  }

  private async flushDoc(docId: string): Promise<void> {
    if (!this.pendingDocs.has(docId) || this.processingDocs.has(docId)) return;
    this.pendingDocs.delete(docId);
    this.processingDocs.add(docId);
    try {
      await this.onDoc(docId);
      this.scheduleBuild();
    } catch (err) {
      log.error({ err, docId }, "doc_process_failed");
    } finally {
      this.processingDocs.delete(docId);
      if (this.pendingDocs.has(docId)) this.scheduleDoc(docId);
    }
  }

  scheduleBuild(): void {
    if (this.buildTimer) clearTimeout(this.buildTimer);
    this.buildTimer = setTimeout(() => {
      this.buildTimer = null;
      void this.runBuild();
    }, config.debounceMs);
    log.debug({}, "build_scheduled");
  }

  private async runBuild(): Promise<void> {
    if (this.buildRunning) {
      this.buildQueued = true;
      return;
    }
    this.buildRunning = true;
    try {
      await this.onBuild();
    } finally {
      this.buildRunning = false;
      if (this.buildQueued) {
        this.buildQueued = false;
        this.scheduleBuild();
      }
    }
  }

  async flushAll(): Promise<void> {
    for (const docId of [...this.pendingDocs]) {
      const t = this.docTimers.get(docId);
      if (t) clearTimeout(t);
      this.docTimers.delete(docId);
      await this.flushDoc(docId);
    }
    if (this.buildTimer) {
      clearTimeout(this.buildTimer);
      this.buildTimer = null;
    }
    await this.runBuild();
  }
}
