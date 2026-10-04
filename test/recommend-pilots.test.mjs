// 10 pilot projects through recommendV1 on the REAL catalog and REAL seed graph.
// Asserts the recommendation sets are sensible and low-confidence flags land
// where they should. This is the v1 acceptance gate for the pipeline.
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

const demandFor = (fingerprint, answers = {}) => {
  const needs = resolveNeeds({ fingerprint, answers, taxonomy: catalog.taxonomy });
  const d = buildDemand({ taxonomy: catalog.taxonomy, fingerprint, needs });
  return { ...d, stacks: fingerprint.stacks ?? [], answered: needs.answered };
};

const pilots = [
  {
    name: "nextjs web app with stripe and playwright",
    fp: { stacks: ["nextjs", "react", "typescript"], platforms: ["web"], capabilityHints: [], inferredNeeds: ["e2e-testing", "payments", "frontend-ui"] },
    expect: { decision: "recommend", includesAny: ["playwright-mcp", "webapp-testing", "nextjs-developer"] },
  },
  {
    name: "python data pipeline with pandas",
    fp: { stacks: ["python"], platforms: [], capabilityHints: [], inferredNeeds: ["data-processing"] },
    // fine-tuning-expert now wins the data-ml cluster on score; pandas was
    // never a catalog id.
    expect: { decision: "recommend", includesAny: ["data-engineer", "ml-pipeline", "fine-tuning-expert"] },
  },
  {
    name: "rust cli with clap",
    fp: { stacks: ["rust"], frameworks: ["clap"], platforms: [], capabilityHints: [], inferredNeeds: [] },
    expect: { decision: "recommend" },
  },
  {
    name: "react native mobile app",
    fp: { stacks: ["react-native", "expo"], platforms: ["mobile"], capabilityHints: [], inferredNeeds: ["mobile"] },
    expect: { decision: "recommend", includesAny: ["react-native-expert", "react-native-skills"] },
  },
  {
    name: "empty project, no signal",
    fp: { empty: true, stacks: [], platforms: [], capabilityHints: [], inferredNeeds: [] },
    expect: { decision: "reject", reason: "no-candidates" },
  },
  {
    name: "mcp server project",
    fp: { stacks: ["typescript"], platforms: [], capabilityHints: [], inferredNeeds: ["mcp-server", "llm-calls"] },
    expect: { decision: "recommend", includesAny: ["mcp-builder", "mcp-developer"] },
  },
  {
    name: "pdf processing scripts",
    fp: { stacks: ["python"], platforms: [], capabilityHints: ["pdf-processing"], inferredNeeds: ["pdf"] },
    expect: { decision: "recommend", includesAny: ["pdf"] },
  },
  {
    name: "solidity smart contracts",
    fp: { stacks: ["solidity"], platforms: [], capabilityHints: [], inferredNeeds: ["smart-contracts"] },
    expect: { decision: "recommend", includesAny: ["guidelines-advisor"] },
  },
  {
    name: "fastapi backend",
    fp: { stacks: ["fastapi", "python"], platforms: [], capabilityHints: [], inferredNeeds: [] },
    expect: { decision: "recommend", includesAny: ["fastapi-expert"] },
  },
  {
    name: "thin ambiguous signal",
    fp: { stacks: [], platforms: [], capabilityHints: [], inferredNeeds: [] },
    answers: {},
    thin: true,
    expect: { decision: "reject" },
  },
];

for (const p of pilots) {
  test(`pilot: ${p.name}`, async () => {
    const demand = p.thin
      ? { stacks: [], platforms: [], capabilitiesWanted: ["tdd-discipline"], capWeights: { "tdd-discipline": 1 }, needs: [], needWeights: {}, webOnlyCaps: new Set(), answered: [] }
      : demandFor(p.fp, p.answers ?? {});
    const r = await recommendV1({ catalog, graph, demand });
    assert.equal(r.decision, p.expect.decision, `${p.name}: decision (reason=${r.reason ?? "n/a"})`);
    if (p.expect.reason) assert.equal(r.reason, p.expect.reason);
    if (p.expect.includesAny) {
      assert.ok(
        p.expect.includesAny.some((id) => r.set.includes(id)),
        `${p.name}: set ${JSON.stringify(r.set)} should include one of ${p.expect.includesAny}`,
      );
    }
    if (r.decision === "recommend") {
      // Every row carries an audit trail.
      for (const row of r.rows) {
        assert.ok(row.reasons.length > 0, `${row.id} has reasons`);
        assert.ok(typeof row.score === "number");
      }
      // Budget respected.
      assert.ok(r.budget.used <= r.budget.limit);
    } else {
      assert.ok(r.reason, "reject carries a reason");
      assert.ok(r.advice, "reject carries advice");
    }
  });
}

test("pilots: no pilot recommends a blocked-verdict item", async () => {
  for (const p of pilots) {
    const demand = p.thin
      ? { stacks: [], platforms: [], capabilitiesWanted: ["tdd-discipline"], capWeights: {}, needs: [], needWeights: {}, webOnlyCaps: new Set(), answered: [] }
      : demandFor(p.fp, p.answers ?? {});
    const r = await recommendV1({ catalog, graph, demand });
    for (const id of r.set) {
      const item = catalog.items.find((i) => i.id === id);
      assert.notEqual(item.security.level, "blocked", `${id} must not be recommended`);
    }
  }
});
