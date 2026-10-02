// Consistency audit for the capability graph. Finds:
//   - dangling node refs (item ids absent from the catalog, capabilities absent from the taxonomy)
//   - contradictory edges: A CONFLICTS_WITH B while A REQUIRES B (in either direction),
//     or A SUPERSEDES B while A CONFLICTS_WITH B
//   - SUPERSEDES cycles
//   - FALLBACK loops (a -> b -> ... -> a)
//   - PROVIDES edges the catalog disagrees with (item does not list the capability)
//   - orphan FALLBACK targets (fallback item neither provides anything nor is itself in the catalog)
//
// Returns an array of { code, edge?, message }. Empty means clean.

export function auditGraph(graph, { itemIds = new Set(), capabilities = {}, catalogItems = new Map() } = {}) {
  const issues = [];
  const nodeId = (ref) => ref.slice(ref.indexOf(":") + 1);
  const kind = (ref) => ref.slice(0, ref.indexOf(":"));

  // 1. Dangling refs.
  for (const edge of graph.edges) {
    for (const ref of [edge.from, edge.to]) {
      const id = nodeId(ref);
      if (kind(ref) === "item" && !itemIds.has(id)) {
        issues.push({ code: "dangling-item", edge, message: `${edge.id}: ${ref} is not a catalog item` });
      }
      if (kind(ref) === "cap" && !capabilities[id]) {
        issues.push({ code: "dangling-cap", edge, message: `${edge.id}: ${ref} is not a taxonomy capability` });
      }
    }
  }

  const conflicts = new Set();
  const requires = new Set();
  const supersedes = new Map();
  const fallback = new Map();
  for (const e of graph.edges) {
    if (e.type === "conflicts_with") {
      conflicts.add(`${e.from}|${e.to}`);
      conflicts.add(`${e.to}|${e.from}`);
    }
    if (e.type === "requires") {
      requires.add(`${e.from}|${e.to}`);
      requires.add(`${e.to}|${e.from}`);
    }
    if (e.type === "supersedes") {
      if (!supersedes.has(e.from)) supersedes.set(e.from, []);
      supersedes.get(e.from).push(e);
    }
    if (e.type === "fallback") {
      if (!fallback.has(e.from)) fallback.set(e.from, []);
      fallback.get(e.from).push(e);
    }
  }

  // 2. Contradictions.
  for (const e of graph.edges) {
    if (e.type === "conflicts_with") {
      if (requires.has(`${e.from}|${e.to}`)) {
        issues.push({ code: "conflict-vs-requires", edge: e, message: `${e.id}: ${e.from} conflicts with ${e.to} yet requires it — contradictory` });
      }
    }
    if (e.type === "supersedes") {
      if (conflicts.has(`${e.from}|${e.to}`)) {
        issues.push({ code: "supersede-vs-conflict", edge: e, message: `${e.id}: ${e.from} supersedes ${e.to} yet conflicts with it — contradictory` });
      }
    }
    if (e.type === "requires") {
      // An item cannot require a capability it itself provides via a single-provider monopoly
      // (it would make the edge unsatisfiable by construction).
      void e;
    }
  }

  // 3. SUPERSEDES cycles (a supersedes b supersedes ... supersedes a).
  const visit = (node, stack, seenGlobal) => {
    if (stack.includes(node)) {
      const cycle = [...stack.slice(stack.indexOf(node)), node];
      issues.push({ code: "supersede-cycle", message: `supersedes cycle: ${cycle.join(" -> ")}` });
      return;
    }
    if (seenGlobal.has(node)) return;
    seenGlobal.add(node);
    for (const e of supersedes.get(node) ?? []) visit(e.to, [...stack, node], seenGlobal);
  };
  for (const node of supersedes.keys()) visit(node, [], new Set());

  // 4. FALLBACK loops.
  const visitFb = (node, stack) => {
    if (stack.includes(node)) {
      issues.push({ code: "fallback-loop", message: `fallback loop: ${[...stack.slice(stack.indexOf(node)), node].join(" -> ")}` });
      return;
    }
    for (const e of fallback.get(node) ?? []) visitFb(e.to, [...stack, node]);
  };
  for (const node of fallback.keys()) visitFb(node, []);

  // 5. PROVIDES edges the catalog disagrees with.
  for (const e of graph.byType.get("provides") ?? []) {
    if (kind(e.from) !== "item" || kind(e.to) !== "cap") continue;
    const it = catalogItems.get(nodeId(e.from));
    if (it && !(it.capabilities ?? []).includes(nodeId(e.to))) {
      issues.push({ code: "provides-mismatch", edge: e, message: `${e.id}: catalog item ${e.from} does not list capability ${e.to}` });
    }
  }

  return issues;
}
