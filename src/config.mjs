import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { readJsonSafe } from "./util.mjs";

// Where the published catalog lives once Repotify has its own repository.
export const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/repotify/repotify/main/catalog";

// npm does not accept the unscoped name "repotify" (too close to restify and reactify), so the package is scoped.
export const NPX_LAUNCHER = "npx -y @repotify/repotify@latest";

// The launcher is interpolated into a shell hook command, so it must be plain words: a poisoned
// repotify.lock.json could otherwise turn the user's "yes" into remote execution at session start.
// Quoted segments are allowed (`node "/path/to/bin/repotify.mjs"`); anything the shell would
// interpret (`;`, `|`, `$`, backticks, `$(…)`, `&&`) falls back to the published launcher. That holds inside the
// quotes too: double quotes do not stop `$(…)` or backticks from running, so a quoted segment is a path, with no
// `$`, no backtick and no control character.
const QUOTED = '"[^"$`\\x00-\\x1f\\x7f]*"';
const BARE = "[A-Za-z0-9_@./\\\\~:+-]+";
const SAFE_LAUNCHER_RE = new RegExp(`^(?:${QUOTED}|${BARE})(?: +(?:${QUOTED}|${BARE}))*$`);
export function sanitizeLauncher(launcher) {
  return typeof launcher === "string" && SAFE_LAUNCHER_RE.test(launcher) ? launcher : NPX_LAUNCHER;
}

// Analytics endpoint: intentionally null until the Cloudflare account is configured.
// While null, events are only queued locally and nothing is sent.
export const TELEMETRY_ENDPOINT = null;

export function catalogUrl(env = process.env) {
  return env.REPOTIFY_CATALOG_URL || DEFAULT_CATALOG_URL;
}

export function homeDir(env = process.env) {
  return env.REPOTIFY_HOME || join(homedir(), ".repotify");
}

export function readConfig(env = process.env) {
  const r = readJsonSafe(join(homeDir(env), "config.json"));
  return r.ok && r.value && typeof r.value === "object" ? r.value : {};
}

// Best effort: sandboxed agents may not allow writes to the home folder, and that must never break a command.
export function writeConfig(env, patch) {
  const dir = homeDir(env);
  const next = { ...readConfig(env), ...patch };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(next, null, 2) + "\n");
  } catch {
    // Read-only home: settings simply do not persist.
  }
  return next;
}
