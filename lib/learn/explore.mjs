// Exploration: feature perturbation (B1) + blind-quota control arm (DL-007/DL-049).
//
// Why perturbation and not epsilon-greedy:
//   A deterministic argmax policy has propensity exactly 1 for the chosen arm,
//   which kills IPS/SNIPS and any offline replay (the telemetry schema already
//   requires 0 < propensity < 1 per candidate). Perturbing the *input feature
//   vector* x~ = x + N(0, sigma^2 I) before scoring reintroduces loggable
//   randomness whose propensity is well-defined and strictly below 1, while
//   keeping exploration directed by the model's own uncertainty (unlike blind
//   epsilon draws). See research finding B1; theory: "Exploration via Feature
//   Perturbation in Contextual Bandits" (GLM-FP, arXiv 2510.17390).
//
// Quota arm (DL-049): a small blind uniform-random control group, pinned at
// <=5% of eligible serving decisions. It is the model-free control for FAZ 9
// claims, NOT the exploration mechanism. The flat 10% tax is gone (DL-007).
//
// Deterministic RNG: mulberry32 seeded per decision so simulations and replays
// are reproducible. Production callers pass a crypto-seeded seed.

export const QUOTA_RATE = 0.05; // DL-049: pinned, asserted from the first instrumented build

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function next() {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller standard normal from a uniform rng. */
export function randn(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Perturb a context vector: x~ = x + sigma * N(0, I).
 * "Micro-noise": sigma must be small relative to feature scale (features are
 * expected ~unit-norm; default sigma=0.05 keeps the perturbed vector in the
 * same decision neighborhood while flipping close calls).
 */
export function perturbContext(x, sigma, rng) {
  if (!(sigma > 0)) throw new Error("explore: sigma must be > 0");
  if (typeof rng !== "function") throw new Error("explore: rng function required");
  const out = new Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + sigma * randn(rng);
  return out;
}

/**
 * Perturbed-argmax selection. Scores each arm on an independently perturbed
 * context, picks the argmax. Independent per-arm noise (not one shared draw)
 * avoids the GLM-FP paper's coupling pathology where a single shared direction
 * can simultaneously boost well-explored arms and starve underexplored ones.
 *
 * Returns { armId, propensities, perturbed: bool }.
 * propensities: per-arm P(win) estimated by Monte Carlo over `mc` draws,
 * clamped to [1/mc, 1 - 1/mc] so the logged propensity always satisfies
 * 0 < p < 1 (schema requirement, B1).
 */
export function selectPerturbed(linucb, contexts, {
  sigma = 0.05,
  mc = 64,
  seed = 1,
  alpha,
} = {}) {
  const armIds = Object.keys(contexts);
  if (!armIds.length) throw new Error("explore: no candidate arms");
  const rng = makeRng(seed);
  const wins = Object.fromEntries(armIds.map((id) => [id, 0]));
  let firstPick = null;

  for (let m = 0; m < mc; m++) {
    const perturbed = {};
    for (const id of armIds) perturbed[id] = perturbContext(contexts[id], sigma, rng);
    const pick = linucb.select(perturbed, alpha === undefined ? {} : { alpha }).armId;
    wins[pick] += 1;
    if (m === 0) firstPick = pick;
  }

  const propensities = {};
  for (const id of armIds) {
    // Clamp: never exactly 0 or 1 (schema: 0 < p < 1; IPS needs p > 0).
    propensities[id] = Math.min(1 - 1 / mc, Math.max(1 / mc, wins[id] / mc));
  }
  return { armId: firstPick, propensities, perturbed: true, mc };
}

/**
 * Blind-quota control arm (DL-007/D2, DL-049).
 * Uniform random pick over eligible arms, used on <=5% of decisions as the
 * experiment/control group. `isQuotaRound` is a deterministic token bucket:
 * quota decisions never exceed QUOTA_RATE of all eligible decisions.
 */
export class QuotaGuard {
  constructor({ rate = QUOTA_RATE } = {}) {
    if (!(rate > 0) || !(rate < 1)) throw new Error("QuotaGuard: rate must be in (0,1)");
    this.rate = rate;
    this.eligible = 0;
    this.quotaTaken = 0;
  }

  /** Call once per eligible serving decision; true = this decision is quota. */
  take() {
    this.eligible += 1;
    // Token bucket: quotaTaken / eligible must stay <= rate.
    if (this.quotaTaken < this.rate * this.eligible) {
      this.quotaTaken += 1;
      return true;
    }
    return false;
  }

  observedRate() {
    return this.eligible ? this.quotaTaken / this.eligible : 0;
  }

  /** Hard assertion for tests/CI: the quota can never be exceeded. */
  assertWithinQuota() {
    if (this.quotaTaken > this.rate * this.eligible + 1e-9) {
      throw new Error(`QuotaGuard: quota exceeded (${this.quotaTaken}/${this.eligible})`);
    }
  }
}

/** Uniform random pick (the quota arm's policy). */
export function quotaPick(armIds, rng) {
  if (!armIds.length) throw new Error("explore: quotaPick needs arms");
  return armIds[Math.floor(rng() * armIds.length)];
}

/** Cold-start eligibility: epsilon (the quota) is the ONLY blind exploration
 *  a never-seen arm gets — new arms enter via quota draws or warm-start. */
export function isColdStart(arm) {
  return arm.pulls === 0;
}
