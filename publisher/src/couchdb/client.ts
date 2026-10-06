import nano, { type DocumentScope, type ServerScope } from "nano";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { Eden, EntryLeaf, MetaDoc } from "../extractor/types.js";

const RETRY_DELAYS = [500, 1000, 2000, 5000];

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= RETRY_DELAYS.length; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === RETRY_DELAYS.length) break;
      log.warn({ err, label, attempt: i + 1 }, "couch_retry");
      await sleep(RETRY_DELAYS[i]!);
    }
  }
  throw lastErr;
}

let dbScope: DocumentScope<Record<string, unknown>> | null = null;

function couchBasicAuthHeader(): string | undefined {
  const url = new URL(config.couchUrl);
  if (!url.username) return undefined;
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

function couchNanoConfig(): { url: string } {
  const creds = new URL(config.couchUrl);
  const server = new URL(config.couchServerUrl);
  if (creds.username) {
    server.username = creds.username;
    server.password = creds.password;
  }
  return { url: server.toString().replace(/\/$/, "") };
}

function createServer(): ServerScope {
  return nano(couchNanoConfig()) as ServerScope;
}

async function couchHttp(
  method: string,
  path: string,
  body?: string,
): Promise<Response> {
  const headers = new Headers({ Accept: "application/json" });
  const auth = couchBasicAuthHeader();
  if (auth) headers.set("Authorization", auth);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${config.couchServerUrl}${path}`, { method, headers, body });
}

export function isDbNotFound(err: unknown): boolean {
  const e = err as {
    statusCode?: number;
    reason?: string;
    error?: string;
    description?: string;
  };
  if (e.statusCode === 404) return true;
  if (e.error === "not_found") return true;
  if (e.reason === "not_found" || e.reason === "missing") return true;
  const text = `${e.reason ?? ""} ${e.description ?? ""}`.toLowerCase();
  return text.includes("does not exist");
}

const couchAuthHint =
  "CouchDB rejected credentials (401). Use COUCHDB_USER=admin and a password that matches the couchdb_data volume, or reset: docker compose -f docker-compose.dev.yml down -v";

export async function ensureDatabase(): Promise<void> {
  const dbName = config.couchDbName;
  const path = `/${encodeURIComponent(dbName)}`;
  await withRetry(async () => {
    const check = await couchHttp("GET", path);
    if (check.status === 200) {
      log.info({ database: dbName }, "database_exists");
      return;
    }
    if (check.status === 401) throw new Error(couchAuthHint);
    if (check.status !== 404) {
      throw new Error(`CouchDB GET ${path} failed: ${check.status} ${await check.text()}`);
    }
    const create = await couchHttp("PUT", path, "{}");
    if (create.status === 201) {
      log.info({ database: dbName }, "database_created");
      resetDb();
      return;
    }
    if (create.status === 401) throw new Error(couchAuthHint);
    if (create.status === 412) {
      log.info({ database: dbName }, "database_exists");
      return;
    }
    throw new Error(`CouchDB PUT ${path} failed: ${create.status} ${await create.text()}`);
  }, "ensure_database");
}

export function getDb(): DocumentScope<Record<string, unknown>> {
  if (!dbScope) {
    dbScope = createServer().db.use(config.couchDbName);
  }
  return dbScope;
}

export function resetDb(): void {
  dbScope = null;
}

export async function getDoc(id: string): Promise<Record<string, unknown> | null> {
  const db = getDb();
  try {
    return await withRetry(() => db.get(id), `get:${id}`);
  } catch (err: unknown) {
    const e = err as { statusCode?: number };
    if (e.statusCode === 404) return null;
    throw err;
  }
}

export async function bulkGetLeaves(
  childIds: string[],
): Promise<EntryLeaf[]> {
  if (childIds.length === 0) return [];
  const db = getDb();
  const response = await withRetry(
    () =>
      db.fetch({ keys: childIds }, { include_docs: true }),
    "fetch",
  );

  const leaves: EntryLeaf[] = [];
  for (const row of response.rows) {
    if ("error" in row) continue;
    const doc = row.doc as EntryLeaf | undefined;
    if (doc?.type === "leaf" && typeof doc.data === "string") {
      leaves.push(doc);
    }
  }
  return leaves;
}

export async function fetchLeavesOrdered(
  childIds: string[],
  eden: Eden = {},
  retry = true,
): Promise<EntryLeaf[]> {
  const byId = new Map<string, EntryLeaf>();
  for (const id of childIds) {
    const embedded = eden[id];
    if (typeof embedded?.data === "string") {
      byId.set(id, { _id: id, type: "leaf", data: embedded.data });
    }
  }
  const externalIds = [...new Set(childIds.filter((id) => !byId.has(id)))];
  const leaves = await bulkGetLeaves(externalIds);
  for (const leaf of leaves) byId.set(leaf._id, leaf);

  const ordered: EntryLeaf[] = [];
  const missing: string[] = [];
  for (const id of childIds) {
    const leaf = byId.get(id);
    if (leaf) ordered.push(leaf);
    else missing.push(id);
  }

  if (missing.length > 0) {
    if (retry) {
      log.warn({ missing: missing.length }, "chunks_missing_retry");
      await sleep(500);
      return fetchLeavesOrdered(childIds, eden, false);
    }
    throw new Error(`Missing chunks: ${missing.join(", ")}`);
  }

  return ordered;
}

export async function listAllDocIds(): Promise<string[]> {
  const db = getDb();
  const ids: string[] = [];
  let startkey: string | undefined;
  const limit = 500;

  while (true) {
    const res = await withRetry(
      () =>
        db.list({
          include_docs: false,
          limit,
          startkey,
        }),
      "list",
    );

    for (const row of res.rows) {
      if (!row.id.startsWith("_")) ids.push(row.id);
    }

    if (res.rows.length < limit) break;
    startkey = res.rows[res.rows.length - 1]!.id + "\ufff0";
  }

  return ids;
}

export async function getMetaDoc(id: string): Promise<MetaDoc | null> {
  const doc = await getDoc(id);
  if (!doc) return null;
  return doc as unknown as MetaDoc;
}
