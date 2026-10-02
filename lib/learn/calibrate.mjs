// B3 proxy calibration (DL-020) — skeleton.
//
// Problem: the 30-day target (kept_30d inside the one-shot label) arrives a
// month late. The online proxy tier (DL-044 ii) serves on fast signals, so we
// must know how well each fast proxy predicts the delayed target — otherwise
// the proxy tier optimizes a fiction. Calibration measures, per fast proxy,
// its ability to predict the 30-day label from matured labels, and adjusts
// proxy weights periodically.
//
// Timing (D3): calibration runs in the post-release window — release never
// waits for 30-day data; 30-day data validates the release afterward.
// In FAZ 6, calibration is SIMULATION-based and every report is tagged
// `source: "simulated"` until real data closes the window (verification gate).
//
// This module is the skeleton: pure functions over matured label batches.
// Scheduling (when to recalibrate) and persistence belong to the caller.

import { proxyFeatures, DEFAULT_WEIGHTS } from "./reward.mjs";

export const CALIBRATION_SOURCE = "simulated"; // flip to "real" only on matured fleet data

// Fast proxies whose 30d-predictive power we track.
export const PROXIES = ["invoked_unique", "outcome_delta", "removed_fast", "installed"];

/**
 * Pearson correlation between two equal-length arrays (null when degenerate).
 */
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Calibrate fast proxies against the matured 30-day target.
 *
 * The target is kept_30d (the delayed 30-day signal) — NOT the full composite.
 * Rationale: every proxy mechanically correlates with a composite it
 * contributes to, so correlating against the composite measures the weight,
 * not predictive power. The B3 question is "does this fast proxy predict the
 * 30-day outcome?", and the 30-day outcome is kept_30d.
 *
 * @param {Array} labelRows  CLOSED label rows (month1 window preferred)
 * @param {Object} opts  { minN, source }
 * @returns {Object} { source, n, target: "kept_30d@month1", proxies: [...] }
 *   each proxy: { proxy, n, corrToTarget, weightMultiplier, verdict }
 *
 * weightMultiplier: 1.0 = proxy predicts the target as expected; <1 = weaker
 * than assumed (down-weight in the proxy tier); >1 = stronger. Clamped to
 * [0.25, 2.0] — calibration adjusts, never reinvents, the locked weights.
 * verdict: "keep" | "downweight" | "drop" (|corr| < 0.1 with n >= minN -> drop
 * from the proxy tier; the bandit label itself is untouched — DL-001 is locked).
 */
export function calibrateProxies(labelRows, {
  minN = 30,
  source = CALIBRATION_SOURCE,
} = {}) {
  const matured = labelRows.filter((r) => r && r.signals);
  const targets = matured.map((r) => (r.signals.kept_30d ? 1 : 0));
  const proxies = PROXIES.map((proxy) => {
    const xs = matured.map((r) => proxyFeatures(r.signals)[proxy] ?? 0);
    const corr = pearson(xs, targets);
    const n = matured.length;
    let verdict = "keep";
    let weightMultiplier = 1.0;
    if (corr === null || n < minN) {
      verdict = "insufficient_data";
    } else {
      const a = Math.abs(corr);
      // Expected direction: invoked_unique/outcome_delta/installed positive,
      // removed_fast negative. Sign flip = the proxy lies.
      const expectedSign = proxy === "removed_fast" ? -1 : 1;
      const signed = corr * expectedSign;
      if (signed < 0) { verdict = "drop"; weightMultiplier = 0; }
      else if (a < 0.1) { verdict = "drop"; weightMultiplier = 0; }
      else if (a < 0.3) { verdict = "downweight"; weightMultiplier = 0.5; }
      else weightMultiplier = Math.min(2.0, Math.max(0.25, a / 0.5));
    }
    return { proxy, n, corrToTarget: corr, weightMultiplier, verdict };
  });
  return { source, n: matured.length, target: "kept_30d@month1", proxies };
}

/**
 * Apply calibrated multipliers to serving-time proxy features.
 * Returns the proxy score contribution vector (weights untouched — DL-002).
 */
export function proxyScore(signals, calibration, weights = DEFAULT_WEIGHTS) {
  const feats = proxyFeatures(signals);
  const mult = Object.fromEntries((calibration?.proxies ?? []).map((p) => [p.proxy, p.weightMultiplier]));
  const wmap = {
    invoked_unique: weights.w1, outcome_delta: weights.w2,
    removed_fast: weights.w4, installed: weights.w6,
  };
  let score = 0;
  for (const [k, w] of Object.entries(wmap)) {
    const m = mult[k] ?? 1;
    score += (k === "removed_fast" ? -w : w) * (feats[k] ?? 0) * m;
  }
  return score;
}
