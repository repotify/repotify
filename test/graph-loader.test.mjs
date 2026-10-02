// Tests for lib/pipeline/graph/loader.mjs: schema validation and R2 enforcement.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateSeed, buildGraph, EDGE_TYPES } from "../lib/pipeline/graph/loader.mjs";

const good = () => ({
  version: 1,
  edges: [
    { id: "e1", type: "provides", from: "item:a", to: "cap:x", tested: true, test: "t#e1" },
    { id: "e2", type: "fallback", from: "item:a", to: "item:b", tested: true, test: "t#e2" },
  ],
});

test("valid seed builds an adjacency index", () => {
  const g = buildGraph(good());
  assert.equal(g.version, 1);
  assert.equal(g.edges.length, 2);
  assert.ok(g.nodes.has("item:a") && g.nodes.has("cap:x"));
  assert.equal(g.outEdges("item:a").length, 2);
  assert.equal(g.edgesOf("item:a").length, 2);
  assert.equal(g.edgesOf("item:a", "fallback").length, 1);
  assert.equal(g.edgesOf("item:missing").length, 0);
});

test("R2: an untested edge is rejected", () => {
  const s = good();
  s.edges[0].tested = false;
  const { ok, errors } = validateSeed(s);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("R2")), errors.join("; "));
  assert.throws(() => buildGraph(s), /R2/);
});

test("R2: a missing test reference is rejected", () => {
  const s = good();
  delete s.edges[1].test;
  assert.equal(validateSeed(s).ok, false);
});

test("unknown edge type is rejected", () => {
  const s = good();
  s.edges[0].type = "likes";
  const { errors } = validateSeed(s);
  assert.ok(errors.some((e) => e.includes("unknown type")));
});

test("bad node refs are rejected", () => {
  const s = good();
  s.edges[0].from = "a";
  s.edges[1].to = "cap:";
  const { errors } = validateSeed(s);
  assert.equal(errors.filter((e) => e.includes("bad ")).length, 2);
});

test("self edges and duplicates are rejected", () => {
  const s = good();
  s.edges[0].to = "item:a";
  const r1 = validateSeed(s);
  assert.ok(r1.errors.some((e) => e.includes("self edge")));
  const s2 = good();
  s2.edges.push({ ...s2.edges[0], id: "e3" });
  assert.ok(validateSeed(s2).errors.some((e) => e.includes("duplicate edge ")));
  const s3 = good();
  s3.edges.push({ ...s3.edges[0], type: "requires" });
  assert.ok(validateSeed(s3).errors.some((e) => e.includes("duplicate edge id")));
});

test("unsupported seed version is rejected", () => {
  const s = good();
  s.version = 99;
  assert.ok(validateSeed(s).errors.some((e) => e.includes("unsupported seed version")));
});

test("all six edge types are in the vocabulary", () => {
  assert.deepEqual([...EDGE_TYPES].sort(), ["conflicts_with", "depends_on", "fallback", "provides", "requires", "supersedes"]);
});
