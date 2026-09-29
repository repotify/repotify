import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256, stableStringify, readJsonSafe } from "../src/util.mjs";
import { validateCatalog } from "../src/catalog.mjs";

export const CATALOG_FILES = ["items.json", "taxonomy.json", "loadouts.json", "core.json"];

export function nextVersion(previous, now = new Date()) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, ".");
  const m = /^(\d{4}\.\d{2}\.\d{2})\.(\d+)$/.exec(previous ?? "");
  return m && m[1] === day ? `${day}.${Number(m[2]) + 1}` : `${day}.1`;
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Writes the catalog files that were provided (taxonomy is kept as-is when omitted) and a meta.json with their hashes.
export function writeCatalogFiles(dir, { items, loadouts, core, taxonomy }, { now = new Date(), extra = {} } = {}) {
  mkdirSync(dir, { recursive: true });
  const write = (name, value) => writeFileSync(join(dir, name), stableStringify(value));
  if (items) write("items.json", [...items].sort(byId));
  if (loadouts) write("loadouts.json", [...loadouts].sort(byId));
  if (core) write("core.json", core);
  if (taxonomy) write("taxonomy.json", taxonomy);
  for (const [name, value] of Object.entries(extra)) write(name, value);
  const previous = readJsonSafe(join(dir, "meta.json"));
  const files = {};
  for (const name of CATALOG_FILES) {
    const path = join(dir, name);
    if (existsSync(path)) files[name] = sha256(readFileSync(path));
  }
  const meta = {
    schemaVersion: 1,
    version: nextVersion(previous.ok ? previous.value.version : null, now),
    generatedAt: now.toISOString(),
    files,
  };
  write("meta.json", meta);
  return meta;
}

// Validates, then writes the catalog plus the review queue and rejection report. Writes nothing when invalid.
export function publishCatalog({ items, taxonomy, loadouts, core, reviewQueue = [], rejected = [] }, outDir, { now = new Date() } = {}) {
  const errors = validateCatalog({ items, taxonomy, loadouts, core });
  if (errors.length) throw new Error(`invalid catalog: ${errors.slice(0, 5).join("; ")}`);
  return writeCatalogFiles(outDir, { items, loadouts, core, taxonomy }, { now, extra: { "review-queue.json": reviewQueue, "rejected.json": rejected } });
}
