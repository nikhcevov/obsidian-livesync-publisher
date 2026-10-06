import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each case reloads config after setting isolated filesystem paths; static imports
// would retain another case's environment-backed module singleton.

const { docs, reader } = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  reader: { start: vi.fn(), stop: vi.fn() },
}));

vi.mock("nano", () => ({
  default: () => ({
    db: {
      use: () => ({
        get: async (id: string) => docs.get(id),
        fetch: async ({ keys }: { keys: string[] }) => ({
          rows: keys.slice().reverse().map((id) => ({ doc: docs.get(id) })),
        }),
        changesReader: reader,
      }),
    },
  }),
}));
vi.mock("../src/hugo/build.js", () => ({
  runHugoBuild: async () => ({ ok: true, durationMs: 0 }),
}));

let root: string;
let events: EventEmitter;
let stopFeed: (() => void) | undefined;

beforeEach(async () => {
  vi.resetModules();
  docs.clear();
  events = new EventEmitter();
  reader.start.mockReturnValue(events);
  root = await mkdtemp(join(tmpdir(), "publisher-sync-test-"));
  vi.stubEnv("STATE_DIR", join(root, "state"));
  vi.stubEnv("CONTENT_DIR", join(root, "content"));
  vi.stubEnv("IMAGE_DIR", join(root, "images"));
  vi.stubEnv("DEBOUNCE_MS", "10");
  vi.stubEnv("LOG_LEVEL", "silent");
});

afterEach(async () => {
  stopFeed?.();
  stopFeed = undefined;
  // Let document/build timers finish before removing their filesystem state.
  await sleep(50);
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const metadata = {
  _id: "post.md", type: "plain" as const, path: "post.md", mtime: 1780000000000,
};

describe("LiveSync content reconstruction", () => {
  it("reads embedded-only text without standalone leaves", async () => {
    const { reconstructText } = await import("../src/extractor/reconstruct.js");
    const result = await reconstructText("post.md", {
      ...metadata, children: ["h:body"],
      eden: { "h:body": { data: "---\npost_published: true\n---\nEmbedded body", epoch: 1 } },
    });
    expect(result?.text).toBe("---\npost_published: true\n---\nEmbedded body");
  });

  it("preserves child order and repetition with eden taking precedence", async () => {
    docs.set("h:a", { _id: "h:a", type: "leaf", data: "stale" });
    docs.set("h:b", { _id: "h:b", type: "leaf", data: "B" });
    docs.set("h:c", { _id: "h:c", type: "leaf", data: "C" });
    const { reconstructText } = await import("../src/extractor/reconstruct.js");
    const result = await reconstructText("post.md", {
      ...metadata, children: ["h:a", "h:b", "h:c", "h:a"],
      eden: {
        "h:a": { data: "A", epoch: 1 },
        "h:unused": { data: "not part of the note", epoch: 99 },
      },
    });
    expect(result?.text).toBe("ABCA");
  });

  it("decodes independently padded embedded and external binary chunks", async () => {
    docs.set("h:bytes", { _id: "h:bytes", type: "leaf", data: "AgM=" });
    docs.set("image.png", {
      _id: "image.png", type: "newnote", path: "image.png", children: ["h:one", "h:bytes", "h:one"],
      eden: { "h:one": { data: "AQ==", epoch: 1 } },
    });
    const { reconstructBinary } = await import("../src/extractor/binary.js");
    const result = await reconstructBinary("image.png");
    expect(result?.buffer).toEqual(Buffer.from([1, 2, 3, 1]));
  });

  it("rejects incomplete content instead of returning a partial note", async () => {
    docs.set("h:available", { _id: "h:available", type: "leaf", data: "partial" });
    const { fetchLeavesOrdered } = await import("../src/couchdb/client.js");
    await expect(fetchLeavesOrdered(["h:available", "h:missing"], {}, false))
      .rejects.toThrow("Missing chunks: h:missing");
  });
});

describe("published note updates", () => {
  async function connect() {
    const { Publisher } = await import("../src/publisher.js");
    const { startChangesFeed, shouldProcessChange } = await import("../src/couchdb/changes.js");
    const publisher = new Publisher();
    stopFeed = startChangesFeed(0, (change) => {
      if (shouldProcessChange(change.doc, change.deleted)) return publisher.handleChange(change);
    }).stop;
  }

  async function publish() {
    const doc = {
      ...metadata, children: ["h:original"],
      eden: { "h:original": { data: "---\npost_published: true\n---\nORIGINAL", epoch: 1 } },
    };
    docs.set(metadata._id, doc);
    events.emit("change", { id: metadata._id, seq: 1, doc });
    await vi.waitFor(async () => {
      expect(await readFile(join(root, "content/posts/post.md"), "utf8")).toContain("ORIGINAL");
    });
  }

  it("recovers on late leaf arrival without another metadata revision", async () => {
    await connect();
    await publish();
    const doc = { ...metadata, children: ["h:late"] };
    docs.set(metadata._id, doc);
    events.emit("change", { id: metadata._id, seq: 2, doc });
    await sleep(650);
    expect(await readFile(join(root, "content/posts/post.md"), "utf8")).toContain("ORIGINAL");
    const leaf = { _id: "h:late", type: "leaf", data: "---\npost_published: true\n---\nUPDATED" };
    docs.set(leaf._id, leaf);
    events.emit("change", { id: leaf._id, seq: 3, doc: leaf });
    await vi.waitFor(async () => {
      expect(await readFile(join(root, "content/posts/post.md"), "utf8")).toContain("UPDATED");
    });
  });

  it("unpublishes a note whose content is cleared to an empty children list", async () => {
    await connect();
    await publish();
    const doc = { ...metadata, children: [], eden: {}, size: 0 };
    docs.set(metadata._id, doc);
    events.emit("change", { id: metadata._id, seq: 2, doc });
    await vi.waitFor(async () => {
      await expect(readFile(join(root, "content/posts/post.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
