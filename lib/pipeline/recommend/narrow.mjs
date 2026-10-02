// v1 signal narrowing: free, deterministic candidate elimination from the seed
// context (fingerprint + taxonomy). No LLM, no Jev, zero user cost.
//
// Input demand: { stacks, platforms, capabilitiesWanted, capWeights, needs, needWeights }.
// Elimination order (all cheap, all reversible, all explained):
//   1. security gate: blocked verdict items are out, always.
//   2. platform mismatch: web-only skills for a project with no web target are out.
//   3. capability mismatch: an item whose capabilities and needs share nothing
//      with the demand is out (unless it is a stack match for a used stack).
//   4. stack mismatch for stack-tier items: stack items only survive for stacks
//      the project actually uses.
//   5. already-installed items are not candidates (they are reported separately).
//
// Every elimination carries a reason code so the agent can explain itself.

import { candidatesFor, providersFor, expandDependencies } from "../graph/index.mjs";

// Reuse the platform rules from the existing recommendation engine.
export function platformMismatch(item, { platforms = [], webOnlyCaps = new Set() }) {
  if (!platforms.length || platforms.includes("web") || !webOnlyCaps.size) return false;
  return item.capabilities.length > 0 && item.capabilities.every((c) => webOnlyCaps.has(c));
}

const intersect = (a = [], b = []) => a.filter((x) => b.includes(x));

// Graph-driven candidate discovery: wanted capabilities -> providers (with
// fallback expansion), widened by DEPENDS_ON, then narrowed by the rules above.
export function narrowCandidates({ catalog, graph, demand, installed = [], blocked = [], answers = {} }) {
  const installedSet = new Set(installed);
  const blockedSet = new Set(blocked);
  const wanted = [...new Set(demand.capabilitiesWanted ?? [])];
  const widened = [...new Set([...wanted, ...expandDependencies(graph, wanted)])];

  const { candidates, exclusions, unmet } = candidatesFor(graph, widened, { blockedItems: blockedSet });

  const itemById = new Map(catalog.items.map((i) => [i.id, i]));
  const kept = [];
  const eliminated = [];

  for (const c of candidates) {
    const it = itemById.get(c.id);
    if (!it) {
      eliminated.push({ id: c.id, reasons: ["not-in-catalog"] });
      continue;
    }
    const reasons = [];
    if (it.security?.level === "blocked") reasons.push("security:blocked");
    if (blockedSet.has(it.id)) reasons.push("user:blocked");
    if (installedSet.has(it.id)) reasons.push("already-installed");
    if (platformMismatch(it, demand)) reasons.push("platform:mismatch");
    const caps = intersect(it.capabilities, wanted);
    const needs = intersect(it.needs ?? [], demand.needs ?? []);
    const stacks = intersect(it.stacks ?? [], demand.stacks ?? []);
    const stackItem = it.tier === "stack" && !(it.stacks ?? []).includes("*");
    if (!caps.length && !needs.length && !stacks.length) reasons.push("demand:no-overlap");
    if (stackItem && !stacks.length) reasons.push("stack:mismatch");
    if (reasons.length) eliminated.push({ id: it.id, reasons });
    else kept.push({ item: it, graphCaps: c.caps, viaFallback: c.viaFallback, supersedes: c.supersedes, reasons: [...caps.map((x) => `cap:${x}`), ...needs.map((x) => `need:${x}`), ...stacks.map((x) => `stack:${x}`)] });
  }

  // Catalog items with strong demand overlap but no graph PROVIDES edge still
  // deserve a look: the graph is a seed, not a closed world. They enter with a
  // flag so the scorer knows the provenance. Hard gates still eliminate with
  // reasons instead of silently skipping.
  const graphIds = new Set([...candidates.map((c) => c.id), ...eliminated.map((e) => e.id)]);
  for (const it of catalog.items) {
    if (graphIds.has(it.id)) continue;
    const preReasons = [];
    if (installedSet.has(it.id)) preReasons.push("already-installed");
    if (blockedSet.has(it.id)) preReasons.push("user:blocked");
    const hardReasons = [];
    if (it.security?.level === "blocked") hardReasons.push("security:blocked");
    if (platformMismatch(it, demand)) hardReasons.push("platform:mismatch");
    const caps = intersect(it.capabilities, wanted);
    const needs = intersect(it.needs ?? [], demand.needs ?? []);
    const stacks = intersect(it.stacks ?? [], demand.stacks ?? []);
    const stackItem = it.tier === "stack" && !(it.stacks ?? []).includes("*");
    if (!caps.length && !needs.length && !stacks.length) hardReasons.push("demand:no-overlap");
    if (stackItem && !stacks.length) hardReasons.push("stack:mismatch");
    const reasons = [...preReasons, ...hardReasons];
    if (reasons.length) {
      eliminated.push({ id: it.id, reasons });
      continue;
    }
    kept.push({ item: it, graphCaps: [], viaFallback: false, supersedes: [], offGraph: true, reasons: [...caps.map((x) => `cap:${x}`), ...needs.map((x) => `need:${x}`), ...stacks.map((x) => `stack:${x}`)] });
  }

  return {
    candidates: kept,
    eliminated,
    exclusions,
    unmet,
    wantedCaps: wanted,
    widenedCaps: widened,
    answered: Object.keys(answers ?? {}),
  };
}
