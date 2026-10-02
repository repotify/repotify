// P4: forgetting schedule (odul-attribution-karar.md §4 madde 4).
//
// Delayed rewards (7–30 day windows) lock stale targets into the posterior:
// a skill that was good in January keeps its January theta in December.
// The cheapest antidote is periodic exponential forgetting on the existing
// LinUCBArm.decay(gamma):  A <- gamma*A + (1-gamma)*lambda*I ; b <- gamma*b.
//
// This module is the SCHEDULE, not the math: it answers "is a decay due?"
// and applies it to every arm of a policy. gamma stays in [0.9, 0.99) per
// the design doc; gamma=1 is a documented no-op (decay disabled).
//
// Persistence of lastDecayAt is the caller's job (fleet policy file, local
// state, …). This module never touches disk.
//
// All product-facing text in this repo is English (repo AGENTS.md).

export const DECAY_INTERVAL_MS = 30 * 24 * 3600 * 1000; // monthly
export const DECAY_GAMMA_DEFAULT = 0.95;
export const DECAY_GAMMA_MIN = 0.9;
export const DECAY_GAMMA_MAX = 0.99; // exclusive upper bound per design; 1.0 = disabled

/**
 * Normalize an ISO string / Date / epoch-ms number / null to epoch ms.
 * null/undefined/unparseable → null (caller treats as "never").
 */
function toMs(t) {
  if (t === null || t === undefined) return null;
  if (typeof t === "number") return Number.isFinite(t) ? t : null;
  const ms = t instanceof Date ? t.getTime() : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Create a decay schedule.
 * @param {Object} opts { gamma, intervalMs, now }
 * @returns {{ due(lastDecayAt): {due, overdueMs}, apply(policy, lastDecayAt): {applied, decayedArms, at} }}
 *   policy: a LinUCB instance (has .arms Map of LinUCBArm).
 */
export function createDecayScheduler({
  gamma = DECAY_GAMMA_DEFAULT,
  intervalMs = DECAY_INTERVAL_MS,
  now = () => new Date(),
} = {}) {
  if (typeof gamma !== "number" || !(gamma >= 0 && gamma <= 1)) {
    throw new Error("decay: gamma must be in [0, 1]");
  }
  if (!(intervalMs > 0)) throw new Error("decay: intervalMs must be positive");

  /** Is a decay due? lastDecayAt: ISO string / Date / ms / null (never). */
  function due(lastDecayAt) {
    const lastMs = toMs(lastDecayAt);
    const nowMs = toMs(now());
    if (lastMs === null) return { due: true, overdueMs: null, reason: "never-decayed" };
    const elapsed = nowMs - lastMs;
    return {
      due: elapsed >= intervalMs,
      overdueMs: Math.max(0, elapsed - intervalMs),
      reason: elapsed >= intervalMs ? "interval-elapsed" : "not-due",
    };
  }

  /**
   * Apply gamma decay to every arm when due. Returns { applied, decayedArms, at }.
   * gamma=1 → { applied: false, reason: "disabled" } (documented no-op).
   * The caller persists the returned `at` as the new lastDecayAt.
   */
  function apply(policy, lastDecayAt) {
    const at = new Date(toMs(now())).toISOString();
    if (gamma === 1) return { applied: false, reason: "disabled", decayedArms: 0, at };
    const d = due(lastDecayAt);
    if (!d.due) return { applied: false, reason: d.reason, decayedArms: 0, at };
    let decayedArms = 0;
    for (const arm of policy.arms.values()) {
      arm.decay(gamma);
      decayedArms++;
    }
    return { applied: true, decayedArms, at, gamma, overdueMs: d.overdueMs };
  }

  return { due, apply, gamma, intervalMs };
}
