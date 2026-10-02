// v1 scoring: the official FAZ9 BASELINE (P5). Hand-made priors, three cheap
// components plus an optional small Jev signal weight. Deterministic, no LLM.
//
//   score = 0.45 * classFit + 0.30 * gate + 0.20 * freshness + 0.05 * jev
//
// classFit: how well the item matches the demand (capabilities, needs, stacks).
// gate:     security verdict — verified 1.0, caution 0.5, blocked never scores.
// freshness: commit recency from catalog signals.
// jev:      optional 0..1 arbitration signal for ambiguous branches (Jev is a
//           SIGNAL, not the decider: 0.05 weight, and only consulted when the
//           top candidates are within the ambiguity margin).
//
// Low-confidence flags ride along so the presenter can mark or reject.

export const BASELINE_WEIGHTS = { classFit: 0.45, gate: 0.3, freshness: 0.2, jev: 0.05 };
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

export function classFitOf(candidate, demand) {
  const item = candidate.item ?? candidate;
  const wanted = new Set(demand.capabilitiesWanted ?? []);
  const caps = (item.capabilities ?? []).filter((c) => wanted.has(c));
  const needs = (item.needs ?? []).filter((n) => (demand.needs ?? []).includes(n));
  const stacks = (item.stacks ?? []).filter((s) => (demand.stacks ?? []).includes(s));
  const anyStack = (item.stacks ?? []).includes("*");
  const capScore = wanted.size ? caps.length / wanted.size : 0;
  const needScore = (demand.needs ?? []).length ? Math.min(1, needs.length / Math.max(1, (demand.needs ?? []).length)) : 0;
  // Stack expertise is the whole point of stack-tier items: a stack match is a full fit.
  const stackScore = item.tier === "stack" && stacks.length ? 1 : 0;
  let fit = Math.max(Math.min(1, capScore * 1.2), needScore * 0.9, stackScore);
  if (!anyStack && (item.stacks ?? []).length && !stacks.length && (demand.stacks ?? []).length) fit *= 0.6;
  // Provenance: a graph PROVIDES edge outranks a coincidental catalog overlap.
  // Unmeasured: provenans cezası for items the graph knows nothing about.
  // Unmeasured operating point: provenance penalty for items the graph knows
  // nothing about (off-graph). 20% is a hand-set haircut, not a measurement.
  if (candidate.offGraph) fit *= 0.8;
  return clamp01(fit);
}

// jevSignal: optional map of item id -> 0..1 from a Jev arbitration call.
// Only applied when the local ranking is ambiguous (top-2 gap < margin) —
// otherwise the free local layer decides and Jev is never consulted.
export function scoreCandidates(narrowed, demand, { jevSignal = null } = {}) {
  const scored = narrowed.candidates.map((c) => {
    const parts = {
      classFit: classFitOf(c, demand),
      gate: gateOf(c.item),
      freshness: freshnessOf(c.item.signals),
      jev: jevSignal?.[c.item.id] ?? 0,
    };
    const score =
      BASELINE_WEIGHTS.classFit * parts.classFit +
      BASELINE_WEIGHTS.gate * parts.gate +
      BASELINE_WEIGHTS.freshness * parts.freshness +
      BASELINE_WEIGHTS.jev * parts.jev;
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
