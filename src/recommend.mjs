// Recommendation engine: demand, fit, score, conflicts, coverage, context budget, candidate table.

export const WEIGHTS = { quality: 0.35, trust: 0.25, adoption: 0.2, freshness: 0.1, community: 0.1 };
export const POPULARITY_CAP_STARS = 5000;
const PRIOR_WEIGHT = 20;
const MIN_FIT = 0.2;

const intersect = (a = [], b = []) => a.filter((x) => b.includes(x));
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ---------------------------------------------------------------------------
// Demand: what this project asks for, and how sure we are.

const WEB_STACKS = ["nextjs", "nuxt", "vue", "svelte", "angular", "astro", "vercel", "electron", "tauri"];
const MOBILE_STACKS = ["react-native", "expo", "flutter"];

// Where the project runs. Fingerprints list platforms from dependencies; hand-written or older ones are read from
// stacks (React counts as web only without React Native, whose apps depend on React too).
export function platformsOf(fp) {
  if (fp?.platforms?.length) return [...fp.platforms].sort();
  const stacks = new Set(fp?.stacks ?? []);
  const mobile = MOBILE_STACKS.some((s) => stacks.has(s));
  const out = new Set();
  if (WEB_STACKS.some((s) => stacks.has(s)) || (stacks.has("react") && !mobile)) out.add("web");
  if (mobile) out.add("mobile");
  if (stacks.has("electron") || stacks.has("tauri")) out.add("desktop");
  return [...out].sort();
}

// Need weights, the capabilities that serve them, and capability evidence from dependencies. Evidence narrows a
// broad need to the facets it shows (openpyxl: spreadsheets, not every office format) unless the user named the need.
export function buildDemand({ taxonomy, fingerprint: fp, needs }) {
  const needWeights = { ...(needs?.weights ?? Object.fromEntries((needs?.needs ?? []).map((n) => [n, 1]))) };
  const answered = new Set(needs?.answered ?? []);
  const hints = (fp?.capabilityHints ?? []).filter((c) => taxonomy.capabilities?.[c]);
  const hinted = new Set(hints);
  const capWeights = {};
  const want = (c, w) => {
    capWeights[c] = Math.max(capWeights[c] ?? 0, w);
  };
  const narrowed = [];
  for (const [n, w] of Object.entries(needWeights)) {
    const caps = taxonomy.needs?.[n]?.capabilities ?? [];
    const shown = caps.filter((c) => hinted.has(c));
    if (shown.length && shown.length < caps.length && !answered.has(n)) {
      narrowed.push(n);
      for (const c of shown) want(c, w);
    } else {
      for (const c of caps) want(c, w);
    }
  }
  for (const c of hints) want(c, 1);
  return {
    needs: Object.keys(needWeights).filter((n) => !narrowed.includes(n)).sort(),
    needWeights,
    capabilitiesWanted: Object.keys(capWeights).sort(),
    capWeights,
    narrowed: narrowed.sort(),
    hints,
    platforms: platformsOf(fp),
    webOnlyCaps: new Set(Object.entries(taxonomy.capabilities ?? {}).filter(([, c]) => c.platform === "web").map(([id]) => id)),
  };
}

// Web-only skills (browser end-to-end tests, web UI review, React DOM performance) do not help an app with no web target.
export function platformMismatch(item, ctx) {
  const platforms = ctx.platforms ?? [];
  if (!platforms.length || platforms.includes("web") || !ctx.webOnlyCaps?.size) return false;
  return item.capabilities.length > 0 && item.capabilities.every((c) => ctx.webOnlyCaps.has(c));
}

// The strongest evidence behind a set of matched needs or capabilities; 1 when the context carries no weights.
const weightOf = (weights, keys) => (weights && keys.length ? Math.max(...keys.map((k) => weights[k] ?? 1)) : 1);

// How well an item matches this project, with reason codes for the agent.
export function fitScore(item, ctx) {
  if (item.tier === "core") return { fit: 1, reasons: ["core"] };
  if (platformMismatch(item, ctx)) return { fit: 0, reasons: [] };
  const caps = intersect(item.capabilities, ctx.capabilitiesWanted);
  const needs = intersect(item.needs, ctx.needs);
  const capScore = caps.length ? Math.min(1, 0.8 + 0.1 * (caps.length - 1)) * weightOf(ctx.capWeights, caps) : 0;
  const needScore = needs.length ? Math.min(0.7, 0.5 + 0.1 * (needs.length - 1)) * weightOf(ctx.needWeights, needs) : 0;
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
  const demand = buildDemand({ taxonomy, fingerprint: fp, needs });
  const loadout = fp?.empty ? pickLoadout(catalog.loadouts, needs ?? {}) : null;
  const ctx = {
    stacks: fp?.stacks ?? [],
    needs: demand.needs,
    needWeights: demand.needWeights,
    capabilitiesWanted: demand.capabilitiesWanted,
    capWeights: demand.capWeights,
    platforms: demand.platforms,
    webOnlyCaps: demand.webOnlyCaps,
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

  // Coverage: an optional item joins the default set only if it serves a wanted capability or need that nothing
  // chosen so far serves. Stack items (expertise for a stack the project uses) and loadout picks are exempt.
  const wantedCaps = new Set(ctx.capabilitiesWanted);
  const servedBy = new Map(); // "cap:x" | "need:y" -> id of the first chosen item that serves it
  const serves = (item) => {
    const keys = item.capabilities.filter((c) => wantedCaps.has(c)).map((c) => `cap:${c}`);
    for (const n of ctx.needs) {
      if ((item.needs ?? []).includes(n) || (taxonomy.needs[n]?.capabilities ?? []).some((c) => item.capabilities.includes(c))) keys.push(`need:${n}`);
    }
    return keys;
  };
  const cover = (item) => {
    for (const k of serves(item)) if (!servedBy.has(k)) servedBy.set(k, item.id);
  };
  const exempt = (s) => (s.item.tier === "stack" && s.reasons.some((r) => r.startsWith("stack:"))) || ctx.loadoutIds.includes(s.item.id);
  const coveredBy = new Map(); // id -> id of the chosen item that already serves everything it would add

  // Context budget: installed items already cost context; core next; then best value per character.
  let used = 0;
  const defaults = new Set();
  const dropped = [];
  for (const s of kept) {
    if (!installedSet.has(s.item.id)) continue;
    used += s.item.descriptionChars;
    cover(s.item);
  }
  const tryAdd = (s) => {
    if (used + s.item.descriptionChars <= budgetChars) {
      used += s.item.descriptionChars;
      defaults.add(s.item.id);
      cover(s.item);
    } else {
      dropped.push(s.item.id);
    }
  };
  for (const s of kept) if (s.item.tier === "core" && !installedSet.has(s.item.id)) tryAdd(s);
  const optional = kept
    .filter((s) => s.item.tier !== "core" && !installedSet.has(s.item.id) && s.fit >= MIN_DEFAULT_FIT)
    .sort((a, b) => b.score / Math.max(50, b.item.descriptionChars) - a.score / Math.max(50, a.item.descriptionChars));
  for (const s of optional) {
    const keys = serves(s.item);
    if (!exempt(s) && keys.length && keys.every((k) => servedBy.has(k))) {
      coveredBy.set(s.item.id, servedBy.get(keys[0]));
      continue;
    }
    tryAdd(s);
  }

  const rows = kept.map((s) => ({
    id: s.item.id,
    type: s.item.type,
    tier: s.item.tier,
    cluster: s.item.cluster,
    score: Math.round(s.score * 100) / 100,
    badges: s.badges,
    summary: s.item.summary,
    reasons: coveredBy.has(s.item.id) ? [`covered-by:${coveredBy.get(s.item.id)}`, ...s.reasons] : s.reasons,
    default: defaults.has(s.item.id),
    installed: installedSet.has(s.item.id),
  }));
  return {
    rows,
    defaultSet: rows.filter((r) => r.default).map((r) => r.id),
    budget: { used, limit: budgetChars },
    loadout: loadout?.id ?? null,
    droppedForBudget: dropped,
    coveredBy: Object.fromEntries(coveredBy),
    demand: { platforms: demand.platforms, narrowed: demand.narrowed, hints: demand.hints },
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
