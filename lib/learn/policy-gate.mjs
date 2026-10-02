// P4: OPE as the set-level safety gate (odul-attribution-karar.md §4 madde 5).
//
// The hybrid design splits learning from validation:
//   - LEARNING (primary): arm-level, call-gated outcome credit + invoke_observed
//     (reward.mjs / labels.mjs). This is where theta updates come from.
//   - SAFETY (this module): set-level OPE (ope.mjs) checks an arm-level policy
//     change BEFORE it ships. OPE never learns and never updates theta; it
//     only passes, flags, or vetoes.
//
// Verdicts:
//   "pass"    OPE produced unclipped estimates and the candidate does not look
//             worse than doing nothing (dr >= 0).
//   "flagged" OPE refused (degenerate propensity / ESS < minESS) or the
//             estimate is clipped — the change ships flagged for human review.
//             Refusal is honest ("no number"), not a block.
//   "veto"    OPE produced clean estimates and the candidate is expected to
//             LOSE (dr < 0 and ips < 0 agree) — do not ship.
//
// Input rows: logged episodes, one per row:
//   { logPropensity, reward, targetPropensity? }
// targetPropensity may be supplied per row or computed by targetPropensityOf(row, i).
// reward is the observed set-level reward (e.g. mean oneShotLabel reward of the
// episode's arms, or any set-level metric the caller defines).
//
// Pure functions, no I/O. Refusal streaks feed tripwire T3 (tripwires.mjs).

import { evaluatePolicy, DEFAULT_MIN_ESS, DEFAULT_CLIP, DEFAULT_CLIP_WARN_FRAC } from "./ope.mjs";

export const GATE_VERSION = "gate1";

/**
 * Gate an arm-level policy change on set-level OPE.
 *
 * @param {Array} rows  [{ logPropensity, reward, targetPropensity? }]
 * @param {Object} opts {
 *   targetPropensityOf: (row, i) => number — required when rows lack targetPropensity,
 *   minESS, clip, clipWarnFrac — forwarded to ope.mjs,
 *   vetoThreshold: dr below this (with ips agreeing) vetoes (default 0),
 * }
 * @returns {Object} {
 *   verdict: "pass"|"flagged"|"veto", refused, reason,
 *   estimates: { ips, snips, dr, ess, n, clipped, clippedFrac } | null,
 * }
 */
export function gatePolicyChange(rows, opts = {}) {
  const {
    targetPropensityOf = null,
    minESS = DEFAULT_MIN_ESS,
    clip = DEFAULT_CLIP,
    clipWarnFrac = DEFAULT_CLIP_WARN_FRAC,
    vetoThreshold = 0,
  } = opts;

  const n = Array.isArray(rows) ? rows.length : 0;
  const built = [];
  for (let i = 0; i < n; i++) {
    const r = rows[i] ?? {};
    const tp = r.targetPropensity !== undefined
      ? r.targetPropensity
      : (typeof targetPropensityOf === "function" ? targetPropensityOf(r, i) : undefined);
    built.push({ logPropensity: r.logPropensity, targetPropensity: tp, reward: r.reward });
  }

  const est = evaluatePolicy(built, { clip, minESS, clipWarnFrac });
  if (est.refused) {
    // Honest refusal: no overlap / degenerate logging policy. The change is
    // FLAGGED (ships for human review), never silently blocked or passed.
    return {
      verdict: "flagged", refused: true, reason: est.reason, estimates: null,
      ess: est.ess ?? null, n: est.n ?? n,
    };
  }

  const { ips, dr, clipped } = est;
  if (clipped) {
    return {
      verdict: "flagged", refused: false,
      reason: `gate: estimate clipped (clippedFrac ${est.clippedFrac}) — treat as diagnostic, not decision-grade`,
      estimates: est,
    };
  }
  if (dr < vetoThreshold && ips < vetoThreshold) {
    return {
      verdict: "veto", refused: false,
      reason: `gate: candidate expected to lose (dr ${dr.toFixed(4)}, ips ${ips.toFixed(4)} < ${vetoThreshold})`,
      estimates: est,
    };
  }
  return { verdict: "pass", refused: false, reason: "gate: OPE estimates clean, candidate not worse", estimates: est };
}
