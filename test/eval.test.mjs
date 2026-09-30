import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadScenarios, runEval } from "./eval/run.mjs";

const read = (f) => JSON.parse(readFileSync(new URL(`../catalog/${f}`, import.meta.url), "utf8"));
const catalog = { items: read("items.json"), taxonomy: read("taxonomy.json"), loadouts: read("loadouts.json"), core: read("core.json") };

test("runEval scores must-include hits, must-not violations and cluster duplicates", () => {
  const scenarios = [
    { name: "a", fingerprint: { empty: true, stacks: [], inferredNeeds: [], agents: { skills: [] } }, answers: { projectType: "mobile" }, mustInclude: ["react-native-skills", "not-a-real-id"], mustNotInclude: ["test-driven-development"] },
  ];
  const r = runEval(scenarios, catalog);
  assert.equal(r.hitRate, 0.5);
  assert.deepEqual(r.misses, [{ scenario: "a", id: "not-a-real-id" }]);
  assert.deepEqual(r.violations, [{ scenario: "a", id: "test-driven-development" }]);
  assert.equal(r.clusterDuplicates, 0);
});

test("the scenario set: at least 40 scenarios, >= 97% must-include hits, no violations, no duplicates", () => {
  const scenarios = loadScenarios();
  assert.ok(scenarios.length >= 40, `${scenarios.length} scenarios`);
  const r = runEval(scenarios, catalog);
  assert.equal(r.clusterDuplicates, 0);
  assert.deepEqual(r.violations, []);
  assert.ok(r.hitRate >= 0.97, `hit rate ${r.hitRate.toFixed(3)}; misses ${JSON.stringify(r.misses)}`);
});
