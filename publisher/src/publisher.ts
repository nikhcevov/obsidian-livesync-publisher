import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { classifyDoc, isChunkId } from "./extractor/filter.js";
import { ImageIndex } from "./extractor/imageIndex.js";
import type { DocClass, Eden } from "./extractor/types.js";
import { reconstructText } from "./extractor/reconstruct.js";
import { getDoc, listAllDocIds } from "./couchdb/client.js";
import { log } from "./logger.js";
import { processFrontmatter } from "./markdown/frontmatter.js";
import { processImages } from "./markdown/images.js";
import { removePost, writePost } from "./markdown/writer.js";
import {
  applyPostRefs,
  clearPostRefs,
  loadAllRefsWithPostIds,
  loadPostRefs,
  rebuildImageRefcounts,
} from "./state/refs.js";
import { Debouncer } from "./watcher/debouncer.js";
import { runHugoBuild, verifyHugo } from "./hugo/build.js";

export class Publisher {
  readonly imageIndex = new ImageIndex();
  private debouncer: Debouncer;
  private postPaths = new Map<string, string>();
  private chunkParents = new Map<string, Set<string>>();
  private docChunks = new Map<string, { kind: DocClass; children: string[] }>();

  constructor() {
    this.debouncer = new Debouncer(
      (id) => this.processDoc(id),
      () => runHugoBuild().then(() => {}),
    );
  }

  async start(fullBootstrap: boolean): Promise<void> {
    await verifyHugo();
    await this.seedImageIndex();
    const refs = await loadAllRefsWithPostIds();
    this.imageIndex.rebuildReverseFromRefs(refs);
    await this.loadPostPaths();

    if (fullBootstrap) {
      log.info({ posts: this.postPaths.size }, "startup_rebuild_started");
      await rebuildImageRefcounts();
      await this.bootstrapPosts();
      this.imageIndex.rebuildReverseFromRefs(await loadAllRefsWithPostIds());
      const build = await runHugoBuild();
      if (!build.ok) throw new Error("Startup Hugo rebuild failed");
      log.info({}, "startup_rebuild_finished");
    }

    log.info({ fullBootstrap }, "publisher_ready");
  }

  schedule(docId: string): void {
    this.debouncer.scheduleDoc(docId);
  }

  scheduleBuild(): void {
    this.debouncer.scheduleBuild();
  }

  async handleChange(change: {
    id: string;
    deleted: boolean;
    doc?: Record<string, unknown>;
  }): Promise<void> {
    if (isChunkId(change.id)) {
      const parents = this.chunkParents.get(change.id);
      if (!parents) return;
      for (const parentId of parents) {
        if (this.docChunks.get(parentId)?.kind === "post") {
          this.schedule(parentId);
        } else {
          const posts = this.imageIndex.getPostsForImage(parentId);
          for (const postId of posts.length > 0 ? posts : this.postPaths.keys()) {
            this.schedule(postId);
          }
        }
      }
      return;
    }

    log.info({ id: change.id, deleted: change.deleted }, "change_received");

    if (change.deleted) {
      this.trackChunkParents(change.id);
      const docPath =
        typeof change.doc?.path === "string" ? change.doc.path : undefined;
      const path =
        this.postPaths.get(change.id) ??
        docPath ??
        (change.id.endsWith(".md") ? change.id : undefined);
      if (path) {
        await this.unpublishPost(change.id);
        this.scheduleBuild();
      }
      const imgPath =
        typeof change.doc?.path === "string" ? change.doc.path : undefined;
      this.imageIndex.remove(change.id, imgPath);
      let posts = this.imageIndex.getPostsForImage(change.id);
      if (posts.length === 0) posts = [...this.postPaths.keys()];
      for (const postId of posts) this.schedule(postId);
      return;
    }

    const doc = change.doc;
    if (!doc) {
      this.schedule(change.id);
      return;
    }

    const kind = classifyDoc(doc);
    this.trackChunkParents(change.id, doc);
    if (kind === "image") {
      const path = String(doc.path);
      this.imageIndex.upsert(change.id, path);
      let posts = this.imageIndex.getPostsForImage(change.id);
      if (posts.length === 0) posts = [...this.postPaths.keys()];
      for (const postId of posts) this.schedule(postId);
      return;
    }

    if (kind === "post") {
      const path = String(doc.path);
      this.postPaths.set(change.id, path);
      this.schedule(change.id);
    }
  }

  private trackChunkParents(
    docId: string,
    doc?: Record<string, unknown>,
  ): void {
    for (const child of this.docChunks.get(docId)?.children ?? []) {
      const parents = this.chunkParents.get(child);
      parents?.delete(docId);
      if (parents?.size === 0) this.chunkParents.delete(child);
    }
    this.docChunks.delete(docId);

    const kind = doc ? classifyDoc(doc) : "ignored";
    if (!doc || kind === "ignored") return;
    const eden = doc.eden as Eden | undefined;
    const children = Array.isArray(doc.children)
      ? doc.children.filter(
          (id): id is string =>
            typeof id === "string" && typeof eden?.[id]?.data !== "string",
        )
      : [];
    this.docChunks.set(docId, { kind, children });
    for (const child of children) {
      let parents = this.chunkParents.get(child);
      if (!parents) {
        parents = new Set();
        this.chunkParents.set(child, parents);
      }
      parents.add(docId);
    }
  }

  private async seedImageIndex(): Promise<void> {
    const ids = await listAllDocIds();
    log.info({ count: ids.length }, "bootstrap_scan");
    for (const id of ids) {
      const doc = await getDoc(id);
      if (!doc) continue;
      if (classifyDoc(doc) === "image") {
        this.trackChunkParents(id, doc);
        this.imageIndex.upsert(id, String(doc.path));
      }
    }
  }

  private async loadPostPaths(): Promise<void> {
    const ids = await listAllDocIds();
    for (const id of ids) {
      const doc = await getDoc(id);
      if (!doc) continue;
      if (classifyDoc(doc) === "post") {
        this.trackChunkParents(id, doc);
        this.postPaths.set(id, String(doc.path));
      }
    }
  }

  private async bootstrapPosts(): Promise<void> {
    for (const [id] of this.postPaths) {
      await this.processDoc(id, true);
    }

    for (const [id, refs] of await loadAllRefsWithPostIds()) {
      if (this.postPaths.has(id)) continue;
      const doc = await getDoc(id);
      if (doc && classifyDoc(doc) === "post") {
        await this.processDoc(id, true);
        continue;
      }
      if (
        doc && !doc.deleted && !doc._deleted &&
        Array.isArray(doc._conflicts) && doc._conflicts.length > 0
      ) {
        log.warn({ docId: id }, "rebuild_conflict_skipped");
        continue;
      }
      if (refs.slug) await removePost(refs.slug);
      await clearPostRefs(id, (file) => this.removeImageFile(file));
    }
  }

  private async processDoc(docId: string, forceImages = false): Promise<void> {
    const doc = await getDoc(docId);
    this.trackChunkParents(docId, doc ?? undefined);
    if (!doc) {
      const path = this.postPaths.get(docId);
      if (path) await this.unpublishPost(docId);
      return;
    }

    if (classifyDoc(doc) !== "post") return;

    const path = String(doc.path);
    this.postPaths.set(docId, path);

    if (doc._deleted || doc.deleted) {
      await this.unpublishPost(docId);
      return;
    }

    const reconstructed = await reconstructText(docId);
    if (!reconstructed) {
      log.warn({ docId }, "doc_skipped");
      return;
    }

    const fm = processFrontmatter(
      reconstructed.text,
      reconstructed.path,
      reconstructed.mtime,
    );

    if (fm.skip) {
      await this.unpublishPost(docId);
      log.info({ docId, reason: fm.reason }, "doc_skipped");
      return;
    }

    const slug = fm.slug!;
    const oldRefs = await loadPostRefs(docId);
    if (oldRefs?.slug && oldRefs.slug !== slug) {
      await removePost(oldRefs.slug);
    }

    const images = await processImages(fm.content!, this.imageIndex, forceImages);
    await writePost(slug, images.markdown);

    for (const imageId of images.imageDocIds) {
      this.imageIndex.linkPostToImage(docId, imageId);
    }

    await applyPostRefs(
      docId,
      { images: images.imageDocIds, files: images.files, slug },
      (file) => this.removeImageFile(file),
    );

    if (images.pending.length > 0) {
      log.debug({ docId, pending: images.pending }, "images_pending");
    }
  }

  private async unpublishPost(docId: string): Promise<void> {
    const refs = await loadPostRefs(docId);
    if (refs?.slug) await removePost(refs.slug);
    this.postPaths.delete(docId);
    await clearPostRefs(docId, (file) => this.removeImageFile(file));
  }

  private async removeImageFile(filename: string): Promise<void> {
    const file = join(config.imageDir, filename);
    try {
      await unlink(file);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }
  }
}
