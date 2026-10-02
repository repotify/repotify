// Repotify v2 recommendation pipeline, v1: narrow -> score -> (arbitrate) -> present.
//
// Signal cascade: fingerprint + taxonomy (free) -> graph traversal (free) ->
// local scoring (free) -> Jev arbitration (paid, only when the top of the
// ranking is genuinely ambiguous) -> questions ordered by information gain
// (asked only when both prior tiers are empty of the needed evidence).
// The default path rejects rather than guessing.

import { narrowCandidates } from "./narrow.mjs";
import { scoreCandidates, needsArbitration, AMBIGUITY_MARGIN } from "./score.mjs";
import { present } from "./present.mjs";
import { questionsByGain, nextQuestion } from "./order.mjs";
import { auditInstalls } from "./audit.mjs";
import { scoreWithFleet } from "../../telemetry/fleet-policy.mjs";
import { buildDemand, pickLoadout } from "../../../src/recommend.mjs";

export { narrowCandidates } from "./narrow.mjs";
export { scoreCandidates, needsArbitration, freshnessOf, gateOf, classFitOf, BASELINE_WEIGHTS, MERIT_WEIGHTS, AMBIGUITY_MARGIN } from "./score.mjs";
export { present, resolveExclusions, selectSet, uncertaintyOf, MIN_V1_SCORE, MIN_DEFAULT_FIT, DEFAULT_BUDGET_CHARS, coverageVariant, COVERAGE_VARIANTS, SCORE_MARGIN, JACCARD_DROP, GATE_REASONS } from "./present.mjs";
export { orderQuestions, questionsByGain, nextQuestion } from "./order.mjs";
export { auditInstalls, scanInstalls } from "./audit.mjs";

// arbitrate: optional async (ids: string[]) => Record<id, 0..1>. Consulted only
// when the local ranking leaves the top slot ambiguous. The wire format is
// caller-owned; lib/signals/jev.mjs exports arbitrateWithJev, the Jev-backed
// implementation of this contract (returns null on any failure, and the
// pipeline then keeps the local ranking).
//
// fleetPolicy: optional fleet-policy.json document (arrived via `repotify
// sync`). When present, the FAZ 9 fleet prior is blended in AFTER the frozen
// P5 baseline (scoreCandidates is never touched) and BEFORE arbitration, so
// Jev arbitrates the ranking the user would actually see. This ordering is
// deliberate (FAZ 9 debate d2): when fleet evidence genuinely separates two
// close candidates, the ambiguity is resolved by data and arbitration is
// correctly skipped — the ±0.1 clamp keeps that influence bounded, and
// arbitration still fires on the blended scores whenever they stay close.
// The blend is bounded (±0.1) and every touched row carries
// fleetAdjusted: true.
// The demand the CLI serves: the shared taxonomy/need-weight translation plus the
// fingerprint stacks and answered keys the narrower and scorer read. The eval
// builds its demand here too, so it measures exactly what users get.
// An empty project has no files to read, so its curated loadout (picked from the
// answers) stands in for the missing stack and capability evidence.
export function demandFor({ catalog, fingerprint, needs }) {
  const loadout = fingerprint?.empty ? pickLoadout(catalog.loadouts ?? [], needs ?? {}) : null;
  const exclusiveGroups = {};
  for (const [id, c] of Object.entries(catalog.taxonomy?.capabilities ?? {})) if (c.exclusiveGroup) exclusiveGroups[id] = c.exclusiveGroup;
  return {
    ...buildDemand({ taxonomy: catalog.taxonomy, fingerprint, needs }),
    stacks: fingerprint?.stacks ?? [],
    answered: needs?.answered ?? [],
    loadoutIds: loadout?.items ?? [],
    exclusiveGroups,
  };
}

// The deterministic serving path without the paid or random layers (no Jev
// arbitration, no exploration swap). The eval runs this; recommendV1 is this
// plus those optional layers.
export function recommendLocal({ catalog, graph, demand, installed = [], blocked = [], budgetChars, answers = {} }, { fleetPolicy = null } = {}) {
  const narrowed = narrowCandidates({ catalog, graph, demand, installed, blocked, answers });
  let scored = scoreCandidates(narrowed, demand);
  if (fleetPolicy != null) scored = scoreWithFleet(scored, fleetPolicy);
  const result = present(scored, demand, { budgetChars, exclusions: narrowed.exclusions });
  return { ...result, narrowed, scored };
}

export async function recommendV1(
  { catalog, graph, demand, installed = [], blocked = [], budgetChars, answers = {} },
  { arbitrate = null, fleetPolicy = null, exploreEpsilon = 0, rng = Math.random } = {},
) {
  const narrowed = narrowCandidates({ catalog, graph, demand, installed, blocked, answers });
  let scored = scoreCandidates(narrowed, demand);
  const fleetApplied = fleetPolicy != null;
  if (fleetApplied) {
    scored = scoreWithFleet(scored, fleetPolicy);
  }
  let arbitrated = false;
  if (arbitrate && needsArbitration(scored)) {
    const topIds = scored.slice(0, 4).map((s) => s.item.id);
    try {
      const signal = await arbitrate(topIds);
      if (signal && typeof signal === "object") {
        scored = scoreCandidates(narrowed, demand, { jevSignal: signal });
        // The fleet prior belongs to the ranking the user sees: re-apply it
        // on top of the arbitrated baseline so arbitration can't be silently
        // undone by the blend (or vice versa).
        if (fleetApplied) scored = scoreWithFleet(scored, fleetPolicy);
        arbitrated = true;
      }
    } catch {
      // Arbitration is advisory; a failure degrades to the local ranking.
    }
  }
  const result = present(scored, demand, { budgetChars, exclusions: narrowed.exclusions });
  // P3 / DL-051: ε-greedy exploration in the serving path. Quota granularity
  // is per-decision (each recommendation episode). The swap happens AFTER
  // arbitrate and present, using only candidates that passed all safety
  // filters (ranked list) — this resolves the arbitrate interaction (DL-051b):
  // perturbation is neither silently zeroed nor constraint-bypassing.
  // With prob ε, replace the lowest-scoring set item with a uniformly random
  // non-set candidate. The learning-loop consumer is lib/learn/ope.mjs (DL-051c).
  let explored = false;
  let exploreItemId = null;
  let finalSet = result.set;
  if (exploreEpsilon > 0 && result.decision === "recommend" && rng() < exploreEpsilon) {
    const setIds = new Set(result.set);
    const candidates = scored.filter((s) => !setIds.has(s.item.id));
    if (candidates.length > 0 && result.set.length > 0) {
      const pick = candidates[Math.floor(rng() * candidates.length)];
      // Replace the lowest-scoring set item (keeps the set size stable).
      const setScored = result.set
        .map((id) => scored.find((s) => s.item.id === id))
        .filter(Boolean);
      setScored.sort((a, b) => a.score - b.score);
      const victim = setScored[0];
      if (victim) {
        finalSet = result.set.map((id) => (id === victim.item.id ? pick.item.id : id));
        explored = true;
        exploreItemId = pick.item.id;
      }
    }
  }
  return {
    ...result,
    set: finalSet,
    explored,
    exploreItemId,
    exploreEpsilon,
    arbitrated,
    fleetApplied,
    eliminated: narrowed.eliminated,
    unmet: narrowed.unmet,
    wantedCaps: narrowed.wantedCaps,
    widenedCaps: narrowed.widenedCaps,
    ranked: scored.map((s) => ({ id: s.item.id, score: s.score, flags: s.flags, fleetAdjusted: !!s.fleetAdjusted })),
  };
}
