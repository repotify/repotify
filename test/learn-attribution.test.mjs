// P4 hybrid attribution tests (odul-attribution-karar.md §4):
// observability matrix, masking, call-gated outcome credit, instrumentation,
// decay schedule, OPE policy gate, tripwires T1/T2/T3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LabelJoiner, OBSERVABILITY } from "../lib/telemetry/index.mjs";
import { validateEvent, INSTALL_SOURCES } from "../lib/telemetry/schema.mjs";
import {
  wrapInstalledSkill, readInstrumentManifest, unwrapInstalledSkill,
  resolveInstrumentedSkill, buildInstallEvent, buildInvokeEvent,
  INSTRUMENT_MANIFEST,
} from "../lib/telemetry/instrument.mjs";
import {
  invokedUnique, outcomeDelta, outcomeGated, maskedComponents,
  isInvokeObserved, compositeReward, compositeRewardDetailed, oneShotLabel,
} from "../lib/learn/reward.mjs";
import { LinUCB } from "../lib/learn/linucb.mjs";
import { createDecayScheduler, DECAY_GAMMA_DEFAULT } from "../lib/learn/decay.mjs";
import { gatePolicyChange } from "../lib/learn/policy-gate.mjs";
import { checkT1, checkT2, checkT3 } from "../lib/learn/tripwires.mjs";

const IID = "123e4567-e89b-42d3-a456-426614174000";
const EID = "223e4567-e89b-42d3-a456-426614174000";
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const DAY = 24 * 3600 * 1000;

const mk = (type, ts, extra = {}) => ({
  type, ts: new Date(ts).toISOString(), schema_version: 1, install_id: IID, ...extra,
});

function closeWith(source) {
  const j = new LabelJoiner({ now: () => new Date(T0 + 8 * DAY) });
  const extra = source === undefined ? {} : { install_source: source };
  j.ingest(mk("install", T0, { episode_id: EID, skill_id: "skill-a", ...extra }));
  const [row] = j.closeWindows();
  return row;
}

// ---- schema: install_source ----

test("schema: install_source validated on install/select", () => {
  assert.deepEqual(INSTALL_SOURCES, ["repotify", "third-party", "external"]);
  const bad = mk("install", T0, { skill_id: "sk", install_source: "nasa" });
  assert.ok(validateEvent(bad).length > 0, "unknown source rejected");
  const ok = mk("install", T0, { skill_id: "sk", install_source: "repotify" });
  assert.deepEqual(validateEvent(ok), []);
  const okSel = mk("select", T0, { skill_id: "sk", install_source: "external" });
  assert.deepEqual(validateEvent(okSel), []);
});

// ---- labels: observability matrix ----

test("labels: install_source pins observability + invoke_observed", () => {
  const full = closeWith("repotify");
  assert.equal(full.observability, OBSERVABILITY.FULL);
  assert.equal(full.signals.invoke_observed, true);

  const redacted = closeWith("third-party");
  assert.equal(redacted.observability, OBSERVABILITY.REDACTED);
  assert.equal(redacted.signals.invoke_observed, false);

  const weak = closeWith("external");
  assert.equal(weak.observability, OBSERVABILITY.WEAK);
  assert.equal(weak.signals.invoke_observed, false);

  const legacy = closeWith(undefined);
  assert.equal(legacy.observability, OBSERVABILITY.UNKNOWN);
  assert.equal(legacy.signals.invoke_observed, null);
});

test("labels: first install_source wins (no downgrade)", () => {
  const j = new LabelJoiner({ now: () => new Date(T0 + 8 * DAY) });
  j.ingest(mk("install", T0, { episode_id: EID, skill_id: "skill-a", install_source: "repotify" }));
  j.ingest(mk("install", T0 + 1000, { episode_id: EID, skill_id: "skill-a", install_source: "external" }));
  const [row] = j.closeWindows();
  assert.equal(row.observability, OBSERVABILITY.FULL);
});

// ---- reward: masking ----

const sig = (over = {}) => ({
  invoked_count: 1, invoked_sessions: 1, invoked_explicit: 1,
  invoked_implicit: 0, invoked_load: 0,
  outcome_count: 1, outcome_success: true, outcome_shared: true,
  outcome_quality: 4, outcome_skill_free_baseline: false,
  abandoned_count: 0, fallback_count: 0, questions_asked: 0, questions_answered: 0,
  kept_30d: false, removed_fast: false, removed: false,
  removal_reason: null, replaced_by: null,
  tokens_in_sum: 0, tokens_out_sum: 0, latency_ms_sum: 0, latency_ms_count: 0,
  invoke_observed: null,
  ...over,
});

test("reward: blind channel masks invoked_unique (null, never 0)", () => {
  assert.equal(invokedUnique(sig({ invoke_observed: false, invoked_sessions: 0 })), null);
  assert.deepEqual(maskedComponents(sig({ invoke_observed: false })), ["invoked_unique"]);
  assert.deepEqual(maskedComponents(sig({ invoke_observed: true })), []);
  assert.deepEqual(maskedComponents(sig()), []);
  assert.equal(isInvokeObserved(sig({ invoke_observed: true })), true);
  assert.equal(isInvokeObserved(sig({ invoke_observed: false })), false);
  assert.equal(isInvokeObserved(sig()), null);
});

test("reward: call-gated outcome credit", () => {
  // observed + never invoked + shared success → no outcome credit
  const gated = sig({ invoke_observed: true, invoked_sessions: 0, invoked_count: 0 });
  assert.equal(outcomeDelta(gated), 0);
  assert.equal(outcomeGated(gated), true);
  // observed + invoked → full credit (success vs failed baseline = 1)
  const earned = sig({ invoke_observed: true, invoked_sessions: 2 });
  assert.equal(outcomeDelta(earned), 1);
  assert.equal(outcomeGated(earned), false);
  // blind channel → shared outcome kept (flagged via invoke_observed=false)
  const blind = sig({ invoke_observed: false, invoked_sessions: 0, invoked_count: 0 });
  assert.equal(outcomeDelta(blind), 1, "shared outcome stays on blind arms");
  assert.equal(outcomeGated(blind), false);
  // legacy rows: old behavior preserved
  assert.equal(outcomeDelta(sig()), 1);
});

test("reward: composite + oneShotLabel carry the audit trail", () => {
  const gated = sig({ invoke_observed: true, invoked_sessions: 0, invoked_count: 0 });
  // 0 + 0.30*0 + 0 - 0 - 0 + 0.10 = 0.10
  assert.ok(Math.abs(compositeReward(gated) - 0.10) < 1e-12);
  const d = compositeRewardDetailed(gated);
  assert.equal(d.reward, compositeReward(gated));
  assert.deepEqual(d.masked, []);
  assert.equal(d.outcome_gated, true);
  assert.equal(d.invoke_observed, true);

  const blind = sig({ invoke_observed: false, invoked_sessions: 0, invoked_count: 0 });
  // masked w1 → 0 + 0.30*1 + 0.10 = 0.40
  assert.ok(Math.abs(compositeReward(blind) - 0.40) < 1e-12);
  const db = compositeRewardDetailed(blind);
  assert.deepEqual(db.masked, ["invoked_unique"]);

  const row = { label_id: "l1", episode_id: "e1", skill_id: "s1", window: "week1", signals: blind };
  const l = oneShotLabel(row);
  assert.deepEqual(l.masked_components, ["invoked_unique"]);
  assert.equal(l.outcome_gated, false);
  assert.equal(l.invoke_observed, false);
  assert.ok(Math.abs(l.reward - 0.40) < 1e-12);
});

test("reward: legacy golden vector unchanged (DL-048)", () => {
  // replica of learn-reward.test.mjs fullSignals(): no invoke_observed key at all
  const full = sig({ kept_30d: true });
  delete full.invoke_observed;
  // 0.35*1 + 0.30*1 + 0.20*1 + 0.10 = 0.95
  assert.ok(Math.abs(compositeReward(full) - 0.95) < 1e-12, `got ${compositeReward(full)}`);
});

// ---- instrumentation ----

test("instrument: wrap → read → resolve → unwrap round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "repotify-instrument-"));
  try {
    const w = wrapInstalledSkill({ dir: join(dir, "skill-x"), skillId: "skill-x", episodeId: EID });
    assert.equal(w.ok, true);
    assert.ok(existsSync(join(dir, "skill-x", INSTRUMENT_MANIFEST)));
    const m = readInstrumentManifest(join(dir, "skill-x"));
    assert.equal(m.skill_id, "skill-x");
    assert.equal(m.episode_id, EID);
    assert.equal(m.invoke_observable, true);
    assert.equal(resolveInstrumentedSkill(join(dir, "skill-x")), "skill-x");
    assert.equal(resolveInstrumentedSkill(join(dir, "nope")), null);
    assert.equal(unwrapInstalledSkill(join(dir, "skill-x")), true);
    assert.equal(readInstrumentManifest(join(dir, "skill-x")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("instrument: wrap never throws on bad input", () => {
  assert.equal(wrapInstalledSkill({}).ok, false);
  assert.equal(wrapInstalledSkill({ dir: "/nonexistent-xyz/deep", skillId: "" }).ok, false);
});

test("instrument: built events validate against the schema", () => {
  const inst = buildInstallEvent({ skillId: "skill-x", episodeId: EID, fromRecommendation: true });
  assert.equal(inst.type, "install");
  assert.equal(inst.install_source, "repotify");
  assert.deepEqual(validateEvent({ ...inst, ts: new Date().toISOString(), schema_version: 1, install_id: IID }), []);
  const inv = buildInvokeEvent({ skillId: "skill-x", episodeId: EID, invocationKind: "explicit", sessionId: "s1" });
  assert.equal(inv.type, "invoke");
  assert.deepEqual(validateEvent({ ...inv, ts: new Date().toISOString(), schema_version: 1, install_id: IID }), []);
  assert.throws(() => buildInvokeEvent({ skillId: "s", invocationKind: "telepathy" }), /invocationKind/);
});

// ---- decay schedule ----

test("decay: due after interval, applies gamma to all arms", () => {
  const policy = new LinUCB();
  policy.observe("a", new Array(64).fill(0.5), 1.0);
  policy.observe("b", new Array(64).fill(0.5), 0.5);
  const before = policy.arm("a").b[0];
  const sched = createDecayScheduler({ gamma: 0.9, intervalMs: DAY, now: () => new Date(T0 + 31 * DAY) });
  assert.equal(sched.due(new Date(T0).toISOString()).due, true);
  assert.equal(sched.due(new Date(T0 + 31 * DAY).toISOString()).due, false);
  const r = sched.apply(policy, new Date(T0).toISOString());
  assert.equal(r.applied, true);
  assert.equal(r.decayedArms, 2);
  assert.ok(Math.abs(policy.arm("a").b[0] - before * 0.9) < 1e-9);
  assert.ok(r.at);
});

test("decay: gamma=1 is a documented no-op; never-decayed is due", () => {
  const policy = new LinUCB();
  const sched = createDecayScheduler({ gamma: 1, now: () => new Date(T0) });
  assert.equal(sched.due(null).due, true);
  assert.equal(sched.apply(policy, null).applied, false);
});

// ---- policy gate ----

function gateRows(n, logP, targetP, reward) {
  return Array.from({ length: n }, () => ({ logPropensity: logP, targetPropensity: targetP, reward }));
}

test("gate: clean estimates pass", () => {
  const rows = gateRows(40, 0.5, 0.6, 0.5);
  const g = gatePolicyChange(rows);
  assert.equal(g.verdict, "pass");
  assert.equal(g.refused, false);
  assert.ok(g.estimates && g.estimates.ess > 0);
});

test("gate: degenerate propensity → flagged (honest refusal, not a block)", () => {
  const rows = gateRows(40, 1.0, 0.6, 0.5); // deterministic logging slot
  const g = gatePolicyChange(rows);
  assert.equal(g.verdict, "flagged");
  assert.equal(g.refused, true);
  assert.ok(/degenerate/.test(g.reason));
});

test("gate: no overlap (ESS<30) → flagged", () => {
  // thin overlap: 39 rows where the target almost never goes, 1 row where it does
  const rows = [
    ...Array.from({ length: 39 }, () => ({ logPropensity: 0.999, targetPropensity: 0.001, reward: 0.5 })),
    { logPropensity: 0.001, targetPropensity: 0.999, reward: 0.5 },
  ];
  const g = gatePolicyChange(rows);
  assert.equal(g.verdict, "flagged");
  assert.equal(g.refused, true);
  assert.ok(/effective sample size/.test(g.reason), g.reason);
});

test("gate: candidate expected to lose → veto", () => {
  const rows = gateRows(40, 0.5, 0.5, -0.8);
  const g = gatePolicyChange(rows);
  assert.equal(g.verdict, "veto");
  assert.ok(/lose/.test(g.reason));
});

// ---- tripwires ----

test("T1: trips below 80% coverage, silent on thin data", () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push({ signals: { invoke_observed: true } });
  for (let i = 0; i < 3; i++) rows.push({ signals: { invoke_observed: false } });
  // 8/11 = 72.7% < 80% → trips
  const t = checkT1(rows);
  assert.equal(t.tripped, true);
  assert.ok(t.detail.coverage < 0.8);

  const good = [];
  for (let i = 0; i < 9; i++) good.push({ signals: { invoke_observed: true } });
  for (let i = 0; i < 1; i++) good.push({ signals: { invoke_observed: false } });
  assert.equal(checkT1(good).tripped, false);

  // thin data → not tripped, insufficient_data
  assert.equal(checkT1(rows.slice(0, 3)).tripped, false);
  assert.equal(checkT1(rows.slice(0, 3)).detail.reason, "insufficient_data");
  // legacy null rows excluded from denominator
  const withLegacy = [...good, ...Array.from({ length: 50 }, () => ({ signals: { invoke_observed: null } }))];
  assert.equal(checkT1(withLegacy).tripped, false);
});

test("T2: trips on correlated outcome inflation", () => {
  // two arms sharing 6 episodes with identical outcomes → corr 1.0
  const rows = [];
  for (let e = 0; e < 6; e++) {
    const win = e % 2 === 0;
    rows.push({ episode_id: `ep${e}`, skill_id: "arm-a", signals: { outcome_success: win } });
    rows.push({ episode_id: `ep${e}`, skill_id: "arm-b", signals: { outcome_success: win } });
  }
  const t = checkT2(rows);
  assert.equal(t.tripped, true, JSON.stringify(t.detail));
  assert.ok(t.detail.meanCorr > 0.7);

  // independent outcomes → no trip
  const rows2 = [];
  const seqA = [1, 0, 1, 0, 1, 0, 1, 0];
  const seqB = [1, 1, 0, 0, 1, 1, 0, 0];
  for (let e = 0; e < 8; e++) {
    rows2.push({ episode_id: `ep${e}`, skill_id: "arm-a", signals: { outcome_success: !!seqA[e] } });
    rows2.push({ episode_id: `ep${e}`, skill_id: "arm-b", signals: { outcome_success: !!seqB[e] } });
  }
  assert.equal(checkT2(rows2).tripped, false);
});

test("T3: trips on a 90-day refusal streak", () => {
  const log = [];
  for (let d = 0; d < 90; d++) log.push({ day: `2026-06-${String(d + 1).padStart(2, "0")}`, refused: true });
  const t = checkT3(log);
  assert.equal(t.tripped, true);
  assert.equal(t.detail.refusalStreakDays, 90);

  const broken = [...log.slice(0, 89), { day: "2026-09-01", refused: false }];
  assert.equal(checkT3(broken).tripped, false);
  assert.equal(checkT3([]).tripped, false);
});
