// OPE research prototype (S15, SWARM-15) — reducing the ESS<30 refusal rate
// WITHOUT relaxing the honesty rules of lib/learn/ope.mjs.
//
// The refusal gate (ESS < 30 on UNCLIPPED weights → refuse; degenerate
// propensity → refuse; clipping fraction reported + flagged) is NOT touched.
// This module never edits ope.mjs; it only adds new, separately-testable
// machinery around it. Every function below is pure, dependency-free, and
// keeps the identical gate semantics — the refusal rate drops because the
// DATA gets better (more of it, better covered), never because the bar moves.
//
// IDEA 1 — multi-epoch MIS pooling (evaluatePolicyMulti):
//   Logs arrive from K epochs, each served by a different logging policy
//   (epsilon changed, the greedy set drifted after a catalog update, the
//   exploration mechanism was swapped). Evaluating each epoch alone refuses
//   on thin epochs. Pooling epochs with the balance heuristic of multiple
//   importance sampling (Veach & Guibas 1995; Owen & Zhou 2000) uses the
//   mixture denominator q(a) = Σ_k (n_k/N)·π_bk(a). The mixture covers the
//   UNION of what each epoch covered, and the balance heuristic is provably
//   near-optimal among MIS estimators — so pooled ESS is typically far above
//   the best single epoch's, and naive concatenation's. Same gate, same flag.
//
// IDEA 2 — coverage-aware logging design + overlap diagnostics:
//   (a) designCoverageLogger: the P3 ε-greedy logger spreads its ε budget
//       uniformly over ~n non-greedy candidates (propensity ε/n ≈ 0.0005),
//       so a target policy that favors any one of them gets weights ≈ 2000
//       and ESS collapses → refusal. Redirecting the SAME ε budget at the
//       candidate policy family — π_b = (1-ε)·greedy + ε·mean_k(π_k) —
//       guarantees every candidate propensity ≥ ε/K on the actions it
//       favors, bounding weights by K/ε. A data-COLLECTION recommendation,
//       not an estimator change.
//   (b) overlapReport: when the gate refuses (or passes thinly), decompose
//       the refusal per action — covered mass, per-action ESS share, top
//       refusal drivers — so the caller learns exactly WHICH logged episodes
//       would grow ESS ("which logs grow ESS?" → the ones where π_b is large
//       where candidate π_e is large).
//   (c) runRefusalBenchmark: deterministic synthetic benchmark measuring the
//       refusal rate of (i) single-epoch P3-style ε-greedy logging,
//       (ii) naive pooling, (iii) MIS pooling, (iv) coverage-aware logging —
//       the "X% → Y%" evidence, on synthetic data, gate unchanged.

export const OPE_ARASTIRMA_VERSION = "ope-arastirma1";

import { evaluatePolicy, DEFAULT_CLIP, DEFAULT_MIN_ESS, DEFAULT_CLIP_WARN_FRAC } from "./ope.mjs";

/**
 * Evaluate a candidate policy on logs pooled from K epochs with different
 * logging policies, via the balance heuristic (multiple importance sampling).
 *
 * @param {Array} epochs  [{ rows }] — each epoch's rows are
 *   { logPropensity, targetPropensity, reward, mixPropensities? } where
 *   logPropensity is the taken action's propensity under THAT epoch's logger
 *   (the B1 logged value, strictly inside (0,1)), and mixPropensities — when
 *   supplied — is the taken action's propensity under EVERY epoch's logger,
 *   in epoch order (values in [0,1]; 0 means "that epoch's logger never takes
 *   this action", which is fine — the mixture denominator only needs the
 *   owning epoch's propensity to be positive).
 *   If NO row supplies mixPropensities, this degrades gracefully to naive
 *   pooling (concatenation; still unbiased, higher variance than MIS).
 * @param {Object} opts  { clip, minESS, clipWarnFrac, qHatTarget, qHatLogged }
 *   — identical semantics to evaluatePolicy in ope.mjs.
 * @returns {Object} evaluatePolicy-shaped result + { epochs, pooled: "mis"|"naive" }.
 *
 * HONESTY (unchanged): degenerate OWN-epoch propensity → refuse; ESS gate on
 * UNCLIPPED pooled weights; clipping fraction reported and flagged.
 */
export function evaluatePolicyMulti(epochs, opts = {}) {
  const {
    clip = DEFAULT_CLIP,
    minESS = DEFAULT_MIN_ESS,
    clipWarnFrac = DEFAULT_CLIP_WARN_FRAC,
    qHatTarget = null,
    qHatLogged = null,
  } = opts;

  if (!Array.isArray(epochs) || epochs.length === 0) {
    return { refused: true, reason: "ope-arastirma: no epochs — nothing to evaluate", n: 0, epochs: 0 };
  }
  const K = epochs.length;
  const perEpoch = epochs.map((e, k) => {
    if (!e || !Array.isArray(e.rows)) {
      return { bad: `ope-arastirma: epoch ${k} has no rows array` };
    }
    return { bad: null, rows: e.rows };
  });
  const firstBad = perEpoch.find((p) => p.bad);
  if (firstBad) return { refused: true, reason: firstBad.bad, n: 0, epochs: K };

  const counts = perEpoch.map((p) => p.rows.length);
  const N = counts.reduce((a, b) => a + b, 0);
  if (N === 0) return { refused: true, reason: "ope-arastirma: no rows — nothing to evaluate", n: 0, epochs: K };

  // Flatten with epoch tags; validate propensities.
  const flat = [];
  for (let k = 0; k < K; k++) {
    for (let i = 0; i < perEpoch[k].rows.length; i++) {
      const r = perEpoch[k].rows[i];
      if (!r || typeof r !== "object") {
        return { refused: true, reason: `ope-arastirma: epoch ${k} row ${i} is not an object`, n: N, epochs: K };
      }
      for (const key of ["logPropensity", "targetPropensity", "reward"]) {
        if (typeof r[key] !== "number" || !Number.isFinite(r[key])) {
          return { refused: true, reason: `ope-arastirma: epoch ${k} row ${i}.${key} must be a finite number`, n: N, epochs: K };
        }
      }
      // B1 invariant, unchanged: the OWN epoch's logged propensity must be
      // strictly inside (0,1). A deterministic slot breaks every estimator.
      if (!(r.logPropensity > 0) || !(r.logPropensity < 1)) {
        return { refused: true, reason: `ope-arastirma: epoch ${k} row ${i} has degenerate logPropensity ${r.logPropensity} — replay impossible`, n: N, epochs: K };
      }
      if (r.targetPropensity < 0 || r.targetPropensity > 1) {
        return { refused: true, reason: `ope-arastirma: epoch ${k} row ${i} targetPropensity outside [0,1]`, n: N, epochs: K };
      }
      const mix = r.mixPropensities;
      if (mix !== undefined && mix !== null) {
        if (!Array.isArray(mix) || mix.length !== K) {
          return { refused: true, reason: `ope-arastirma: epoch ${k} row ${i} mixPropensities must be an array of length ${K}`, n: N, epochs: K };
        }
        for (let j = 0; j < K; j++) {
          if (typeof mix[j] !== "number" || !Number.isFinite(mix[j]) || mix[j] < 0 || mix[j] >= 1) {
            return { refused: true, reason: `ope-arastirma: epoch ${k} row ${i} mixPropensities[${j}] must be in [0,1)`, n: N, epochs: K };
          }
        }
      }
      flat.push({ ...r, _epoch: k });
    }
  }

  const useMis = flat.every((r) => Array.isArray(r.mixPropensities));
  const alpha = counts.map((c) => c / N); // epoch mixture fractions

  // Pooled importance weights (unclipped — the ESS gate sees raw weights).
  const rawWeights = flat.map((r) => {
    if (!useMis) return r.targetPropensity / r.logPropensity; // naive pooling
    let q = 0;
    for (let j = 0; j < K; j++) q += alpha[j] * r.mixPropensities[j];
    // q > 0 always: the owning epoch contributes alpha[k]*logPropensity > 0.
    return r.targetPropensity / q;
  });

  // Identical gate to ope.mjs: ESS on UNCLIPPED weights.
  const sumW = rawWeights.reduce((a, b) => a + b, 0);
  const sumW2 = rawWeights.reduce((a, b) => a + b * b, 0);
  const ess = sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;
  if (ess < minESS) {
    return {
      refused: true, n: N, epochs: K, pooled: useMis ? "mis" : "naive",
      ess: +ess.toFixed(2),
      reason: `ope-arastirma: pooled effective sample size ${ess.toFixed(1)} < ${minESS} — even pooled, the target policy has no overlap with the logging mixture; refusing to estimate`,
    };
  }

  // Reuse the single-epoch machinery by feeding it precomputed weights:
  // emulate rows whose "logPropensity" is defined so that targetPropensity /
  // logPropensity equals the pooled weight. logPropensity' = targetPropensity / w
  // is in (0,1) whenever w > targetPropensity... not guaranteed. Instead,
  // compute the estimators directly here with the same formulas as ope.mjs.
  const weights = new Array(N);
  let clipped = 0;
  for (let i = 0; i < N; i++) {
    let w = rawWeights[i];
    if (w > clip) { w = clip; clipped++; }
    weights[i] = w;
  }
  const rewards = flat.map((r) => r.reward);
  const meanR = rewards.reduce((a, b) => a + b, 0) / N;
  const finiteOr = (v) => (typeof v === "number" && Number.isFinite(v) ? v : meanR);
  const qT = typeof qHatTarget === "function"
    ? flat.map((r, i) => finiteOr(qHatTarget(r, i)))
    : new Array(N).fill(meanR);
  const qL = typeof qHatLogged === "function"
    ? flat.map((r, i) => finiteOr(qHatLogged(r, i)))
    : qT.slice();

  let ipsSum = 0, wSum = 0, wrSum = 0, drSum = 0;
  for (let i = 0; i < N; i++) {
    const w = weights[i], rwd = rewards[i];
    ipsSum += w * rwd;
    wSum += w;
    wrSum += w * rwd;
    drSum += qT[i] + w * (rwd - qL[i]);
  }
  const clippedFrac = clipped / N;
  return {
    ips: ipsSum / N,
    snips: wSum > 0 ? wrSum / wSum : NaN,
    dr: drSum / N,
    ess: +ess.toFixed(2),
    n: N,
    epochs: K,
    pooled: useMis ? "mis" : "naive",
    clippedFrac: +clippedFrac.toFixed(4),
    clipped: clippedFrac > clipWarnFrac,
    weights,
  };
}

/**
 * Overlap/coverage diagnostics for a (possibly refused) evaluation.
 * Answers "WHY was this refused / thin?" by decomposing the importance
 * weights per action: which actions carry the target policy's probability
 * mass, and which of those the logger starved.
 *
 * @param {Array} rows  evaluatePolicy-shaped rows + optional `action` label
 * @param {Object} opts { clip } — weights clipped at clip for the max-weight stat
 * @returns {Object} { ess, n, refusedAt30, perAction: [{ action, n, weightShare,
 *   loggedMass, meanWeight, maxWeight, rawMaxWeight, essShare, starvation }],
 *   topDrivers: [action...] }
 *   weightShare(a) = Σ_{i:a_i=a} w_i / Σw — the self-normalized estimate of the
 *   TARGET policy's probability mass on action a (what the target wants).
 *   loggedMass(a) = n_a/n — what the logger actually served. A refusal driver
 *   is an action with large weightShare and tiny loggedMass: the target wants
 *   it, the logger starved it. Diagnostics only — never an estimate.
 */
export function overlapReport(rows, opts = {}) {
  const { clip = DEFAULT_CLIP } = opts;
  const n = Array.isArray(rows) ? rows.length : 0;
  if (!n) return { ess: 0, n: 0, refusedAt30: true, perAction: [], topDrivers: [] };

  const byAction = new Map();
  let sumW = 0, sumW2 = 0;
  for (const r of rows) {
    const a = r && r.action !== undefined ? String(r.action) : "(unlabeled)";
    const w = r.targetPropensity / r.logPropensity;
    sumW += w; sumW2 += w * w;
    if (!byAction.has(a)) byAction.set(a, { n: 0, sumW: 0, sumW2: 0, maxW: 0 });
    const s = byAction.get(a);
    s.n += 1;
    s.sumW += w; s.sumW2 += w * w;
    if (w > s.maxW) s.maxW = w;
  }
  const ess = sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;
  const perAction = [...byAction.entries()].map(([action, s]) => ({
    action,
    n: s.n,
    weightShare: sumW > 0 ? +(s.sumW / sumW).toFixed(4) : 0,
    loggedMass: +(s.n / n).toFixed(4),
    meanWeight: +(s.sumW / s.n).toFixed(2),
    maxWeight: +Math.min(s.maxW, clip).toFixed(2),
    rawMaxWeight: +s.maxW.toFixed(2),
    // Share of Σw² contributed by this action: where the variance lives.
    essShare: sumW2 > 0 ? +(s.sumW2 / sumW2).toFixed(4) : 0,
    // Starvation: how much more the target wants this action than the
    // logger served it. >>1 = starved overlap = refusal driver.
    starvation: s.n > 0 && sumW > 0 ? +((s.sumW / sumW) / (s.n / n)).toFixed(2) : 0,
  }));
  // Top refusal drivers: highest starvation among actions the target
  // actually wants (non-trivial weight share).
  const topDrivers = perAction
    .filter((p) => p.weightShare >= 0.01)
    .sort((a, b) => b.starvation - a.starvation)
    .slice(0, 5)
    .map((p) => p.action);
  return { ess: +ess.toFixed(2), n, refusedAt30: ess < DEFAULT_MIN_ESS, perAction, topDrivers };
}

/**
 * Coverage-aware logging-policy design (data-collection recommendation).
 * Given K candidate target policies, build π_b = (1-ε)·greedy + ε·mean_k(π_k):
 * the SAME ε exploration budget as P3's ε-greedy, redirected from
 * uniform-over-non-greedy (ε/n per candidate, ≈0.0005) to the candidate
 * family (≥ ε/K per candidate-favored action). Importance weights for any
 * candidate are then bounded by K/ε instead of n/ε.
 *
 * @param {Object} cfg { greedyId, candidates: [{ id, probs: {actionId: p} }],
 *   epsilon, actionIds, uniformFloor }
 *   uniformFloor β ∈ [0,1): fraction of the ε budget kept as a UNIFORM floor
 *   over all actions — the GLM critic's guardrail. β=0 (default) spends the
 *   whole budget on the candidate family (max ESS gain, but support becomes
 *   partial: out-of-family actions get propensity 0). β>0 keeps every action
 *   at propensity ≥ ε·β/n — complete support is preserved, at the cost of a
 *   looser weight bound K/(ε·(1-β)). For any serving implementation, β>0 is
 *   REQUIRED (critic's verdict: without it the gates go blind to support
 *   mismatch).
 * @returns {Object} { propensity(actionId), minPropensity, maxWeightBound,
 *   epsilon, K, uniformFloor } — pure lookup, no I/O.
 */
export function designCoverageLogger({ greedyId, candidates, epsilon = 0.05, actionIds, uniformFloor = 0 }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("designCoverageLogger: candidates must be a non-empty array");
  }
  if (!Array.isArray(actionIds) || actionIds.length === 0) {
    throw new Error("designCoverageLogger: actionIds must be a non-empty array");
  }
  if (!(epsilon > 0) || !(epsilon < 1)) throw new Error("designCoverageLogger: epsilon must be in (0,1)");
  if (!(uniformFloor >= 0) || !(uniformFloor < 1)) throw new Error("designCoverageLogger: uniformFloor must be in [0,1)");
  const K = candidates.length;
  const n = actionIds.length;
  const mean = {};
  for (const a of actionIds) mean[a] = 0;
  for (const c of candidates) {
    for (const a of actionIds) mean[a] += (c.probs[a] ?? 0) / K;
  }
  const propensity = (a) =>
    (1 - epsilon) * (a === greedyId ? 1 : 0) +
    epsilon * ((1 - uniformFloor) * (mean[a] ?? 0) + uniformFloor / n);
  return {
    propensity,
    epsilon,
    K,
    uniformFloor,
    // Worst case over ALL actions (candidate-unfavored actions keep ε·0 = 0
    // from the mixture, but the greedy action keeps (1-ε); actions favored by
    // no candidate and not greedy have propensity 0 — by design: the budget
    // is spent where candidates live).
    minCandidatePropensity: Math.min(...candidates.map((c) => {
      const favored = actionIds.filter((a) => (c.probs[a] ?? 0) > 0);
      return Math.min(...favored.map((a) => propensity(a)));
    })),
    // Uniform floor keeps COMPLETE support when β>0 (critic's guardrail).
    minPropensity: Math.min(...actionIds.map((a) => propensity(a))),
    maxWeightBound: uniformFloor > 0 ? K / (epsilon * (1 - uniformFloor)) : K / epsilon,
  };
}

// --- Deterministic synthetic benchmark -------------------------------------
// World: nActions items, K candidate target policies (each deterministic on a
// distinct item), fixed per-action rewards. Compares four logging/evaluation
// strategies with the IDENTICAL honesty gate (ESS<30 → refuse):
//   A. single-epoch P3-style ε-greedy (ε=0.05, uniform ε/n exploration)
//   B. coverage-aware logger (same ε budget, Idea 2)
//   C. two complementary epochs, best single epoch evaluated alone
//   D. two complementary epochs, naive pooling
//   E. two complementary epochs, MIS pooling (Idea 1)
// Reports refusal rates — the "X% → Y%" evidence on synthetic data.

/** Deterministic PRNG (mulberry32). */
function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function next() {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {Object} cfg { seeds, episodesPerEpoch, nActions, epsilon }
 * @returns {Object} { A: {refusals,total,rate}, B: {...}, C: {...}, D: {...},
 *   E: {...}, truth } — all deterministic given seeds.
 */
export function runRefusalBenchmark({ seeds = [1, 2, 3, 4, 5], episodesPerEpoch = 3000, nActions = 100, epsilon = 0.05 } = {}) {
  const K = 4; // candidate policies
  const candItems = [3, 17, 42, 88]; // distinct items each candidate favors
  const actionIds = Array.from({ length: nActions }, (_, i) => `item${i}`);
  const rewards = {};
  for (let i = 0; i < nActions; i++) rewards[`item${i}`] = 0.2 + 0.6 * ((i * 37) % 10) / 9;

  const candidates = candItems.map((idx, k) => ({
    id: `cand${k}`,
    probs: { [`item${idx}`]: 1 },
  }));

  // Logger A: P3 ε-greedy — greedy item0 at 1-ε+ε/n, everything else ε/n.
  const loggerA = { greedy: "item0", propensity: (a) => (a === "item0" ? (1 - epsilon) + epsilon / nActions : epsilon / nActions) };
  // Logger B: coverage-aware, same ε budget (Idea 2).
  const cov = designCoverageLogger({ greedyId: "item0", candidates, epsilon, actionIds });
  const loggerB = { greedy: "item0", propensity: (a) => cov.propensity(a) };

  const sample = (rng, propFn) => {
    const u = rng();
    let acc = 0;
    for (const a of actionIds) {
      acc += propFn(a);
      if (u < acc) return a;
    }
    return actionIds[actionIds.length - 1];
  };
  const genEpoch = (rng, logger) => {
    const rows = [];
    for (let i = 0; i < episodesPerEpoch; i++) {
      const a = sample(rng, logger.propensity);
      rows.push({
        action: a,
        logPropensity: logger.propensity(a),
        targetPropensity: 0, // filled per target below
        reward: rewards[a],
      });
    }
    return rows;
  };
  const withTarget = (rows, targetItem) => rows.map((r) => ({
    ...r, targetPropensity: r.action === targetItem ? 1 : 0,
  }));

  const tally = { A: { refusals: 0, total: 0 }, B: { refusals: 0, total: 0 }, C: { refusals: 0, total: 0 }, D: { refusals: 0, total: 0 }, E: { refusals: 0, total: 0 } };
  const bump = (key, refused) => { tally[key].total++; if (refused) tally[key].refusals++; };

  for (const seed of seeds) {
    const rng = makeRng(seed);
    // --- A vs B: single-epoch, each candidate target evaluated alone.
    const rowsA = genEpoch(rng, loggerA);
    const rowsB = genEpoch(rng, loggerB);
    for (const item of candItems.map((i) => `item${i}`)) {
      bump("A", !!evaluatePolicy(withTarget(rowsA, item)).refused);
      bump("B", !!evaluatePolicy(withTarget(rowsB, item)).refused);
    }
    // --- C vs D vs E: two complementary epochs (greedy item3 / greedy item17),
    //     target = 50/50 mixture of cand0 and cand1. Each epoch alone starves
    //     one side of the mixture; the mixture denominator covers both.
    const ep1 = { greedy: "item3", propensity: (a) => (a === "item3" ? (1 - epsilon) + epsilon / nActions : epsilon / nActions) };
    const ep2 = { greedy: "item17", propensity: (a) => (a === "item17" ? (1 - epsilon) + epsilon / nActions : epsilon / nActions) };
    const rows1 = genEpoch(rng, ep1);
    const rows2 = genEpoch(rng, ep2);
    // Plant 2 cross rows deterministically: each epoch then structurally
    // contains the thin overlap (w=1000 rows) instead of leaving it to
    // sampling luck (m=0 would let the ESS gate accept a biased estimate —
    // see the CAVEAT test). Single-epoch ESS ≈ 4.5 → refuses, always.
    for (let i = 0; i < 2; i++) {
      rows1[i] = { action: "item17", logPropensity: ep1.propensity("item17"), targetPropensity: 0, reward: rewards.item17 };
      rows2[i] = { action: "item3", logPropensity: ep2.propensity("item3"), targetPropensity: 0, reward: rewards.item3 };
    }
    const mixTarget = (r) => (r.action === "item3" || r.action === "item17" ? 0.5 : 0);
    const t1 = rows1.map((r) => ({ ...r, targetPropensity: mixTarget(r) }));
    const t2 = rows2.map((r) => ({ ...r, targetPropensity: mixTarget(r) }));
    // C: best single epoch.
    const rC1 = evaluatePolicy(t1), rC2 = evaluatePolicy(t2);
    bump("C", !!(rC1.refused && rC2.refused));
    // D: naive pooling (concatenation).
    const naive = evaluatePolicyMulti([{ rows: t1 }, { rows: t2 }]);
    bump("D", !!naive.refused);
    // E: MIS pooling — each row carries its propensity under BOTH loggers.
    const m1 = t1.map((r) => ({ ...r, mixPropensities: [ep1.propensity(r.action), ep2.propensity(r.action)] }));
    const m2 = t2.map((r) => ({ ...r, mixPropensities: [ep1.propensity(r.action), ep2.propensity(r.action)] }));
    const mis = evaluatePolicyMulti([{ rows: m1 }, { rows: m2 }]);
    bump("E", !!mis.refused);
    if (seed === seeds[0]) {
      tally._misEstimate = +mis.snips.toFixed(4);
      tally._misEss = mis.ess;
      tally._truth = +((rewards.item3 + rewards.item17) / 2).toFixed(4);
    }
  }
  const rate = (t) => ({ refusals: t.refusals, total: t.total, rate: +(t.refusals / t.total).toFixed(3) });
  return {
    A_singleEpsGreedy: rate(tally.A),
    B_coverageLogger: rate(tally.B),
    C_bestSingleEpoch: rate(tally.C),
    D_naivePool: rate(tally.D),
    E_misPool: rate(tally.E),
    misSanity: { snips: tally._misEstimate, ess: tally._misEss, truth: tally._truth },
    config: { seeds: seeds.length, episodesPerEpoch, nActions, epsilon, K },
  };
}
