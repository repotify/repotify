// v1 signal narrowing: free, deterministic candidate elimination from the seed
// context (fingerprint + taxonomy). No LLM, no Jev, zero user cost.
//
// Input demand: { stacks, platforms, capabilitiesWanted, capWeights, needs, needWeights }.
// Elimination order (all cheap, all reversible, all explained):
//   1. security gate: blocked verdict items are out, always.
//   2. platform mismatch: web-only skills for a project with no web target are out; so are items made for
//      other agents than the one asking, when that agent is known.
//   3. capability mismatch: an item whose capabilities and needs share nothing
//      with the demand is out (unless it is a stack match for a used stack).
//   4. stack mismatch: an item written for specific stacks (no "*") survives only
//      when the project uses one of them. Stack-tier items always need a match;
//      other items need one whenever the project's stacks are known (a Java
//      skill is noise in a Python repo however well its capabilities match).
//   5. already-installed items are not candidates (they are reported separately and
//      keep their job: see present()), nor is anything that conflicts with one.
// Core items (the always-useful backbone) and loadout picks for an empty project
// skip the overlap and stack rules; the security, user and platform gates still apply.
//
// Every elimination carries a reason code so the agent can explain itself.

import { candidatesFor, providersFor, expandDependencies } from "../graph/index.mjs";

// A job that only makes sense on one platform (reviewing a web UI, automating a phone) is noise for a project that
// shows its platforms and not that one. A project with no platform evidence (a library, an API) keeps every item.
export function platformMismatch(item, { platforms = [], webOnlyCaps = new Set(), capPlatforms = null }) {
  if (!platforms.length) return false;
  const platformOf = (c) => capPlatforms?.[c] ?? (webOnlyCaps.has(c) ? "web" : null);
  return item.capabilities.length > 0 && item.capabilities.every((c) => platformOf(c) && !platforms.includes(platformOf(c)));
}

const intersect = (a = [], b = []) => a.filter((x) => b.includes(x));

// Pairs that must not be installed together: the catalog's own `conflicts` lists and
// the graph's CONFLICTS_WITH edges, keyed both ways.
function conflictIndex(catalog, graph) {
  const index = new Map();
  const add = (a, b) => {
    if (!index.has(a)) index.set(a, new Set());
    index.get(a).add(b);
  };
  for (const it of catalog.items) for (const c of it.conflicts ?? []) {
    add(it.id, c);
    add(c, it.id);
  }
  for (const e of graph?.byType?.get("conflicts_with") ?? []) {
    const a = e.from.slice("item:".length);
    const b = e.to.slice("item:".length);
    add(a, b);
    add(b, a);
  }
  return index;
}

// An item made for other agents than the one asking (a Claude Code hook for a Cursor user) cannot be used. Only
// when the asking agents are known: `demand.agents` is empty otherwise and nothing is held back.
export function agentMismatch(item, { agents = [] } = {}) {
  return agents.length > 0 && Array.isArray(item.agents) && item.agents.length > 0 && !item.agents.some((a) => agents.includes(a));
}

// Graph-driven candidate discovery: wanted capabilities -> providers (with
// fallback expansion), widened by DEPENDS_ON, then narrowed by the rules above.
export function narrowCandidates({ catalog, graph, demand, installed = [], blocked = [], answers = {} }) {
  const installedSet = new Set(installed);
  const blockedSet = new Set(blocked);
  const loadoutSet = new Set(demand.loadoutIds ?? []);
  const projectStacks = demand.stacks ?? [];
  // Demand rules that only apply to optional items: overlap with the demand,
  // and a stack the project uses when the item names specific stacks.
  // Why a kept item is here, for the agent to explain: core and loadout picks
  // carry their tier, everything else the demand it matched.
  const whyKept = (it, { caps, needs, stacks }) => [
    ...(it.tier === "core" ? ["core"] : []),
    ...(loadoutSet.has(it.id) ? ["loadout"] : []),
    ...caps.map((x) => `cap:${x}`),
    ...needs.map((x) => `need:${x}`),
    ...stacks.map((x) => `stack:${x}`),
  ];
  const fitReasons = (it, { caps, needs, stacks }) => {
    if (it.tier === "core" || loadoutSet.has(it.id)) return [];
    const reasons = [];
    const specific = (it.stacks ?? []).length > 0 && !(it.stacks ?? []).includes("*");
    if (!caps.length && !needs.length && !stacks.length) reasons.push("demand:no-overlap");
    if (specific && !stacks.length && (it.tier === "stack" || projectStacks.length)) reasons.push("stack:mismatch");
    return reasons;
  };
  const wanted = [...new Set(demand.capabilitiesWanted ?? [])];
  const widened = [...new Set([...wanted, ...expandDependencies(graph, wanted)])];

  const { candidates, exclusions, unmet } = candidatesFor(graph, widened, { blockedItems: blockedSet });

  const itemById = new Map(catalog.items.map((i) => [i.id, i]));
  const kept = [];
  const eliminated = [];
  // What is installed already does its job here: anything that conflicts with it is out.
  const conflicts = conflictIndex(catalog, graph);
  const installedItems = catalog.items.filter((i) => installedSet.has(i.id));
  const clashes = (id) => installedItems.filter((i) => conflicts.get(id)?.has(i.id)).map((i) => `conflicts-with-installed:${i.id}`);

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
    else reasons.push(...clashes(it.id));
    if (platformMismatch(it, demand)) reasons.push("platform:mismatch");
    if (agentMismatch(it, demand)) reasons.push("agent:unsupported");
    const caps = intersect(it.capabilities, wanted);
    const needs = intersect(it.needs ?? [], demand.needs ?? []);
    const stacks = intersect(it.stacks ?? [], projectStacks);
    reasons.push(...fitReasons(it, { caps, needs, stacks }));
    if (reasons.length) eliminated.push({ id: it.id, reasons });
    else kept.push({ item: it, graphCaps: c.caps, viaFallback: c.viaFallback, supersedes: c.supersedes, reasons: whyKept(it, { caps, needs, stacks }) });
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
    else preReasons.push(...clashes(it.id));
    if (blockedSet.has(it.id)) preReasons.push("user:blocked");
    const hardReasons = [];
    if (it.security?.level === "blocked") hardReasons.push("security:blocked");
    if (platformMismatch(it, demand)) hardReasons.push("platform:mismatch");
    if (agentMismatch(it, demand)) hardReasons.push("agent:unsupported");
    const caps = intersect(it.capabilities, wanted);
    const needs = intersect(it.needs ?? [], demand.needs ?? []);
    const stacks = intersect(it.stacks ?? [], projectStacks);
    hardReasons.push(...fitReasons(it, { caps, needs, stacks }));
    const reasons = [...preReasons, ...hardReasons];
    if (reasons.length) {
      eliminated.push({ id: it.id, reasons });
      continue;
    }
    kept.push({ item: it, graphCaps: [], viaFallback: false, supersedes: [], offGraph: true, reasons: whyKept(it, { caps, needs, stacks }) });
  }

  // Conflicting pairs among the candidates themselves; the graph's pairs come from
  // candidatesFor, the catalog's own lists are added here (off-graph items too).
  const keptIds = new Set(kept.map((k) => k.item.id));
  const pairs = [...exclusions];
  const paired = (a, b) => pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  for (const k of kept) for (const other of conflicts.get(k.item.id) ?? []) {
    if (keptIds.has(other) && !paired(k.item.id, other)) pairs.push([k.item.id, other]);
  }

  return {
    candidates: kept,
    eliminated,
    installed: installedItems,
    exclusions: pairs,
    unmet,
    wantedCaps: wanted,
    widenedCaps: widened,
    answered: Object.keys(answers ?? {}),
  };
}
