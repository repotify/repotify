#!/usr/bin/env node
// Recommendation quality on the scenario set.
// "Hit" = a must-include id is in the recommended default set; a violation = a must-not id is in it.
// It runs the engine the CLI serves (lib/pipeline/recommend, deterministic path), not the v1 baseline.
import { isMain } from "../../src/util.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { demandFor, recommendLocal } from "../../lib/pipeline/recommend/index.mjs";
import { loadSeedGraph } from "../../lib/pipeline/graph/loader.mjs";
import { resolveNeeds } from "../../src/needs.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const SEED_GRAPH = join(here, "..", "..", "data", "graph-seed.json");

export function loadScenarios(dir = join(here, "scenarios")) {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

// `machine` pins what the computer can run (the CLI probes the real one; an eval must not depend on the machine it
// runs on). A scenario's own `machine` wins; with neither, no runtime is held against an item.
export function runEval(scenarios, catalog, { graph = loadSeedGraph(SEED_GRAPH), machine = null } = {}) {
  const itemById = new Map(catalog.items.map((i) => [i.id, i]));
  let hits = 0;
  let total = 0;
  let clusterDuplicates = 0;
  const misses = [];
  const violations = [];
  const perScenario = [];
  for (const s of scenarios) {
    const fp = { empty: false, stacks: [], inferredNeeds: [], agents: { configured: [], skills: [] }, ...s.fingerprint };
    const needs = resolveNeeds({ fingerprint: fp, answers: s.answers ?? {}, taxonomy: catalog.taxonomy });
    const pinned = s.machine ?? machine;
    const demand = { ...demandFor({ catalog, fingerprint: fp, needs, answers: s.answers ?? {} }), ...(pinned ? { machine: pinned } : {}) };
    const rec = recommendLocal({ catalog, graph, demand, answers: s.answers ?? {} });
    const defaultSet = rec.set;
    const chosen = new Set(defaultSet);
    const clusters = defaultSet.map((id) => itemById.get(id)?.cluster);
    clusterDuplicates += clusters.length - new Set(clusters).size;
    let sHits = 0;
    for (const id of s.mustInclude ?? []) {
      total++;
      if (chosen.has(id)) {
        hits++;
        sHits++;
      } else misses.push({ scenario: s.name, id });
    }
    for (const id of s.mustNotInclude ?? []) if (chosen.has(id)) violations.push({ scenario: s.name, id });
    perScenario.push({ name: s.name, hits: sHits, of: (s.mustInclude ?? []).length, defaultSet, budget: rec.budget?.used ?? 0 });
  }
  const avg = (f) => (perScenario.length ? perScenario.reduce((n, x) => n + f(x), 0) / perScenario.length : 0);
  return {
    hitRate: total ? hits / total : 1, hits, total, misses, violations, clusterDuplicates, perScenario,
    avgDefaults: avg((x) => x.defaultSet.length), avgBudget: avg((x) => x.budget),
  };
}

if (isMain(import.meta.url)) {
  const read = (f) => JSON.parse(readFileSync(join(here, "..", "..", "catalog", f), "utf8"));
  const catalog = { items: read("items.json"), taxonomy: read("taxonomy.json"), loadouts: read("loadouts.json"), core: read("core.json") };
  const r = runEval(loadScenarios(), catalog);
  console.log(`scenarios: ${r.perScenario.length}  must-include hits: ${r.hits}/${r.total} (${(r.hitRate * 100).toFixed(1)}%)  violations: ${r.violations.length}  cluster duplicates: ${r.clusterDuplicates}  avg default set: ${r.avgDefaults.toFixed(1)} items, ${Math.round(r.avgBudget)} chars`);
  for (const m of r.misses) console.log(`  miss      ${m.scenario}: ${m.id}`);
  for (const v of r.violations) console.log(`  violation ${v.scenario}: ${v.id}`);
  if (process.argv.includes("--verbose")) for (const s of r.perScenario) console.log(`  ${s.name.padEnd(24)} ${s.hits}/${s.of}  budget ${s.budget}  ${s.defaultSet.join(",")}`);
  // A catalog rebuild may move an item or two; a real regression shows up as a violation or a drop below 97%.
  process.exit(r.hitRate >= 0.97 && !r.violations.length && !r.clusterDuplicates ? 0 : 1);
}
