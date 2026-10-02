// `repotify sync` + server reference: unit tests.
//
// Covers 9.2 (aggregate-only payload, consent gates, interactive confirm,
// watermark, send/apply) and 9.3 (D1 rules: schema allowlist, quarantine,
// min group size, PII rejection; nightly policy; 8b leaderboard gate).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SYNC_SCHEMA, SYNC_STATE_VERSION, buildSyncPayload, summarizePayload, confirmSend, sendSync,
  applyFleetPolicy, recordSync, runSyncCommand, persistPendingNonce, isNonceReplayError,
  FLEET_POLICY_SCHEMA,
} from "../lib/telemetry/sync.mjs";
import { createTracker } from "../lib/telemetry/store.mjs";
import { scanEvent } from "../lib/telemetry/privacy.mjs";
import { writeConfig } from "../src/config.mjs";
import { createAggregator } from "../lib/telemetry/server/aggregate.mjs";
import { computeFleetPolicy, wilsonInterval } from "../lib/telemetry/server/policy.mjs";
import { computeLeaderboardStatus } from "../lib/telemetry/server/leaderboard.mjs";
import { distribute } from "../lib/telemetry/server/distribute.mjs";
import { loadFleetPolicy, blendScore, scoreWithFleet, FLEET_BLEND } from "../lib/telemetry/fleet-policy.mjs";
import {
  FLEET_INSTALL_THRESHOLD, FLEET_MIN_GROUP_INSTALLS, FLEET_QUARANTINE_HOURS,
} from "../lib/telemetry/server/thresholds.mjs";

// Test temp dirs: track every mkdtempSync dir and remove them all in after(),
// or a day of test runs fills /tmp (512M tmpfs) and later runs fail with ENOSPC.
const tempDirs = [];
const mkTemp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
};
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const dir = () => mkTemp("rp-sync-");
const envFor = (d, extra = {}) => ({ REPOTIFY_HOME: d, ...extra });
const enableTelemetry = (d) => writeConfig(envFor(d), { telemetry: true, telemetryNoticeShown: true });

function seedEvents(d, n = 3) {
  enableTelemetry(d);
  const t = createTracker({ env: envFor(d), dir: d, now: () => "2026-05-10T12:00:00.000Z" });
  for (let i = 0; i < n; i++) {
    const ep = randomUUID();
    const sid = `alpha-0${i + 1}`;
    assert.equal(t.track({
      type: "recommendation", episode_id: ep,
      candidates: [{ skill_id: sid, position: 0, propensity: 0.5, shown: true }],
    }), true);
    assert.equal(t.track({ type: "install", skill_id: sid, episode_id: ep, from_recommendation: true }), true);
    assert.equal(t.track({ type: "invoke", skill_id: sid, invocation_kind: "explicit", session_id: `s${i}` }), true);
    assert.equal(t.track({ type: "outcome", skill_id: sid, task_success: i !== 2 }), true);
    if (i !== 2) t.track({ type: "kept_30d", skill_id: sid });
    else t.track({ type: "removed_fast", skill_id: sid, removal_reason: "unused" });
  }
  return d;
}

const payloadFor = (skill = "alpha-01") => ({
  schema: SYNC_SCHEMA,
  window_start: "2026-05-01T00:00:00.000Z",
  window_end: "2026-05-02T00:00:00.000Z",
  nonce: randomUUID(),
  aggregates: { [skill]: { shown: 4, installed: 4, kept_30d: 3, removed_fast: 1 } },
});

// ---------- 9.2: buildSyncPayload ----------

test("sync is gated by the kill triple (disabled) and the T1 notice", () => {
  for (const extra of [{ DO_NOT_TRACK: "1" }, { REPOTIFY_TELEMETRY: "0" }]) {
    assert.equal(buildSyncPayload({ env: envFor(dir(), extra) }).status, "disabled");
  }
  // Telemetry on but notice never shown -> T1: nothing recorded, nothing to sync.
  const d = dir();
  writeConfig(envFor(d), { telemetry: true });
  const t = createTracker({ env: envFor(d), dir: d });
  assert.equal(t.track({ type: "install", skill_id: "alpha-01" }), false, "T1: no data before notice");
  assert.equal(buildSyncPayload({ env: envFor(d) }).status, "notice-pending");
});

test("payload is aggregates-only: no raw events, ids, hashes, or per-event timestamps", () => {
  const d = seedEvents(dir());
  const built = buildSyncPayload({ env: envFor(d) });
  assert.equal(built.status, "ready");
  const { payload, stats } = built;
  assert.equal(payload.schema, SYNC_SCHEMA);
  assert.deepEqual(Object.keys(payload).sort(), ["aggregates", "nonce", "schema", "window_end", "window_start"]);
  assert.equal(stats.events, 15, "3 installs x 5 events");
  assert.equal(stats.skills, 3);
  const a1 = payload.aggregates["alpha-01"];
  assert.deepEqual(a1, {
    shown: 1, installed: 1, selected: 0, invoked: 1, invoked_sessions: 1,
    outcome_success: 1, outcome_failure: 0, kept_30d: 1, removed_fast: 0, removed: 0,
    replaced: 0, abandoned: 0, fallback: 0, questions_asked: 0, questions_answered: 0,
  });
  // Removal buckets are mutually exclusive: a fast removal counts once.
  assert.equal(payload.aggregates["alpha-03"].removed_fast, 1);
  assert.equal(payload.aggregates["alpha-03"].removed, 0);
  const serialized = JSON.stringify(payload);
  assert.ok(!/install_id|project_hash|episode_id|session_id/.test(serialized), "no identifiers leak");
  assert.equal(scanEvent(payload).length, 0, "privacy scan clean");
});

test("usage events (tokens/latency) never leave the machine", () => {
  const d = dir();
  enableTelemetry(d);
  const t = createTracker({ env: envFor(d), dir: d, now: () => "2026-05-10T12:00:00.000Z" });
  t.track({ type: "usage", skill_id: "alpha-01", tokens_in: 5000, tokens_out: 2000, latency_ms: 900 });
  const built = buildSyncPayload({ env: envFor(d) });
  assert.equal(built.status, "ready");
  assert.deepEqual(built.payload.aggregates, {}, "usage folds into nothing");
});

test("watermark: each event's contribution is sent at most once", () => {
  const d = seedEvents(dir());
  const env = envFor(d);
  const first = buildSyncPayload({ env });
  assert.equal(first.status, "ready");
  recordSync({ env, watermark: first.nextWatermark });
  const second = buildSyncPayload({ env });
  assert.equal(second.status, "empty", "nothing new -> nothing to send");
  assert.ok(existsSync(join(d, "sync-state.json")));
  const state = JSON.parse(readFileSync(join(d, "sync-state.json"), "utf8"));
  assert.equal(state.version, 2, "pair watermark");
  assert.ok(Array.isArray(state.watermark) && state.watermark[1] >= 15, "consumed (gen, seq) recorded");
});

test("watermark survives rotation: per-file seq, no loss, no double-send", () => {
  const d = dir();
  enableTelemetry(d);
  // Tiny maxBytes forces a rotation mid-stream.
  const t = createTracker({ env: envFor(d), dir: d, maxBytes: 300, now: () => "2026-05-10T12:00:00.000Z" });
  for (let i = 0; i < 12; i++) assert.equal(t.track({ type: "install", skill_id: "alpha-01" }), true);
  assert.ok(existsSync(join(d, "stage0.jsonl.1")), "rotation happened");
  const first = buildSyncPayload({ env: envFor(d) });
  assert.equal(first.status, "ready");
  assert.equal(first.stats.events, 12, "both generations folded, nothing lost");
  assert.equal(first.payload.aggregates["alpha-01"].installed, 12);
  recordSync({ env: envFor(d), watermark: first.nextWatermark });
  const second = buildSyncPayload({ env: envFor(d) });
  assert.equal(second.status, "empty", "rotation-aware watermark: nothing resent");
  // New events after a rotation are still picked up exactly once.
  const t2 = createTracker({ env: envFor(d), dir: d, maxBytes: 300, now: () => "2026-05-11T12:00:00.000Z" });
  t2.track({ type: "install", skill_id: "alpha-02" });
  const third = buildSyncPayload({ env: envFor(d) });
  assert.equal(third.status, "ready");
  assert.deepEqual(Object.keys(third.payload.aggregates), ["alpha-02"]);
});

test("watermark migrates v1 ts state without resend or loss", () => {
  const d = seedEvents(dir());
  const env = envFor(d);
  // Simulate a v1 client: ts watermark at the first window's end.
  const v1 = buildSyncPayload({ env });
  assert.equal(v1.status, "ready");
  writeFileSync(join(d, "sync-state.json"), JSON.stringify({ synced_through_ts: v1.payload.window_end }) + "\n");
  // One more event after the v1 sync, then migrate to v2.
  const t = createTracker({ env, dir: d, now: () => "2026-05-12T12:00:00.000Z" });
  t.track({ type: "install", skill_id: "alpha-09" });
  const migrated = buildSyncPayload({ env });
  assert.equal(migrated.status, "ready");
  assert.deepEqual(Object.keys(migrated.payload.aggregates), ["alpha-09"], "only post-v1 events sync, nothing resent");
  recordSync({ env, watermark: migrated.nextWatermark });
  assert.equal(buildSyncPayload({ env }).status, "empty");
});

test("summarizePayload shows the exact counters the user is asked to approve", () => {
  const d = seedEvents(dir());
  const { payload, stats } = buildSyncPayload({ env: envFor(d) });
  const text = summarizePayload(payload, stats);
  assert.match(text, /alpha-01/);
  assert.match(text, /15 local events/);
  assert.match(text, /No raw events/);
});

test("pending nonce: identical rebuild reuses the nonce; changed payload gets a fresh one", () => {
  const d = seedEvents(dir());
  const env = envFor(d);
  const b1 = buildSyncPayload({ env });
  assert.equal(b1.status, "ready");
  persistPendingNonce({ env, payload: b1.payload, digest: b1.digest });
  const b2 = buildSyncPayload({ env });
  assert.equal(b2.payload.nonce, b1.payload.nonce, "same window, same bytes -> same nonce (retry dedupes)");
  const t = createTracker({ env, dir: d, now: () => "2026-05-11T12:00:00.000Z" });
  t.track({ type: "install", skill_id: "alpha-04" });
  const b3 = buildSyncPayload({ env });
  assert.notEqual(b3.payload.nonce, b1.payload.nonce, "new events -> new attempt, new nonce");
});

test("isNonceReplayError recognizes replay rejections", () => {
  const e = new Error("nonce replay: already ingested");
  e.code = "NONCE_REPLAY";
  assert.equal(isNonceReplayError(e), true);
  assert.equal(isNonceReplayError(new Error("nonce replay detected")), true);
  assert.equal(isNonceReplayError(new Error("boom")), false);
  assert.equal(isNonceReplayError(null), false);
});

test("runSyncCommand: nonce replay is treated as already-synced (no double count)", async () => {
  const d = seedEvents(dir());
  const env = envFor(d, { REPOTIFY_TELEMETRY_URL: "https://fleet.example" });
  const writes = [];
  const io = {
    env,
    stdin: {},
    stdout: { write: (t) => writes.push(t) },
    stderr: { write: () => {} },
  };
  const replayTransport = async () => {
    const e = new Error("nonce replay: payload already admitted");
    e.code = "NONCE_REPLAY";
    throw e;
  };
  const code = await runSyncCommand(io, { transport: replayTransport, readAnswer: async () => "y" });
  assert.equal(code, 0);
  assert.match(writes.join(""), /already received/i);
  assert.equal(buildSyncPayload({ env }).status, "empty", "watermark advanced: the retry sends nothing new");
});

test("runSyncCommand: happy path persists the policy and advances the watermark", async () => {
  const d = seedEvents(dir());
  const env = envFor(d, { REPOTIFY_TELEMETRY_URL: "https://fleet.example" });
  const writes = [];
  const io = {
    env,
    stdin: {},
    stdout: { write: (t) => writes.push(t) },
    stderr: { write: () => {} },
  };
  const policy = {
    schema: FLEET_POLICY_SCHEMA, version: "fleet/1",
    skills: { "alpha-01": { effectiveness: 0.8, n: 10, ci_lo: 0.6, ci_hi: 0.95 } },
  };
  const code = await runSyncCommand(io, {
    transport: async () => ({ policy, leaderboard: { enabled: false, installs: 48, threshold: 200 } }),
    readAnswer: async () => "y",
  });
  assert.equal(code, 0);
  assert.ok(existsSync(join(d, "fleet-policy.json")), "policy saved");
  assert.equal(buildSyncPayload({ env }).status, "empty", "watermark advanced after success");
  assert.match(writes.join(""), /Fleet policy updated/);
});

test("runSyncCommand: no endpoint configured -> exit 2, nothing sent", async () => {
  const d = seedEvents(dir());
  const env = envFor(d); // no REPOTIFY_TELEMETRY_URL
  const errs = [];
  const io = {
    env,
    stdin: {},
    stdout: { write: () => {} },
    stderr: { write: (t) => errs.push(t) },
  };
  let transportCalled = false;
  const code = await runSyncCommand(io, {
    transport: async () => { transportCalled = true; return {}; },
    readAnswer: async () => "y",
  });
  assert.equal(code, 2);
  assert.equal(transportCalled, false, "nothing leaves the machine");
  assert.match(errs.join(""), /No fleet endpoint configured/);
});

// ---------- 9.2: interactive gate ----------

test("confirmSend: non-TTY refuses, 'n' cancels, 'y' sends", async () => {
  const noTty = await confirmSend({ isTTY: false, readAnswer: async () => "y", endpoint: "https://x" });
  assert.equal(noTty.ok, false);
  assert.match(noTty.reason, /interactive terminal/);
  const no = await confirmSend({ isTTY: true, readAnswer: async () => "n", endpoint: "https://x" });
  assert.equal(no.ok, false);
  assert.match(no.reason, /Cancelled/);
  for (const yes of ["y", "Y", "yes", "YES "]) {
    const ok = await confirmSend({ isTTY: true, readAnswer: async () => yes, endpoint: "https://x" });
    assert.equal(ok.ok, true, JSON.stringify(yes));
  }
});

test("sendSync validates the server answer; applyFleetPolicy validates the envelope", async () => {
  const policy = { schema: FLEET_POLICY_SCHEMA, version: "fleet/1", skills: { "alpha-01": { effectiveness: 0.8, n: 10 } } };
  const okFetch = async () => ({ ok: true, json: async () => ({ fleet_policy: policy, leaderboard: { enabled: false } }) });
  const res = await sendSync({ payload: payloadFor(), endpoint: "https://fleet.example", fetchImpl: okFetch });
  assert.equal(res.policy.skills["alpha-01"].effectiveness, 0.8);

  const badFetch = async () => ({ ok: true, json: async () => ({ fleet_policy: { nope: true } }) });
  await assert.rejects(() => sendSync({ payload: payloadFor(), endpoint: "https://fleet.example", fetchImpl: badFetch }), /valid fleet policy/);
  const errFetch = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => sendSync({ payload: payloadFor(), endpoint: "https://fleet.example", fetchImpl: errFetch }), /500/);
  const downFetch = async () => { throw new Error("boom"); };
  await assert.rejects(() => sendSync({ payload: payloadFor(), endpoint: "https://fleet.example", fetchImpl: downFetch }), /could not reach/);

  const d = dir();
  const path = applyFleetPolicy({ env: envFor(d), policy });
  assert.ok(existsSync(path));
  assert.throws(() => applyFleetPolicy({ env: envFor(d), policy: { bad: 1 } }), /invalid fleet policy/);
});

test("applyFleetPolicy rejects out-of-range rows (compromised endpoint cannot wreck rankings)", () => {
  const d = dir();
  const env = envFor(d);
  const bad = (skills) => ({ schema: FLEET_POLICY_SCHEMA, version: "fleet/1", skills });
  assert.throws(() => applyFleetPolicy({ env, policy: bad({ a: { effectiveness: 999, n: 10 } }) }), /out-of-range/);
  assert.throws(() => applyFleetPolicy({ env, policy: bad({ a: { effectiveness: NaN, n: 10 } }) }), /out-of-range/);
  assert.throws(() => applyFleetPolicy({ env, policy: bad({ a: { effectiveness: -0.1, n: 10 } }) }), /out-of-range/);
  assert.throws(() => applyFleetPolicy({ env, policy: bad({ a: { effectiveness: 0.5, n: -1 } }) }), /out-of-range/);
  assert.throws(() => applyFleetPolicy({ env, policy: bad({ a: { effectiveness: 0.5, n: 1.5 } }) }), /out-of-range/);
  assert.throws(
    () => applyFleetPolicy({ env, policy: bad({ a: { effectiveness: 0.5, n: 5, ci_lo: 0.9, ci_hi: 0.1 } }) }),
    /out-of-range/,
  );
  // Boundary values and missing optional fields are fine.
  const p = applyFleetPolicy({
    env,
    policy: bad({
      a: { effectiveness: 0, n: 0 },
      b: { effectiveness: 1, n: 10, ci_lo: 0, ci_hi: 1 },
    }),
  });
  assert.ok(existsSync(p));
});

// ---------- 9.3: server intake rules ----------

test("server rejects hostile payloads: schema, fields, counters, future windows, replay", () => {
  const agg = createAggregator({ now: () => new Date("2026-06-01T00:00:00Z") });
  const bad = (mut) => { const p = payloadFor(); mut(p); return p; };
  assert.throws(() => agg.ingest(bad((p) => { p.schema = "telemetry-sync/v9"; })), /schema must be/);
  assert.throws(() => agg.ingest(bad((p) => { p.install_id = "x"; })), /unknown top-level field/);
  assert.throws(() => agg.ingest(bad((p) => { p.aggregates["alpha-01"].reward = 5; })), /unknown counter/);
  assert.throws(() => agg.ingest(bad((p) => { p.aggregates["alpha-01"].shown = -1; })), /non-negative integer/);
  assert.throws(() => agg.ingest(bad((p) => { p.aggregates["Bad Skill!"] = { shown: 1 }; })), /invalid skill id/);
  assert.throws(() => agg.ingest(bad((p) => { p.window_end = "2027-01-01T00:00:00Z"; })), /in the future/);
  assert.throws(() => agg.ingest(bad((p) => { p.nonce = "not-a-uuid"; })), /nonce must be a uuid/);
  const p = payloadFor();
  agg.ingest(p);
  assert.throws(() => agg.ingest(p), /nonce replay/);
  // PII-shaped smuggling inside an otherwise valid field name position is rejected.
  assert.throws(
    () => agg.ingest(bad((q) => { q.aggregates["alpha-01"] = { shown: 1, note: "x" }; })),
    /unknown counter/,
  );
});

test("server: quarantine delays admission by 24h; admit() folds and drops per-sync rows", () => {
  const clock = { t: Date.parse("2026-06-01T00:00:00Z") };
  const agg = createAggregator({ now: () => new Date(clock.t) });
  agg.ingest(payloadFor("alpha-01"));
  assert.equal(agg.admit().admitted, 0, "fresh payload stays quarantined");
  assert.equal(agg.quarantineDepth(), 1);
  clock.t += (FLEET_QUARANTINE_HOURS + 1) * 3600 * 1000;
  const r = agg.admit();
  assert.equal(r.admitted, 1);
  assert.equal(agg.quarantineDepth(), 0, "admitted payloads are dropped, not retained");
  assert.equal(agg.admittedCount(), 1);
  const snap = agg.snapshot();
  assert.equal(snap.admitted_syncs, 1);
  assert.deepEqual(snap.suppressed, ["alpha-01"], "below min group size -> suppressed");
  assert.deepEqual(snap.skills, {});
});

test("server: min group size publishes only buckets with >= 5 contributing syncs", () => {
  const clock = { t: Date.parse("2026-06-01T00:00:00Z") };
  const agg = createAggregator({ now: () => new Date(clock.t), minGroupInstalls: FLEET_MIN_GROUP_INSTALLS });
  for (let i = 0; i < 4; i++) agg.ingest(payloadFor("alpha-01"));
  agg.ingest(payloadFor("alpha-02"));
  clock.t += 25 * 3600 * 1000;
  agg.admit();
  let snap = agg.snapshot();
  assert.deepEqual(Object.keys(snap.skills), [], "4 syncs < 5: nothing published");
  assert.deepEqual(snap.suppressed.sort(), ["alpha-01", "alpha-02"]);
  const agg2 = createAggregator({ now: () => new Date(clock.t), minGroupInstalls: FLEET_MIN_GROUP_INSTALLS });
  for (let i = 0; i < 5; i++) agg2.ingest(payloadFor("alpha-01"));
  clock.t += 25 * 3600 * 1000;
  agg2.admit();
  snap = agg2.snapshot();
  assert.deepEqual(Object.keys(snap.skills), ["alpha-01"]);
  assert.equal(snap.skills["alpha-01"].contributing_syncs, 5);
  assert.equal(snap.skills["alpha-01"].counters.shown, 20, "sums fold across syncs");
});

// ---------- 9.3: nightly policy ----------

test("computeFleetPolicy: empirical-Bayes effectiveness with a skeptical prior", () => {
  const snap = {
    admitted_syncs: 8, window_start: "2026-05-01T00:00:00Z", window_end: "2026-05-31T00:00:00Z",
    suppressed: [],
    skills: {
      // pos = 8 kept + 8 success = 16; neg = 2 fast-removed. eff = 18/22.
      "alpha-01": { counters: { kept_30d: 8, outcome_success: 8, removed_fast: 2 }, contributing_syncs: 8 },
      // no signal at all -> shrinks to the 0.5 prior.
      "alpha-02": { counters: {}, contributing_syncs: 6 },
    },
  };
  const policy = computeFleetPolicy(snap, { now: () => new Date("2026-06-01T00:00:00Z") });
  assert.equal(policy.schema, FLEET_POLICY_SCHEMA);
  assert.equal(policy.version, "fleet/1");
  assert.equal(policy.contributing_syncs, 8);
  assert.equal(policy.skills_published, 2);
  const good = policy.skills["alpha-01"];
  assert.ok(Math.abs(good.effectiveness - 18 / 22) < 1e-4, `got ${good.effectiveness}`);
  assert.equal(good.n, 18);
  assert.ok(good.ci_lo < good.effectiveness && good.effectiveness < good.ci_hi, "Wilson CI brackets the estimate");
  const thin = policy.skills["alpha-02"];
  assert.equal(thin.effectiveness, 0.5, "no evidence -> prior");
  assert.equal(thin.n, 0);
  // Proof, not recipe: no raw counter breakdowns in the published policy.
  assert.ok(!("counters" in good) && !("kept_30d" in good));
  assert.equal(JSON.parse(JSON.stringify(policy)).schema, FLEET_POLICY_SCHEMA, "JSON-serializable");
});

test("computeFleetPolicy: defense-in-depth re-checks the >=5 nonce gate (FAZ 10 policy-B)", () => {
  const snap = {
    admitted_syncs: 8, window_start: "2026-05-01T00:00:00Z", window_end: "2026-05-31T00:00:00Z",
    suppressed: ["thin-at-aggregate"],
    skills: {
      "alpha-01": { counters: { kept_30d: 8 }, contributing_syncs: 8 },
      // Slipped past the aggregate gate (hand-built / stale snapshot): the
      // policy must still refuse to publish it.
      "thin-sneaky": { counters: { kept_30d: 3 }, contributing_syncs: 3 },
    },
  };
  const policy = computeFleetPolicy(snap, { now: () => new Date("2026-06-01T00:00:00Z") });
  assert.ok(!("thin-sneaky" in policy.skills), "sub-threshold skill never enters the policy");
  assert.ok("alpha-01" in policy.skills, "at-threshold skill still published");
  assert.equal(policy.skills_published, 1);
  assert.equal(policy.skills_suppressed, 2, "aggregate-suppressed + policy re-suppressed");
});

test("wilsonInterval sanity", () => {
  assert.deepEqual(wilsonInterval(0, 0), { lo: 0, hi: 1 });
  const { lo, hi } = wilsonInterval(10, 10);
  assert.ok(lo > 0.7 && hi === 1, `got [${lo}, ${hi}]`);
  const mid = wilsonInterval(5, 10);
  assert.ok(mid.lo < 0.5 && mid.hi > 0.5);
});

// ---------- 9.3: 8b leaderboard gate + distribution ----------

test("leaderboard stays behind the flag until 200 installs (frozen constant)", () => {
  assert.equal(FLEET_INSTALL_THRESHOLD, 200, "DL-045 frozen");
  assert.equal(computeLeaderboardStatus({ admitted_syncs: 199 }).enabled, false);
  assert.deepEqual(computeLeaderboardStatus({ admitted_syncs: 199 }), { enabled: false, installs: 199, threshold: 200 });
  assert.equal(computeLeaderboardStatus({ admitted_syncs: 200 }).enabled, true);
});

test("distribute writes fleet-policy.json + leaderboard-status.json into the catalog bundle", () => {
  const outDir = join(dir(), "bundle");
  const policy = computeFleetPolicy(
    { admitted_syncs: 5, skills: { "alpha-01": { counters: { kept_30d: 5 }, contributing_syncs: 5 } }, suppressed: [] },
    { now: () => new Date("2026-06-01T00:00:00Z") },
  );
  const status = computeLeaderboardStatus({ admitted_syncs: 5 });
  const { policyPath, statusPath } = distribute({ policy, leaderboardStatus: status, outDir });
  assert.ok(existsSync(policyPath) && existsSync(statusPath));
  assert.equal(JSON.parse(readFileSync(policyPath, "utf8")).schema, FLEET_POLICY_SCHEMA);
  assert.equal(JSON.parse(readFileSync(statusPath, "utf8")).enabled, false);
  assert.throws(() => distribute({ policy, leaderboardStatus: status }), /outDir/);
});

// ---------- client-side fleet hook ----------

test("loadFleetPolicy returns null before the first sync; blend is bounded", () => {
  assert.equal(loadFleetPolicy({ env: envFor(dir()) }), null);
  const policy = { schema: FLEET_POLICY_SCHEMA, skills: { "alpha-01": { effectiveness: 1 }, "alpha-02": { effectiveness: 0 } } };
  assert.equal(blendScore(0.7, "alpha-01", policy), 0.7 + FLEET_BLEND * 0.5, "best skill: +blend/2");
  assert.equal(blendScore(0.7, "alpha-02", policy), 0.7 - FLEET_BLEND * 0.5, "worst skill: -blend/2");
  assert.equal(blendScore(0.99, "alpha-01", policy), 1, "clamped at 1");
  assert.equal(blendScore(0.01, "alpha-02", policy), 0, "clamped at 0");
  assert.equal(blendScore(0.7, "unknown-skill", policy), 0.7, "absent from policy -> untouched");
  assert.equal(blendScore(0.7, "alpha-01", null), 0.7, "no policy -> untouched");
  assert.ok(Math.abs(FLEET_BLEND * 0.5 - 0.1) < 1e-12, "fleet influence bounded to ±0.1");
});

test("scoreWithFleet re-ranks toward measured effectiveness, deterministically", () => {
  const policy = { schema: FLEET_POLICY_SCHEMA, skills: { "alpha-01": { effectiveness: 0.9 }, "alpha-02": { effectiveness: 0.1 } } };
  const slate = [
    { item: { id: "alpha-02" }, score: 0.8 },
    { item: { id: "alpha-01" }, score: 0.79 },
  ];
  const ranked = scoreWithFleet(slate, policy);
  assert.equal(ranked[0].item.id, "alpha-01", "fleet evidence overturns a thin baseline margin");
  assert.equal(ranked[0].fleetAdjusted, true);
  assert.equal(scoreWithFleet(slate, null), slate, "null policy -> input untouched");
  const again = scoreWithFleet(slate, policy);
  assert.deepEqual(ranked.map((r) => r.item.id), again.map((r) => r.item.id), "deterministic");
});

test("robustness: blend and min-group constants are not load-bearing magic", () => {
  // Blend 0.1..0.3 keeps the good>bad ordering and the ±blend/2 bound.
  const policy = {
    schema: FLEET_POLICY_SCHEMA,
    skills: { good: { effectiveness: 0.8 }, bad: { effectiveness: 0.2 } },
  };
  for (const blend of [0.1, FLEET_BLEND, 0.3]) {
    const g = blendScore(0.5, "good", policy, { blend });
    const b = blendScore(0.5, "bad", policy, { blend });
    assert.ok(g > b, `blend=${blend}: ordering preserved`);
    assert.ok(Math.abs(g - 0.5) <= blend * 0.5 + 1e-12, `blend=${blend}: good within bound`);
    assert.ok(Math.abs(b - 0.5) <= blend * 0.5 + 1e-12, `blend=${blend}: bad within bound`);
  }
  // Min group 3 vs 10: a 5-sync skill is published under 3, suppressed under 10.
  const snapFor = (minGroup) => {
    const clock = { t: Date.parse("2026-06-01T00:00:00Z") };
    const agg = createAggregator({ now: () => new Date(clock.t), minGroupInstalls: minGroup });
    for (let i = 0; i < 5; i++) agg.ingest(payloadFor("alpha-01"));
    clock.t += (FLEET_QUARANTINE_HOURS + 1) * 3600 * 1000;
    agg.admit();
    return agg.snapshot();
  };
  assert.deepEqual(Object.keys(snapFor(3).skills), ["alpha-01"], "min group 3: 5 syncs published");
  assert.deepEqual(Object.keys(snapFor(10).skills), [], "min group 10: 5 syncs suppressed");
  assert.deepEqual(snapFor(10).suppressed, ["alpha-01"]);
});
