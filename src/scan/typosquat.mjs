const DAY = 86400000;

export function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// A young item whose name is within a small edit distance of a popular item from another repo.
// Unknown age counts as young: the finding is only "medium" (caution), never blocking.
export function checkTyposquat(item, known, now = new Date(), { minStars = 500, maxAgeDays = 90 } = {}) {
  const ageDays = item.createdAt ? (now - new Date(item.createdAt)) / DAY : 0;
  if (ageDays >= maxAgeDays) return null;
  const names = new Set([item.id, item.name].filter(Boolean).map((n) => n.toLowerCase()));
  for (const k of known) {
    if ((k.stars ?? 0) < minStars) continue;
    if (k.repo && item.repo && k.repo.toLowerCase() === item.repo.toLowerCase()) continue;
    for (const target of [k.id, k.name].filter(Boolean).map((n) => n.toLowerCase())) {
      if (target.length < 4) continue;
      const limit = target.length >= 8 ? 2 : 1;
      for (const name of names) {
        const d = levenshtein(name, target);
        if (d <= limit) {
          return {
            rule: "typosquat",
            severity: "medium",
            file: "(metadata)",
            line: 0,
            excerpt: `${name} ~ ${target}`,
            note: `looks like ${k.repo ?? target} (${k.stars} stars), repo age ${Math.round(ageDays)}d`,
          };
        }
      }
    }
  }
  return null;
}
