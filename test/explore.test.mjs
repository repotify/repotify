// P3 / DL-051: ε-greedy exploration in the serving path.
import { strict as assert } from "node:assert";
import { test, before } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSeedGraph } from "../lib/pipeline/graph/loader.mjs";
import { recommendV1 } from "../lib/pipeline/recommend/index.mjs";
import { buildDemand } from "../src/recommend.mjs";
import { resolveNeeds } from "../src/needs.mjs";
import { loadCatalog } from "../src/catalog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let graph;
let catalog;

before(async () => {
  graph = loadSeedGraph(join(root, "data", "graph-seed.json"));
  ({ catalog } = await loadCatalog());
});

const demandFor = (fingerprint) => {
  const needs = resolveNeeds({ fingerprint, answers: {}, taxonomy: catalog.taxonomy });
  const d = buildDemand({ taxonomy: catalog.taxonomy, fingerprint, needs });
  return { ...d, stacks: fingerprint.stacks ?? [], answered: needs.answered };
};

test("exploreEpsilon=0: deterministic, no exploration markers", async () => {
  const demand = demandFor({ stacks: ["python"], platforms: [], capabilityHints: [], inferredNeeds: ["data-processing"] });
  const r = await recommendV1({ catalog, graph, demand }, { exploreEpsilon: 0, rng: () => 0.0 });
  assert.equal(r.explored, false);
  assert.equal(r.exploreItemId, null);
  assert.equal(r.exploreEpsilon, 0);
});

test("exploreEpsilon=1: always explores when possible", async () => {
  const demand = demandFor({ stacks: ["python"], platforms: [], capabilityHints: [], inferredNeeds: ["data-processing"] });
  // rng: first call < 1 (explore), second picks candidate index.
  let calls = 0;
  const rng = () => (calls++ === 0 ? 0.5 : 0.0);
  const r = await recommendV1({ catalog, graph, demand }, { exploreEpsilon: 1, rng });
  if (r.decision === "recommend" && r.set.length > 0) {
    assert.equal(r.explored, true);
    assert.ok(r.exploreItemId);
    assert.ok(r.set.includes(r.exploreItemId), "explore item is in the set");
  }
});

test("exploration only swaps with safety-filtered candidates", async () => {
  const demand = demandFor({ stacks: ["python"], platforms: [], capabilityHints: [], inferredNeeds: ["data-processing"] });
  let calls = 0;
  const rng = () => (calls++ === 0 ? 0.5 : 0.999);
  const r = await recommendV1({ catalog, graph, demand }, { exploreEpsilon: 1, rng });
  if (r.explored) {
    const rankedIds = new Set(r.ranked.map((x) => x.id));
    assert.ok(rankedIds.has(r.exploreItemId), "explore item comes from the ranked (filtered) list");
  }
});
