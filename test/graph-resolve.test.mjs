// Tests for lib/pipeline/graph/resolve.mjs: traversal semantics on synthetic graphs.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildGraph } from "../lib/pipeline/graph/loader.mjs";
import { providersFor, candidatesFor, expandDependencies, MAX_FALLBACK_DEPTH } from "../lib/pipeline/graph/resolve.mjs";

const E = (id, type, from, to) => ({ id, type, from, to, tested: true, test: "t" });
const G = (edges) => buildGraph({ version: 1, edges });

test("providersFor lists direct providers", () => {
  const g = G([E("e1", "provides", "item:a", "cap:x"), E("e2", "provides", "item:b", "cap:x")]);
  assert.deepEqual(providersFor(g, "x").map((p) => p.id).sort(), ["a", "b"]);
  assert.deepEqual(providersFor(g, "y"), []);
});

test("blocked primaries expand through fallback chains, transitively", () => {
  const g = G([
    E("e1", "provides", "item:a", "cap:x"),
    E("e2", "fallback", "item:a", "item:b"),
    E("e3", "fallback", "item:b", "item:c"),
  ]);
  const out = providersFor(g, "x", { blockedItems: new Set(["a", "b"]) });
  assert.deepEqual(out.map((p) => p.id), ["c"]);
  assert.equal(out[0].viaFallback, true);
});

test("fallback expansion is cycle-safe", () => {
  const g = G([
    E("e1", "provides", "item:a", "cap:x"),
    E("e2", "fallback", "item:a", "item:b"),
    E("e3", "fallback", "item:b", "item:a"),
  ]);
  const out = providersFor(g, "x", { blockedItems: new Set(["a", "b"]) });
  assert.deepEqual(out, []);
});

test("blocked primary with no fallback yields nothing", () => {
  const g = G([E("e1", "provides", "item:a", "cap:x")]);
  assert.deepEqual(providersFor(g, "x", { blockedItems: new Set(["a"]) }), []);
});

test("fallback chains are depth-capped (deep fallbacks do not inherit demand)", () => {
  const g = G([
    E("e1", "provides", "item:a", "cap:x"),
    E("e2", "fallback", "item:a", "item:b"),
    E("e3", "fallback", "item:b", "item:c"),
    E("e4", "fallback", "item:c", "item:d"),
  ]);
  const out2 = providersFor(g, "x", { blockedItems: new Set(["a", "b", "c"]) });
  assert.deepEqual(out2.map((p) => p.id), [], "d at depth 3 is beyond the cap");
  const out3 = providersFor(g, "x", { blockedItems: new Set(["a", "b"]) });
  assert.deepEqual(out3.map((p) => p.id), ["c"], "c at depth 2 survives");
  assert.equal(MAX_FALLBACK_DEPTH, 2);
});

test("candidatesFor applies supersedes preference", () => {
  const g = G([
    E("e1", "provides", "item:new", "cap:x"),
    E("e2", "provides", "item:old", "cap:x"),
    E("e3", "supersedes", "item:new", "item:old"),
  ]);
  const { candidates } = candidatesFor(g, ["x"]);
  assert.deepEqual(candidates.map((c) => c.id), ["new"]);
  assert.deepEqual(candidates[0].supersedes, ["old"]);
  const { candidates: all } = candidatesFor(g, ["x"], { includeSuperseded: true });
  assert.deepEqual(all.map((c) => c.id).sort(), ["new", "old"]);
  assert.equal(all.find((c) => c.id === "old").supersededBy, "new");
});

test("candidatesFor reports conflicts as exclusion pairs", () => {
  const g = G([
    E("e1", "provides", "item:a", "cap:x"),
    E("e2", "provides", "item:b", "cap:x"),
    E("e3", "conflicts_with", "item:a", "item:b"),
  ]);
  const { candidates, exclusions } = candidatesFor(g, ["x"]);
  assert.equal(candidates.length, 2);
  assert.deepEqual(exclusions, [["a", "b"]]);
});

test("candidatesFor reports unmet requirements", () => {
  const g = G([
    E("e1", "provides", "item:a", "cap:x"),
    E("e2", "provides", "item:b", "cap:y"),
    E("e3", "requires", "item:a", "cap:y"),
  ]);
  const only = candidatesFor(g, ["x"]);
  assert.deepEqual(only.unmet, [{ item: "a", cap: "y", edge: "e3" }]);
  const both = candidatesFor(g, ["x", "y"]);
  assert.deepEqual(both.unmet, []);
});

test("expandDependencies does one hop and drops the seed caps", () => {
  const g = G([
    E("e1", "depends_on", "cap:x", "cap:y"),
    E("e2", "depends_on", "cap:y", "cap:z"),
  ]);
  assert.deepEqual(expandDependencies(g, ["x"]), ["y"]);
  assert.deepEqual(expandDependencies(g, ["x", "y"]), ["z"]);
});
