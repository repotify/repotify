// Tests for lib/learn/ope-arastirma.mjs — OPE refusal-rate research prototype.
// Honesty contract under test: the ESS<30 gate, the degenerate-propensity
// refusal, and the clipping flag behave EXACTLY as in lib/learn/ope.mjs.
// The refusal rate drops because the data gets better, never because the
// bar moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy } from "../lib/learn/ope.mjs";
import {
  evaluatePolicyMulti,
  overlapReport,
  designCoverageLogger,
  runRefusalBenchmark,
  OPE_ARASTIRMA_VERSION,
} from "../lib/learn/ope-arastirma.mjs";

// --- Synthetic world: two complementary ε-greedy epochs -------------------
// Epoch 1 greedy on itemA, epoch 2 greedy on itemB (ε=0.05, n=100 →
// non-greedy propensity 0.0005, greedy ≈ 0.95). Target: 50/50 mixture.
// Each epoch alone starves one side of the mixture → ESS collapses →
// single-epoch evaluatePolicy refuses. MIS pooling covers both sides.
const EPS = 0.05, N_ACT = 100;
const ITEMS = ["itemA", "itemB", ...Array.from({ length: 98 }, (_, i) => `item${i}`)];
const propA = (a) => (a === "itemA" ? (1 - EPS) + EPS / N_ACT : EPS / N_ACT);
const propB = (a) => (a === "itemB" ? (1 - EPS) + EPS / N_ACT : EPS / N_ACT);

function makeEpoch(propFn, greedyItem, n) {
  // Fully deterministic construction (no RNG): exact propensity-proportional
  // counts, with 2 forced rows of the OTHER candidate item so the thin
  // overlap is structurally present (not left to sampling luck). With
  // n=1500, ε=0.05: ~1426 greedy rows (w≈0.53), 2 rare rows (w=1000 for the
  // 50/50 mixture target), rest w=0 → ESS ≈ 3.8 → the honest gate refuses.
  const rareItem = greedyItem === "itemA" ? "itemB" : "itemA";
  const nGreedy = Math.round(n * propFn(greedyItem));
  const nRare = 2;
  const nOther = n - nGreedy - nRare;
  const otherItems = ITEMS.filter((a) => a !== greedyItem && a !== rareItem);
  const rows = [];
  const push = (a) => rows.push({
    action: a,
    logPropensity: propFn(a),
    // Target: 50/50 mixture of itemA/itemB.
    targetPropensity: a === "itemA" || a === "itemB" ? 0.5 : 0,
    // Rewards: itemA=0.8, itemB=0.4 → truth = 0.6.
    reward: a === "itemA" ? 0.8 : a === "itemB" ? 0.4 : 0.1,
  });
  for (let i = 0; i < nGreedy; i++) push(greedyItem);
  for (let i = 0; i < nRare; i++) push(rareItem);
  for (let i = 0; i < nOther; i++) push(otherItems[i % otherItems.length]);
  return rows;
}

// Both epochs' propensities for the taken action (balance-heuristic input).
const withMix = (rows) => rows.map((r) => ({ ...r, mixPropensities: [propA(r.action), propB(r.action)] }));

test("ope-arastirma: single epochs refuse the mixture target (thin overlap)", () => {
  const t1 = makeEpoch(propA, "itemA", 1500);
  const t2 = makeEpoch(propB, "itemB", 1500);
  const r1 = evaluatePolicy(t1);
  const r2 = evaluatePolicy(t2);
  assert.equal(r1.refused, true, "epoch 1 (greedy itemA) must refuse the 50/50 mixture");
  assert.equal(r2.refused, true, "epoch 2 (greedy itemB) must refuse the 50/50 mixture");
  assert.match(r1.reason, /effective sample size/);
});

test("ope-arastirma: CAVEAT — ESS cannot see support that never appears (m=0)", () => {
  // If the rare item happens to NEVER be logged, single-epoch evaluation
  // ACCEPTS with a badly biased estimate: ESS ≈ 10800 looks healthy because
  // the thin-overlap rows are simply absent. No estimator can fix zero
  // coverage — this is the honest case FOR Idea 2 (design the logger so
  // candidate support is covered by construction). Documented, not fixed.
  const t1 = makeEpoch(propA, "itemA", 1500).filter((r) => r.action !== "itemB");
  const r = evaluatePolicy(t1);
  assert.equal(r.refused, undefined, "gate sees only healthy weights → accepts");
  assert.ok(r.ess > 1000, `ess=${r.ess} looks healthy`);
  // But the 50/50 mixture truth is 0.6; with itemB missing, SNIPS ≈ 0.8.
  assert.ok(Math.abs(r.snips - 0.8) < 0.05, `snips=${r.snips} estimates only the covered side`);
  assert.ok(Math.abs(r.snips - 0.6) > 0.1, "biased away from truth, gate silent");
});

test("ope-arastirma: MIS pooling accepts where both single epochs refuse", () => {
  const t1 = makeEpoch(propA, "itemA", 1500);
  const t2 = makeEpoch(propB, "itemB", 1500);
  const m1 = withMix(t1);
  const m2 = withMix(t2);
  const r = evaluatePolicyMulti([{ rows: m1 }, { rows: m2 }]);
  assert.equal(r.refused, undefined, `MIS pooled should accept: ${r.reason ?? ""}`);
  assert.equal(r.pooled, "mis");
  assert.equal(r.epochs, 2);
  assert.ok(r.ess >= 30, `ess=${r.ess}`);
  // Truth for the 50/50 mixture is 0.6; SNIPS must be close.
  assert.ok(Math.abs(r.snips - 0.6) < 0.1, `snips=${r.snips}`);
  assert.equal(r.clipped, false);
});

test("ope-arastirma: naive pooling refuses where MIS accepts (same data)", () => {
  const t1 = makeEpoch(propA, "itemA", 1500);
  const t2 = makeEpoch(propB, "itemB", 1500);
  // Same rows, NO mixPropensities → naive concatenation.
  const r = evaluatePolicyMulti([{ rows: t1 }, { rows: t2 }]);
  assert.equal(r.pooled, "naive");
  assert.equal(r.refused, true, "naive pooling keeps the degenerate weights → still refuses");
  assert.match(r.reason, /effective sample size/);
});

test("ope-arastirma: honesty — degenerate own-epoch propensity still refuses", () => {
  const t1 = makeEpoch(propA, "itemA", 200);
  t1[0].logPropensity = 1; // deterministic slot
  const r = evaluatePolicyMulti([{ rows: t1 }]);
  assert.equal(r.refused, true);
  assert.match(r.reason, /degenerate/);
});

test("ope-arastirma: honesty — pooled ESS gate still refuses thin mixtures", () => {
  // Target lives on an item NEITHER epoch covers → pooled ESS collapses.
  const t1 = makeEpoch(propA, "itemA", 500).map((r) => ({ ...r, targetPropensity: r.action === "itemZ" ? 1 : 0 }));
  const t2 = makeEpoch(propB, "itemB", 500).map((r) => ({ ...r, targetPropensity: r.action === "itemZ" ? 1 : 0 }));
  const m1 = withMix(t1);
  const m2 = withMix(t2);
  const r = evaluatePolicyMulti([{ rows: m1 }, { rows: m2 }]);
  assert.equal(r.refused, true, "no overlap anywhere → must still refuse");
  assert.match(r.reason, /effective sample size/);
});

test("ope-arastirma: honesty — clipping flag survives pooling", () => {
  const t1 = makeEpoch(propA, "itemA", 1500);
  const t2 = makeEpoch(propB, "itemB", 1500);
  const m1 = withMix(t1);
  const m2 = withMix(t2);
  const r = evaluatePolicyMulti([{ rows: m1 }, { rows: m2 }], { clip: 1.01, minESS: 5 });
  assert.equal(r.refused, undefined);
  assert.equal(r.clipped, true, "tiny clip → most weights clipped → flagged");
  assert.ok(r.clippedFrac > 0.5);
});

test("ope-arastirma: overlapReport names the starved action as top driver", () => {
  const t1 = makeEpoch(propA, "itemA", 1500);
  const rep = overlapReport(t1);
  assert.equal(rep.refusedAt30, true);
  assert.ok(rep.topDrivers.includes("itemB"), `topDrivers=${rep.topDrivers}`);
  const b = rep.perAction.find((p) => p.action === "itemB");
  assert.ok(b.weightShare > 0.3, `itemB weightShare=${b.weightShare}`);
  assert.ok(b.loggedMass < 0.05, `itemB loggedMass=${b.loggedMass}`);
  assert.ok(b.starvation > 5, `itemB starvation=${b.starvation}`);
});

test("ope-arastirma: designCoverageLogger bounds candidate weights by K/epsilon", () => {
  const actionIds = ["a", "b", "c", "d"];
  const candidates = [
    { id: "p1", probs: { b: 1 } },
    { id: "p2", probs: { c: 1 } },
  ];
  const d = designCoverageLogger({ greedyId: "a", candidates, epsilon: 0.05, actionIds });
  // Propensities sum to 1.
  const total = actionIds.reduce((s, a) => s + d.propensity(a), 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `total=${total}`);
  // Each candidate-favored action gets ≥ ε/K = 0.025 (vs ε/n = 0.0125 uniform).
  assert.ok(d.minCandidatePropensity >= 0.025 - 1e-12, `min=${d.minCandidatePropensity}`);
  assert.equal(d.maxWeightBound, 40); // K/ε = 2/0.05
  // Greedy action keeps (1-ε).
  assert.ok(Math.abs(d.propensity("a") - 0.95) < 1e-9);
});

test("ope-arastirma: benchmark is deterministic and shows X→Y", () => {
  const b1 = runRefusalBenchmark();
  const b2 = runRefusalBenchmark();
  assert.deepEqual(b1, b2, "same seeds → identical benchmark");
  // A: P3-style ε-greedy, single epoch — novel candidates refused ~always.
  assert.ok(b1.A_singleEpsGreedy.rate >= 0.9, `A rate=${b1.A_singleEpsGreedy.rate}`);
  // B: coverage-aware logger, same ε budget — refusal collapses.
  assert.ok(b1.B_coverageLogger.rate <= 0.3, `B rate=${b1.B_coverageLogger.rate}`);
  assert.ok(b1.B_coverageLogger.rate < b1.A_singleEpsGreedy.rate, "B must beat A");
  // C: best single epoch refuses the mixture (planted thin overlap → structural);
  // D: naive pooling still refuses; E: MIS pooling accepts.
  assert.ok(b1.C_bestSingleEpoch.rate >= 0.9, `C rate=${b1.C_bestSingleEpoch.rate}`);
  assert.ok(b1.D_naivePool.rate >= 0.9, `D rate=${b1.D_naivePool.rate}`);
  assert.equal(b1.E_misPool.rate, 0, `E rate=${b1.E_misPool.rate}`);
  assert.ok(b1.E_misPool.rate <= b1.C_bestSingleEpoch.rate, "MIS must not refuse more than best single");
  // MIS estimate sanity: close to truth.
  assert.ok(Math.abs(b1.misSanity.snips - b1.misSanity.truth) < 0.1,
    `snips=${b1.misSanity.snips} truth=${b1.misSanity.truth}`);
});

test("ope-arastirma: designCoverageLogger uniform floor keeps complete support (critic guardrail)", () => {
  const actionIds = ["a", "b", "c", "d"];
  const candidates = [{ id: "p1", probs: { b: 1 } }];
  const d = designCoverageLogger({ greedyId: "a", candidates, epsilon: 0.05, actionIds, uniformFloor: 0.2 });
  // Every action keeps propensity ≥ ε·β/n = 0.05·0.2/4 = 0.0025 — no zero support.
  assert.ok(d.minPropensity >= 0.0025 - 1e-12, `minPropensity=${d.minPropensity}`);
  const total = actionIds.reduce((s, x) => s + d.propensity(x), 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `total=${total}`);
  // β=0 keeps the old behavior (partial support, tighter bound).
  const d0 = designCoverageLogger({ greedyId: "a", candidates, epsilon: 0.05, actionIds });
  assert.equal(d0.minPropensity, 0);
  assert.equal(d0.maxWeightBound, 20); // K/ε = 1/0.05
});

test("ope-arastirma: version constant is pinned", () => {
  assert.equal(OPE_ARASTIRMA_VERSION, "ope-arastirma1");
});
