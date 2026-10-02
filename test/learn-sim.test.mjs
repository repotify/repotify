// FAZ 6 acceptance: DL-022 regret bar on the 200-round simulated user flow.
//
// Harness arms (DL-047): linucb (the learner) vs baseline (FAZ 5 simple score,
// the locked baseline) vs quota (blind uniform-random control, DL-007/D2).
// Bar: regret(linucb) <= 0.80 * regret(baseline) over 200 rounds.
// Train/eval rewards are separated (DL-022): the bandit trains on
// rank-normalized DL-001 one-shot labels; regret is scored on the hidden
// oracle quality. Delayed labels close LABEL_DELAY rounds after the decision
// (virtual time advances through the windows, DL-047).
//
// The linucb arm is B2 warm-started from 120 historical labels — the locked
// deployment behavior (DL-019: new skills do NOT start A=lambda*I, b=0 cold).
// A pure-cold run is kept as the DL-019 diagnostic.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIM_SEED, N_ROUNDS, buildWorld, runPolicy, generateHistory,
} from "./learn-harness.mjs";

const LINUCB_ALPHA = 0.5;
const WARM_N = 120;
const BAR = 0.8;

function linucbRun(world) {
  return runPolicy(world, "linucb", {
    warmLabels: generateHistory(world, WARM_N),
    alpha: LINUCB_ALPHA,
  });
}

function regretReport(r) {
  return `${r.policy}: cumRegret=${r.cumRegret.toFixed(2)} ` +
    `labels=${r.labelsClosed} maxGrad/ep=${r.maxGradPerEpisode} proxyRounds=${r.proxyRounds}`;
}

test("DL-022 acceptance: linucb regret <= 80% of baseline over 200 rounds", () => {
  const world = buildWorld(SIM_SEED);
  const lin = linucbRun(world);
  const base = runPolicy(world, "baseline");
  const quota = runPolicy(world, "quota");

  console.log(`    [sim] ${regretReport(lin)}`);
  console.log(`    [sim] ${regretReport(base)}`);
  console.log(`    [sim] ${regretReport(quota)}`);

  assert.equal(lin.decisions, N_ROUNDS);
  assert.equal(base.decisions, N_ROUNDS);

  // Every decision produced exactly one label and one gradient example (DL-005).
  for (const r of [lin, base, quota]) {
    assert.equal(r.labelsClosed, N_ROUNDS, `${r.policy}: every decision must close exactly one label`);
    assert.equal(r.maxGradPerEpisode, 1, `${r.policy}: DL-044 — at most one gradient update per episode`);
  }
  // The online proxy tier saw fast signals every round without emitting gradients (DL-044 ii).
  assert.equal(lin.proxyRounds, N_ROUNDS);

  const ratio = lin.cumRegret / base.cumRegret;
  console.log(`    [sim] regret ratio linucb/baseline = ${ratio.toFixed(3)} (bar <= ${BAR})`);
  assert.ok(ratio <= BAR, `DL-022 FAILED: ratio ${ratio.toFixed(3)} > ${BAR}`);
});

test("DL-022 robustness: bar holds across world seeds (not seed luck)", () => {
  for (const seed of [7, 99, 1234, 55555]) {
    const world = buildWorld(seed);
    const lin = linucbRun(world);
    const base = runPolicy(world, "baseline");
    const ratio = lin.cumRegret / base.cumRegret;
    console.log(`    [sim] seed=${seed} ratio=${ratio.toFixed(3)}`);
    assert.ok(ratio <= BAR, `seed ${seed}: ratio ${ratio.toFixed(3)} > ${BAR}`);
  }
});

test("quota arm is a valid control: worse than both learner and baseline", () => {
  const world = buildWorld(SIM_SEED);
  const lin = linucbRun(world);
  const base = runPolicy(world, "baseline");
  const quota = runPolicy(world, "quota");
  assert.ok(quota.cumRegret > base.cumRegret, "control must be worse than baseline");
  assert.ok(quota.cumRegret > lin.cumRegret, "control must be worse than learner");
});

test("DL-019: warm-start reduces early regret vs pure cold start", () => {
  const world = buildWorld(SIM_SEED);
  const warm = linucbRun(world);
  const cold = runPolicy(world, "linucb", { alpha: LINUCB_ALPHA }); // no warmLabels
  const early = (r) => r.regretTrace.slice(0, 60).reduce((a, b) => a + b, 0);
  const warmEarly = early(warm), coldEarly = early(cold);
  console.log(`    [sim] early regret (first 60 rounds): warm=${warmEarly.toFixed(2)} cold=${coldEarly.toFixed(2)}`);
  assert.ok(warmEarly < coldEarly, `DL-019 FAILED: warm ${warmEarly.toFixed(2)} >= cold ${coldEarly.toFixed(2)}`);
});

test("harness determinism: same seed -> identical regret", () => {
  const r1 = linucbRun(buildWorld(SIM_SEED));
  const r2 = linucbRun(buildWorld(SIM_SEED));
  assert.equal(r1.cumRegret, r2.cumRegret);
  assert.deepEqual(r1.regretTrace, r2.regretTrace);
});
