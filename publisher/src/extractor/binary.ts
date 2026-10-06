import { config } from "../config.js";
import { fetchLeavesOrdered, getMetaDoc } from "../couchdb/client.js";
import { log } from "../logger.js";
import type { NewnoteEntry, ReconstructedBinary } from "./types.js";

export async function reconstructBinary(
  docId: string,
): Promise<ReconstructedBinary | null> {
  const doc = await getMetaDoc(docId);
  if (!doc || doc.type !== "newnote") return null;

  const meta = doc as NewnoteEntry;
  const children = meta.children ?? [];

  try {
    const leaves = await fetchLeavesOrdered(children, meta.eden);
    const estimated = leaves.reduce((sum, l) => sum + l.data.length, 0);
    const estimatedBytes = Math.ceil((estimated * 3) / 4);
    if (estimatedBytes > config.maxImageBytes) {
      log.warn({ docId, estimatedBytes }, "image_too_large");
      return null;
    }

    const parts = leaves.map((l) => Buffer.from(l.data, "base64"));
    const buffer = Buffer.concat(parts);

    if (buffer.length > config.maxImageBytes) {
      log.warn({ docId, size: buffer.length }, "image_too_large");
      return null;
    }

    return {
      buffer,
      path: meta.path,
      mtime: meta.mtime ?? Date.now(),
      size: meta.size ?? buffer.length,
    };
  } catch (err) {
    log.error({ err, docId }, "binary_reconstruct_failed");
    return null;
  }
}
