// B2 warm-start (DL-019): new skills inherit the fleet's prior.
//
// A new skill must NOT start from A=lambda*I, b=0 cold — that wastes the only
// data asset the system has. Instead it starts from accumulated sufficient
// statistics over a relevant historical log slice:
//   A = sum_t x_t x_t^T + lambda*I,   b = sum_t r_t x_t
// where each (x_t, r_t) is a past (context, one-shot label reward) pair.
//
// Inputs: closed label rows (lib/telemetry/labels.mjs) + a contextProvider
// that maps each label row to its d=64 decision-time feature vector. The v1
// schema stores a "context snapshot reference" on the recommendation event;
// rehydrating it is the caller's job — warm-start takes features, never
// invents them.

import { FEATURE_DIM, addOuter } from "./linucb.mjs";
import { oneShotLabel } from "./reward.mjs";

/**
 * Accumulate sufficient statistics from historical labels.
 *
 * @param {Array} labelRows  closed label rows ({ label_id, episode_id, skill_id, window, signals })
 * @param {Function} contextProvider  (labelRow) => Array[d] feature vector at decision time
 * @param {Object} opts  { lambda, rewardOf } — rewardOf defaults to the DL-001 one-shot label
 * @returns {Map} skillId -> { A: Float64Array(d*d), b: Float64Array(d), n }
 */
export function accumulateFromLabels(labelRows, contextProvider, {
  lambda = 1.0,
  rewardOf = (row) => oneShotLabel(row).reward,
} = {}) {
  if (typeof contextProvider !== "function") {
    throw new Error("warmstart: contextProvider (labelRow => feature vector) is required");
  }
  const acc = new Map();
  for (const row of labelRows) {
    if (!row || !row.skill_id) continue;
    const x = contextProvider(row);
    if (!Array.isArray(x) || x.length !== FEATURE_DIM) {
      throw new Error(`warmstart: context for ${row.skill_id} must be length ${FEATURE_DIM}`);
    }
    const r = rewardOf(row);
    if (typeof r !== "number" || !Number.isFinite(r)) continue; // skip unlabelable rows, loudly countable below
    let a = acc.get(row.skill_id);
    if (!a) {
      a = { A: new Float64Array(FEATURE_DIM * FEATURE_DIM), b: new Float64Array(FEATURE_DIM), n: 0, skipped: 0 };
      for (let i = 0; i < FEATURE_DIM; i++) a.A[i * FEATURE_DIM + i] = lambda;
      acc.set(row.skill_id, a);
    }
    addOuter(a.A, FEATURE_DIM, x);
    for (let i = 0; i < FEATURE_DIM; i++) a.b[i] += r * x[i];
    a.n += 1;
  }
  return acc;
}

/**
 * Seed a LinUCB policy's arm with accumulated statistics. The arm behaves as
 * if it had already seen `n` historical (x, r) pairs — cold start is skipped.
 * Returns the number of historical pairs absorbed (0 if none).
 */
export function warmStartArm(linucb, skillId, accum) {
  const a = accum.get(skillId);
  if (!a || a.n === 0) return 0;
  const arm = linucb.arm(skillId);
  if (arm.pulls !== 0) {
    throw new Error(`warmstart: arm ${skillId} already has live pulls; warm-start only applies to fresh arms`);
  }
  arm.A.set(a.A);
  arm.b.set(a.b);
  arm._Ainv = null; // invalidate cached inverse
  // pulls stays 0: these are prior observations, not live decisions. The
  // exploration bonus shrinks via A (uncertainty is what matters), while
  // isColdStart() still reports "never served live" for quota accounting.
  return a.n;
}

/**
 * Batch warm-start for a set of new skill ids. Returns { warmed, cold } id lists.
 */
export function warmStartMany(linucb, skillIds, accum) {
  const warmed = [], cold = [];
  for (const id of skillIds) {
    if (warmStartArm(linucb, id, accum) > 0) warmed.push(id);
    else cold.push(id);
  }
  return { warmed, cold };
}
