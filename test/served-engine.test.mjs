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

// 2026-10-02 audit: the v2 engine forgot what the project already had. After
// installing frontend-design, sql-pro and differential-review it starred
// image-to-code, database-optimizer and claude-security (the same three jobs),
// and a skill copied in by hand was starred again although `install` refuses it.
const webApp = { empty: false, stacks: ["nextjs", "node", "react", "typescript"], platforms: ["web"], inferredNeeds: ["database", "e2e-testing", "frontend-ui", "testing"], frameworks: ["next"], agents: { configured: [], skills: [] } };
const webDemand = () => demandFor({ catalog, fingerprint: webApp, needs: resolveNeeds({ fingerprint: webApp, answers: {}, taxonomy: catalog.taxonomy }) });

test("installed items keep their job: nothing else is offered for it, and their context counts", async () => {
  const installed = ["frontend-design", "sql-pro", "differential-review"];
  const fresh = await recommendV1({ catalog, graph, demand: webDemand() });
  const r = await recommendV1({ catalog, graph, demand: webDemand(), installed });
  const heldClusters = new Set(installed.map((id) => itemById.get(id).cluster));
  for (const id of r.set) {
    assert.ok(!installed.includes(id), `${id} is installed already`);
    assert.ok(!heldClusters.has(itemById.get(id).cluster), `${id} does the job of an installed item`);
  }
  for (const id of installed) assert.ok(r.table.some((t) => t.id === id && t.installed && !t.default), `${id} listed as installed`);
  const chars = (ids) => ids.reduce((n, id) => n + itemById.get(id).descriptionChars, 0);
  assert.equal(r.budget.used, chars(installed) + chars(r.set));
  assert.ok(fresh.set.includes("frontend-design") && fresh.set.includes("sql-pro"));
});

test("a candidate that conflicts with an installed item is not offered", () => {
  const [a, b] = ["ask-navigator", "behavioral-modes"];
  assert.ok(itemById.get(a).conflicts.includes(b), "fixture: the catalog pairs them");
  const narrowed = recommendLocal({ catalog, graph, demand: webDemand(), installed: [a] }).narrowed;
  const out = narrowed.eliminated.find((e) => e.id === b);
  assert.ok(!narrowed.candidates.some((c) => c.item.id === b));
  assert.ok(out.reasons.includes(`conflicts-with-installed:${a}`), JSON.stringify(out));
});

test("the candidate table has one row per job, no noise below the fit floor, and a reason on every row", () => {
  for (const s of scenarios) {
    const { demand } = servedSet(s);
    const r = recommendLocal({ catalog, graph, demand });
    const clusters = r.table.map((t) => itemById.get(t.id).cluster);
    assert.equal(new Set(clusters).size, clusters.length, `${s.name}: a job listed twice (${clusters.join(",")})`);
    for (const t of r.table) {
      const s2 = r.scored.find((x) => x.item.id === t.id);
      if (itemById.get(t.id).tier !== "core") assert.ok(s2.parts.classFit >= 0.2, `${s.name}: ${t.id} fit ${s2.parts.classFit}`);
      assert.ok(t.reasons.length > 0, `${s.name}: ${t.id} has no reason`);
    }
    for (const id of r.set) assert.ok(r.table.some((t) => t.id === id && t.default), `${s.name}: ${id} missing from the table`);
  }
});

test("Jev arbitration is asked only about optional items, never the core that tops every ranking", async () => {
  const asked = [];
  const arbitrate = async (ids) => {
    asked.push(...ids);
    return Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 1 : 0]));
  };
  for (const s of scenarios) await recommendV1({ catalog, graph, demand: servedSet(s).demand }, { arbitrate });
  assert.ok(asked.length > 0, "some scenario is ambiguous enough to ask");
  for (const id of asked) assert.notEqual(itemById.get(id).tier, "core", `${id} is core`);
});
