import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { readJsonSafe } from "./util.mjs";

// Where the published catalog lives once Repotify has its own repository.
export const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/repotify/repotify/main/catalog";

// npm does not accept the unscoped name "repotify" (too close to restify and reactify), so the package is scoped.
export const NPX_LAUNCHER = "npx -y @repotify/repotify@latest";

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
