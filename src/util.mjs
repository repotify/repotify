import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

// True when the module is the entry script, also when started through a symlink or a path with spaces.
export function isMain(metaUrl) {
  try {
    return Boolean(process.argv[1]) && metaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

export function compareSemver(a, b) {
  const pa = String(a ?? "0").split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b ?? "0").split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

// Conservative token estimate used for every budget check.
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 3.5);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

// Returns a normalized relative POSIX path, or null when the path could escape its root.
export function safeRelPath(p) {
  if (typeof p !== "string" || p === "") return null;
  if (p.includes("\0") || p.includes("\\")) return null;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const normalized = posix.normalize(p);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return null;
  if (normalized.split("/").some((part) => part === "..")) return null;
  return normalized.replace(/\/$/, "");
}

export function readJsonSafe(file) {
  try {
    const text = readFileSync(file, "utf8").replace(/^\u{FEFF}/u, "");
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}
