// P4 tripwires (odul-attribution-karar.md §4): monitoring alarms for the
// hybrid attribution design. These DETECT; they never act. A tripped wire
// means "the design's assumptions broke — a human (Ahmet) decides what to
// do". There is no automatic rollback anywhere in this module.
//
//   T1: 30 days in, invoke_observed=true coverage over installed skills < 80%
//       → call-gating is fiction; outcome credit must retreat to OPE-only.
//   T2: winner's curse — arms that share episodes inflate their outcome
//       thetas together (correlated), i.e. shared luck learned as merit.
//   T3: OPE refuses for 90 consecutive days → the B layer is decorative;
//       the safety check degrades to an n>=30 harness A/B.
//
// All functions are pure (inputs in, verdict out). checkedAt is injected via
// opts.now for testability.
//
// All product-facing text in this repo is English (repo AGENTS.md).

import { pearson } from "./calibrate.mjs";

export const TRIPWIRE_VERSION = "tw1";
export const T1_MIN_COVERAGE = 0.8;
export const T1_MIN_ROWS = 10;
export const T2_MIN_SHARED_EPISODES = 5;
export const T2_CORR_THRESHOLD = 0.7;
export const T3_MAX_REFUSAL_DAYS = 90;

function verdict(id, tripped, detail) {
  return {
    tripwire: id,
    tripped: Boolean(tripped),
    checkedAt: new Date().toISOString(),
    detail,
  };
}

/**
 * T1 — observability coverage.
 * @param {Array} labelRows  closed label rows (need signals.invoke_observed)
 * @param {Object} opts { minCoverage, minRows }
 * Coverage = P(invoke_observed === true) over rows whose observability is
 * known (legacy "unknown" rows are excluded from the denominator — they are
 * pre-instrumentation, not evidence of blindness).
 */
export function checkT1(labelRows, { minCoverage = T1_MIN_COVERAGE, minRows = T1_MIN_ROWS } = {}) {
  const known = (labelRows ?? []).filter(
    (r) => r?.signals && (r.signals.invoke_observed === true || r.signals.invoke_observed === false)
  );
  if (known.length < minRows) {
    return verdict("T1", false, {
      reason: "insufficient_data",
      known: known.length, minRows,
      note: "T1 needs 30 days of instrumented labels; silence is not a pass",
    });
  }
  const covered = known.filter((r) => r.signals.invoke_observed === true).length;
  const coverage = covered / known.length;
  return verdict("T1", coverage < minCoverage, {
    coverage: +coverage.toFixed(4),
    covered, known: known.length, minCoverage,
    ...(coverage < minCoverage
      ? { action: "call-gating is fiction — retreat outcome credit to OPE-only (human decision)" }
      : { action: "none" }),
  });
}

/**
 * T2 — winner's curse (correlated outcome inflation).
 * @param {Array} labelRows  closed label rows ({ episode_id, skill_id, signals })
 * For every pair of arms sharing >= minShared episodes, correlate their
 * outcome_delta series across the shared episodes. If the mean pairwise
 * correlation exceeds the threshold, shared episode luck is being learned
 * as individual arm merit.
 */
export function checkT2(
  labelRows,
  { minShared = T2_MIN_SHARED_EPISODES, corrThreshold = T2_CORR_THRESHOLD } = {}
) {
  const rows = (labelRows ?? []).filter((r) => r?.episode_id && r?.skill_id && r?.signals);
  // arm -> Map(episode_id -> outcome_delta)
  const byArm = new Map();
  for (const r of rows) {
    const d = r.signals.outcome_success === null || r.signals.outcome_success === undefined
      ? 0
      : (r.signals.outcome_success ? 1 : 0) - 0.5;
    if (!byArm.has(r.skill_id)) byArm.set(r.skill_id, new Map());
    byArm.get(r.skill_id).set(r.episode_id, d);
  }
  const arms = [...byArm.keys()];
  const corrs = [];
  const pairs = [];
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const a = byArm.get(arms[i]), b = byArm.get(arms[j]);
      const shared = [...a.keys()].filter((e) => b.has(e));
      if (shared.length < minShared) continue;
      const xs = shared.map((e) => a.get(e));
      const ys = shared.map((e) => b.get(e));
      const c = pearson(xs, ys);
      if (c !== null) { corrs.push(c); pairs.push({ arms: [arms[i], arms[j]], shared: shared.length, corr: +c.toFixed(4) }); }
    }
  }
  if (!corrs.length) {
    return verdict("T2", false, {
      reason: "insufficient_data",
      pairs: 0, minShared,
      note: "no arm pair shares enough episodes yet",
    });
  }
  const mean = corrs.reduce((s, c) => s + c, 0) / corrs.length;
  const worst = pairs.reduce((w, p) => (p.corr > w.corr ? p : w), pairs[0]);
  return verdict("T2", mean > corrThreshold, {
    meanCorr: +mean.toFixed(4), pairs: pairs.length, corrThreshold, worstPair: worst,
    ...(mean > corrThreshold
      ? { action: "tighten gating threshold or lower outcome weight in the gradient (weight change = Ahmet approval)" }
      : { action: "none" }),
  });
}

/**
 * T3 — OPE refusal streak.
 * @param {Array} refusalLog  chronological [{ day: "YYYY-MM-DD", refused: bool }, …]
 *   (one entry per day the gate ran; from policy-gate.mjs verdicts).
 * Trips when the trailing run of refused days reaches maxRefusalDays.
 */
export function checkT3(refusalLog, { maxRefusalDays = T3_MAX_REFUSAL_DAYS } = {}) {
  const log = (refusalLog ?? []).slice().sort((a, b) => (a.day < b.day ? -1 : 1));
  let streak = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].refused) streak++;
    else break;
  }
  return verdict("T3", streak >= maxRefusalDays, {
    refusalStreakDays: streak, maxRefusalDays, logDays: log.length,
    ...(streak >= maxRefusalDays
      ? { action: "B layer is decorative — degrade safety check to an n>=30 harness A/B (human decision)" }
      : { action: "none" }),
  });
}
