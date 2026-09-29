import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeRelPath, sha256 } from "./util.mjs";

export const ITEM_TYPES = ["skill", "plugin", "mcp", "tool", "config"];
export const TIERS = ["core", "stack", "mission"];
export const LEVELS = ["verified", "caution", "quarantined", "rejected"];
export const PUBLISHABLE_LEVELS = ["verified", "caution"];
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
export const MAX_SUMMARY = 140;

const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

export function validateItem(item, taxonomy) {
  const errors = [];
  const e = (msg) => errors.push(`${item?.id ?? "?"}: ${msg}`);
  if (!item || typeof item !== "object") return ["item: not an object"];
  if (typeof item.id !== "string" || !ID_RE.test(item.id)) e("invalid id");
  if (!ITEM_TYPES.includes(item.type)) e(`invalid type ${item.type}`);
  if (typeof item.name !== "string" || !item.name) e("missing name");
  if (typeof item.summary !== "string" || !item.summary) e("missing summary");
  else if (item.summary.length > MAX_SUMMARY) e(`summary longer than ${MAX_SUMMARY} characters`);
  if (!TIERS.includes(item.tier)) e(`invalid tier ${item.tier}`);

  const needsRepo = !item.builtin;
  if (needsRepo && (typeof item.repo !== "string" || !REPO_RE.test(item.repo))) e("invalid repo (owner/name)");

  if (item.type === "skill" || item.type === "plugin") {
    if (typeof item.commit !== "string" || !HEX40.test(item.commit)) e("invalid commit (40 hex)");
    if (item.path != null && item.path !== "" && safeRelPath(item.path) === null) e("invalid path");
    if (!Array.isArray(item.files) || item.files.length === 0) e("files must be a non-empty list");
    else {
      for (const f of item.files) {
        if (!f || safeRelPath(f.path) === null) e(`unsafe file path ${f?.path}`);
        if (!f || typeof f.sha256 !== "string" || !HEX64.test(f.sha256)) e(`invalid sha256 for ${f?.path}`);
      }
    }
  }
  if (item.type === "mcp" || item.type === "tool" || item.type === "config") {
    const s = item.setup;
    if (!s || !isStrArray(s.steps) || s.steps.length === 0) e("setup.steps required");
    else if (item.type === "mcp" && (!s.mcp || typeof s.mcp.command !== "string" || !isStrArray(s.mcp.args ?? []))) e("setup.mcp {command, args} required");
  }

  const caps = taxonomy.capabilities ?? {};
  if (!isStrArray(item.capabilities) || item.capabilities.length === 0) e("capabilities must be a non-empty list");
  else for (const c of item.capabilities) if (!caps[c]) e(`unknown capability ${c}`);
  if (!isStrArray(item.needs)) e("needs must be a list");
  else for (const n of item.needs) if (!taxonomy.needs?.[n]) e(`unknown need ${n}`);
  if (!isStrArray(item.stacks) || item.stacks.length === 0) e("stacks must be a non-empty list");
  else for (const s of item.stacks) if (s !== "*" && !taxonomy.stacks?.[s]) e(`unknown stack ${s}`);
  if (!isStrArray(item.agents) || item.agents.length === 0) e("agents must be a non-empty list");
  else for (const a of item.agents) if (!(taxonomy.agents ?? []).includes(a)) e(`unknown agent ${a}`);
  if (!caps[item.cluster]) e(`unknown cluster ${item.cluster}`);
  if (!isStrArray(item.conflicts ?? [])) e("conflicts must be a list");
  if (!Number.isInteger(item.descriptionChars) || item.descriptionChars < 0) e("descriptionChars must be a non-negative integer");
  if (!isStrArray(item.badges ?? [])) e("badges must be a list");

  const level = item.security?.level;
  if (!LEVELS.includes(level)) e(`invalid security level ${level}`);
  else if (!PUBLISHABLE_LEVELS.includes(level)) e(`security level ${level} cannot be published`);
  return errors;
}

export function validateCatalog({ items, taxonomy, loadouts = [], core = [] }) {
  const errors = [];
  const byId = new Map();
  for (const item of items) {
    errors.push(...validateItem(item, taxonomy));
    if (byId.has(item.id)) errors.push(`${item.id}: duplicate id`);
    byId.set(item.id, item);
  }
  for (const item of items) {
    for (const c of item.conflicts ?? []) if (!byId.has(c)) errors.push(`${item.id}: conflict references missing item ${c}`);
  }
  for (const entry of core) {
    if (!byId.has(entry.id)) errors.push(`core: missing item ${entry.id}`);
    else if (byId.get(entry.id).tier !== "core") errors.push(`core: ${entry.id} is not tier core`);
    if (typeof entry.reason !== "string" || !entry.reason) errors.push(`core: ${entry.id} needs a reason`);
  }
  for (const lo of loadouts) {
    if (!ID_RE.test(lo.id ?? "")) errors.push(`loadout: invalid id ${lo.id}`);
    if (!taxonomy.projectTypes?.[lo.projectType]) errors.push(`loadout ${lo.id}: unknown projectType ${lo.projectType}`);
    for (const n of lo.needs ?? []) if (!taxonomy.needs?.[n]) errors.push(`loadout ${lo.id}: unknown need ${n}`);
    const clusters = new Map();
    for (const id of lo.items ?? []) {
      const item = byId.get(id);
      if (!item) {
        errors.push(`loadout ${lo.id}: missing item ${id}`);
        continue;
      }
      if (clusters.has(item.cluster)) errors.push(`loadout ${lo.id}: ${id} and ${clusters.get(item.cluster)} share cluster ${item.cluster}`);
      clusters.set(item.cluster, id);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Loading: remote (ETag) -> cache -> bundled copy shipped with the package.


export const CATALOG_FILES = ["items.json", "taxonomy.json", "loadouts.json", "core.json"];
export const BUNDLED_DIR = fileURLToPath(new URL("../catalog/", import.meta.url));

export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

class CatalogError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// Verifies raw file texts against meta and the schema, then parses them.
function assemble(metaText, texts) {
  const meta = JSON.parse(metaText);
  if (meta.schemaVersion !== 1) throw new CatalogError("integrity", `unsupported schema ${meta.schemaVersion}`);
  const parsed = {};
  for (const f of CATALOG_FILES) {
    if (typeof texts[f] !== "string" || sha256(texts[f]) !== meta.files?.[f]) throw new CatalogError("integrity", `hash mismatch for ${f}`);
    parsed[f] = JSON.parse(texts[f]);
  }
  const catalog = { items: parsed["items.json"], taxonomy: parsed["taxonomy.json"], loadouts: parsed["loadouts.json"], core: parsed["core.json"], meta };
  const errors = validateCatalog(catalog);
  if (errors.length) throw new CatalogError("integrity", `invalid catalog: ${errors[0]}`);
  return catalog;
}

// Full check of a catalog folder (hashes + schema); used by the publish job before committing.
export function verifyCatalogDir(dir) {
  try {
    const texts = {};
    for (const f of CATALOG_FILES) texts[f] = readFileSync(join(dir, f), "utf8");
    const catalog = assemble(readFileSync(join(dir, "meta.json"), "utf8"), texts);
    return { errors: [], version: catalog.meta.version, items: catalog.items.length };
  } catch (error) {
    return { errors: [error.message], version: null, items: 0 };
  }
}

function readDir(dir) {
  if (!existsSync(join(dir, "meta.json"))) return null;
  try {
    const texts = {};
    for (const f of CATALOG_FILES) texts[f] = readFileSync(join(dir, f), "utf8");
    return assemble(readFileSync(join(dir, "meta.json"), "utf8"), texts);
  } catch {
    return null;
  }
}

// Best effort: a read-only home only means no cache.
function writeCache(cacheDir, metaText, texts, etag) {
  try {
    mkdirSync(cacheDir, { recursive: true });
    for (const f of CATALOG_FILES) writeFileSync(join(cacheDir, f), texts[f]);
    writeFileSync(join(cacheDir, "meta.json"), metaText);
    writeFileSync(join(cacheDir, "etag.json"), JSON.stringify({ etag: etag ?? null }));
  } catch {
    // Ignored on purpose.
  }
}

async function fetchRemote(url, cacheDir, fetchImpl, useEtag) {
  let etag = null;
  try {
    if (useEtag) etag = JSON.parse(readFileSync(join(cacheDir, "etag.json"), "utf8")).etag;
  } catch {
    // No cache yet.
  }
  const headers = etag ? { "If-None-Match": etag } : {};
  let res;
  try {
    res = await fetchImpl(`${url}/meta.json`, { headers, signal: AbortSignal.timeout(15000) });
  } catch (error) {
    throw new CatalogError("offline", error.message);
  }
  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new CatalogError("http", `HTTP ${res.status}`);
  const metaText = await res.text();
  const texts = {};
  for (const f of CATALOG_FILES) {
    let r;
    try {
      r = await fetchImpl(`${url}/${f}`, { signal: AbortSignal.timeout(30000) });
    } catch (error) {
      throw new CatalogError("offline", error.message);
    }
    if (!r.ok) throw new CatalogError("http", `HTTP ${r.status} for ${f}`);
    texts[f] = await r.text();
  }
  let catalog;
  try {
    catalog = assemble(metaText, texts);
  } catch (error) {
    throw error instanceof CatalogError ? error : new CatalogError("integrity", error.message);
  }
  return { catalog, metaText, texts, etag: res.headers.get("etag") };
}

export async function loadCatalog({ url, cacheDir, bundledDir = BUNDLED_DIR, fetchImpl = fetch, offline = false } = {}) {
  const bundled = readDir(bundledDir);
  if (!bundled) throw new Error("bundled catalog is missing or corrupted; reinstall repotify");
  const cached = cacheDir ? readDir(cacheDir) : null;
  const fallback = (why) => {
    const best = cached && compareVersions(cached.meta.version, bundled.meta.version) >= 0 ? { catalog: cached, source: "cache" } : { catalog: bundled, source: "bundled" };
    return { ...best, notice: `${why}; using the ${best.source} catalog (${best.catalog.meta.version}).` };
  };
  const newest = cached && compareVersions(cached.meta.version, bundled.meta.version) >= 0 ? { catalog: cached, source: "cache" } : { catalog: bundled, source: "bundled" };
  if (offline || !url) return newest;
  let remote;
  try {
    remote = await fetchRemote(url, cacheDir, fetchImpl, Boolean(cached));
  } catch (error) {
    if (error.kind === "offline") return fallback("Offline");
    if (error.kind === "integrity") return fallback(`Catalog integrity check failed (${error.message})`);
    return fallback(`Catalog unavailable (${error.message})`);
  }
  if (remote.notModified) return cached ? newest : fallback("Cache missing");
  const newestLocal = [bundled, cached].filter(Boolean).reduce((a, b) => (compareVersions(a.meta.version, b.meta.version) >= 0 ? a : b));
  if (compareVersions(remote.catalog.meta.version, newestLocal.meta.version) < 0) {
    return fallback(`Remote catalog ${remote.catalog.meta.version} is older than the local copy`);
  }
  if (cacheDir) writeCache(cacheDir, remote.metaText, remote.texts, remote.etag);
  return { catalog: remote.catalog, source: "remote" };
}
