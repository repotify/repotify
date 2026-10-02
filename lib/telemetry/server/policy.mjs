// Nightly fleet policy computation — the "sürünün zekası" (wisdom of the herd).
//
// Input: the admitted aggregate snapshot (server/aggregate.mjs) — per-skill
// counter sums over distinct syncs, thin buckets already suppressed.
//
// Output: fleet-policy.json — per-skill EFFECTIVENESS, the public PROOF
// ("which skill is best at which job"). The RECIPE stays server-side: raw
// counter breakdowns, per-sync rows, nonces, and the weighting below never
// leave the server (publish strategy: KANIT açık, TARİF gizli).
//
// Effectiveness is an empirical-Bayes shrinkage estimate over the strong
// slow signals, aligned with the DL-001 reward components:
//   pos = kept_30d + outcome_success        (retention + task success)
//   neg = removed_fast + removed + replaced + outcome_failure
//   effectiveness = (pos + a0) / (pos + neg + a0 + b0),  a0 = b0 = 2
// The skeptical Beta(2,2) prior shrinks thin-but-admitted buckets toward 0.5
// so a skill with 5 syncs cannot outrank a skill with 500 on noise.
// A 95% Wilson interval rides along for the acceptance reporting.
//
// Node 18+, no dependencies. Pure function: same snapshot in, same policy out.

import { FLEET_POLICY_SCHEMA, FLEET_MIN_GROUP_INSTALLS } from "./thresholds.mjs";

export const POLICY_VERSION = "fleet/1";
// Skeptical prior: Beta(a0, b0). A skill needs real evidence to move far from 0.5.
// FAZ 9 debate d4: a FIXED Beta(2,2) shrinks toward 0.5 even when the fleet
// mean is far from 0.5 (systematic bias for thin skills). The principled fix
// is an empirical-Bayes prior — estimate (a0, b0) from the fleet via MLE each
// window and ship it inside the policy document. Kept as Beta(2,2) for FAZ 9:
// with k>=5 admission the likelihood dominates quickly, and the P5 acceptance
// passed on this estimator. FAZ 10 candidate.
const PRIOR_A = 2, PRIOR_B = 2;

/** 95% Wilson score interval for k successes in n trials. */
export function wilsonInterval(k, n, z = 1.96) {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

function effectivenessOf(counters) {
  const pos = (counters.kept_30d ?? 0) + (counters.outcome_success ?? 0);
  const neg = (counters.removed_fast ?? 0) + (counters.removed ?? 0) +
    (counters.replaced ?? 0) + (counters.outcome_failure ?? 0);
  const n = pos + neg;
  const effectiveness = (pos + PRIOR_A) / (n + PRIOR_A + PRIOR_B);
  const { lo, hi } = wilsonInterval(pos, n);
  return { effectiveness, n, ci_lo: lo, ci_hi: hi };
}

/**
 * Compute the fleet policy from an admitted snapshot.
 * Returns the fleet-policy.json document (JSON-serializable, deterministic).
 */
export function computeFleetPolicy(snapshot, { now = () => new Date() } = {}) {
  const skills = {};
  let resuppressed = 0;
  for (const [skillId, bucket] of Object.entries(snapshot.skills ?? {})) {
    // Defense-in-depth (FAZ 10 GLM debate, policy-B): the >=5-nonce gate is
    // enforced in aggregate.mjs, but re-verify here — a hand-built or stale
    // snapshot must never publish a thin skill into fleet-policy.json.
    if ((bucket.contributing_syncs ?? 0) < FLEET_MIN_GROUP_INSTALLS) {
      resuppressed += 1;
      continue;
    }
    const { effectiveness, n, ci_lo, ci_hi } = effectivenessOf(bucket.counters);
    skills[skillId] = {
      effectiveness: Math.round(effectiveness * 10000) / 10000,
      n,
      ci_lo: Math.round(ci_lo * 10000) / 10000,
      ci_hi: Math.round(ci_hi * 10000) / 10000,
    };
  }
  return {
    schema: FLEET_POLICY_SCHEMA,
    version: POLICY_VERSION,
    computed_at: new Date(now()).toISOString(),
    window_start: snapshot.window_start ?? null,
    window_end: snapshot.window_end ?? null,
    contributing_syncs: snapshot.admitted_syncs ?? 0,
    skills_published: Object.keys(skills).length,
    skills_suppressed: (snapshot.suppressed ?? []).length + resuppressed,
    // Proof, not recipe: effectiveness + evidence weight + CI. No raw
    // counter breakdowns, no per-sync rows, no nonces.
    skills,
  };
}
