// Decision lock test for DL-036 (R2=A, approved by Ahmet 2026-10-01):
// an edge that was not exercised by a forcing test may never enter the
// capability graph. The frozen seed (data/graph-seed.json) must satisfy
// this, and the loader must reject any seed that does not.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { validateSeed, buildGraph } from "../lib/pipeline/graph/loader.mjs";

const seedPath = new URL("../data/graph-seed.json", import.meta.url);
const seed = JSON.parse(readFileSync(seedPath, "utf8"));

test("R2 lock: every edge in the frozen seed is test-forced", () => {
  assert.ok(Array.isArray(seed.edges) && seed.edges.length > 0, "seed has edges");
  const bad = seed.edges.filter(
    (e) => e.tested !== true || typeof e.test !== "string" || !e.test
  );
  assert.deepEqual(
    bad.map((e) => e?.id),
    [],
    `R2 violation in data/graph-seed.json: ${JSON.stringify(bad.map((e) => e?.id))}`
  );
});

test("R2 lock: the frozen seed passes validation", () => {
  const { ok, errors } = validateSeed(seed);
  assert.equal(ok, true, errors.join("; "));
  const g = buildGraph(seed);
  assert.equal(g.edges.length, seed.edges.length);
});

test("R2 lock: an untested edge is rejected from the graph", () => {
  const s = { version: 1, edges: [
    { id: "x1", type: "fallback", from: "item:a", to: "item:b", tested: false, test: "t#x1" },
  ] };
  const { ok, errors } = validateSeed(s);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("R2")), errors.join("; "));
  assert.throws(() => buildGraph(s), /R2/);
});

test("R2 lock: a tested flag that is merely missing is rejected too", () => {
  const s = { version: 1, edges: [
    { id: "x2", type: "provides", from: "item:a", to: "cap:x", test: "t#x2" },
  ] };
  assert.equal(validateSeed(s).ok, false);
});
