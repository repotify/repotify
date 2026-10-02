// Canonical composite reward R(x,a) — versioned, byte-identical everywhere.
//
// DL-001 (LOCKED):
//   R(x,a) = w1*invoked_unique + w2*outcome_delta + w3*kept_30d
//            - w4*removed_fast - w5*replaced [+ w6*installed, hard cap <= 0.10]
// Two-tier execution (DL-044):
//   (i)  the bandit's GRADIENT update happens exactly once per decision, at the
//        slowest applicable window close (DL-005) — `oneShotLabel()`;
//   (ii) fast signals drive the ONLINE PROXY tier: short-horizon serving-score
//        updates and proxy calibration (DL-020/B3) — `proxyFeatures()` — which
//        affect what is served but never emit a second gradient update.
// Cross-scale normalization (DL-043): rank normalization within the cohort is
// canonical; z-score is diagnostic only.
//
// DL-003: token_* fields are rejected as training labels (reported separately).
// DL-048: this pure function is the serving-side twin of FAZ 1's frozen
// reference fixture (test/fixtures/reward-reference.mjs): identical inputs
// (the label row from lib/telemetry/labels.mjs) must produce identical labels.
//
// Weights (DL-002, served until fleet data exists):
//   w1 invoked_unique 0.35 in [0.30, 0.40]
//   w2 outcome_delta  0.30 in [0.25, 0.35]
//   w3 kept_30d       0.20 in [0.15, 0.25]  (biased positive; keeping costs nothing)
//   w4 removed_fast   0.30 in [0.25, 0.40]  (penalty)
//   w5 replaced       0.35 >= w4            (strongest negative)
//   w6 installed      0.10 <= 0.10          (symbolic; never buys rank)

export const REWARD_VERSION = "r1";

export const DEFAULT_WEIGHTS = Object.freeze({
  w1: 0.35, // invoked_unique
  w2: 0.30, // outcome_delta
  w3: 0.20, // kept_30d
  w4: 0.30, // removed_fast (penalty)
  w5: 0.35, // replaced (penalty, strongest)
  w6: 0.10, // installed (capped, symbolic)
});

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** CI-enforced invariants from DL-002 (caps + ordering). Throws on violation. */
export function assertWeightsValid(w = DEFAULT_WEIGHTS) {
  const errs = [];
  const pos = [w.w1, w.w2, w.w3];
  for (const [k, v] of Object.entries(w)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) errs.push(`${k} must be a finite non-negative number`);
  }
  if (Math.max(...pos) > 0.40 + 1e-12) errs.push("no positive term may exceed 0.40 (DL-002)");
  if (w.w1 < 0.30 - 1e-12 || w.w1 > 0.40 + 1e-12) errs.push("w1 out of [0.30, 0.40]");
  if (w.w2 < 0.25 - 1e-12 || w.w2 > 0.35 + 1e-12) errs.push("w2 out of [0.25, 0.35]");
  if (w.w3 < 0.15 - 1e-12 || w.w3 > 0.25 + 1e-12) errs.push("w3 out of [0.15, 0.25]");
  if (w.w4 < 0.25 - 1e-12 || w.w4 > 0.40 + 1e-12) errs.push("w4 out of [0.25, 0.40]");
  if (w.w5 + 1e-12 < w.w4) errs.push("w5 must be >= w4 (replaced is the strongest negative)");
  if (w.w6 > 0.10 + 1e-12) errs.push("w6 installed hard cap 0.10 exceeded (DL-004)");
  if (errs.length) throw new Error(`reward weights invalid: ${errs.join("; ")}`);
  return true;
}

// ---- component extractors (raw label signals -> [0,1] or [-1,1] components) ----

/** invoked_unique: unique (session, skill) successful loads; gaming-resistant.
 *  Binary presence (>=1 distinct session), not a count: within one episode,
 *  extra sessions are confounded by task length, and raw counts were removed
 *  as gameable by the jury (Fix 3). Scale differences across the cohort are
 *  handled by rank normalization.
 *
 *  P4: when invoke_observed === false the invoke channel is blind and the
 *  component is MASKED — returns null (unknown), never 0. "Not observed = 0"
 *  is systematic bias against redacted/external arms, not evidence of absence.
 *  Legacy rows (invoke_observed null/absent) keep the old 1/0 semantics (DL-048). */
export function invokedUnique(signals) {
  if (signals.invoke_observed === false) return null;
  return signals.invoked_sessions > 0 ? 1 : 0;
}

/** P4: true/false when the label row pins the observation channel, null for legacy rows. */
export function isInvokeObserved(signals) {
  if (signals.invoke_observed === true) return true;
  if (signals.invoke_observed === false) return false;
  return null;
}

/** P4: components excluded from the scalar because they are unobserved (masked, not zero). */
export function maskedComponents(signals) {
  const m = [];
  if (signals.invoke_observed === false) m.push("invoked_unique");
  return m;
}

/**
 * outcome_delta: task outcome vs the project's own skill-free baseline
 * (difference-in-differences cancels project-difficulty confounds).
 * +1 full win over baseline, -1 full loss, 0 when unobserved.
 *
 * P4 call-gated attribution: when the invoke channel is fully observed and the
 * arm was never invoked, it cannot have caused the outcome — it gets no
 * outcome credit (0), even if a shared outcome was recorded. "Equal split to
 * every arm" was the worst attribution; the gate is provably less biased.
 * Arms on a blind channel keep the shared outcome, flagged (see outcomeGated).
 */
export function outcomeDelta(signals) {
  if (signals.invoke_observed === true && !(signals.invoked_sessions > 0)) return 0;
  if (signals.outcome_success === null || signals.outcome_success === undefined) return 0;
  const success = signals.outcome_success ? 1 : 0;
  const baseline = signals.outcome_skill_free_baseline === null ||
    signals.outcome_skill_free_baseline === undefined
    ? 0.5
    : (signals.outcome_skill_free_baseline ? 1 : 0);
  return success - baseline;
}

/** P4: was this arm's outcome credit gated off by the call gate? */
export function outcomeGated(signals) {
  return signals.invoke_observed === true &&
    !(signals.invoked_sessions > 0) &&
    (signals.outcome_success !== null && signals.outcome_success !== undefined);
}

export function kept30d(signals) { return signals.kept_30d ? 1 : 0; }
export function removedFast(signals) { return signals.removed_fast ? 1 : 0; }
export function replaced(signals) { return signals.replaced_by ? 1 : 0; }

// ---- composite ----

/**
 * Raw composite (un-normalized). Pure function of the joined label signals.
 * kept_30d is only meaningful on month1-window labels; on earlier windows it
 * is simply false (DL-005: each window's label stands on its own signals).
 *
 * KNOWN RESIDUAL (critic's finding, FAZ 6 debate): invoked_unique (+w1) and
 * removed_fast (-w4) do not fully cancel: a skill that is invoked once and
 * then quickly removed nets +0.35 - 0.30 = +0.05, so "tried and rejected"
 * slightly beats "never tried". The weights are locked (DL-001/DL-002, w4
 * capped at 0.30), so this cannot be fixed by re-weighting here. Mitigation
 * is fleet-level, not local: FAZ 9 must monitor removed_fast rate per skill
 * and treat a high try-then-remove pattern as a negative catalog signal.
 */
export function compositeReward(signals, weights = DEFAULT_WEIGHTS) {
  assertWeightsValid(weights);
  // P4: masked components (unobserved invoke channel) contribute 0 to the
  // scalar — numerically identical to the old 0, but explicitly recorded as
  // masked (see compositeRewardDetailed), never mistaken for negative evidence.
  const iu = invokedUnique(signals);
  return (
    weights.w1 * (iu === null ? 0 : iu) +
    weights.w2 * outcomeDelta(signals) +
    weights.w3 * kept30d(signals) -
    weights.w4 * removedFast(signals) -
    weights.w5 * replaced(signals) +
    weights.w6 * 1 // installed: the label exists, so exposure happened
  );
}

/**
 * P4: composite reward plus the attribution audit trail. The scalar is
 * identical to compositeReward(); `masked` lists components excluded for
 * lack of observation, `outcome_gated` flags call-gated outcome credit,
 * `invoke_observed` pins the observation channel.
 */
export function compositeRewardDetailed(signals, weights = DEFAULT_WEIGHTS) {
  return {
    reward: compositeReward(signals, weights),
    masked: maskedComponents(signals),
    outcome_gated: outcomeGated(signals),
    invoke_observed: isInvokeObserved(signals),
  };
}

/**
 * DL-044 tier (ii): fast-only components available before the 30-day window
 * closes. Feeds the online proxy tier (serving-score updates, B3 calibration).
 * Never a gradient label.
 */
export function proxyFeatures(signals) {
  return {
    invoked_unique: invokedUnique(signals),
    outcome_delta: outcomeDelta(signals),
    removed_fast: removedFast(signals),
    replaced: replaced(signals),
    installed: 1,
    // kept_30d is NOT a fast signal — the proxy tier predicts it (B3).
  };
}

/**
 * DL-044 tier (i): exactly one gradient example per (episode_id, skill_id),
 * emitted at the slowest applicable window close (DL-005). `window` is
 * "week1" | "month1" from the LabelJoiner.
 */
export function oneShotLabel(labelRow, weights = DEFAULT_WEIGHTS) {
  if (!labelRow || !labelRow.signals) throw new Error("reward: oneShotLabel needs a label row with signals");
  const detailed = compositeRewardDetailed(labelRow.signals, weights);
  return {
    reward_version: REWARD_VERSION,
    label_id: labelRow.label_id,
    episode_id: labelRow.episode_id,
    skill_id: labelRow.skill_id,
    window: labelRow.window,
    reward: detailed.reward,
    // P4 attribution audit trail (additive; legacy rows get null/[]/false).
    invoke_observed: detailed.invoke_observed,
    masked_components: detailed.masked,
    outcome_gated: detailed.outcome_gated,
  };
}

// ---- normalization (DL-043: rank canonical, z-score diagnostic) ----

/**
 * Rank normalization within the cohort: maps raw rewards to [0,1] via
 * (rank - 1) / (n - 1). Robust to outliers and to scale-gaming of any single
 * signal; degrades gracefully on tiny cohorts. Ties share the average rank.
 * This is THE training normalization.
 */
export function rankNormalize(values) {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based
    for (let k = i; k <= j; k++) ranks[order[k][1]] = avgRank;
    i = j + 1;
  }
  return ranks.map((r) => (r - 1) / (n - 1));
}

/** Z-score normalization: diagnostic only, never the training path. */
export function zScoreNormalize(values) {
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  if (!(sd > 0)) return values.map(() => 0);
  return values.map((v) => (v - mean) / sd);
}

/** DL-003: token_* must never enter the training label. */
export function assertNoTokenFields(signals) {
  for (const k of Object.keys(signals)) {
    if (k.startsWith("token_")) throw new Error(`reward: token field '${k}' excluded from training label (DL-003)`);
  }
  return true;
}

// Convenience: full pipeline for a batch of closed labels.
export function labelBatch(labelRows, weights = DEFAULT_WEIGHTS) {
  const raw = labelRows.map((row) => {
    assertNoTokenFields(row.signals);
    return oneShotLabel(row, weights);
  });
  const normed = rankNormalize(raw.map((l) => l.reward));
  return raw.map((l, i) => ({ ...l, reward_rank: normed[i] }));
}
