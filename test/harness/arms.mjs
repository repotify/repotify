// Arms: how the agent's available skill set is chosen for one run.
//   repotify    — the REAL v2 pipeline: lib/pipeline/recommend recommendV1 for
//                 the scenario fingerprint (P1 engine-duality fix, 2026-10-01).
//                 Before P1 this arm ran the v1 engine; old runs labeled
//                 "repotify" measured v1 — see test/harness/METHOD.md.
//   v1-baseline — FROZEN v1 engine (src/recommend.mjs defaultSet). Reference
//                 baseline only; never extended.
//   none        — no skills at all (bare agent, the counterfactual baseline).
//   naive       — seeded random skill set, same size as repotify's (luck baseline).
//   jev         — Jev (decision model) picks the top-3 skills by choice probability
//                 from repotify's v2 ranked rows (routing-signal arm).
import { recommend, buildDemand } from "../../src/recommend.mjs";
import { recommendV1 } from "../../lib/pipeline/recommend/index.mjs";
import { loadSeedGraph } from "../../lib/pipeline/graph/loader.mjs";
import { resolveNeeds } from "../../src/needs.mjs";
import { jevDecide } from "./drivers.mjs";
import { fileURLToPath } from "node:url";

export const ARMS = ["repotify", "repotify-loose", "repotify-jaccard", "repotify-hybrid", "v1-baseline", "none", "naive", "jev", "oracle", "placebo"];

// mulberry32: tiny seeded PRNG so the naive arm is reproducible.
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function loadCatalog(readJson) {
  return {
    items: readJson("items.json"),
    taxonomy: readJson("taxonomy.json"),
    loadouts: readJson("loadouts.json"),
    core: readJson("core.json"),
  };
}

// Seed graph is static: load once per process.
let _graph = null;
export function seedGraph() {
  if (!_graph) {
    const p = fileURLToPath(new URL("../../data/graph-seed.json", import.meta.url));
    _graph = loadSeedGraph(p);
  }
  return _graph;
}

export function recommendFor(catalog, scenario) {
  const fp = { empty: false, stacks: [], inferredNeeds: [], agents: { configured: [], skills: [] }, ...scenario.fingerprint };
  const needs = resolveNeeds({ fingerprint: fp, answers: scenario.answers ?? {}, taxonomy: catalog.taxonomy });
  return recommend({ catalog, fingerprint: fp, needs });
}

// v2 wiring mirrors src/cli.mjs cmdRecommend (minus paid Jev arbitration and
// fleet policy — the harness measures the local pipeline deterministically).
export async function recommendV1For(catalog, scenario) {
  const fp = { empty: false, stacks: [], inferredNeeds: [], agents: { configured: [], skills: [] }, ...scenario.fingerprint };
  const resolved = resolveNeeds({ fingerprint: fp, answers: scenario.answers ?? {}, taxonomy: catalog.taxonomy });
  const demand = {
    ...buildDemand({ taxonomy: catalog.taxonomy, fingerprint: fp, needs: resolved }),
    stacks: fp?.stacks ?? [],
    answered: resolved.answered ?? [],
  };
  return recommendV1(
    { catalog, graph: seedGraph(), demand, installed: [], blocked: [], answers: scenario.answers ?? {} },
    {},
  );
}

export function itemById(catalog, id) {
  return catalog.items.find((i) => i.id === id);
}

export function skillCard(catalog, id, maxSummary = 160) {
  const it = itemById(catalog, id);
  if (!it) return `${id}: (not in catalog)`;
  const s = (it.summary ?? "").replace(/\s+/g, " ").slice(0, maxSummary);
  return `${id}: ${s}`;
}

// Resolve the skill set an arm offers the agent. Returns { ids, source, meta }.
// repIndex feeds the naive seed so repeated runs of the naive arm draw fresh sets.
export async function resolveArmSet({ arm, catalog, scenario, repIndex = 0 }) {
  if (arm === "none") return { ids: [], source: "none", meta: {} };
  if (arm === "v1-baseline") {
    const rec = recommendFor(catalog, scenario);
    const ids = rec.defaultSet.filter((id) => itemById(catalog, id));
    return { ids, source: "v1-recommend-defaultSet", meta: { budgetChars: rec.budget?.used ?? 0 } };
  }
  // Everything below keys off the v2 pipeline ("repotify" arm).
  // Coverage-gate experiment arms (2026-10-01): repotify-loose / repotify-jaccard
  // run the v2 pipeline with REPOTIFY_COVERAGE_VARIANT set; the env read in
  // present.mjs happens at call time, so sequential per-arm switching is safe.
  // The plain "repotify" arm pins "strict" (the default).
  const coverageVariantFor = arm === "repotify" ? "strict"
    : arm.startsWith("repotify-") ? arm.slice("repotify-".length) : null;
  const prevVariant = process.env.REPOTIFY_COVERAGE_VARIANT;
  if (coverageVariantFor) process.env.REPOTIFY_COVERAGE_VARIANT = coverageVariantFor;
  let recV2;
  try {
    recV2 = await recommendV1For(catalog, scenario);
  } finally {
    if (prevVariant === undefined) delete process.env.REPOTIFY_COVERAGE_VARIANT;
    else process.env.REPOTIFY_COVERAGE_VARIANT = prevVariant;
  }
  const v2Ids = (recV2.set ?? []).filter((id) => itemById(catalog, id));
  if (arm === "repotify" || arm.startsWith("repotify-")) {
    return {
      ids: v2Ids,
      source: recV2.decision === "reject" ? "v2-reject" : "v2-recommendV1",
      meta: {
        decision: recV2.decision,
        reason: recV2.reason ?? null,
        budgetChars: recV2.budget?.used ?? 0,
        arbitrated: false,
        fleetApplied: false,
        coverageVariant: coverageVariantFor,
      },
    };
  }
  if (arm === "naive" || arm === "placebo") {
    const n = v2Ids.length;
    const pool = catalog.items.map((i) => i.id);
    const rng = seededRng(hashStr(`${arm}#${scenario.id}#${repIndex}`));
    const picked = new Set();
    let guard = 0;
    while (picked.size < Math.min(n, pool.length) && guard++ < 10000) picked.add(pool[Math.floor(rng() * pool.length)]);
    return { ids: [...picked], source: "seeded-random", meta: { seed: hashStr(`${arm}#${scenario.id}#${repIndex}`) } };
  }
  if (arm === "oracle") {
    // Ceiling arm: the agent is offered exactly the ground-truth must-include set.
    // Separates "can the pipeline route" from "do the right skills help".
    const ids = (scenario.mustInclude ?? []).filter((id) => itemById(catalog, id));
    return { ids, source: "oracle-mustInclude", meta: {} };
  }
  if (arm === "jev") {
    // Jev sees the same ranked rows as the v2 repotify arm (top 12) and ranks them.
    const candidates = (recV2.ranked ?? []).slice(0, 12).map((r) => r.id).filter((id) => itemById(catalog, id));
    if (!candidates.length) return { ids: [], source: "jev-empty-candidates", meta: {} };
    const criteria = Object.fromEntries(candidates.map((id) => [id, itemById(catalog, id).summary?.slice(0, 200) ?? id]));
    try {
      const { answers, usage } = await jevDecide({
        state: `${scenario.project} Task: ${scenario.task}`,
        questions: {
          pick: {
            type: "choice",
            instructions: `Which ONE skill from the list is the single best fit for this task? Choose only from the listed ids.`,
            criteria,
          },
        },
      });
      const probs = answers?.pick?.probabilities ?? {};
      const top3 = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id).filter((id) => candidates.includes(id));
      return { ids: top3, source: "jev-choice", meta: { probabilities: probs, jevCost: usage?.cost ?? null } };
    } catch (err) {
      return { ids: [], source: "jev-failed", meta: { error: String(err?.message ?? err) } };
    }
  }
  throw new Error(`unknown arm: ${arm}`);
}
