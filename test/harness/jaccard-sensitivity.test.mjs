// Unit tests for test/harness/jaccard-sensitivity.mjs.
// The sweep re-implements the coverage gate's greedy loop to vary the
// JACCARD_DROP threshold (a module const in production). These tests pin the
// re-implementation to production present() and validate the report shape.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scenarioInputs,
  simulateJaccardGate,
  checkFaithfulness,
  runSensitivity,
  JACCARD_GRID,
  RECALL_FLOOR,
} from "./jaccard-sensitivity.mjs";
import { loadCatalog, seedGraph } from "./arms.mjs";
import { present, JACCARD_DROP } from "../../lib/pipeline/recommend/index.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
let catalog;
let graph;
let scenarios;

before(() => {
  catalog = loadCatalog((f) => JSON.parse(readFileSync(join(here, "..", "..", "catalog", f), "utf8")));
  graph = seedGraph();
  scenarios = ["js-frontend", "python-api"].map((id) =>
    JSON.parse(readFileSync(join(here, "scenarios", `${id}.json`), "utf8")),
  );
});

describe("jaccard-sensitivity sweep", () => {
  it("grid covers the shipped default and the +/-0.1 knife-edge window", () => {
    assert.ok(JACCARD_GRID.includes(JACCARD_DROP), "default threshold on the grid");
    assert.ok(JACCARD_GRID.includes(0.5) && JACCARD_GRID.includes(0.7), "window endpoints on the grid");
    assert.equal(RECALL_FLOOR, 0.857, "floor matches the published post-triage pilot recall");
  });

  it("simulation matches production present() at the default threshold (faithfulness)", () => {
    delete process.env.REPOTIFY_COVERAGE_VARIANT;
    for (const scenario of scenarios) {
      const { demand, kept } = scenarioInputs(catalog, graph, scenario);
      const prod = present(kept, demand, {});
      const sim = simulateJaccardGate(kept, demand, JACCARD_DROP);
      const fc = checkFaithfulness(prod, sim);
      assert.ok(fc.faithful, `scenario ${scenario.id}: ${fc.detail}`);
    }
  });

  it("checkFaithfulness detects a drifted simulation", () => {
    delete process.env.REPOTIFY_COVERAGE_VARIANT;
    const scenario = scenarios[0];
    const { demand, kept } = scenarioInputs(catalog, graph, scenario);
    const prod = present(kept, demand, {});
    const sim = simulateJaccardGate(kept, demand, 0.3); // different threshold: must differ
    const fc = checkFaithfulness(prod, sim);
    assert.equal(fc.faithful, false, "different threshold must not be faithful");
    assert.ok(fc.detail, "drift detail explains the mismatch");
  });

  it("runSensitivity produces the report shape CI consumes", () => {
    const report = runSensitivity({ catalog, graph, scenarios, grid: [0.5, 0.6, 0.7] });
    assert.equal(report.variant, "jaccard");
    assert.equal(report.threshold_default, JACCARD_DROP);
    assert.equal(report.faithful, true);
    assert.equal(report.per_threshold.length, 3);
    for (const p of report.per_threshold) {
      assert.ok(typeof p.mean_recall === "number" && p.mean_recall >= 0 && p.mean_recall <= 1);
      assert.ok(p.per_scenario["js-frontend"], "per-scenario detail present");
    }
    assert.deepEqual(Object.keys(report.window.recall).sort(), ["def", "minus", "plus"]);
    assert.equal(typeof report.window.knife_edge, "boolean");
    assert.equal(report.baseline.recall_floor, RECALL_FLOOR);
    assert.equal(report.baseline.pass, true, "baseline floor holds on the committed catalog");
  });

  it("sweep is deterministic across runs", () => {
    const a = runSensitivity({ catalog, graph, scenarios, grid: [0.55, 0.6] });
    const b = runSensitivity({ catalog, graph, scenarios, grid: [0.55, 0.6] });
    assert.deepEqual(a.per_threshold, b.per_threshold);
  });
});
