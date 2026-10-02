// The engine users get is the engine the quality bar measures. These tests lock
// the fixes from the 2026-10-02 review: the eval used to score the frozen v1
// engine while the CLI served v2, so a 100% eval sat next to sets that offered
// Spring Boot to Flask apps and rootkit analysis to web shops.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarios, runEval } from "./eval/run.mjs";
import { demandFor, recommendLocal, recommendV1, classFitOf } from "../lib/pipeline/recommend/index.mjs";
import { loadSeedGraph } from "../lib/pipeline/graph/loader.mjs";
import { resolveNeeds } from "../src/needs.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(readFileSync(join(root, "catalog", f), "utf8"));
const catalog = { items: read("items.json"), taxonomy: read("taxonomy.json"), loadouts: read("loadouts.json"), core: read("core.json") };
const graph = loadSeedGraph(join(root, "data", "graph-seed.json"));
const scenarios = loadScenarios();
const itemById = new Map(catalog.items.map((i) => [i.id, i]));

const servedSet = (s) => {
  const fp = { empty: false, stacks: [], inferredNeeds: [], agents: { configured: [], skills: [] }, ...s.fingerprint };
  const needs = resolveNeeds({ fingerprint: fp, answers: s.answers ?? {}, taxonomy: catalog.taxonomy });
  return { fp, demand: demandFor({ catalog, fingerprint: fp, needs }) };
};

test("the eval measures the served engine: its sets equal recommendV1 without exploration", async () => {
  const r = runEval(scenarios, catalog, { graph });
  for (const s of scenarios) {
    const { demand } = servedSet(s);
    const served = await recommendV1({ catalog, graph, demand, answers: s.answers ?? {} }, { exploreEpsilon: 0 });
    const measured = r.perScenario.find((p) => p.name === s.name).defaultSet;
    assert.deepEqual(measured, served.set, s.name);
  }
});

test("no default set offers a skill written for a stack the project does not use", () => {
  for (const s of scenarios) {
    const { fp, demand } = servedSet(s);
    if (!fp.stacks.length) continue;
    for (const id of recommendLocal({ catalog, graph, demand }).set) {
      const stacks = itemById.get(id).stacks ?? [];
      if (!stacks.length || stacks.includes("*")) continue;
      assert.ok(stacks.some((x) => fp.stacks.includes(x)), `${s.name}: ${id} is for ${stacks.join("/")}, project uses ${fp.stacks.join("/")}`);
    }
  }
});

test("every project gets the core backbone, even when the demand is too thin to pick extras", () => {
  const core = catalog.items.filter((i) => i.tier === "core").map((i) => i.id);
  for (const s of scenarios) {
    const set = new Set(recommendLocal({ catalog, graph, demand: servedSet(s).demand }).set);
    const missing = core.filter((id) => !set.has(id));
    // The context budget may cut the last core item on a crowded set; never more than one.
    assert.ok(missing.length <= 1, `${s.name}: core missing ${missing.join(",")}`);
  }
  const thin = { stacks: [], platforms: [], capabilitiesWanted: ["tdd-discipline"], capWeights: {}, needs: [], needWeights: {}, webOnlyCaps: new Set(), answered: [] };
  const r = recommendLocal({ catalog, graph, demand: thin });
  assert.equal(r.decision, "reject");
  assert.ok(r.set.every((id) => core.includes(id)), `thin demand offers only core: ${r.set}`);
  assert.ok(r.set.length >= core.length - 1);
});

test("a specialist that serves one wanted job fits fully; matching more of the demand is not required", () => {
  const semgrep = itemById.get("semgrep");
  const demand = { stacks: ["python"], capabilitiesWanted: ["static-analysis", "tdd-discipline", "deploy-vercel", "property-testing", "security-review", "supply-chain-audit"], capWeights: {}, needs: [], needWeights: {}, webOnlyCaps: new Set() };
  assert.ok(classFitOf({ item: semgrep }, demand) >= 0.8);
});

test("exploration is off unless REPOTIFY_EXPLORE=1", () => {
  const cli = readFileSync(join(root, "src", "cli.mjs"), "utf8");
  assert.match(cli, /env\.REPOTIFY_EXPLORE === "1"/);
  assert.match(cli, /randomized: eps > 0/);
});

test("the catalog holds coding skills: no forensics or marketing collections, no math-contest or bot-config skills", () => {
  const offTopicRepos = ["mukul975/anthropic-cybersecurity-skills", "coreyhaines31/marketingskills"];
  for (const it of catalog.items) {
    assert.ok(!offTopicRepos.includes(it.repo), `${it.id} comes from ${it.repo}`);
    assert.ok(!["anthropics-configure", "math-olympiad", "solo"].includes(it.id), it.id);
  }
  const seed = readFileSync(join(root, "pipeline", "seed-sources.json"), "utf8");
  for (const repo of offTopicRepos) assert.ok(!seed.includes(`"repo":"${repo}"`), `seed still lists ${repo}`);
});
