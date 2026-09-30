#!/usr/bin/env node
// Re-writes catalog/meta.json (hashes and version) after an editorial change to catalog/taxonomy.json, the one catalog
// file with no source elsewhere. Validates first and writes nothing when the catalog is invalid.
// Usage: node pipeline/rehash.mjs [catalog-dir]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../src/util.mjs";
import { validateCatalog } from "../src/catalog.mjs";
import { writeCatalogFiles } from "./publish.mjs";

export function rehashCatalog(dir, { now = new Date() } = {}) {
  const read = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
  const catalog = { items: read("items.json"), taxonomy: read("taxonomy.json"), loadouts: read("loadouts.json"), core: read("core.json") };
  const errors = validateCatalog(catalog);
  if (errors.length) throw new Error(`invalid catalog: ${errors.slice(0, 5).join("; ")}`);
  return writeCatalogFiles(dir, catalog, { now });
}

if (isMain(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? fileURLToPath(new URL("../catalog/", import.meta.url)));
  const meta = rehashCatalog(dir);
  console.error(`catalog ${meta.version} rehashed`);
}
