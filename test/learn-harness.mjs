// ROLE: shared helper, not a test file. Imported by test/learn-sim.test.mjs
// (the real node:test cases live there); `npm test` only runs test/*.test.mjs,
// so this module never executes on its own.
// FAZ 6 acceptance harness (DL-022) — synthetic user flow, deterministic seeds.
//
// Simulates 200 rounds of: recommend -> (virtual) 7/14/30-day windows ->
// one-shot label -> bandit update. Three harness arms (DL-047):
//   1. linucb   — the learner: LinUCB + feature perturbation (B1)
//   2. baseline — FAZ 5 simple score (lib/pipeline/recommend/score.mjs), static
//   3. quota    — blind uniform-random control (DL-007/D2, DL-049)
//
// Train/eval reward separation (DL-022):
//   TRAIN: rank-normalized (DL-043) DL-001 composite from simulated events,
//          exactly one gradient update per (episode, skill) at the slowest
//          applicable window close (DL-005/DL-044). The bandit never sees the
//          oracle.
//   EVAL: oracle true expected quality per (round, arm). Regret is computed
//         on the eval reward only — the learner cannot grade its own homework.
//
// Delayed labels: virtual time advances through the windows (DL-047); a label
// opened at round t closes at t + LABEL_DELAY rounds. Fast signals additionally
// feed the online proxy tier every round (DL-044 ii) without emitting gradient
// updates — the harness asserts <=1 gradient example per episode.
//
// DATA-REGIME CAVEAT (critic's finding, FAZ 6 debate): 200 dense rounds
// validate the LEARNING DYNAMICS (does LinUCB beat the static baseline when
// labels flow?), not the calendar-time data rate. Production accumulates the
// same 200 labels over months at single-digit monthly volumes per user; until
// then the system is warm-start prior + light personalization, and the UCB
// bonus does most of the work. Do not read the regret ratios as
// "production regret after N months".

import { LinUCB, FEATURE_DIM } from "../lib/learn/linucb.mjs";
import { selectPerturbed, quotaPick, makeRng } from "../lib/learn/explore.mjs";
import { oneShotLabel, rankNormalize, proxyFeatures } from "../lib/learn/reward.mjs";
import { accumulateFromLabels, warmStartArm } from "../lib/learn/warmstart.mjs";
import { scoreCandidates } from "../lib/pipeline/recommend/score.mjs";

export const SIM_SEED = 20261001;
export const N_ROUNDS = 200;
export const N_ARMS = 8;
export const D_CTX = 32;
export const LABEL_DELAY = 8; // virtual rounds until the slowest window closes

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// ---- synthetic world: context-specialized skills, static scores lie ----

function randn(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Builds the world. Static catalog features (what the FAZ 5 baseline sees)
 * are deliberately misaligned with true quality: the baseline's top pick is a
 * mediocre generalist, while true quality is context-dependent and belongs to
 * arms the static score ranks low. This is the honest test: can the learner
 * beat hand-made priors by listening to context?
 */
export function buildWorld(seed = SIM_SEED) {
  const rng = makeRng(seed);
  const arms = [];
  for (let a = 0; a < N_ARMS; a++) {
    const embed = Array.from({ length: FEATURE_DIM - D_CTX }, () => randn(rng));
    // sparse specialization vector: 4 strong dims out of 32
    const v = new Array(D_CTX).fill(0);
    const dims = new Set();
    while (dims.size < 4) dims.add(Math.floor(rng() * D_CTX));
    for (const d of dims) v[d] = (rng() < 0.5 ? -1 : 1) * (0.8 + rng() * 0.7);
    // bias: INVERSELY related to static score (the trap for the baseline)
    const bias = 0.9 - a * 0.22 + (rng() - 0.5) * 0.1;
    arms.push({ id: `skill-${a}`, embed, v, bias });
  }
  // Static catalog features for the baseline: arm 0 looks best on paper.
  const catalogCandidates = arms.map((arm, a) => ({
    item: {
      id: arm.id,
      capabilities: a === 0
        ? ["lint", "test", "format", "docs", "ci"]
        : ["lint", "test"].slice(0, a % 2 === 0 ? 2 : 1),
      needs: ["javascript"],
      stacks: ["node"],
      tier: a === 0 ? "stack" : "general",
      security: { level: a === 7 ? "caution" : "verified" },
      signals: { lastCommitDays: a * 12 },
    },
  }));
  const demand = {
    capabilitiesWanted: ["lint", "test", "format", "docs", "ci"],
    needs: ["javascript"],
    stacks: ["node"],
  };
  return { arms, catalogCandidates, demand, rng };
}

export function roundContext(world, t) {
  // Deterministic per-round context: re-seed from (seed, t) so every policy
  // arm faces identical contexts (fair comparison).
  const rng = makeRng(SIM_SEED * 31 + t * 101);
  return Array.from({ length: D_CTX }, () => randn(rng));
}

/** Per-arm feature vector x_{t,a} = normalize([context; armEmbed]), d=64. */
export function armFeatures(world, ctx, a) {
  const x = [...ctx, ...world.arms[a].embed];
  const n = Math.sqrt(x.reduce((s, v) => s + v * v, 0)) || 1;
  return x.map((v) => v / n);
}

/** Oracle true expected quality (EVAL reward — hidden from learners). */
export function trueQuality(world, ctx, a) {
  const arm = world.arms[a];
  let s = arm.bias;
  for (let i = 0; i < D_CTX; i++) s += arm.v[i] * ctx[i] * 0.8;
  return sigmoid(s);
}

// ---- event simulation: quality -> raw telemetry-like signals ----

export function simulateSignals(q, rng) {
  const invoked = rng() < sigmoid(6 * (q - 0.5));
  const invoked_sessions = invoked ? 1 + Math.floor(rng() * 2) : 0;
  const outcome_success = invoked ? rng() < sigmoid(6 * (q - 0.5)) : null;
  const outcome_skill_free_baseline = invoked ? rng() < 0.45 : null;
  const removed_fast = rng() < sigmoid(-6 * (q - 0.5)) * 0.9;
  const replaced_by = removed_fast && rng() < 0.6 ? "skill-other" : null;
  const kept_30d = !removed_fast && rng() < sigmoid(5 * (q - 0.5));
  return {
    invoked_count: invoked_sessions,
    invoked_sessions,
    invoked_explicit: invoked_sessions,
    invoked_implicit: 0,
    invoked_load: 0,
    outcome_count: invoked ? 1 : 0,
    outcome_success,
    outcome_shared: false,
    outcome_quality: null,
    outcome_skill_free_baseline,
    abandoned_count: 0,
    fallback_count: 0,
    questions_asked: 0,
    questions_answered: 0,
    kept_30d,
    removed_fast,
    removed: removed_fast || (!kept_30d && rng() < 0.1),
    removal_reason: removed_fast ? "unused" : null,
    replaced_by,
    tokens_in_sum: 0, tokens_out_sum: 0, latency_ms_sum: 0, latency_ms_count: 0,
  };
}

// ---- one policy run through the 200-round script ----

/**
 * @param {"linucb"|"baseline"|"quota"} policyName
 * @param {Object} opts { warmLabels } — warmLabels: historical label rows for B2 warm-start
 */
export function runPolicy(world, policyName, { warmLabels = null, alpha = 1.0 } = {}) {
  const rng = makeRng(SIM_SEED + policyName.length * 777 + (policyName === "quota" ? 5 : 0));
  const contexts = (t) => {
    const ctx = roundContext(world, t);
    const out = {};
    for (let a = 0; a < N_ARMS; a++) out[world.arms[a].id] = armFeatures(world, ctx, a);
    return { ctx, feats: out };
  };

  let linucb = null;
  let baselinePick = null;
  if (policyName === "linucb") {
    // alpha=0.5: serving hyperparameter (not a locked decision). Rank-normalized
    // rewards live in [0,1] with unit-norm features; a sim sweep showed 0.5
    // beats the literature default 1.0 here (less over-exploration on noisy
    // quantized labels). Re-tune when real label statistics exist.
    linucb = new LinUCB({ alpha });
    if (warmLabels) {
      const acc = accumulateFromLabels(warmLabels, (row) => row._x);
      for (const arm of world.arms) warmStartArm(linucb, arm.id, acc);
    }
  } else if (policyName === "baseline") {
    const scored = scoreCandidates({ candidates: world.catalogCandidates }, world.demand);
    baselinePick = scored[0].item.id;
  }

  const pending = []; // decisions awaiting their window close
  const closedRaw = []; // raw composite rewards (rolling rank-norm cohort)
  const gradPerEpisode = new Map();
  let cumRegret = 0;
  let explorePicks = 0;
  const proxyTrace = []; // fast proxy features per round (DL-044 ii evidence)
  const regretTrace = []; // per-round eval regret (for early-regret comparisons)

  for (let t = 0; t < N_ROUNDS; t++) {
    const { ctx, feats } = contexts(t);

    // --- serve ---
    let pick;
    if (policyName === "linucb") {
      const sel = selectPerturbed(linucb, feats, { sigma: 0.05, mc: 24, seed: 5000 + t });
      pick = sel.armId;
      // schema invariant on every logged propensity (B1)
      for (const p of Object.values(sel.propensities)) {
        if (!(p > 0) || !(p < 1)) throw new Error("harness: propensity escaped (0,1)");
      }
    } else if (policyName === "baseline") {
      pick = baselinePick;
    } else {
      pick = quotaPick(world.arms.map((a) => a.id), rng);
      explorePicks++;
    }

    // --- eval reward (oracle; the learner never sees this) ---
    const qs = world.arms.map((_, a) => trueQuality(world, ctx, a));
    const best = Math.max(...qs);
    const chosenIdx = world.arms.findIndex((a) => a.id === pick);
    const roundRegret = best - qs[chosenIdx];
    cumRegret += roundRegret;
    regretTrace.push(roundRegret);

    // --- simulate the world: events -> hold -> delayed one-shot label ---
    const q = qs[chosenIdx];
    const signals = simulateSignals(q, rng);
    proxyTrace.push(proxyFeatures(signals)); // online proxy tier sees this NOW (no gradient)
    pending.push({
      episode: t, skill_id: pick, x: feats[pick],
      labelRow: {
        label_id: `label-${policyName}-${t}`, episode_id: `ep-${t}`, skill_id: pick,
        window: "month1", signals,
      },
      closeAt: t + LABEL_DELAY,
    });

    // --- close matured windows: exactly one gradient update per decision ---
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].closeAt <= t) {
        const d = pending.splice(i, 1)[0];
        const raw = oneShotLabel(d.labelRow).reward;
        closedRaw.push(raw);
        // rolling rank normalization (DL-043) over recent closed labels
        const cohort = closedRaw.slice(-64);
        const rank = cohort.filter((v) => v <= raw).length / cohort.length;
        const key = `${d.episode}::${d.skill_id}`;
        gradPerEpisode.set(key, (gradPerEpisode.get(key) ?? 0) + 1);
        if (policyName === "linucb") linucb.observe(d.skill_id, d.x, rank);
      }
    }
  }

  // Virtual time advances past the horizon so every label closes (DL-047):
  // these train the model but do NOT add eval regret (clock stopped at 200).
  for (const d of pending.splice(0)) {
    const raw = oneShotLabel(d.labelRow).reward;
    closedRaw.push(raw);
    const cohort = closedRaw.slice(-64);
    const rank = cohort.filter((v) => v <= raw).length / cohort.length;
    const key = `${d.episode}::${d.skill_id}`;
    gradPerEpisode.set(key, (gradPerEpisode.get(key) ?? 0) + 1);
    if (policyName === "linucb") linucb.observe(d.skill_id, d.x, rank);
  }

  const maxGrad = Math.max(...gradPerEpisode.values());
  return {
    policy: policyName,
    cumRegret,
    decisions: N_ROUNDS,
    labelsClosed: gradPerEpisode.size,
    maxGradPerEpisode: maxGrad, // DL-044 verification: must be 1
    explorePicks,
    proxyRounds: proxyTrace.length,
    regretTrace,
  };
}

/** Generate historical labels (uniform-random serving) for B2 warm-start tests. */
export function generateHistory(world, n = 120) {
  const rng = makeRng(SIM_SEED + 4242);
  const rows = [];
  for (let t = 0; t < n; t++) {
    const ctx = roundContext(world, 100000 + t); // disjoint round ids from the main script
    const a = Math.floor(rng() * N_ARMS);
    const q = trueQuality(world, ctx, a);
    rows.push({
      label_id: `hist-${t}`, episode_id: `hist-ep-${t}`, skill_id: world.arms[a].id,
      window: "month1", signals: simulateSignals(q, rng),
      _x: armFeatures(world, ctx, a), // decision-time context (rehydrated from snapshot ref in prod)
    });
  }
  return rows;
}
