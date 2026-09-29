import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readJsonSafe, stableStringify } from "./util.mjs";

export const LOCK_FILE = "repotify.lock.json";

export function readLock(cwd) {
  const r = readJsonSafe(join(cwd, LOCK_FILE));
  const lock = r.ok && r.value && typeof r.value === "object" ? r.value : {};
  return { version: 1, catalogVersion: lock.catalogVersion ?? null, items: lock.items && typeof lock.items === "object" ? lock.items : {} };
}

export function writeLock(cwd, lock) {
  const path = join(cwd, LOCK_FILE);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, stableStringify({ version: 1, catalogVersion: lock.catalogVersion ?? null, items: lock.items }));
  renameSync(tmp, path);
}
