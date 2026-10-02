// `repotify sync` — the ONLY path by which anything leaves the machine (DL-009).
//
// Privacy contract (the whole point of this module):
// - Only AGGREGATES leave: per-skill counters summed over the sync window.
//   Raw events, install ids, project hashes, per-event timestamps, prompts,
//   code, answers: NEVER. The builder copies counters and nothing else.
// - The exact payload is printed for the user BEFORE sending; sending needs
//   an interactive yes on a TTY. There is deliberately no --yes flag and no
//   non-interactive path: "sessiz gönderim yok" (no silent submission).
// - A watermark (sync-state.json) means each local event's contribution is
//   sent at most once; a second sync with no new events sends nothing.
// - In return the server hands back the fleet policy (public proof: which
//   skill works best at which job) which is saved locally as fleet-policy.json.
//
// Node 18+, no dependencies.

import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "../../src/config.mjs";
import { createEventStore } from "./store.mjs";
import { canTrack, noticeNeeded } from "./consent.mjs";
import { scanEvent } from "./privacy.mjs";

export const SYNC_SCHEMA = "telemetry-sync/v1";
export const SYNC_STATE_FILE = "sync-state.json";
export const FLEET_POLICY_FILE = "fleet-policy.json";
export const FLEET_POLICY_SCHEMA = "fleet-policy/1";

// Per-skill counters. This list is the entire vocabulary the server ever
// sees — extending it is a schema change, never an accident.
const COUNTERS = [
  "shown",            // times the skill appeared on a recommendation slate
  "installed",        // installs (from a recommendation or directly)
  "selected",         // switched on without install (hook / MCP enable)
  "invoked",          // the agent loaded or called the skill
  "invoked_sessions", // distinct sessions with at least one invoke
  "outcome_success",  // finished tasks: raw success
  "outcome_failure",  // finished tasks: raw failure
  "kept_30d",         // still installed after 30 days
  "removed_fast",     // removed within 7 days of install (bucket is exclusive: NOT also counted in `removed`)
  "removed",          // removed after 7 days, not in favour of another skill (exclusive)
  "replaced",         // removed in favour of another skill (exclusive: NOT also counted in `removed`)
  "abandoned",        // task given up mid-way
  "fallback",         // capability-graph fallback edge taken
  "questions_asked",
  "questions_answered",
];

const zeroCounters = () => Object.fromEntries(COUNTERS.map((c) => [c, 0]));

/** Fold one Stage 0 event into per-skill counters. Unknown types are ignored. */
function foldEvent(agg, e) {
  const touch = (skillId) => {
    if (!skillId || typeof skillId !== "string") return null;
    return (agg[skillId] ??= zeroCounters());
  };
  switch (e.type) {
    case "recommendation":
      for (const c of e.candidates ?? []) {
        const a = touch(c.skill_id);
        if (a && c.shown) a.shown += 1;
      }
      break;
    case "install": { const a = touch(e.skill_id); if (a) a.installed += 1; break; }
    case "select": { const a = touch(e.skill_id); if (a) a.selected += 1; break; }
    case "invoke": {
      const a = touch(e.skill_id);
      if (a) {
        a.invoked += 1;
        if (e.session_id) (a._sessions ??= new Set()).add(e.session_id);
      }
      break;
    }
    case "outcome": {
      // Outcomes without a skill_id are episode-level (shared/baseline) and
      // carry no per-skill information — they stay local.
      const ids = e.skill_id ? [e.skill_id] : (e.skill_ids ?? []);
      for (const id of ids) {
        const a = touch(id);
        if (a) a[e.task_success ? "outcome_success" : "outcome_failure"] += 1;
      }
      break;
    }
    case "kept_30d": { const a = touch(e.skill_id); if (a) a.kept_30d += 1; break; }
    // Removal buckets are mutually exclusive: each removal event lands in
    // exactly one counter, so the server-side effectiveness denominator
    // (removed_fast + removed + replaced + outcome_failure) counts every
    // removal exactly once. (Pragmatist verdict: fix the old double count,
    // where removed_fast/replaced also incremented `removed`.)
    case "removed_fast": { const a = touch(e.skill_id); if (a) a.removed_fast += 1; break; }
    case "removed": { const a = touch(e.skill_id); if (a) a.removed += 1; break; }
    case "replaced": { const a = touch(e.skill_id); if (a) a.replaced += 1; break; }
    case "abandon": { const a = touch(e.skill_id); if (a) a.abandoned += 1; break; }
    case "fallback": {
      const a = touch(e.to_skill);
      if (a) a.fallback += 1;
      break;
    }
    case "question": {
      const a = touch(e.skill_id);
      if (a) { a.questions_asked += 1; if (!e.skipped) a.questions_answered += 1; }
      break;
    }
    default:
      break; // usage and anything future: tokens/latency never leave the machine
  }
}

export const SYNC_STATE_VERSION = 2;

// The sync watermark is a single (gen, seq) pair: every event with
// (gen, seq) <= watermark has been synced. The store stamps a generation id
// on every event (incremented on rotation) and a per-generation seq, so the
// pair totally orders the log across rotations, clock skew, and VM snapshot
// restores — the failure modes of the old ts-based watermark
// (v1: { synced_through_ts }). No per-file bookkeeping, no reset heuristics:
// rotated generations keep their identity in the events themselves.
function loadSyncState(dir) {
  try {
    const s = JSON.parse(readFileSync(join(dir, SYNC_STATE_FILE), "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch {
    return null; // absent or corrupt: treat as fresh
  }
}

function saveSyncState(dir, state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SYNC_STATE_FILE), JSON.stringify(state, null, 2) + "\n", "utf8");
}

// Events that predate gen-stamping sort before everything.
const pairOf = (e) => [
  Number.isInteger(e.gen) && e.gen >= 0 ? e.gen : -1,
  Number.isInteger(e.seq) && e.seq >= 0 ? e.seq : 0,
];
const pairGt = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
const maxPair = (events) => {
  let m = [0, 0];
  for (const e of events) {
    const p = pairOf(e);
    if (pairGt(p, m)) m = p;
  }
  return m;
};

/** Split the log into fresh (never synced) events and the next watermark. */
function planSyncWindow(gens, prev) {
  const all = [];
  for (const { events } of gens) all.push(...events);
  const nextWatermark = maxPair(all);
  const v2 = prev?.version === SYNC_STATE_VERSION && Array.isArray(prev.watermark);
  const v1ts = !v2 && typeof prev?.synced_through_ts === "string" ? prev.synced_through_ts : null;
  let fresh;
  if (v2) {
    fresh = all.filter((e) => pairGt(pairOf(e), prev.watermark));
  } else if (v1ts) {
    // v1 -> v2 migration (single transition): the old ts watermark already
    // covered everything <= v1ts; only newer events are fresh.
    fresh = all.filter((e) => typeof e.ts === "string" && e.ts > v1ts);
  } else {
    fresh = all;
  }
  return { fresh, nextWatermark };
}

// A content digest of the built payload, used to recognize an identical
// rebuild so a retry after an unknown outcome can reuse the same nonce.
const digestPayload = (aggregates, windowStart, windowEnd) =>
  createHash("sha256")
    .update(JSON.stringify({ aggregates, window_start: windowStart, window_end: windowEnd }))
    .digest("hex");

/**
 * Persist the in-flight attempt's nonce BEFORE sending. If the outcome is
 * unknown (crash, dropped response), the next identical build reuses the same
 * nonce and the server's replay rejection turns the retry into a no-op
 * instead of a double count. Called by runSyncCommand after the user confirms.
 */
export function persistPendingNonce({ env = process.env, payload, digest }) {
  const dir = homeDir(env);
  const prev = loadSyncState(dir) ?? {};
  saveSyncState(dir, {
    ...prev,
    version: SYNC_STATE_VERSION,
    pending: { nonce: payload.nonce, window_end: payload.window_end, digest },
  });
}

/** A server "nonce replay" rejection means the payload is already admitted. */
export function isNonceReplayError(e) {
  return e?.code === "NONCE_REPLAY" || /nonce replay/i.test(e?.message ?? "");
}

/**
 * Build the sync payload from local Stage 0 events.
 *
 * Returns one of:
 * - { status: "disabled" }            telemetry is off (any leg of the kill triple)
 * - { status: "notice-pending" }      T1: the first-run notice hasn't been shown yet
 * - { status: "empty", stats }        nothing new since the last sync
 * - { status: "ready", payload, stats, digest, nextWatermark }
 *
 * The payload contains ONLY per-skill counters. install_id, project_hash,
 * per-event timestamps and every other field are dropped by construction —
 * this function never copies them.
 *
 * nextWatermark is computed but NOT persisted here: runSyncCommand persists
 * it via recordSync() only after the server confirms (or reports a nonce
 * replay, which means the payload is already admitted). A failed send leaves
 * the watermark untouched so the retry resends the same window.
 */
export function buildSyncPayload({ env = process.env, now = () => new Date().toISOString() } = {}) {
  const dir = homeDir(env);
  if (!canTrack(env)) {
    return noticeNeeded(env)
      ? { status: "notice-pending" }
      : { status: "disabled" };
  }
  const store = createEventStore({ dir });
  const prev = loadSyncState(dir);
  const { fresh: events, nextWatermark } = planSyncWindow(store.readDetailed(), prev);
  if (!events.length) {
    return { status: "empty", stats: { events: 0, skills: 0 } };
  }
  const agg = {};
  let minTs = null, maxTs = null;
  for (const e of events) {
    foldEvent(agg, e);
    if (typeof e.ts === "string") {
      if (!minTs || e.ts < minTs) minTs = e.ts;
      if (!maxTs || e.ts > maxTs) maxTs = e.ts;
    }
  }
  // Materialize session sets into counts, then drop them (sets never serialize).
  const aggregates = {};
  for (const id of Object.keys(agg).sort()) {
    const a = agg[id];
    a.invoked_sessions = a._sessions ? a._sessions.size : 0;
    delete a._sessions;
    if (Object.values(a).some((v) => v > 0)) aggregates[id] = a;
  }
  const digest = digestPayload(aggregates, minTs, maxTs);
  // Same-nonce retry: if the previous attempt never got a confirmed outcome
  // and the rebuild is byte-identical, keep its nonce so the server dedupes.
  const pending = prev?.pending;
  const nonce = pending && pending.window_end === maxTs && pending.digest === digest && typeof pending.nonce === "string"
    ? pending.nonce
    : randomUUID(); // replay dedupe only; unlinkable across distinct syncs
  const payload = {
    schema: SYNC_SCHEMA,
    window_start: minTs,
    window_end: maxTs,
    nonce,
    aggregates,
  };
  // Belt and braces: the privacy scan runs over the payload too. If this ever
  // trips, the aggregate builder grew a field it shouldn't have.
  const findings = scanEvent(payload);
  if (findings.length) {
    throw new Error(`sync payload failed the privacy scan (aggregates only): ${findings.map((f) => f.pattern).join(", ")}`);
  }
  return {
    status: "ready",
    payload,
    digest,
    nextWatermark, // [gen, seq]; persisted by recordSync() only on confirmation
    stats: {
      events: events.length,
      skills: Object.keys(aggregates).length,
      window_start: minTs,
      window_end: maxTs,
    },
  };
}

/** Human-readable rendering of the exact payload about to leave the machine. */
export function summarizePayload(payload, stats) {
  const lines = [
    `Anonymous aggregate summary (${stats.events} local events folded into per-skill counts):`,
    `window ${payload.window_start} .. ${payload.window_end}`,
    "",
  ];
  const header = ["skill", ...COUNTERS.filter((c) => Object.values(payload.aggregates).some((a) => a[c] > 0))];
  lines.push(header.join(" | "));
  for (const [id, a] of Object.entries(payload.aggregates)) {
    lines.push([id, ...header.slice(1).map((c) => String(a[c]))].join(" | "));
  }
  lines.push("", "No raw events, install ids, project hashes, timestamps-per-event, prompts, or code are included.");
  return lines.join("\n");
}

/**
 * Interactive gate. Returns true only on an explicit yes typed by the user
 * on a TTY. Non-interactive stdin refuses — there is no --yes for sync.
 */
export async function confirmSend({ isTTY, readAnswer, endpoint }) {
  if (!isTTY) {
    return { ok: false, reason: "Refusing: `repotify sync` needs an interactive terminal so you can review what is sent. Nothing was sent." };
  }
  const answer = (await readAnswer(`Send this anonymous summary to ${endpoint}? [y/N] `)).trim();
  if (/^y(es)?$/i.test(answer)) return { ok: true };
  return { ok: false, reason: "Cancelled. Nothing was sent." };
}

/**
 * POST the payload; validate the server's answer. The server must return the
 * fleet policy (public proof) and leaderboard status.
 */
export async function sendSync({ payload, endpoint, fetchImpl = fetch }) {
  const url = `${endpoint.replace(/\/$/, "")}/v1/sync`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (cause) {
    throw new Error(`sync failed: could not reach ${endpoint} (${cause?.message ?? cause})`);
  }
  if (!res.ok) throw new Error(`sync failed: server answered ${res.status}`);
  const body = await res.json();
  const policy = body?.fleet_policy;
  if (!policy || policy.schema !== FLEET_POLICY_SCHEMA || typeof policy.skills !== "object") {
    throw new Error("sync failed: server did not return a valid fleet policy");
  }
  return { policy, leaderboard: body.leaderboard ?? null };
}

/**
 * Persist the fleet policy the server returned.
 *
 * Validates the envelope AND every skill row's value ranges. The policy is
 * the return channel of the sync: a compromised or buggy endpoint must not
 * be able to push effectiveness=999 and wreck local rankings, so anything
 * out of range rejects the whole document. (Critic's attack surface, closed.)
 */
export function applyFleetPolicy({ env = process.env, policy }) {
  if (!policy || policy.schema !== FLEET_POLICY_SCHEMA || typeof policy.skills !== "object") {
    throw new Error("refusing to save an invalid fleet policy");
  }
  for (const [id, row] of Object.entries(policy.skills)) {
    const bad =
      !row || typeof row !== "object" ||
      typeof row.effectiveness !== "number" || !Number.isFinite(row.effectiveness) ||
      row.effectiveness < 0 || row.effectiveness > 1 ||
      (row.n !== undefined && (!Number.isInteger(row.n) || row.n < 0)) ||
      (row.ci_lo !== undefined && (typeof row.ci_lo !== "number" || !Number.isFinite(row.ci_lo) || row.ci_lo < 0 || row.ci_lo > 1)) ||
      (row.ci_hi !== undefined && (typeof row.ci_hi !== "number" || !Number.isFinite(row.ci_hi) || row.ci_hi < 0 || row.ci_hi > 1)) ||
      (row.ci_lo !== undefined && row.ci_hi !== undefined && row.ci_lo > row.ci_hi);
    if (bad) throw new Error(`refusing to save a fleet policy with an out-of-range row for skill ${id}`);
  }
  const dir = homeDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FLEET_POLICY_FILE);
  writeFileSync(path, JSON.stringify(policy, null, 2) + "\n", "utf8");
  return path;
}

/**
 * Advance the watermark after a confirmed send, and clear the pending nonce.
 * Only ever called on server confirmation (or a nonce-replay answer, which
 * means the payload is already admitted) — never on failure.
 */
export function recordSync({ env = process.env, watermark }) {
  const dir = homeDir(env);
  saveSyncState(dir, {
    version: SYNC_STATE_VERSION,
    watermark, // [gen, seq]: everything at or below this pair is synced
    synced_at: new Date().toISOString(),
    pending: null,
  });
}

/**
 * Full `repotify sync` flow for the CLI. io: { env, stdin, stdout, stderr }.
 * transport (tests): async ({ payload, endpoint }) => ({ policy, leaderboard }).
 * readAnswer (tests): async (prompt) => answer — bypasses the readline TTY
 *   prompt; the production path always prompts on a real TTY.
 * Returns a process exit code.
 */
export async function runSyncCommand(io, { endpoint = null, transport = null, now, readAnswer = null } = {}) {
  const env = io.env ?? {};
  const out = (t) => io.stdout.write(t.endsWith("\n") ? t : t + "\n");
  const err = (t) => io.stderr.write(t.endsWith("\n") ? t : t + "\n");

  const built = buildSyncPayload({ env, ...(now ? { now } : {}) });
  if (built.status === "disabled") {
    err("Telemetry is off — there is nothing to sync. Turn it on first: `repotify telemetry on`.");
    return 2;
  }
  if (built.status === "notice-pending") {
    err("The first-run telemetry notice hasn't been shown yet, so nothing has been recorded. Run any repotify command once, then sync.");
    return 2;
  }
  if (built.status === "empty") {
    out("Nothing new to sync — local events are already shared.");
    return 0;
  }

  const target = endpoint ?? env.REPOTIFY_TELEMETRY_URL ?? null;
  if (!target) {
    err("No fleet endpoint configured. Set REPOTIFY_TELEMETRY_URL to sync against a fleet server. Nothing was sent.");
    return 2;
  }

  out(summarizePayload(built.payload, built.stats));
  out("");
  // TTY gate first: never prompt where no human is reading. (This is a UX
  // consent control, not a security boundary: a pty can fake isTTY. The
  // threat model is "the tool must not silently exfiltrate", not "malware on
  // the machine must be stopped" — the latter is out of scope client-side.)
  let answer;
  if (readAnswer) {
    answer = await readAnswer(`Send this anonymous summary to ${target}? [y/N] `);
  } else {
    if (!io.stdin?.isTTY) {
      err("Refusing: `repotify sync` needs an interactive terminal so you can review what is sent. Nothing was sent.");
      return 2;
    }
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: io.stdin, output: io.stdout });
    try {
      answer = await rl.question(`Send this anonymous summary to ${target}? [y/N] `);
    } finally {
      rl.close();
    }
  }
  const confirmed = await confirmSend({
    isTTY: true,
    readAnswer: async () => answer,
    endpoint: target,
  });
  if (!confirmed.ok) {
    err(confirmed.reason);
    return 1;
  }

  // Claim the nonce BEFORE sending: if the outcome is unknown (crash, lost
  // response), the retry reuses it and the server dedupes instead of double
  // counting. The watermark still only advances on confirmation below.
  persistPendingNonce({ env, payload: built.payload, digest: built.digest });

  let result;
  try {
    result = transport
      ? await transport({ payload: built.payload, endpoint: target })
      : await sendSync({ payload: built.payload, endpoint: target, fetchImpl: io.fetchImpl ?? fetch });
  } catch (e) {
    if (isNonceReplayError(e)) {
      // The server already admitted this exact payload (the first attempt's
      // response was lost). Treat as success: advance the watermark so the
      // retry does not double count. (Critic's crash-race, closed.)
      recordSync({ env, watermark: built.nextWatermark });
      out("Server already received this summary (nonce replay) — marked as synced, nothing double-counted.");
      return 0;
    }
    err(`Sync failed: ${e.message}. Nothing was recorded as sent; try again later.`);
    return 1;
  }
  const policyPath = applyFleetPolicy({ env, policy: result.policy });
  recordSync({ env, watermark: built.nextWatermark });
  const n = Object.keys(result.policy.skills).length;
  out(`Synced ${built.stats.events} events (${built.stats.skills} skills). Fleet policy updated: ${n} skills with measured effectiveness → ${policyPath}.`);
  if (result.leaderboard && typeof result.leaderboard.installs === "number") {
    out(`Fleet leaderboard: ${result.leaderboard.enabled ? "LIVE" : `behind the flag (${result.leaderboard.installs}/${result.leaderboard.threshold} installs)`}.`);
  }
  return 0;
}
