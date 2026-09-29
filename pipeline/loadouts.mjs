import { qualityScore, trustScore } from "../src/recommend.mjs";

// Loadouts: editorial item lists plus `fill` capabilities completed with the best available item.
export function buildLoadouts(defs, items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const value = (i) => qualityScore(i.jury) + (trustScore(i.security?.level) ?? -10);
  return defs.map(({ fill = [], ...def }) => {
    const chosen = (def.items ?? []).filter((id) => byId.has(id));
    const clusters = new Set(chosen.map((id) => byId.get(id).cluster));
    for (const cap of fill) {
      if (chosen.some((id) => byId.get(id).capabilities.includes(cap))) continue;
      const best = items.filter((i) => i.capabilities.includes(cap) && !clusters.has(i.cluster) && trustScore(i.security?.level) !== null).sort((a, b) => value(b) - value(a))[0];
      if (best) {
        chosen.push(best.id);
        clusters.add(best.cluster);
      }
    }
    return { ...def, items: chosen };
  });
}
