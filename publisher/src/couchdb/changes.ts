import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { getDb, withRetry } from "./client.js";
import { log } from "../logger.js";
import { classifyDoc, isChunkId } from "../extractor/filter.js";

export interface CouchChange {
  id: string;
  seq: string | number;
  deleted?: boolean;
  doc?: Record<string, unknown>;
}

export type ChangeHandler = (change: {
  id: string;
  deleted: boolean;
  doc?: Record<string, unknown>;
}) => void | Promise<void>;

function lastSeqPath(): string {
  return join(config.stateDir, "last_seq.json");
}

export async function loadLastSeq(): Promise<string | number | undefined> {
  try {
    const raw = await readFile(lastSeqPath(), "utf8");
    const data = JSON.parse(raw) as { seq?: string | number };
    return data.seq;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return undefined;
    throw err;
  }
}

export async function saveLastSeq(seq: string | number): Promise<void> {
  await mkdir(config.stateDir, { recursive: true });
  const tmp = `${lastSeqPath()}.tmp`;
  await writeFile(tmp, JSON.stringify({ seq }), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, lastSeqPath());
}

export async function getCurrentSeq(): Promise<string | number> {
  const db = getDb();
  const info = await withRetry(() => db.info(), "info");
  return info.update_seq;
}

export function startChangesFeed(
  since: string | number | undefined,
  onChange: ChangeHandler,
): { stop: () => void } {
  const db = getDb();
  let stopped = false;
  let pending = Promise.resolve();
  const sinceVal = since ?? "now";

  db.changesReader
    .start({
      since: sinceVal,
      includeDocs: true,
      batchSize: 50,
    })
    .on("change", (change: CouchChange) => {
      if (stopped) return;
      const id = change.id;

      pending = pending.then(async () => {
        if (stopped) return;
        try {
          const doc = change.doc as Record<string, unknown> | undefined;
          const deleted = Boolean(
            change.deleted || doc?._deleted || doc?.deleted,
          );
          await onChange({ id, deleted, doc });
          await saveLastSeq(change.seq);
        } catch (err) {
          log.error({ err, id }, "change_handler_error");
        }
      });
    })
    .on("error", (err: Error) => {
      log.error({ err }, "couch_disconnected");
    });

  log.info({ since: sinceVal }, "changes_feed_started");

  return {
    stop: () => {
      stopped = true;
      db.changesReader.stop();
    },
  };
}

export function shouldProcessChange(
  doc: Record<string, unknown> | undefined,
  deleted: boolean,
): boolean {
  if (deleted || doc?._deleted || doc?.deleted) return true;
  if (!doc) return false;
  if (typeof doc._id === "string" && isChunkId(doc._id)) {
    return doc.type === "leaf";
  }
  return classifyDoc(doc) !== "ignored";
}
