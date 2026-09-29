// Capability graph: assign clusters and make items of the same exclusive group conflict.
export function buildGraph(items, taxonomy) {
  const groupOf = (item) => new Set(item.capabilities.map((c) => taxonomy.capabilities[c]?.exclusiveGroup).filter(Boolean));
  const groups = items.map(groupOf);
  return items.map((item, i) => {
    const conflicts = new Set(item.conflicts ?? []);
    items.forEach((other, j) => {
      if (i !== j && [...groups[i]].some((g) => groups[j].has(g))) conflicts.add(other.id);
    });
    return { ...item, cluster: item.cluster ?? item.capabilities[0], conflicts: [...conflicts].sort() };
  });
}
