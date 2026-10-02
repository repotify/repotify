// Unit tests: lib/learn/reward.mjs (DL-001 canonical reward, DL-043 rank)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REWARD_VERSION, DEFAULT_WEIGHTS, assertWeightsValid,
  invokedUnique, outcomeDelta, compositeReward, proxyFeatures,
  oneShotLabel, rankNormalize, zScoreNormalize,
  assertNoTokenFields, labelBatch,
} from "../lib/learn/reward.mjs";

function fullSignals(over = {}) {
  return {
    invoked_count: 2, invoked_sessions: 2, invoked_explicit: 2,
    invoked_implicit: 0, invoked_load: 0,
    outcome_count: 1, outcome_success: true, outcome_shared: false,
    outcome_quality: 4, outcome_skill_free_baseline: false,
    abandoned_count: 0, fallback_count: 0, questions_asked: 0, questions_answered: 0,
    kept_30d: true, removed_fast: false, removed: false,
    removal_reason: null, replaced_by: null,
    tokens_in_sum: 0, tokens_out_sum: 0, latency_ms_sum: 0, latency_ms_count: 0,
    ...over,
  };
}

test("REWARD_VERSION pinned", () => {
  assert.equal(REWARD_VERSION, "r1");
});

test("default weights satisfy DL-002 caps and ordering", () => {
  assert.equal(assertWeightsValid(), true);
  assert.equal(assertWeightsValid(DEFAULT_WEIGHTS), true);
});

test("assertWeightsValid rejects violations (CI gate)", () => {
  assert.throws(() => assertWeightsValid({ ...DEFAULT_WEIGHTS, w6: 0.2 }), /0\.10/);
  assert.throws(() => assertWeightsValid({ ...DEFAULT_WEIGHTS, w5: 0.2 }), /w5/);
  assert.throws(() => assertWeightsValid({ ...DEFAULT_WEIGHTS, w1: 0.5 }), /0\.40/);
  assert.throws(() => assertWeightsValid({ ...DEFAULT_WEIGHTS, w4: 0.1 }), /w4/);
  assert.throws(() => assertWeightsValid({ ...DEFAULT_WEIGHTS, w2: NaN }), /finite/);
});

test("golden vector: hand-computed composite", () => {
  // invoked=1, delta=1-0=1, kept=1, removed_fast=0, replaced=0, installed=1
  // 0.35*1 + 0.30*1 + 0.20*1 - 0 + 0 + 0.10*1 = 0.95
  const r = compositeReward(fullSignals());
  assert.ok(Math.abs(r - 0.95) < 1e-12, `got ${r}`);

  // worst case: never invoked, failed vs baseline, removed fast, replaced
  // 0 + 0.30*(0-1) + 0 - 0.30*1 - 0.35*1 + 0.10 = -0.85
  const bad = compositeReward(fullSignals({
    invoked_sessions: 0, invoked_count: 0, outcome_success: false,
    outcome_skill_free_baseline: true, kept_30d: false,
    removed_fast: true, removed: true, removal_reason: "unused",
    replaced_by: "skill-x",
  }));
  assert.ok(Math.abs(bad - (-0.85)) < 1e-12, `got ${bad}`);
});

test("outcome_delta: difference-in-differences semantics", () => {
  assert.equal(outcomeDelta(fullSignals()), 1); // success vs failed baseline
  assert.equal(outcomeDelta(fullSignals({ outcome_success: true, outcome_skill_free_baseline: true })), 0);
  assert.equal(outcomeDelta(fullSignals({ outcome_success: false, outcome_skill_free_baseline: true })), -1);
  assert.equal(outcomeDelta(fullSignals({ outcome_success: null, outcome_skill_free_baseline: null })), 0); // unobserved -> 0
  assert.equal(outcomeDelta(fullSignals({ outcome_success: true, outcome_skill_free_baseline: null })), 0.5); // neutral baseline
});

test("invoked_unique is binary presence (gaming-resistant)", () => {
  assert.equal(invokedUnique(fullSignals()), 1);
  assert.equal(invokedUnique(fullSignals({ invoked_sessions: 0 })), 0);
  assert.equal(invokedUnique(fullSignals({ invoked_sessions: 7 })), 1); // count does not inflate
});

test("removed_fast penalty strictly exceeds any install credit (anti-free-rider)", () => {
  const s = fullSignals({ invoked_sessions: 0, outcome_success: null, kept_30d: false, removed_fast: true, removal_reason: "unused" });
  const r = compositeReward(s);
  // -0.30 (removed_fast) + 0.10 (installed) = -0.20 < 0: install-then-dump never pays
  assert.ok(r < 0, `install-and-dump must not pay: ${r}`);
});

test("replaced is the strongest negative", () => {
  const a = compositeReward(fullSignals({ kept_30d: false, removed_fast: true, removal_reason: "unused", replaced_by: null }));
  const b = compositeReward(fullSignals({ kept_30d: false, removed_fast: false, replaced_by: "skill-y" }));
  assert.ok(b < a, `replaced (${b}) must hurt more than plain fast removal (${a})`);
});

test("proxyFeatures: fast tier only — kept_30d excluded (DL-044 ii)", () => {
  const pf = proxyFeatures(fullSignals());
  assert.ok(!("kept_30d" in pf), "kept_30d must not be a fast signal");
  assert.deepEqual(Object.keys(pf).sort(),
    ["installed", "invoked_unique", "outcome_delta", "removed_fast", "replaced"].sort());
});

test("oneShotLabel: exactly one label shape per decision (DL-005)", () => {
  const row = { label_id: "l1", episode_id: "e1", skill_id: "s1", window: "month1", signals: fullSignals() };
  const l = oneShotLabel(row);
  assert.equal(l.reward_version, "r1");
  assert.equal(l.window, "month1");
  assert.ok(Math.abs(l.reward - 0.95) < 1e-12);
  assert.throws(() => oneShotLabel({}), /signals/);
});

test("rankNormalize: canonical [0,1] mapping, ties share average rank", () => {
  assert.deepEqual(rankNormalize([]), []);
  assert.deepEqual(rankNormalize([5]), [0.5]);
  const r = rankNormalize([10, 20, 30, 40]);
  assert.deepEqual(r, [0, 1 / 3, 2 / 3, 1]);
  const tied = rankNormalize([1, 5, 5, 9]);
  assert.ok(Math.abs(tied[1] - tied[2]) < 1e-12, "ties share rank");
  assert.ok(tied[0] === 0 && tied[3] === 1);
  for (const v of rankNormalize([-3, 0.5, 100, -100, 2])) {
    assert.ok(v >= 0 && v <= 1, `rank ${v} out of [0,1]`);
  }
  // robust to outliers: one huge value does not compress the rest to a point
  const out = rankNormalize([0.1, 0.2, 0.3, 1000]);
  assert.ok(Math.abs(out[2] - 2 / 3) < 1e-12);
});

test("zScoreNormalize exists but is NOT the label path (diagnostic only, DL-043)", () => {
  const z = zScoreNormalize([1, 2, 3]);
  assert.ok(Math.abs(z[1]) < 1e-12); // mean-centered
  assert.deepEqual(zScoreNormalize([]), []);
});

test("assertNoTokenFields: token_* rejected from training labels (DL-003)", () => {
  assert.equal(assertNoTokenFields(fullSignals()), true);
  assert.throws(() => assertNoTokenFields({ ...fullSignals(), token_efficiency: 0.9 }), /DL-003/);
});

test("labelBatch: raw + rank in one pass", () => {
  const rows = [0, 1, 2].map((i) => ({
    label_id: `l${i}`, episode_id: `e${i}`, skill_id: "s",
    window: "month1",
    signals: fullSignals({ kept_30d: i > 0, invoked_sessions: i }),
  }));
  const out = labelBatch(rows);
  assert.equal(out.length, 3);
  assert.ok(out[0].reward_rank < out[2].reward_rank);
  assert.ok(out.every((l) => l.reward_rank >= 0 && l.reward_rank <= 1));
});
