// Server-side aggregate intake — the D1 reference implementation.
//
// The client sends ONLY per-skill counters (lib/telemetry/sync.mjs). The
// server still treats every payload as hostile and enforces three rules
// before a count may touch the public aggregate:
//
// 1. SCHEMA ALLOWLIST: unknown top-level fields, unknown counter names,
//    non-id skill keys, non-integer counts, or future windows → rejected.
//    The wire vocabulary can only grow by a schema version bump.
// 2. PII SCAN: the payload is scanned with the same patterns as client
//    events; anything identity-like → rejected, loudly.
// 3. DELAYED WINDOW: accepted payloads sit in quarantine for
//    FLEET_QUARANTINE_HOURS before `admit()` folds them in. The published
//    aggregate is always at least a day stale — by design.
// 4. MIN GROUP SIZE: `snapshot()` publishes a skill bucket only when at
//    least FLEET_MIN_GROUP_INSTALLS distinct syncs contributed to it
//    (k-anonymity). Thin buckets are suppressed, never published thin.
//
// Unlinkability note: the nonce is a random per-sync uuid used ONLY for
// replay dedupe. It is never stored next to anything identifying, never
// returned, and never joins across syncs — one install syncing twice in a
// window counts twice, which the min-group-size rule absorbs.
//
// Node 18+, no dependencies. In-memory; D1 persistence is the production
// mapping (one row per (skill, counter) per admitted window).

import { randomUUID } from "node:crypto";
import {
  FLEET_MIN_GROUP_INSTALLS, FLEET_QUARANTINE_HOURS, SYNC_SCHEMA,
} from "./thresholds.mjs";

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The only counter names the server will ever accept.
const KNOWN_COUNTERS = new Set([
  "shown", "installed", "selected", "invoked", "invoked_sessions",
  "outcome_success", "outcome_failure", "kept_30d", "removed_fast", "removed",
  "replaced", "abandoned", "fallback", "questions_asked", "questions_answered",
]);

// Same PII patterns as the client privacy scan: identity-like strings have
// no business in an aggregate payload.
const PII_PATTERNS = [
  /(^|[\s"'=:(])(\/(home|Users)\/[^\s"'<>\]]+|[A-Za-z]:\\[^\s"'<>\]]+|~\/[^\s"'<>\]]+)/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(api[_-]?key|secret|passwd|password|bearer|access[_-]?token)[\s:=]+\S+/i,
];

function scanStrings(value, path, hits) {
  if (typeof value === "string") {
    for (const re of PII_PATTERNS) {
      const m = value.match(re);
      if (m) { hits.push(`${path}: ${m[0].slice(0, 60)}`); return; }
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => scanStrings(v, `${path}[${i}]`, hits)); return; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) scanStrings(v, path ? `${path}.${k}` : k, hits);
  }
}

function validatePayload(p, nowMs) {
  const errs = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["payload must be an object"];
  for (const k of Object.keys(p)) {
    if (!["schema", "window_start", "window_end", "nonce", "aggregates"].includes(k)) {
      errs.push(`unknown top-level field: ${k}`);
    }
  }
  if (p.schema !== SYNC_SCHEMA) errs.push(`schema must be ${SYNC_SCHEMA}`);
  if (typeof p.window_start !== "string" || Number.isNaN(Date.parse(p.window_start))) errs.push("invalid window_start");
  if (typeof p.window_end !== "string" || Number.isNaN(Date.parse(p.window_end))) errs.push("invalid window_end");
  if (!errs.length) {
    if (Date.parse(p.window_start) >= Date.parse(p.window_end)) errs.push("window_start must precede window_end");
    if (Date.parse(p.window_end) > nowMs) errs.push("window_end is in the future");
  }
  if (typeof p.nonce !== "string" || !UUID_RE.test(p.nonce)) errs.push("nonce must be a uuid");
  if (!p.aggregates || typeof p.aggregates !== "object" || Array.isArray(p.aggregates)) {
    errs.push("aggregates must be an object");
  } else {
    for (const [skillId, counters] of Object.entries(p.aggregates)) {
      if (!ID_RE.test(skillId)) { errs.push(`invalid skill id: ${skillId}`); continue; }
      if (!counters || typeof counters !== "object" || Array.isArray(counters)) {
        errs.push(`${skillId}: counters must be an object`); continue;
      }
      for (const [name, v] of Object.entries(counters)) {
        if (!KNOWN_COUNTERS.has(name)) errs.push(`${skillId}: unknown counter ${name}`);
        else if (!Number.isInteger(v) || v < 0 || v > 1e12) errs.push(`${skillId}.${name}: must be a non-negative integer`);
      }
    }
  }
  const hits = [];
  scanStrings(p, "", hits);
  for (const h of hits) errs.push(`PII pattern in payload: ${h}`);
  return errs;
}

export function createAggregator({
  now = () => new Date(),
  minGroupInstalls = FLEET_MIN_GROUP_INSTALLS,
  quarantineHours = FLEET_QUARANTINE_HOURS,
} = {}) {
  const quarantine = [];          // [{ payload, receivedAtMs }] — the ONLY per-sync storage, and only until the delay passes
  const folded = new Map();       // skill -> { counters, nonces:Set, windowStart, windowEnd } — sums only, never per-sync rows
  let admittedSyncs = 0;
  const seenNonces = new Set();

  const fold = (p) => {
    admittedSyncs += 1;
    for (const [skillId, counters] of Object.entries(p.aggregates)) {
      let s = folded.get(skillId);
      if (!s) { s = { counters: {}, nonces: new Set(), windowStart: p.window_start, windowEnd: p.window_end }; folded.set(skillId, s); }
      s.nonces.add(p.nonce);
      if (p.window_start < s.windowStart) s.windowStart = p.window_start;
      if (p.window_end > s.windowEnd) s.windowEnd = p.window_end;
      for (const [name, v] of Object.entries(counters)) {
        s.counters[name] = (s.counters[name] ?? 0) + v;
      }
    }
  };

  return {
    /** Validate + quarantine. Throws on any rule violation. */
    ingest(payload) {
      const nowMs = new Date(now()).getTime();
      const errs = validatePayload(payload, nowMs);
      if (errs.length) throw new Error(`sync payload rejected: ${errs.join("; ")}`);
      if (seenNonces.has(payload.nonce)) throw new Error("sync payload rejected: nonce replay");
      seenNonces.add(payload.nonce);
      quarantine.push({ payload, receivedAtMs: nowMs });
      return { quarantined: true, quarantine_depth: quarantine.length };
    },
    /**
     * Fold past-quarantine payloads into the aggregate sums and DROP them.
     * After admit(), no per-sync record exists anywhere — the server holds
     * only sums, exactly the "never persist per-device reports" principle.
     */
    admit() {
      const nowMs = new Date(now()).getTime();
      const cutoff = nowMs - quarantineHours * 3600 * 1000;
      let n = 0;
      for (let i = quarantine.length - 1; i >= 0; i--) {
        if (quarantine[i].receivedAtMs <= cutoff) {
          fold(quarantine[i].payload);
          quarantine.splice(i, 1);
          n += 1;
        }
      }
      return { admitted: n, quarantine_depth: quarantine.length, admitted_total: admittedSyncs };
    },
    quarantineDepth() { return quarantine.length; },
    admittedCount() { return admittedSyncs; },
    /**
     * The publishable aggregate: per-skill counter sums, with thin buckets
     * suppressed (k-anonymity). contributing_syncs counts distinct nonces per
     * skill — the min-group-size denominator.
     */
    snapshot() {
      const skills = {};
      const suppressed = [];
      let windowStart = null, windowEnd = null;
      for (const [skillId, s] of [...folded.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!windowStart || s.windowStart < windowStart) windowStart = s.windowStart;
        if (!windowEnd || s.windowEnd > windowEnd) windowEnd = s.windowEnd;
        if (s.nonces.size >= minGroupInstalls) {
          skills[skillId] = { counters: { ...s.counters }, contributing_syncs: s.nonces.size };
        } else {
          suppressed.push(skillId);
        }
      }
      return {
        skills, suppressed,
        admitted_syncs: admittedSyncs,
        window_start: windowStart, window_end: windowEnd,
      };
    },
  };
}
