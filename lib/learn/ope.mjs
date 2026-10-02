// Offline policy evaluation (OPE) over Stage 0 telemetry logs — FAZ 11 (Q-A).
//
// The "ölç" leg of öner → ölç → öğren needs counterfactual answers: "what
// would policy π_e have earned on the traffic policy π_b actually served?"
// Stage 0 already logs the full propensity record per recommendation episode
// (B1: every candidate gets 0 < propensity < 1, enforced by the validator),
// so logged propensities exist. This module replays those logs with three
// standard estimators:
//
//   IPS   = mean( w_i * r_i )                    — unbiased, high variance
//   SNIPS = Σ(w_i r_i) / Σ(w_i)                  — self-normalized, lower variance
//   DR    = mean( q̂_i + w_i (r_i − q̂_i) )       — doubly robust; needs a reward
//           model q̂ (defaults to the logging-policy mean reward)
//
// where w_i = π_e(a_i|x_i) / π_b(a_i|x_i), clipped at CLIP (default 20).
//
// HONESTY RULES (eleştirmen şartı):
//   1. No coverage → no number. If effective sample size (ESS) is below
//      minESS, or any logging propensity is degenerate (≤0 or ≥1), the
//      module REFUSES and returns { refused: true, reason } instead of
//      inventing an estimate. A silent plausible number is worse than no number.
//   2. Propensities must be the ones logged at serve time, never reconstructed
//      from the current model. The caller joins label rows to episodes; this
//      module never invents propensities.
//   3. Clipping fraction is reported. If > clipWarnFrac of weights hit the
//      clip, the estimate is flagged `clipped: true` — treat as diagnostic,
//      not decision-grade.
//
// Input rows: { logPropensity, targetPropensity, reward }
//   logPropensity    π_b(a|x) — the propensity actually logged at serve time
//   targetPropensity π_e(a|x) — the candidate policy's probability for the
//                    action that was taken (caller's responsibility)
//   reward           observed reward for that episode (e.g. oneShotLabel)
//
// Pure functions, no I/O, no dependencies.

export const OPE_VERSION = "ope1";
export const DEFAULT_CLIP = 20;
export const DEFAULT_MIN_ESS = 30;
export const DEFAULT_CLIP_WARN_FRAC = 0.1;

function checkRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, reason: "ope: no rows — nothing to evaluate" };
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || typeof r !== "object") return { ok: false, reason: `ope: row ${i} is not an object` };
    for (const k of ["logPropensity", "targetPropensity", "reward"]) {
      if (typeof r[k] !== "number" || !Number.isFinite(r[k])) {
        return { ok: false, reason: `ope: row ${i}.${k} must be a finite number` };
      }
    }
    // B1 invariant: logged propensity is ALWAYS strictly below 1 and above 0.
    // A degenerate propensity (0/1/deterministic slot) breaks every estimator.
    if (!(r.logPropensity > 0) || !(r.logPropensity < 1)) {
      return { ok: false, reason: `ope: row ${i} has degenerate logPropensity ${r.logPropensity} — replay impossible (deterministic slot breaks IPS/SNIPS/DR)` };
    }
    if (r.targetPropensity < 0 || r.targetPropensity > 1) {
      return { ok: false, reason: `ope: row ${i} targetPropensity ${r.targetPropensity} outside [0,1]` };
    }
  }
  return { ok: true };
}

/**
 * Evaluate a candidate policy on logged episodes.
 *
 * @param {Array} rows  [{ logPropensity, targetPropensity, reward }]
 * @param {Object} opts {
 *   clip: max importance weight (default 20),
 *   minESS: minimum effective sample size (default 30),
 *   clipWarnFrac: fraction of clipped weights that flags the estimate (default 0.1),
 *   qHatTarget: (row, index) => E_{a ~ π_e}[q̂(x,a)] — predicted reward under the
 *     TARGET policy; default = logging-policy mean reward,
 *   qHatLogged: (row, index) => q̂(x, a_logged) — predicted reward of the LOGGED
 *     action (control variate); default = qHatTarget
 * }
 * DR = mean( qT_i + w_i (r_i − qL_i) ). With the true reward model this is exact;
 * with a constant model it degrades gracefully to a mean-adjusted IPS.
 * @returns {Object} { ips, snips, dr, ess, n, clippedFrac, clipped, weights }
 *          or { refused: true, reason, ess?, n }
 */
export function evaluatePolicy(rows, opts = {}) {
  const {
    clip = DEFAULT_CLIP,
    minESS = DEFAULT_MIN_ESS,
    clipWarnFrac = DEFAULT_CLIP_WARN_FRAC,
    qHatTarget = null,
    qHatLogged = null,
  } = opts;
  const n = Array.isArray(rows) ? rows.length : 0;

  const bad = checkRows(rows);
  if (!bad.ok) return { refused: true, reason: bad.reason, n };

  const rawWeights = new Array(n);
  for (let i = 0; i < n; i++) rawWeights[i] = rows[i].targetPropensity / rows[i].logPropensity;

  // Effective sample size: (Σw)² / Σw², computed on UNCLIPPED weights.
  // Clipping inflates ESS (it caps the extreme weights), which would hide
  // thin overlap — so the refusal gate uses raw weights. Low ESS = the target
  // policy lives where the logging policy rarely went → no overlap → refuse.
  const sumW = rawWeights.reduce((a, b) => a + b, 0);
  const sumW2 = rawWeights.reduce((a, b) => a + b * b, 0);
  const ess = sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;
  if (ess < minESS) {
    return {
      refused: true, n, ess: +ess.toFixed(2),
      reason: `ope: effective sample size ${ess.toFixed(1)} < ${minESS} — target policy has no overlap with logging policy; refusing to estimate`,
    };
  }

  const weights = new Array(n);
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    let w = rawWeights[i];
    if (w > clip) { w = clip; clipped++; }
    weights[i] = w;
  }

  const rewards = rows.map((r) => r.reward);
  const meanR = rewards.reduce((a, b) => a + b, 0) / n;
  const finiteOr = (v) => (typeof v === "number" && Number.isFinite(v) ? v : meanR);
  const qT = typeof qHatTarget === "function"
    ? rows.map((r, i) => finiteOr(qHatTarget(r, i)))
    : new Array(n).fill(meanR);
  const qL = typeof qHatLogged === "function"
    ? rows.map((r, i) => finiteOr(qHatLogged(r, i)))
    : qT.slice();

  let ipsSum = 0, wSum = 0, wrSum = 0, drSum = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i], r = rewards[i];
    ipsSum += w * r;
    wSum += w;
    wrSum += w * r;
    drSum += qT[i] + w * (r - qL[i]);
  }
  const clippedFrac = clipped / n;
  return {
    ips: ipsSum / n,
    snips: wSum > 0 ? wrSum / wSum : NaN,
    dr: drSum / n,
    ess: +ess.toFixed(2),
    n,
    clippedFrac: +clippedFrac.toFixed(4),
    clipped: clippedFrac > clipWarnFrac,
    weights,
  };
}
