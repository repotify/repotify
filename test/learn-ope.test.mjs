// Tests for lib/learn/ope.mjs — offline policy evaluation.
// Ground-truth design: a uniform logging policy over 2 actions with KNOWN
// rewards, so IPS must recover the target policy's true value within tolerance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy, OPE_VERSION, DEFAULT_CLIP } from "../lib/learn/ope.mjs";

function uniformLog({ n, rewardA, rewardB, seed = 42 }) {
  // Logging policy: uniform over {A, B} → logPropensity 0.5 for the taken action.
  // Rewards deterministic per action: the "world" is fully known.
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const a = rnd() < 0.5 ? "A" : "B";
    rows.push({
      logPropensity: 0.5,
      // Target policy: always pick A → targetPropensity 1 for A-rows, 0 for B-rows.
      targetPropensity: a === "A" ? 1 : 0,
      reward: a === "A" ? rewardA : rewardB,
    });
  }
  return rows;
}

test("ope: IPS recovers the target policy value under a uniform logger", () => {
  const rows = uniformLog({ n: 4000, rewardA: 0.8, rewardB: 0.2 });
  const r = evaluatePolicy(rows);
  assert.equal(r.refused, undefined);
  // True value of "always A" is 0.8.
  assert.ok(Math.abs(r.ips - 0.8) < 0.05, `ips=${r.ips}`);
  assert.ok(Math.abs(r.snips - 0.8) < 0.05, `snips=${r.snips}`);
  assert.ok(Math.abs(r.dr - 0.8) < 0.05, `dr=${r.dr}`);
  assert.ok(r.ess > 1000, `ess=${r.ess}`);
  assert.equal(r.clipped, false);
});

test("ope: SNIPS normalizes away logging-policy scale mismatch", () => {
  // Logger favors B (0.9); target always picks A. Overlap exists but thin.
  const rows = [];
  let s = 7;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 6000; i++) {
    const a = rnd() < 0.9 ? "B" : "A";
    rows.push({
      logPropensity: a === "A" ? 0.1 : 0.9,
      targetPropensity: a === "A" ? 1 : 0,
      reward: a === "A" ? 1 : 0,
    });
  }
  const r = evaluatePolicy(rows, { clip: 50 });
  assert.equal(r.refused, undefined);
  // True value of "always A" is 1. IPS with thin overlap is noisy; SNIPS must be closer.
  assert.ok(Math.abs(r.snips - 1) < 0.15, `snips=${r.snips}`);
});

test("ope: DR with the true reward model is exact", () => {
  const rows = uniformLog({ n: 500, rewardA: 0.7, rewardB: 0.3 });
  const r = evaluatePolicy(rows, {
    // Target policy always picks A → E_{π_e}[q̂] = 0.7 on every row.
    qHatTarget: () => 0.7,
    qHatLogged: (row) => (row.targetPropensity === 1 ? 0.7 : 0.3),
  });
  assert.ok(Math.abs(r.dr - 0.7) < 1e-9, `dr=${r.dr}`);
});

test("ope: refuses on degenerate (deterministic) logging propensity", () => {
  const rows = uniformLog({ n: 100, rewardA: 1, rewardB: 0 });
  rows[5].logPropensity = 1; // deterministic slot — breaks every estimator
  const r = evaluatePolicy(rows);
  assert.equal(r.refused, true);
  assert.match(r.reason, /degenerate/);
});

test("ope: refuses when effective sample size is too low (no overlap)", () => {
  // Logger almost never takes A; target always takes A → ESS collapses.
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push({ logPropensity: i < 2 ? 0.01 : 0.99, targetPropensity: 1, reward: 0.5 });
  }
  const r = evaluatePolicy(rows, { minESS: 30 });
  assert.equal(r.refused, true);
  assert.match(r.reason, /effective sample size/);
});

test("ope: refuses on empty input instead of inventing a number", () => {
  const r = evaluatePolicy([]);
  assert.equal(r.refused, true);
});

test("ope: flags heavy clipping as diagnostic-only", () => {
  const rows = [];
  for (let i = 0; i < 500; i++) {
    rows.push({ logPropensity: 0.02, targetPropensity: 1, reward: 1 });
  }
  const r = evaluatePolicy(rows, { clip: 5, minESS: 5 });
  assert.equal(r.refused, undefined);
  assert.equal(r.clipped, true);
  assert.ok(r.clippedFrac > 0.9);
});

test("ope: version constant is pinned", () => {
  assert.equal(OPE_VERSION, "ope1");
  assert.equal(DEFAULT_CLIP, 20);
});
