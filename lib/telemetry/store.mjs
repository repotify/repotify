// Append-only JSONL event store for Stage 0 telemetry. Node 18+, no deps.
//
// One line per event, immutable by construction: events are only ever
// appended, never edited or deleted in place. When the active file exceeds
// maxBytes it is rotated aside (stage0.jsonl.1, then .2, .3, ... — a
// monotonic generation number, never reused) and a fresh file starts —
// rotated generations remain append-only history. Monotonic numbering (not
// a single .1 slot) is what makes repeated rotation lossless: the sync
// watermark is keyed per generation basename, so a reused name could hide
// a fresh generation behind an old watermark.
//
// The tracker composes schema validation + the privacy scan + the T1 consent
// gate: track() returns false (and writes nothing) when consent is missing,
// and throws on schema or privacy violations so bad data fails loudly
// instead of silently poisoning the log.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateEvent, SCHEMA_VERSION } from "./schema.mjs";
import { assertContentFree } from "./privacy.mjs";
import { canTrack, noticeNeeded } from "./consent.mjs";
import { readConfig } from "../../src/config.mjs";

export const EVENTS_FILE = "stage0.jsonl";
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export function createEventStore({ dir, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!dir) throw new Error("createEventStore requires a dir");
  const path = join(dir, EVENTS_FILE);

  // Monotonic sequence number per file generation, for gap detection.
  // A reader that sees seq 1,2,4 knows event 3 was lost.
  let seq = null;
  // Generation id: increments on every rotation, stamped on every event.
  // (gen, seq) is globally monotonic — gen only moves forward, seq restarts
  // at 1 per generation — so the pair totally orders the log across
  // rotations, clock skew, and VM snapshot restores. Derived lazily: the
  // .1 file always holds the immediately previous generation, so its last
  // event's gen + 1 is the current one.
  let gen = null;
  const currentGen = () => {
    if (gen === null) {
      gen = 1;
      try {
        // Highest rotated generation holds the previous gen; the active
        // file holds the current one when nothing has rotated yet.
        let probe = null, rotated = false;
        let n = 1;
        while (existsSync(`${path}.${n}`)) { probe = `${path}.${n}`; rotated = true; n += 1; }
        if (!probe && existsSync(path)) probe = path;
        if (probe) {
          const lines = readFileSync(probe, "utf8").split("\n").filter((l) => l.trim());
          if (lines.length) {
            let lastGen;
            try { lastGen = JSON.parse(lines[lines.length - 1]).gen; } catch { lastGen = undefined; }
            if (Number.isInteger(lastGen) && lastGen >= 1) gen = lastGen + (rotated ? 1 : 0);
            else if (rotated) gen = 2; // pre-gen .N: at least one rotation happened
          } else if (rotated) gen = 2;
        }
      } catch {
        gen = 1;
      }
    }
    return gen;
  };
  const nextSeq = () => {
    if (seq === null) {
      seq = 0;
      try {
        if (existsSync(path)) {
          seq = readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).length;
        }
      } catch {
        seq = 0;
      }
    }
    seq += 1;
    return seq;
  };

  const rotateIfNeeded = () => {
    try {
      if (existsSync(path) && statSync(path).size >= maxBytes) {
        // Monotonic generation number: scan for the highest existing
        // stage0.jsonl.N so a repeated rotation never clobbers history.
        let n = 1;
        while (existsSync(`${path}.${n}`)) n += 1;
        renameSync(path, `${path}.${n}`);
        seq = 0;
        if (gen !== null) gen += 1; // null gen re-derives lazily from the new .N
      }
    } catch {
      // Rotation is best effort; a failed rotation must not lose the event.
    }
  };

  /** Rotated generations, oldest first: [stage0.jsonl.1, stage0.jsonl.2, ...]. */
  const rotatedGenerations = () => {
    const out = [];
    let n = 1;
    while (existsSync(`${path}.${n}`)) {
      out.push(`${path}.${n}`);
      n += 1;
    }
    return out;
  };

  return {
    path,
    /** Validate + privacy-scan + append. Throws on invalid or non-content-free events. */
    append(event) {
      mkdirSync(dir, { recursive: true });
      rotateIfNeeded();
      const stamped = { ...event, gen: currentGen(), seq: nextSeq() };
      const errors = validateEvent(stamped);
      if (errors.length) throw new Error(`invalid telemetry event: ${errors.join("; ")}`);
      assertContentFree(stamped);
      appendFileSync(path, `${JSON.stringify(stamped)}\n`, "utf8");
      return true;
    },
    /**
     * Read events back grouped by file generation, oldest generation first:
     * [{ file, events }]. seq numbers are monotonic only within a generation,
     * so watermarking must be per-file (see lib/telemetry/sync.mjs).
     */
    readDetailed() {
      const files = [...rotatedGenerations(), path];
      const out = [];
      for (const f of files) {
        if (!existsSync(f)) continue;
        const events = [];
        for (const line of readFileSync(f, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try { events.push(JSON.parse(line)); } catch { /* skipped below by filters */ }
        }
        out.push({ file: f, events });
      }
      return out;
    },
    /**
     * Read events back, newest-last. Malformed lines are skipped defensively
     * (a corrupt line must not break reads); optional filters narrow the scan.
     */
    read({ type, episodeId, skillId, since, until, limit } = {}) {
      const out = [];
      for (const { events } of this.readDetailed()) {
        for (const e of events) {
          if (type && e.type !== type) continue;
          if (episodeId && e.episode_id !== episodeId) continue;
          if (skillId && e.skill_id !== skillId && !(Array.isArray(e.skill_ids) && e.skill_ids.includes(skillId))) continue;
          if (since && e.ts < since) continue;
          if (until && e.ts > until) continue;
          out.push(e);
          if (limit && out.length >= limit) return out;
        }
      }
      return out;
    },
  };
}

/**
 * Verify the log's integrity: per-generation seq continuity, corrupt lines.
 * The critic's question — "who watches the seq gaps?" — is answered here:
 * a future `repotify telemetry doctor` (or the flush path) calls this.
 * Returns { generations: [{file, events, corrupt, gaps: [missingSeq...]}], ok }.
 */
export function verifyLog(dir) {
  const base = join(dir, EVENTS_FILE);
  const files = [];
  let n = 1;
  while (existsSync(`${base}.${n}`)) {
    files.push(`${base}.${n}`);
    n += 1;
  }
  files.push(base);
  const generations = [];
  let ok = true;
  for (const f of files) {
    let lines = [];
    try {
      lines = readFileSync(f, "utf8").split("\n").filter((l) => l.trim());
    } catch {
      continue; // generation absent — not an error
    }
    let corrupt = 0;
    const seqs = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (Number.isInteger(e.seq) && e.seq > 0) seqs.push(e.seq);
        else corrupt += 1;
      } catch {
        corrupt += 1;
      }
    }
    const gaps = [];
    const seen = new Set(seqs);
    if (seqs.length) {
      const max = Math.max(...seqs);
      for (let s = 1; s <= max; s++) if (!seen.has(s)) gaps.push(s);
    }
    if (corrupt || gaps.length) ok = false;
    generations.push({ file: f, events: seqs.length, corrupt, gaps });
  }
  return { generations, ok };
}

/**
 * The Stage 0 tracker: the single entry point emission code should use.
 * - T1: track() is a silent no-op returning false until the first-run notice
 *   has been seen (canTrack). Nothing hits disk before that.
 * - Every event gets ts / schema_version / install_id stamped; per-call
 *   overrides win for the rest.
 */
export function createTracker({ env = process.env, dir, installId, maxBytes, now = () => new Date().toISOString() } = {}) {
  const store = createEventStore({ dir, maxBytes });
  const resolveInstallId = () => {
    if (installId) return installId;
    // Reuse the id persisted by the legacy pipeline when present, so both
    // pipelines attribute to the same install.
    try {
      return readConfig(env).installId ?? randomUUID();
    } catch {
      return randomUUID();
    }
  };
  // Cached after first use so every event in a process shares one id.
  let cachedId = null;
  const id = () => (cachedId ??= resolveInstallId());
  // Fail-open accounting: consent refusals are not drops (nothing was
  // attempted); only attempted-but-failed writes count.
  let dropped = 0;

  return {
    store,
    enabled: canTrack(env),
    noticeNeeded: () => noticeNeeded(env),
    droppedCount: () => dropped,
    track(event) {
      // Fail-open by construction: telemetry must never break or slow a user
      // command. Consent refusal is a silent false; a schema/privacy/disk
      // failure is counted and swallowed the same way (the store itself still
      // throws, so tests catch bad events loudly — only this boundary is quiet).
      if (!canTrack(env)) return false;
      try {
        const full = {
          ts: now(),
          schema_version: SCHEMA_VERSION,
          install_id: id(),
          ...event,
        };
        for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
        return store.append(full);
      } catch {
        dropped += 1;
        return false;
      }
    },
    /** Convenience: start a recommendation episode id for this process. */
    newEpisodeId: () => randomUUID(),
  };
}

