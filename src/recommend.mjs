// Recommendation engine: fit, score, conflicts, context budget, candidate table.

export const WEIGHTS = { quality: 0.35, trust: 0.25, adoption: 0.2, freshness: 0.1, community: 0.1 };
export const POPULARITY_CAP_STARS = 5000;
const PRIOR_WEIGHT = 20;
const MIN_FIT = 0.2;

const intersect = (a = [], b = []) => a.filter((x) => b.includes(x));
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// How well an item matches this project, with reason codes for the agent.
export function fitScore(item, ctx) {
  if (item.tier === "core") return { fit: 1, reasons: ["core"] };
  const caps = intersect(item.capabilities, ctx.capabilitiesWanted);
  const needs = intersect(item.needs, ctx.needs);
  const capScore = caps.length ? Math.min(1, 0.8 + 0.1 * (caps.length - 1)) : 0;
  const needScore = needs.length ? Math.min(0.7, 0.5 + 0.1 * (needs.length - 1)) : 0;
  const match = Math.max(capScore, needScore);
  const reasons = [...caps.map((c) => `cap:${c}`), ...needs.map((n) => `need:${n}`)];
  const anyStack = item.stacks.includes("*");
  const stacks = intersect(item.stacks, ctx.stacks);
  let fit;
  const inLoadout = (ctx.loadoutIds ?? []).includes(item.id);
  if (item.tier === "stack" && !anyStack) {
    if (!stacks.length && !inLoadout) return { fit: 0, reasons: [] };
    fit = stacks.length ? 0.6 + 0.4 * match : 0;
    reasons.push(...stacks.map((s) => `stack:${s}`));
  } else {
    fit = match;
    if (!anyStack) {
      if (stacks.length) reasons.push(...stacks.map((s) => `stack:${s}`));
      else fit *= 0.5;
    }
  }
  if (inLoadout) {
    fit = Math.max(fit, 0.9);
    reasons.push(ctx.loadout ? `loadout:${ctx.loadout}` : "loadout");
  }
  return { fit, reasons };
}

export function qualityScore(jury) {
  if (!jury) return 0.5;
  const q = (jury.quality + jury.specificity + jury.maintenance) / 3;
  const agreement = jury.agreement ?? 1;
  return clamp01(agreement < 0.6 ? q - (0.6 - agreement) * 0.5 : q);
}

export function trustScore(level) {
  if (level === "verified") return 1;
  if (level === "caution") return 0.6;
  return null;
}

export function adoptionScore(signals = {}) {
  const stars = signals.stars ?? 0;
  const popularity = Math.min(1, Math.log10(1 + stars) / Math.log10(1 + POPULARITY_CAP_STARS));
  const velocity = Math.min(1, (signals.starVelocity30d ?? 0) / 200);
  const coUsage = Math.min(1, Math.log10(1 + (signals.coUsage ?? 0)) / 3);
  const mentions = Math.min(1, (signals.mentions30d ?? 0) / 20);
  return 0.5 * popularity + 0.2 * velocity + 0.2 * coUsage + 0.1 * mentions;
}

export function freshnessScore(lastCommitDays) {
  if (lastCommitDays == null) return 0.5;
  if (lastCommitDays <= 30) return 1;
  return clamp01(1 - (lastCommitDays - 30) / 335);
}

export function communityScore(c = {}) {
  const m = PRIOR_WEIGHT;
  const sel = ((c.selected ?? 0) + m * 0.3) / ((c.shown ?? 0) + m);
  const keep = ((c.kept7d ?? 0) + m * 0.7) / ((c.selected ?? 0) + m);
  const rate = ((c.rating ?? 0) * (c.votes ?? 0) + m * 0.5) / ((c.votes ?? 0) + m);
  return 0.4 * clamp01(sel) + 0.4 * clamp01(keep) + 0.2 * clamp01(rate);
}

export function scoreItem(item, ctx) {
  const trust = trustScore(item.security?.level);
  if (trust === null) return null;
  const { fit, reasons } = fitScore(item, ctx);
  if (fit < MIN_FIT) return null;
  const parts = {
    quality: qualityScore(item.jury),
    trust,
    adoption: adoptionScore(item.signals),
    freshness: freshnessScore(item.signals?.lastCommitDays),
    community: communityScore(item.community),
  };
  const score = fit * Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + w * parts[k], 0);
  const badges = new Set((item.badges ?? []).filter((b) => b !== "verified" && b !== "caution"));
  badges.add(item.security.level === "caution" ? "caution" : "verified");
  if (parts.quality >= 0.7 && fit >= 0.7 && parts.adoption <= 0.35) badges.add("gem");
  if ((item.signals?.starVelocity30d ?? 0) >= 100) badges.add("trending");
  return { score, fit, parts, reasons, badges: [...badges] };
}

// ---------------------------------------------------------------------------
// Candidate list: generation, conflicts, context budget, table.

export const DEFAULT_BUDGET_CHARS = 6000;
export const MAX_TABLE_CHARS = 3150;
const MIN_DEFAULT_FIT = 0.6;

export function pickLoadout(loadouts, { projectType, needs = [] }) {
  const typed = loadouts.find((lo) => projectType && lo.projectType === projectType);
  if (typed) return typed;
  let best = null;
  let bestOverlap = 0;
  for (const lo of loadouts) {
    const overlap = intersect(lo.needs, needs).length;
    if (overlap > bestOverlap) {
      best = lo;
      bestOverlap = overlap;
    }
  }
  return best;
}

function exclusiveGroups(item, taxonomy) {
  return item.capabilities.map((c) => taxonomy.capabilities[c]?.exclusiveGroup).filter(Boolean);
}

export function recommend({ catalog, fingerprint: fp, needs, installed = [], budgetChars = DEFAULT_BUDGET_CHARS, maxRows = 30 }) {
  const { taxonomy } = catalog;
  const needCodes = needs?.needs ?? [];
  const capabilitiesWanted = [...new Set(needCodes.flatMap((n) => taxonomy.needs[n]?.capabilities ?? []))];
  const loadout = fp?.empty ? pickLoadout(catalog.loadouts, needs ?? {}) : null;
  const ctx = {
    stacks: fp?.stacks ?? [],
    needs: needCodes,
    capabilitiesWanted,
    loadoutIds: loadout?.items ?? [],
    loadout: loadout?.id,
  };
  const installedSet = new Set([...installed, ...(fp?.agents?.skills ?? [])]);

  const scored = [];
  for (const item of catalog.items) {
    const s = scoreItem(item, ctx);
    if (s) scored.push({ item, ...s });
  }
  // Core first, then installed (they already occupy their cluster), then by score.
  const rank = (x) => (x.item.tier === "core" ? 2 : 0) + (installedSet.has(x.item.id) ? 1 : 0);
  scored.sort((a, b) => rank(b) - rank(a) || b.score - a.score || (a.item.id < b.item.id ? -1 : 1));

  const kept = [];
  const clusters = new Set();
  const groups = new Set();
  for (const s of scored) {
    const it = s.item;
    if (clusters.has(it.cluster)) continue;
    const eg = exclusiveGroups(it, taxonomy);
    if (eg.some((g) => groups.has(g))) continue;
    if (kept.some((k) => (k.item.conflicts ?? []).includes(it.id) || (it.conflicts ?? []).includes(k.item.id))) continue;
    kept.push(s);
    clusters.add(it.cluster);
    for (const g of eg) groups.add(g);
    if (kept.length >= maxRows) break;
  }

  // Context budget: installed items already cost context; core next; then best value per character.
  let used = 0;
  const defaults = new Set();
  const dropped = [];
  for (const s of kept) if (installedSet.has(s.item.id)) used += s.item.descriptionChars;
  const tryAdd = (s) => {
    if (used + s.item.descriptionChars <= budgetChars) {
      used += s.item.descriptionChars;
      defaults.add(s.item.id);
    } else {
      dropped.push(s.item.id);
    }
  };
  for (const s of kept) if (s.item.tier === "core" && !installedSet.has(s.item.id)) tryAdd(s);
  const optional = kept
    .filter((s) => s.item.tier !== "core" && !installedSet.has(s.item.id) && s.fit >= MIN_DEFAULT_FIT)
    .sort((a, b) => b.score / Math.max(50, b.item.descriptionChars) - a.score / Math.max(50, a.item.descriptionChars));
  for (const s of optional) tryAdd(s);

  const rows = kept.map((s) => ({
    id: s.item.id,
    type: s.item.type,
    tier: s.item.tier,
    cluster: s.item.cluster,
    score: Math.round(s.score * 100) / 100,
    badges: s.badges,
    summary: s.item.summary,
    reasons: s.reasons,
    default: defaults.has(s.item.id),
    installed: installedSet.has(s.item.id),
  }));
  return {
    rows,
    defaultSet: rows.filter((r) => r.default).map((r) => r.id),
    budget: { used, limit: budgetChars },
    loadout: loadout?.id ?? null,
    droppedForBudget: dropped,
  };
}

const BADGE_ICON = { verified: "✓", caution: "⚠", gem: "💎", trending: "🔥" };

export function formatTable(rec) {
  const header = [
    `Repotify candidates (★ = default set; context ${rec.budget.used}/${rec.budget.limit} chars${rec.loadout ? `; loadout ${rec.loadout}` : ""})`,
    "mark id | type | cluster | score | badges | summary | why",
  ].join("\n");
  const fixed = rec.rows.map((r) => {
    const mark = r.installed ? "·" : r.default ? "★" : "·";
    const badges = r.badges.map((b) => BADGE_ICON[b] ?? b).join("") + (r.installed ? " installed" : "");
    const why = r.reasons.slice(0, 3).join(",");
    return { head: `${mark} ${r.id} | ${r.type} | ${r.cluster} | ${r.score.toFixed(2)} | ${badges} | `, tail: ` | ${why}`, summary: r.summary };
  });
  const fixedLen = header.length + fixed.reduce((n, f) => n + f.head.length + f.tail.length + 1, 0);
  const perRow = rec.rows.length ? Math.max(12, Math.floor((MAX_TABLE_CHARS - fixedLen) / rec.rows.length)) : 0;
  const lines = fixed.map((f) => f.head + (f.summary.length > perRow ? f.summary.slice(0, perRow - 1) + "…" : f.summary) + f.tail);
  let text = [header, ...lines].join("\n");
  if (text.length > MAX_TABLE_CHARS) text = [header, ...lines.map((l) => l.slice(0, Math.floor((MAX_TABLE_CHARS - header.length) / lines.length) - 1))].join("\n");
  return text;
}
