// Repotify v2 recommendation pipeline: narrow -> score -> (arbitrate) -> present.
//
// Signal cascade: fingerprint + taxonomy (free) -> graph traversal (free) ->
// local scoring (free) -> Jev arbitration (paid and opt-in, only when the top
// optional candidates are genuinely ambiguous). When the demand is too thin to
// pick extras, the default path offers the core backbone and says why instead
// of guessing (the agent then asks the questions from `repotify questions`).

import { narrowCandidates } from "./narrow.mjs";
import { scoreCandidates, needsArbitration, MIN_CANDIDATE_FIT } from "./score.mjs";
import { present, candidateTable } from "./present.mjs";
import { scoreWithFleet } from "../../telemetry/fleet-policy.mjs";
import { buildDemand, pickLoadout } from "../../../src/recommend.mjs";

export { narrowCandidates } from "./narrow.mjs";
export { scoreCandidates, needsArbitration, freshnessOf, gateOf, classFitOf, BASELINE_WEIGHTS, MERIT_WEIGHTS, AMBIGUITY_MARGIN, MIN_CANDIDATE_FIT } from "./score.mjs";
export { present, candidateTable, resolveExclusions, selectSet, uncertaintyOf, MIN_V1_SCORE, MIN_DEFAULT_FIT, DEFAULT_BUDGET_CHARS, MAX_TABLE_ROWS, coverageVariant, COVERAGE_VARIANTS, SCORE_MARGIN, JACCARD_DROP, GATE_REASONS } from "./present.mjs";

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
// Answers can add what the files cannot show: stacks and products the project uses (`answers.stacks`) and the
// platforms it targets (`answers.platforms`). Unknown ids are ignored. `agents` are the agents asking, when known:
// items none of them can use are held back.
export function demandFor({ catalog, fingerprint, needs, answers = {}, agents = [] }) {
  const loadout = fingerprint?.empty ? pickLoadout(catalog.loadouts ?? [], needs ?? {}) : null;
  const exclusiveGroups = {};
  const capPlatforms = {};
  for (const [id, c] of Object.entries(catalog.taxonomy?.capabilities ?? {})) {
    if (c.exclusiveGroup) exclusiveGroups[id] = c.exclusiveGroup;
    if (c.platform) capPlatforms[id] = c.platform;
  }
  const said = (Array.isArray(answers?.stacks) ? answers.stacks : []).filter((s) => catalog.taxonomy?.stacks?.[s]);
  const platforms = (Array.isArray(answers?.platforms) ? answers.platforms : []).filter((p) => ["web", "mobile", "desktop"].includes(p));
  const base = buildDemand({ taxonomy: catalog.taxonomy, fingerprint, needs });
  return {
    ...base,
    capPlatforms,
    platforms: [...new Set([...base.platforms, ...platforms])].sort(),
    stacks: [...new Set([...(fingerprint?.stacks ?? []), ...said])],
    answered: needs?.answered ?? [],
    loadoutIds: loadout?.items ?? [],
    exclusiveGroups,
    agents,
  };
}

// Candidates scored for this demand, noise below the fit floor left out, with the
// fleet prior (if any) blended in.
function rank(narrowed, demand, { fleetPolicy = null, jevSignal = null } = {}) {
  const scored = scoreCandidates(narrowed, demand, { jevSignal, minFit: MIN_CANDIDATE_FIT });
  return fleetPolicy != null ? scoreWithFleet(scored, fleetPolicy) : scored;
}

// The catalog items already installed, scored like candidates so the table can show them.
const installedRows = (narrowed, demand) =>
  scoreCandidates({ candidates: (narrowed.installed ?? []).map((item) => ({ item, reasons: [] })) }, demand);

const tableOf = (scored, { set, installed, demand, narrowed, decision }) =>
  candidateTable(scored, { set, installed, exclusiveGroups: demand.exclusiveGroups ?? {}, exclusions: narrowed.exclusions, alternates: decision === "recommend" });

// The deterministic serving path without the paid or random layers (no Jev
// arbitration, no exploration swap). The eval runs this; recommendV1 is this
// plus those optional layers.
export function recommendLocal({ catalog, graph, demand, installed = [], blocked = [], budgetChars, answers = {} }, { fleetPolicy = null } = {}) {
  const narrowed = narrowCandidates({ catalog, graph, demand, installed, blocked, answers });
  const scored = rank(narrowed, demand, { fleetPolicy });
  const held = installedRows(narrowed, demand);
  const result = present(scored, demand, { budgetChars, exclusions: narrowed.exclusions, installed: held });
  const table = tableOf(scored, { set: result.set, installed: held, demand, narrowed, decision: result.decision });
  return { ...result, table, narrowed, scored };
}

export async function recommendV1(
  { catalog, graph, demand, installed = [], blocked = [], budgetChars, answers = {} },
  { arbitrate = null, fleetPolicy = null, exploreEpsilon = 0, rng = Math.random } = {},
) {
  const narrowed = narrowCandidates({ catalog, graph, demand, installed, blocked, answers });
  let scored = rank(narrowed, demand, { fleetPolicy });
  const fleetApplied = fleetPolicy != null;
  let arbitrated = false;
  // Only optional items compete: core items fit every project, top the ranking
  // everywhere (and tie with each other), and are in the set regardless.
  const optional = scored.filter((s) => s.item.tier !== "core");
  if (arbitrate && needsArbitration(optional)) {
    const topIds = optional.slice(0, 4).map((s) => s.item.id);
    try {
      const signal = await arbitrate(topIds);
      if (signal && typeof signal === "object") {
        // The fleet prior belongs to the ranking the user sees: it is re-applied
        // on top of the arbitrated baseline so arbitration can't be silently
        // undone by the blend (or vice versa).
        scored = rank(narrowed, demand, { fleetPolicy, jevSignal: signal });
        arbitrated = true;
      }
    } catch {
      // Arbitration is advisory; a failure degrades to the local ranking.
    }
  }
  const held = installedRows(narrowed, demand);
  const result = present(scored, demand, { budgetChars, exclusions: narrowed.exclusions, installed: held });
  let table = tableOf(scored, { set: result.set, installed: held, demand, narrowed, decision: result.decision });
  // P3 / DL-051: ε-greedy exploration in the serving path, per decision (each
  // recommendation episode). The swap happens after arbitration and present,
  // and only between rows of the candidate table, so it keeps every gate: with
  // prob ε the lowest-scoring optional set item makes way for a uniformly
  // random alternate (a job nobody holds yet). Core items are never swapped
  // out. The learning-loop consumer is lib/learn/ope.mjs (DL-051c).
  let explored = false;
  let exploreItemId = null;
  let finalSet = result.set;
  const alternates = table.filter((r) => !r.default && !r.installed);
  if (exploreEpsilon > 0 && result.decision === "recommend" && rng() < exploreEpsilon && alternates.length) {
    const victim = result.set
      .map((id) => scored.find((s) => s.item.id === id))
      .filter((s) => s && s.item.tier !== "core")
      .sort((a, b) => a.score - b.score)[0];
    if (victim) {
      const pick = alternates[Math.floor(rng() * alternates.length)];
      finalSet = result.set.map((id) => (id === victim.item.id ? pick.id : id));
      explored = true;
      exploreItemId = pick.id;
      table = tableOf(scored, { set: finalSet, installed: held, demand, narrowed, decision: result.decision });
    }
  }
  return {
    ...result,
    set: finalSet,
    table,
    installed: held.map((s) => s.item.id),
    explored,
    exploreItemId,
    exploreEpsilon,
    exploreCandidates: alternates.length,
    arbitrated,
    fleetApplied,
    eliminated: narrowed.eliminated,
    unmet: narrowed.unmet,
    wantedCaps: narrowed.wantedCaps,
    widenedCaps: narrowed.widenedCaps,
    ranked: scored.map((s) => ({ id: s.item.id, score: s.score, flags: s.flags, reasons: s.reasons ?? [], fleetAdjusted: !!s.fleetAdjusted })),
  };
}
