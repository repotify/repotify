// Content-hash cache for the v1 test runner (FAZ 2.3).
// Same content -> same score: when the canonical content hash is unchanged,
// the recorded scores stay valid and no test layer is re-run. Layer and
// formula versions are part of the key, so any rule change invalidates
// the cache deterministically.
import { sha256 } from "../../../src/util.mjs";

export function canonicalContent({ text = null, files = null } = {}) {
  const parts = [];
  if (text != null && String(text).length) parts.push(["SKILL.md", String(text)]);
  if (Array.isArray(files)) {
    const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const f of sorted) parts.push([f.path, String(f.content ?? "")]);
  }
  return parts.map(([p, c]) => `--- ${p} ---\n${c}`).join("\n");
}

export function contentHashFor(input) {
  return sha256(canonicalContent(input));
}

// versions: { cheap, expensive, score, juryPrompt, taxonomy } — every rule
// version that feeds a cached number.
export function cacheKey(contentHash, versions = {}) {
  const v = ["cheap", "expensive", "score", "juryPrompt", "taxonomy", "eligible"]
    .map((k) => `${k}=${versions[k] ?? "0"}`)
    .join(":");
  return `${contentHash}:${v}`;
}

export function cacheRead(cache, key) {
  if (!cache || typeof cache !== "object") return null;
  const rec = cache[key];
  return rec && typeof rec === "object" ? rec : null;
}

export function cacheWrite(cache, key, record) {
  if (!cache || typeof cache !== "object") return;
  cache[key] = record;
}
