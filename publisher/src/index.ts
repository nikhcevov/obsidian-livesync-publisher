import { mkdir } from "node:fs/promises";
import { config } from "./config.js";
import {
  getCurrentSeq,
  loadLastSeq,
  shouldProcessChange,
  startChangesFeed,
} from "./couchdb/changes.js";
import {
  ensureDatabase,
  getDb,
  isDbNotFound,
  withRetry,
} from "./couchdb/client.js";
import { log } from "./logger.js";
import { Publisher } from "./publisher.js";

async function ensureDirs(): Promise<void> {
  await mkdir(config.stateDir, { recursive: true });
  await mkdir(config.contentDir, { recursive: true });
  await mkdir(`${config.contentDir}/posts`, { recursive: true });
  await mkdir(config.imageDir, { recursive: true });
  await mkdir(config.hugoDest, { recursive: true });
}

async function verifyCouch(): Promise<void> {
  const db = getDb();
  try {
    await withRetry(() => db.info(), "startup_info");
  } catch (err: unknown) {
    if (!config.couchAutoCreate || !isDbNotFound(err)) throw err;
    await ensureDatabase();
    await withRetry(() => getDb().info(), "startup_info");
  }
  log.info({ url: config.couchUrl.replace(/:[^:@]+@/, ":***@") }, "couch_connected");
}

async function main(): Promise<void> {
  log.info(
    {
      host: config.couchServerUrl,
      database: config.couchDbName,
      hasAuth: config.couchHasAuth,
      autoCreate: config.couchAutoCreate,
      rebuildOnStart: config.rebuildOnStart,
    },
    "couch_config",
  );
  await ensureDirs();
  if (config.couchAutoCreate) await ensureDatabase();
  await verifyCouch();

  let since = await loadLastSeq();
  const fullBootstrap = since === undefined || config.rebuildOnStart;
  if (since === undefined) {
    since = await getCurrentSeq();
    log.info({ since }, "bootstrap_seq");
  }

  const publisher = new Publisher();
  await publisher.start(fullBootstrap);

  startChangesFeed(since, (change) => {
    if (!shouldProcessChange(change.doc, change.deleted)) return;
    return publisher.handleChange(change);
  });

  const shutdown = () => {
    log.info({}, "shutting_down");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.fatal({ err }, "fatal");
  process.exit(1);
});
