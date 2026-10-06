import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each case reloads config after setting isolated filesystem paths; static imports
// would retain another case's environment-backed module singleton.

const { docs, reader, build } = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  reader: { start: vi.fn(), stop: vi.fn() },
  build: vi.fn(),
}));

vi.mock("nano", () => ({
  default: () => ({
    db: {
      use: () => ({
        get: async (id: string) => docs.get(id),
        list: async () => ({ rows: [...docs.keys()].sort().map((id) => ({ id })) }),
        fetch: async ({ keys }: { keys: string[] }) => ({
          rows: keys.slice().reverse().map((id) => ({ doc: docs.get(id) })),
        }),
        changesReader: reader,
      }),
    },
  }),
}));
vi.mock("../src/hugo/build.js", () => ({
  verifyHugo: async () => {},
  runHugoBuild: build,
}));

let root: string;
let events: EventEmitter;
let stopFeed: (() => void) | undefined;

beforeEach(async () => {
  vi.resetModules();
  docs.clear();
  build.mockReset().mockResolvedValue({ ok: true, durationMs: 0 });
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

describe("startup recovery rebuild", () => {
  function postFixture(id: string, slug: string, images = "") {
    const child = `h:${id}`;
    return {
      ...metadata, _id: id, path: id, children: [child],
      eden: {
        [child]: {
          data: `---\npost_published: true\npost_slug: ${slug}\n---\nRECOVERED ${slug}\n${images}`,
          epoch: 1,
        },
      },
    };
  }

  it("restores damaged posts and cached images without touching untracked files", async () => {
    docs.set("post.md", postFixture("post.md", "custom", "![[image.png]]"));
    docs.set("image.png", {
      _id: "image.png", type: "newnote", path: "image.png", mtime: 1,
      children: ["h:image"], eden: { "h:image": { data: "AQID", epoch: 1 } },
    });
    const { Publisher } = await import("../src/publisher.js");
    const { imageFilename } = await import("../src/markdown/images.js");
    const post = join(root, "content/posts/custom.md");
    const image = join(root, "images", imageFilename("image.png"));
    const manual = join(root, "content/posts/manual.md");
    await new Publisher().start(true);
    await writeFile(post, "damaged markdown");
    await writeFile(image, Buffer.from([9, 9, 9]));
    await writeFile(manual, "handwritten content");
    await writeFile(join(root, "state/refcount.json"), "invalid JSON");

    await new Publisher().start(false);
    expect(await readFile(post, "utf8")).toBe("damaged markdown");
    expect(await readFile(image)).toEqual(Buffer.from([9, 9, 9]));

    await new Publisher().start(true);
    expect(await readFile(post, "utf8")).toContain("RECOVERED custom");
    expect(await readFile(image)).toEqual(Buffer.from([1, 2, 3]));
    expect(await readFile(manual, "utf8")).toBe("handwritten content");
    expect(JSON.parse(await readFile(join(root, "state/refcount.json"), "utf8")))
      .toEqual({ "image.png": 1 });

    docs.set("post.md", postFixture("post.md", "renamed", "![[image.png]]"));
    await new Publisher().start(true);
    await expect(readFile(post)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "content/posts/renamed.md"), "utf8"))
      .toContain("RECOVERED renamed");
  });

  it("removes tracked stale output while protecting shared images and conflicted posts", async () => {
    docs.set("kept.md", postFixture("kept.md", "kept", "![[shared.png]]"));
    docs.set("deleted.md", postFixture("deleted.md", "custom-deleted", "![[shared.png]]\n![[orphan.png]]"));
    docs.set("soft.md", postFixture("soft.md", "custom-soft"));
    docs.set("draft.md", postFixture("draft.md", "custom-draft"));
    docs.set("conflict.md", postFixture("conflict.md", "custom-conflict"));
    for (const name of ["shared.png", "orphan.png"]) {
      const child = `h:${name}`;
      docs.set(name, {
        _id: name, type: "newnote", path: name, children: [child],
        eden: { [child]: { data: "AQID", epoch: 1 } },
      });
    }
    const { Publisher } = await import("../src/publisher.js");
    const { imageFilename } = await import("../src/markdown/images.js");
    await new Publisher().start(true);
    const untracked = join(root, "content/posts/deleted.md");
    await writeFile(untracked, "handwritten tombstone-name content");
    docs.delete("deleted.md");
    docs.set("soft.md", { ...docs.get("soft.md"), deleted: true });
    docs.set("draft.md", {
      ...metadata, _id: "draft.md", path: "draft.md", children: [],
    });
    docs.set("conflict.md", { ...docs.get("conflict.md"), _conflicts: ["2-other"] });

    const recovery = new Publisher();
    await recovery.start(true);
    await recovery.handleChange({ id: "deleted.md", deleted: true });
    expect(await readFile(untracked, "utf8")).toBe("handwritten tombstone-name content");
    for (const slug of ["custom-deleted", "custom-soft", "custom-draft"]) {
      await expect(readFile(join(root, "content/posts", `${slug}.md`)))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(join(root, "content/posts/kept.md"), "utf8")).toContain("RECOVERED kept");
    expect(await readFile(join(root, "content/posts/custom-conflict.md"), "utf8"))
      .toContain("RECOVERED custom-conflict");
    expect(await readFile(join(root, "images", imageFilename("shared.png"))))
      .toEqual(Buffer.from([1, 2, 3]));
    await expect(readFile(join(root, "images", imageFilename("orphan.png"))))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(root, "state/refcount.json"), "utf8")))
      .toEqual({ "shared.png": 1 });
  });

  it("fails startup when Hugo cannot complete the recovery build", async () => {
    docs.set("post.md", postFixture("post.md", "post"));
    const { Publisher } = await import("../src/publisher.js");
    await new Publisher().start(true);
    const checkpoint = join(root, "state/last_seq.json");
    await writeFile(checkpoint, JSON.stringify({ seq: "saved-sequence" }));
    build.mockResolvedValueOnce({ ok: false, durationMs: 0 });
    await expect(new Publisher().start(true)).rejects.toBeInstanceOf(Error);
    expect(JSON.parse(await readFile(checkpoint, "utf8"))).toEqual({ seq: "saved-sequence" });
  });
});
