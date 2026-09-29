// Community signals from the analytics Worker. Absent stats never change the catalog.
export async function fetchCommunity({ url, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const doc = await res.json();
    return doc && typeof doc.items === "object" ? doc : null;
  } catch {
    return null;
  }
}

export function mergeCommunity(items, stats) {
  if (!stats?.items) return items;
  return items.map((item) => {
    const s = stats.items[item.id];
    if (!s) return item;
    const votes = (s.up ?? 0) + (s.down ?? 0);
    return {
      ...item,
      community: { shown: s.shown ?? 0, selected: s.selected ?? 0, kept7d: s.kept7d ?? 0, removed: s.removed ?? 0, rating: votes ? (s.up ?? 0) / votes : 0, votes },
    };
  });
}
