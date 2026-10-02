// Tests for lib/pipeline/graph/check.mjs: contradiction hunting.
import { strict as assert } from "node:assert";
import { test, before } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSeedGraph } from "../lib/pipeline/graph/loader.mjs";
import { auditGraph } from "../lib/pipeline/graph/check.mjs";
import { loadCatalog } from "../src/catalog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let seedGraph;
let catalog;

before(async () => {
  seedGraph = loadSeedGraph(join(root, "data", "graph-seed.json"));
  ({ catalog } = await loadCatalog());
});

const ctxOf = () => ({
  itemIds: new Set(catalog.items.map((i) => i.id)),
  capabilities: catalog.taxonomy.capabilities,
  catalogItems: new Map(catalog.items.map((i) => [i.id, i])),
});

const mini = (edges) => ({
  edges,
  byType: new Map([["provides", edges.filter((e) => e.type === "provides")]]),
});

test("the shipped seed audits clean against the catalog", () => {
  const issues = auditGraph(seedGraph, ctxOf());
  assert.deepEqual(issues, [], JSON.stringify(issues, null, 1));
});

test("dangling item and capability refs are reported", () => {
  const g = mini([
    { id: "x1", type: "provides", from: "item:nope", to: "cap:also-nope", tested: true, test: "t" },
  ]);
  const issues = auditGraph(g, ctxOf());
  assert.ok(issues.some((i) => i.code === "dangling-item"));
  assert.ok(issues.some((i) => i.code === "dangling-cap"));
});

test("conflicts_with + requires on the same pair is a contradiction", () => {
  const g = {
    edges: [
      { id: "x1", type: "conflicts_with", from: "item:a", to: "item:b", tested: true, test: "t" },
      { id: "x2", type: "requires", from: "item:a", to: "item:b", tested: true, test: "t" },
    ],
    byType: new Map([["provides", []]]),
  };
  const issues = auditGraph(g, { itemIds: new Set(["a", "b"]), capabilities: {}, catalogItems: new Map() });
  assert.ok(issues.some((i) => i.code === "conflict-vs-requires"), JSON.stringify(issues));
  // One-sided conflict without a requires edge is not a contradiction.
  const g2 = {
    edges: [{ id: "x1", type: "conflicts_with", from: "item:a", to: "item:b", tested: true, test: "t" }],
    byType: new Map([["provides", []]]),
  };
  const clean = auditGraph(g2, { itemIds: new Set(["a", "b"]), capabilities: {}, catalogItems: new Map() });
  assert.ok(!clean.some((i) => i.code === "conflict-vs-requires"));
});

test("supersedes cycles are reported", () => {
  const g = {
    edges: [
      { id: "x1", type: "supersedes", from: "item:a", to: "item:b", tested: true, test: "t" },
      { id: "x2", type: "supersedes", from: "item:b", to: "item:a", tested: true, test: "t" },
    ],
    byType: new Map([["provides", []]]),
  };
  const issues = auditGraph(g, { itemIds: new Set(["a", "b"]), capabilities: {}, catalogItems: new Map() });
  assert.ok(issues.some((i) => i.code === "supersede-cycle"));
});

test("fallback loops are reported", () => {
  const g = {
    edges: [
      { id: "x1", type: "fallback", from: "item:a", to: "item:b", tested: true, test: "t" },
      { id: "x2", type: "fallback", from: "item:b", to: "item:a", tested: true, test: "t" },
    ],
    byType: new Map([["provides", []]]),
  };
  const issues = auditGraph(g, { itemIds: new Set(["a", "b"]), capabilities: {}, catalogItems: new Map() });
  assert.ok(issues.some((i) => i.code === "fallback-loop"));
});

test("provides edges the catalog disagrees with are reported", () => {
  const g = mini([
    { id: "x1", type: "provides", from: "item:pdf", to: "cap:spreadsheets", tested: true, test: "t" },
  ]);
  const issues = auditGraph(g, ctxOf());
  assert.ok(issues.some((i) => i.code === "provides-mismatch"));
});
