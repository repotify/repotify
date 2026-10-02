// Scoring: how well the item fits this project, times how good the item is.
// Deterministic, no LLM.
//
//   score = classFit * merit + 0.05 * jev
//   merit = 0.35 * quality + 0.25 * gate + 0.20 * adoption + 0.10 * freshness + 0.10 * community
//
// The FAZ9 baseline (0.45 classFit + 0.30 gate + 0.20 freshness) left the jury's
// quality verdict and adoption out of the ranking: gate and freshness are ~1 for
// almost every catalog item, so a weak skill that shares one capability token
// tied a strong one, and the shortest description won the slot. Measured on the
// eval scenarios served through this engine: 49% must-include recall with the
// baseline plus one-per-cluster, 100% with merit. The merit parts and weights are
// the ones the v1 engine shipped with (src/recommend.mjs), shared, not copied.
//
// classFit: how well the item matches the demand (capabilities, needs, stacks).
// gate:     security verdict — verified 1.0, caution 0.5, blocked never scores.
// freshness: commit recency from catalog signals.
// jev:      optional 0..1 arbitration signal for ambiguous branches (Jev is a
//           SIGNAL, not the decider: 0.05 weight, and only consulted when the
//           top candidates are within the ambiguity margin).
//
// Low-confidence flags ride along so the presenter can mark or reject.

import { WEIGHTS as MERIT_WEIGHTS, qualityScore, adoptionScore, communityScore, fitScore } from "../../../src/recommend.mjs";

export { MERIT_WEIGHTS };
export const BASELINE_WEIGHTS = { classFit: 1, jev: 0.05 };
export const AMBIGUITY_MARGIN = 0.08;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function freshnessOf(signals = {}) {
  const d = signals.lastCommitDays;
  if (d == null) return 0.5;
  if (d <= 30) return 1;
  return clamp01(1 - (d - 30) / 335);
}

export function gateOf(item) {
  const level = item.security?.level;
  if (level === "verified") return 1;
  if (level === "caution") return 0.5;
  return 0; // blocked: never recommended
}

// classFit: does the item do a job this project wants? One matched capability is
// a real fit (a specialist like semgrep serves one job, and serves it fully);
// more matches add a little. The earlier measure — matched / all wanted
// capabilities — scored every specialist near 0.2 and let broad, vague skills
// win. The rule is the v1 engine's fitScore (stack, need-weight and loadout
// handling included), shared with src/recommend.mjs.
export function classFitOf(candidate, demand) {
  const item = candidate.item ?? candidate;
  const ctx = { ...demand, stacks: demand.stacks ?? [], needs: demand.needs ?? [], capabilitiesWanted: demand.capabilitiesWanted ?? [] };
  // Off-graph items (no PROVIDES edge in the seed graph) carry the "off-graph"
  // flag but no fit haircut: the seed graph covers a minority of the catalog,
  // and the unmeasured 20% haircut pushed stack experts and specialists like
  // semgrep under the default-set floor.
  const { fit } = fitScore({ capabilities: [], needs: [], stacks: [], ...item }, ctx);
  return clamp01(fit);
}

// jevSignal: optional map of item id -> 0..1 from a Jev arbitration call.
// Only applied when the local ranking is ambiguous (top-2 gap < margin) —
// otherwise the free local layer decides and Jev is never consulted.
export function scoreCandidates(narrowed, demand, { jevSignal = null } = {}) {
  const scored = narrowed.candidates.map((c) => {
    const parts = {
      classFit: classFitOf(c, demand),
      quality: qualityScore(c.item.jury),
      gate: gateOf(c.item),
      adoption: adoptionScore(c.item.signals),
      freshness: freshnessOf(c.item.signals),
      community: communityScore(c.item.community),
      jev: jevSignal?.[c.item.id] ?? 0,
    };
    parts.merit =
      MERIT_WEIGHTS.quality * parts.quality +
      MERIT_WEIGHTS.trust * parts.gate +
      MERIT_WEIGHTS.adoption * parts.adoption +
      MERIT_WEIGHTS.freshness * parts.freshness +
      MERIT_WEIGHTS.community * parts.community;
    const score = BASELINE_WEIGHTS.classFit * parts.classFit * parts.merit + BASELINE_WEIGHTS.jev * parts.jev;
    const flags = [];
    if (c.offGraph) flags.push("off-graph");
    if (c.viaFallback) flags.push("via-fallback");
    if (parts.gate < 1) flags.push("caution-verdict");
    return { ...c, score: Math.round(score * 1000) / 1000, parts, flags };
  });

  // Sort: score desc, then id for determinism.
  scored.sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : 1));

  // Low-confidence flags that need the full ranked list.
  if (scored.length >= 2 && scored[0].score - scored[1].score < AMBIGUITY_MARGIN) {
    scored[0].flags.push("low-margin");
    scored[1].flags.push("low-margin");
  }
  const thinDemand = (demand.capabilitiesWanted ?? []).length < 2 && !(demand.answered ?? []).length;
  if (thinDemand) for (const s of scored) s.flags.push("thin-demand");
  for (const u of narrowed.unmet ?? []) {
    const s = scored.find((x) => x.item.id === u.item);
    if (s && !s.flags.includes("unmet-requirements")) s.flags.push("unmet-requirements");
  }
  return scored;
}

// Should Jev be consulted at all? Only when the free local ranking leaves a
// genuine tie for the top slot — otherwise arbitration is wasted money.
export function needsArbitration(scored) {
  if (scored.length < 2) return false;
  return scored[0].score - scored[1].score < AMBIGUITY_MARGIN && !scored[0].flags.includes("thin-demand");
}
