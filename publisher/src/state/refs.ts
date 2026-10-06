import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";

export interface PostRefs {
  images: string[];
  files: string[];
  slug?: string;
}

let chain: Promise<void> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(fn);
  chain = result.then(
    () => {},
    () => {},
  );
  return result;
}

function refsPath(postDocId: string): string {
  const safe = Buffer.from(postDocId).toString("base64url");
  return join(config.stateDir, "refs", `${safe}.json`);
}

function refcountPath(): string {
  return join(config.stateDir, "refcount.json");
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data), "utf8");
  await rename(tmp, path);
}

export async function loadPostRefs(postDocId: string): Promise<PostRefs | null> {
  try {
    const raw = await readFile(refsPath(postDocId), "utf8");
    const data = JSON.parse(raw) as PostRefs;
    return { images: data.images ?? [], files: data.files ?? [], slug: data.slug };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

export async function loadAllRefsWithPostIds(): Promise<
  Map<string, PostRefs>
> {
  const map = new Map<string, PostRefs>();
  const refsDir = join(config.stateDir, "refs");
  try {
    const files = await readdir(refsDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const raw = await readFile(join(refsDir, file), "utf8");
      const data = JSON.parse(raw) as PostRefs & { postDocId?: string };
      if (data.postDocId) {
        map.set(data.postDocId, {
          images: data.images ?? [],
          files: data.files ?? [],
          slug: data.slug,
        });
      }
    }
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }
  return map;
}

export async function rebuildImageRefcounts(): Promise<void> {
  return runExclusive(async () => {
    const refs = await loadAllRefsWithPostIds();
    const counts: Record<string, number> = {};
    for (const ref of refs.values()) {
      for (const id of new Set(ref.images)) {
        counts[id] = (counts[id] ?? 0) + 1;
      }
    }
    await atomicWriteJson(refcountPath(), counts);
  });
}

async function loadRefcount(): Promise<Record<string, number>> {
  try {
    const raw = await readFile(refcountPath(), "utf8");
    return JSON.parse(raw) as Record<string, number>;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw err;
  }
}

export async function applyPostRefs(
  postDocId: string,
  newRefs: PostRefs,
  onOrphanFile: (filename: string) => Promise<void>,
): Promise<void> {
  return runExclusive(async () => {
    const old = (await loadPostRefs(postDocId)) ?? {
      images: [],
      files: [],
    };
    const counts = await loadRefcount();

    const oldImages = new Set(old.images);
    const newImages = new Set(newRefs.images);

    for (const id of oldImages) {
      if (!newImages.has(id)) {
        counts[id] = (counts[id] ?? 1) - 1;
        if (counts[id]! <= 0) delete counts[id];
      }
    }
    for (const id of newImages) {
      if (!oldImages.has(id)) {
        counts[id] = (counts[id] ?? 0) + 1;
      }
    }

    const allRefs = await loadAllRefsWithPostIds();
    for (const file of old.files) {
      if (newRefs.files.includes(file)) continue;
      let usedElsewhere = false;
      for (const [pid, ref] of allRefs) {
        if (pid === postDocId) continue;
        if (ref.files.includes(file)) {
          usedElsewhere = true;
          break;
        }
      }
      if (!usedElsewhere) {
        await onOrphanFile(file);
        log.info({ file }, "image_orphan_removed");
      }
    }

    if (
      newRefs.images.length === 0 &&
      newRefs.files.length === 0 &&
      !newRefs.slug
    ) {
      try {
        await unlink(refsPath(postDocId));
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") throw err;
      }
    } else {
      await atomicWriteJson(refsPath(postDocId), {
        postDocId,
        images: newRefs.images,
        files: newRefs.files,
        slug: newRefs.slug,
      });
    }

    await atomicWriteJson(refcountPath(), counts);
  });
}

export async function clearPostRefs(
  postDocId: string,
  onOrphanFile: (filename: string) => Promise<void>,
): Promise<void> {
  return applyPostRefs(postDocId, { images: [], files: [] }, onOrphanFile);
}
