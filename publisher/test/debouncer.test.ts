import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";

// Reload config after selecting this case's debounce window.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("applies the newest edit after an in-flight reconstruction finishes", async () => {
  vi.resetModules();
  vi.stubEnv("DEBOUNCE_MS", "10");
  const { Debouncer } = await import("../src/watcher/debouncer.js");
  let releaseFirst!: () => void;
  const firstRead = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let currentContent = "original";
  let publishedContent = "";
  const debouncer = new Debouncer(async () => {
    const snapshot = currentContent;
    if (snapshot === "original") {
      markStarted();
      await firstRead;
    }
    publishedContent = snapshot;
  }, async () => {});

  debouncer.scheduleDoc("post.md");
  await started;
  currentContent = "newest";
  debouncer.scheduleDoc("post.md");
  await sleep(30);
  releaseFirst();
  await vi.waitFor(() => expect(publishedContent).toBe("newest"));
  await debouncer.flushAll();
});
