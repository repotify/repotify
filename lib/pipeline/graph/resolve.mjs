// Fallback / candidate resolution over the capability graph.
// All traversal is local and deterministic (in-memory BFS, cycle-safe).

import { item as itemRef } from "./loader.mjs";

// Fallback chains deeper than this are knowledge rot, not provenance: a
// "try this instead" three hops from the blocked item has no business
// inheriting the original's demand match. (Debate fix: eleştirmen's
// transitive-dilution hole — chains were unbounded.)
export const MAX_FALLBACK_DEPTH = 2;

// Items that provide a capability, minus blocked items. Blocked primaries are
// replaced by their FALLBACK chain (transitive, cycle-safe, depth-capped).
export function providersFor(graph, capability, { blockedItems = new Set() } = {}) {
  const want = `cap:${capability}`;
  const primary = (graph.byType.get("provides") ?? [])
    .filter((e) => e.to === want)
    .map((e) => e.from.slice("item:".length));
  const out = [];
  const seen = new Set();
  const expand = (id, viaFallback, depth) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (!blockedItems.has(id)) {
      out.push({ id, viaFallback });
      return;
    }
    if (depth >= MAX_FALLBACK_DEPTH) return; // no short fallback path: drop
    for (const e of graph.edgesOf(`item:${id}`).filter((x) => x.type === "fallback")) {
      expand(e.to.slice("item:".length), true, depth + 1);
    }
  };
  for (const id of primary) expand(id, false, 0);
  return out;
}

// Ordered candidate items for a set of wanted capabilities. Applies:
//   - blocked-item removal with FALLBACK expansion
//   - SUPERSEDES preference (keeps the superseder, records the preference)
//   - CONFLICTS_WITH exclusion sets (reported; the caller drops the loser)
//   - REQUIRES enforcement (reports unmet requirements)
// Returns { candidates: [{id, caps, viaFallback, supersedes}], exclusions: [[a,b]], unmet: [{item, cap}] }.
export function candidatesFor(graph, wantedCaps, { blockedItems = new Set(), includeSuperseded = false } = {}) {
  const superseded = new Set();
  for (const e of graph.byType.get("supersedes") ?? []) superseded.add(e.to.slice("item:".length));

  const byId = new Map();
  for (const c of wantedCaps) {
    for (const p of providersFor(graph, c, { blockedItems })) {
      if (!includeSuperseded && superseded.has(p.id)) continue; // superseded items never enter as primaries
      if (!byId.has(p.id)) byId.set(p.id, { id: p.id, caps: new Set(), viaFallback: p.viaFallback, supersedes: [], supersededBy: null });
      const rec = byId.get(p.id);
      rec.caps.add(c);
      rec.viaFallback ||= p.viaFallback;
    }
  }
  // Record which edges drove the preference, for the audit trail.
  for (const e of graph.byType.get("supersedes") ?? []) {
    const winner = e.from.slice("item:".length);
    const loser = e.to.slice("item:".length);
    if (byId.has(winner)) byId.get(winner).supersedes.push(loser);
    if (byId.has(loser)) byId.get(loser).supersededBy = winner;
  }

  const candidates = [...byId.values()].map((r) => ({ ...r, caps: [...r.caps].sort() }));

  // Exclusion sets from CONFLICTS_WITH (symmetric).
  const exclusions = [];
  const ids = new Set(candidates.map((c) => c.id));
  for (const e of graph.byType.get("conflicts_with") ?? []) {
    const a = e.from.slice("item:".length);
    const b = e.to.slice("item:".length);
    if (ids.has(a) && ids.has(b) && !exclusions.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) {
      exclusions.push([a, b]);
    }
  }

  // REQUIRES: report when no candidate provides the required capability.
  const provided = new Set();
  for (const c of candidates) for (const cp of c.caps) provided.add(cp);
  // Also count capabilities provided by catalog items even if not candidates? No:
  // requirements are enforced against the final set; callers widen with the catalog.
  const unmet = [];
  for (const c of candidates) {
    for (const e of graph.edgesOf(itemRef(c.id)).filter((x) => x.type === "requires")) {
      const need = e.to.slice("cap:".length);
      if (!provided.has(need)) unmet.push({ item: c.id, cap: need, edge: e.id });
    }
  }

  return { candidates, exclusions, unmet };
}

// One-hop DEPENDS_ON expansion of wanted capabilities (soft: suggestions, not requirements).
export function expandDependencies(graph, wantedCaps) {
  const extra = new Set();
  for (const c of wantedCaps) {
    for (const e of graph.edgesOf(`cap:${c}`).filter((x) => x.type === "depends_on")) {
      extra.add(e.to.slice("cap:".length));
    }
  }
  for (const c of wantedCaps) extra.delete(c);
  return [...extra].sort();
}
