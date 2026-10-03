import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { readJsonSafe } from "./util.mjs";

// Where the published catalog lives once Repotify has its own repository.
export const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/repotify/repotify/main/catalog";

// npm does not accept the unscoped name "repotify" (too close to restify and reactify), so the package is scoped.
export const NPX_LAUNCHER = "npx -y @repotify/repotify@latest";

// The launcher is interpolated into a shell hook command and may come from repotify.lock.json, which a cloned
// repository can ship. "Plain words" was not enough: `sh -c "…"`, `node -e …` and `cmd /c …` are plain words that
// run whatever follows. So the launcher is one of exactly two shapes and nothing else: the published package, or
// `node "<absolute path>/repotify.mjs"` with a path the shell reads as a path (no `"`, `$`, backtick or control
// character, no flag, nothing after it). Anything else falls back to the published launcher.
const NODE_LAUNCHER_RE = /^node "(?:\/|[A-Za-z]:[\\/])[^"$`\x00-\x1f\x7f]*[\\/]repotify\.mjs"$/;
export function sanitizeLauncher(launcher) {
  return typeof launcher === "string" && (launcher === NPX_LAUNCHER || NODE_LAUNCHER_RE.test(launcher)) ? launcher : NPX_LAUNCHER;
}

export function catalogUrl(env = process.env) {
  return env.REPOTIFY_CATALOG_URL || DEFAULT_CATALOG_URL;
}

// Variables that change where Repotify reads from or sends to. They are for development and self-hosting; because
// they act silently, `repotify telemetry status` lists the ones in effect and a changed catalog source is announced.
const OVERRIDE_VARS = ["REPOTIFY_CATALOG_URL", "REPOTIFY_RAW_BASE", "REPOTIFY_TELEMETRY_URL", "REPOTIFY_HOME", "REPOTIFY_OFFLINE"];
export function envOverrides(env = process.env) {
  return OVERRIDE_VARS.filter((k) => env[k]).map((k) => `${k}=${String(env[k]).replace(/[^\x20-\x7e]/g, "?").slice(0, 120)}`);
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
