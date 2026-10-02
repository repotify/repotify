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

// A web app: the table has open jobs (alternates) and the set has optional items to swap.
const webApp = { stacks: ["nextjs", "react", "typescript", "node"], platforms: ["web"], capabilityHints: [], inferredNeeds: ["frontend-ui", "testing", "e2e-testing"], frameworks: ["next"] };
const clustersOf = (ids) => ids.map((id) => catalog.items.find((i) => i.id === id)?.cluster);

test("exploreEpsilon=1: explores whenever an open job and an optional set item exist", async () => {
  const demand = demandFor(webApp);
  // rng: first call < 1 (explore), second picks the alternate.
  let calls = 0;
  const rng = () => (calls++ === 0 ? 0.5 : 0.0);
  const r = await recommendV1({ catalog, graph, demand }, { exploreEpsilon: 1, rng });
  assert.equal(r.decision, "recommend");
  assert.ok(r.exploreCandidates > 0);
  assert.equal(r.explored, true);
  assert.ok(r.set.includes(r.exploreItemId), "explore item is in the set");
  assert.equal(new Set(clustersOf(r.set)).size, r.set.length, "still one item per job");
});

test("exploration only swaps in an alternate from the candidate table, never a core item out", async () => {
  const demand = demandFor(webApp);
  const base = await recommendV1({ catalog, graph, demand });
  let calls = 0;
  const rng = () => (calls++ === 0 ? 0.5 : 0.999);
  const r = await recommendV1({ catalog, graph, demand }, { exploreEpsilon: 1, rng });
  assert.equal(r.explored, true);
  const alternates = base.table.filter((t) => !t.default && !t.installed).map((t) => t.id);
  assert.ok(alternates.includes(r.exploreItemId), "explore item is a table alternate");
  for (const id of base.set) {
    if (catalog.items.find((i) => i.id === id).tier === "core") assert.ok(r.set.includes(id), `${id} kept`);
  }
});

test("no open job, no exploration: the swap never doubles a job", async () => {
  const demand = demandFor({ stacks: ["python"], platforms: [], capabilityHints: [], inferredNeeds: ["data-processing"] });
  const r = await recommendV1({ catalog, graph, demand }, { exploreEpsilon: 1, rng: () => 0 });
  if (!r.exploreCandidates) assert.equal(r.explored, false);
  assert.equal(new Set(clustersOf(r.set)).size, r.set.length);
});
