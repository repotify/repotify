#!/usr/bin/env node
// Usage: node pipeline/verify.mjs <catalog-dir>. Exits 1 when hashes or schema do not check out.
import { verifyCatalogDir } from "../src/catalog.mjs";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node pipeline/verify.mjs <catalog-dir>");
  process.exit(2);
}
const r = verifyCatalogDir(dir);
if (r.errors.length) {
  console.error(`catalog invalid: ${r.errors.join("; ")}`);
  process.exit(1);
}
console.log(`catalog ${r.version} ok (${r.items} items)`);
