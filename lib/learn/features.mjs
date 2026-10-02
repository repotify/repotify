// P5: Bandit context features — jury scores as FEATURES, not as a mixed score.
//
// The v1 pipeline (frozen) mixes jury scores into a scalar via qualityScore().
// P5 forbids that for the bandit: jury.quality/specificity/maintenance/agreement
// enter the LinUCB context vector as raw features (dims 0-3). The bandit learns
// their weights from data (reward labels) — no hand-tuned mixture.
//
// Feature layout (d=64, DL-014):
//   0-3   jury: quality, specificity, maintenance, agreement (0.5/1.0 if missing)
//   4-6   demand match: capability, need, stack overlap ratios
//   7-9   tier one-hot: core, stack, mission
//   10    verified badge (1/0)
//   11    caution badge (1/0)
//   12-63 reserved (zeros) — future features must append, never reorder.

import { FEATURE_DIM } from "./linucb.mjs";

const JURY_DIMS = 4;

export function juryFeatures(item) {
  const j = item?.jury ?? null;
  return [
    j?.quality ?? 0.5,
    j?.specificity ?? 0.5,
    j?.maintenance ?? 0.5,
    j?.agreement ?? 1.0,
  ];
}

export function demandFeatures(item, demand) {
  const caps = item?.capabilities ?? [];
  const wanted = demand?.wantedCaps ?? [];
  const capOverlap = wanted.length
    ? wanted.filter((c) => caps.includes(c)).length / wanted.length
    : 0;
  const needs = demand?.needs ?? [];
  const itemNeeds = item?.needs ?? [];
  const needOverlap = needs.length
    ? needs.filter((n) => itemNeeds.includes(n)).length / needs.length
    : 0;
  const stacks = demand?.stacks ?? [];
  const itemStacks = item?.stacks ?? [];
  const stackOverlap = stacks.length
    ? stacks.filter((s) => itemStacks.includes(s)).length / stacks.length
    : 0;
  return [capOverlap, needOverlap, stackOverlap];
}

export function tierFeatures(item) {
  const t = item?.tier;
  return [t === "core" ? 1 : 0, t === "stack" ? 1 : 0, t === "mission" ? 1 : 0];
}

export function badgeFeatures(item) {
  const badges = item?.badges ?? [];
  return [badges.includes("verified") ? 1 : 0, badges.includes("caution") ? 1 : 0];
}

/**
 * Build the d=64 LinUCB context vector for (item, demand).
 * Jury scores are features — the bandit learns their weights.
 */
export function buildContext(item, demand = {}) {
  const x = new Array(FEATURE_DIM).fill(0);
  const parts = [
    ...juryFeatures(item),      // 0-3
    ...demandFeatures(item, demand), // 4-6
    ...tierFeatures(item),      // 7-9
    ...badgeFeatures(item),     // 10-11
  ];
  for (let i = 0; i < parts.length; i++) x[i] = parts[i];
  return x;
}

/** Context provider for warmstart.mjs: (labelRow) => features. */
export function labelRowContext(itemById, demandByEpisode) {
  return (row) => {
    const item = itemById.get(row.skill_id);
    const demand = demandByEpisode?.get(row.episode_id) ?? {};
    return buildContext(item, demand);
  };
}
