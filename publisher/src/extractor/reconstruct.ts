import { fetchLeavesOrdered, getMetaDoc } from "../couchdb/client.js";
import { log } from "../logger.js";
import type {
  MetaDoc,
  NotesEntry,
  PlainEntry,
  ReconstructedText,
} from "./types.js";

export async function reconstructText(
  docId: string,
  meta?: MetaDoc,
): Promise<ReconstructedText | null> {
  const doc = meta ?? (await getMetaDoc(docId));
  if (!doc) return null;

  if (doc.type === "notes") {
    const notes = doc as NotesEntry;
    if (typeof notes.data !== "string") {
      log.warn({ docId }, "notes_missing_data");
      return null;
    }
    return {
      text: notes.data,
      path: notes.path,
      mtime: notes.mtime ?? Date.now(),
    };
  }

  if (doc.type !== "plain") {
    log.warn({ docId, type: (doc as MetaDoc).type }, "unknown_meta_type");
    return null;
  }

  const plain = doc as PlainEntry;
  const children = plain.children ?? [];

  try {
    const leaves = await fetchLeavesOrdered(children, plain.eden);
    const text = leaves.map((l) => l.data).join("");
    return {
      text,
      path: plain.path,
      mtime: plain.mtime ?? Date.now(),
    };
  } catch (err) {
    log.error({ err, docId }, "reconstruct_failed");
    return null;
  }
}
