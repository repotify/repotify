// P4 instrumentation (odul-attribution-karar.md §4 madde 2): installation is
// the instrumentation point.
//
// "Repotify installs it" and "repotify can observe its invokes" must be the
// same fact. When repotify installs a skill, it writes an instrumentation
// manifest into the installed skill directory. The manifest binds the on-disk
// folder to the catalog skill_id, so that when the host agent later loads or
// calls the skill, the invoke event it reports through repotify's Stage 0
// flow can be attributed to the right skill_id — no platform cooperation
// needed, no name guessing.
//
// What this module does NOT do: it cannot observe invokes by itself. The host
// agent (Claude Code, Cursor, Codex, …) must report skill loads through
// repotify's tracker; the manifest only makes those reports attributable.
// Skills installed any other way (third-party catalog, manual) get no
// manifest, and their invoke channel stays blind by construction — which is
// exactly what invoke_observed=false means downstream.
//
// Manifest file: <skill-dir>/.repotify-instrument.json
//   { schema: "repotify-instrument/v1", skill_id, episode_id, installed_at, wrapped_by: "repotify" }
//
// All product-facing text in this repo is English (repo AGENTS.md).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_SOURCES, INVOCATION_KINDS } from "./schema.mjs";

export const INSTRUMENT_MANIFEST = ".repotify-instrument.json";
export const INSTRUMENT_SCHEMA = "repotify-instrument/v1";
export const WRAPPED_BY = "repotify";

/**
 * Wrap an installed skill directory: record the (skill_id, episode_id)
 * binding that makes later invoke events attributable. Best-effort by
 * contract — returns { ok, manifest } or { ok: false, reason }; it must
 * never break an install (callers swallow failures into a warning).
 */
export function wrapInstalledSkill({ dir, skillId, episodeId = null, installedAt = null } = {}) {
  if (!dir || typeof dir !== "string") return { ok: false, reason: "dir required" };
  if (!skillId || typeof skillId !== "string") return { ok: false, reason: "skillId required" };
  try {
    mkdirSync(dir, { recursive: true });
    const manifest = {
      schema: INSTRUMENT_SCHEMA,
      skill_id: skillId,
      episode_id: episodeId,
      installed_at: installedAt ?? new Date().toISOString(),
      wrapped_by: WRAPPED_BY,
      // The invoke channel for this pair is observable: the host agent's
      // load/call reports resolve to this skill_id via the manifest.
      invoke_observable: true,
    };
    writeFileSync(join(dir, INSTRUMENT_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
    return { ok: true, manifest, path: join(dir, INSTRUMENT_MANIFEST) };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

/** Read back a manifest written by wrapInstalledSkill; null when absent/invalid. */
export function readInstrumentManifest(dir) {
  try {
    const raw = readFileSync(join(dir, INSTRUMENT_MANIFEST), "utf8");
    const m = JSON.parse(raw);
    if (!m || m.schema !== INSTRUMENT_SCHEMA || typeof m.skill_id !== "string") return null;
    return m;
  } catch {
    return null;
  }
}

/** Remove the manifest (on uninstall). Best-effort; returns true when gone. */
export function unwrapInstalledSkill(dir) {
  try {
    rmSync(join(dir, INSTRUMENT_MANIFEST), { force: true });
    return !existsSync(join(dir, INSTRUMENT_MANIFEST));
  } catch {
    return false;
  }
}

/**
 * Build a schema-valid `install` event for a repotify-wrapped install.
 * Carries install_source "repotify" so the label pipe opens the hold with
 * observability=full (invoke_observed=true at window close).
 */
export function buildInstallEvent({ skillId, episodeId = null, fromRecommendation = false } = {}) {
  const e = {
    type: "install",
    skill_id: skillId,
    install_source: INSTALL_SOURCES[0], // "repotify"
    from_recommendation: Boolean(fromRecommendation),
  };
  if (episodeId) e.episode_id = episodeId;
  return e;
}

/**
 * Build a schema-valid `invoke` event attributed via the instrumentation
 * manifest. The host agent calls this (through its repotify tracker) when it
 * loads or calls a wrapped skill.
 */
export function buildInvokeEvent({ skillId, episodeId = null, invocationKind, sessionId = null } = {}) {
  if (!INVOCATION_KINDS.includes(invocationKind)) {
    throw new Error(`instrument: invocationKind must be one of ${INVOCATION_KINDS.join("|")}`);
  }
  const e = { type: "invoke", skill_id: skillId, invocation_kind: invocationKind };
  if (episodeId) e.episode_id = episodeId;
  if (sessionId) e.session_id = sessionId;
  return e;
}

/**
 * Resolve the attributable skill_id for an on-disk skill directory:
 * the manifest's skill_id when wrapped, otherwise null (unattributable —
 * an invoke report for this dir must not be guessed into the label pipe).
 */
export function resolveInstrumentedSkill(dir) {
  const m = readInstrumentManifest(dir);
  return m ? m.skill_id : null;
}
