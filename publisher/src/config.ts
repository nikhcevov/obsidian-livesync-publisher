import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer env ${name}: ${raw}`);
  return n;
}

function parseList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = raw.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function parseCouch() {
  const base = required("COUCHDB_URL").replace(/\/$/, "");
  const dbName = required("COUCHDB_DB");
  const url = new URL(base);
  const user = process.env.COUCHDB_USER;
  const pass = process.env.COUCHDB_PASSWORD;
  if (user && !url.username) url.username = user;
  if (pass && !url.password) url.password = pass;
  url.pathname = `/${encodeURIComponent(dbName)}`;
  const couchUrl = url.toString();
  return {
    couchUrl,
    couchServerUrl: url.origin,
    couchDbName: dbName,
    couchHasAuth: Boolean(url.username),
  };
}

const couch = parseCouch();

export function buildCouchUrl(): string {
  return couch.couchUrl;
}

export const config = {
  couchUrl: couch.couchUrl,
  couchServerUrl: couch.couchServerUrl,
  couchDbName: couch.couchDbName,
  couchHasAuth: couch.couchHasAuth,
  couchAutoCreate: parseBool("COUCHDB_AUTO_CREATE", false),
  rebuildOnStart: parseBool("REBUILD_ON_START", false),
  debounceMs: parseIntEnv("DEBOUNCE_MS", 4000),
  publishGate: optional("PUBLISH_GATE", "frontmatter"),
  logLevel: optional("LOG_LEVEL", "info"),
  imageUrlPrefix: optional("IMAGE_URL_PREFIX", "/img"),
  maxImageBytes: parseIntEnv("MAX_IMAGE_BYTES", 10485760),
  imageExtensions: parseList("IMAGE_EXTENSIONS", [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "avif",
  ]),
  hugoSite: optional("HUGO_SITE", "/hugo"),
  hugoDest: optional("HUGO_DEST", "/public"),
  stateDir: optional("STATE_DIR", "/state"),
  contentDir: optional("CONTENT_DIR", "/hugo/content"),
  imageDir: optional("IMAGE_DIR", "/hugo/static/img"),
  hugoBin: optional("HUGO_BIN", "hugo"),
} as const;
