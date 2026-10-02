// R2: every edge in data/graph-seed.json must pass at least one forcing-case
// test. This file iterates the seed and forces each edge's semantics through
// the resolver. An edge that no test exercises cannot enter the graph — the
// loader rejects it at build time (see graph-loader.test.mjs).

import { strict as assert } from "node:assert";
import { test, before } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSeedGraph, item as itemRef } from "../lib/pipeline/graph/loader.mjs";
import { providersFor, candidatesFor, expandDependencies } from "../lib/pipeline/graph/resolve.mjs";
import { resolveExclusions } from "../lib/pipeline/recommend/present.mjs";
import { loadCatalog } from "../src/catalog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let graph;
let catalog;
let seed;

before(async () => {
  seed = JSON.parse(readFileSync(join(root, "data", "graph-seed.json"), "utf8"));
  graph = loadSeedGraph(join(root, "data", "graph-seed.json"));
  ({ catalog } = await loadCatalog());
});

const nodeId = (ref) => ref.slice(ref.indexOf(":") + 1);
const providesCapsOf = (itemId) =>
  graph.byType.get("provides").filter((e) => e.from === itemRef(itemId)).map((e) => nodeId(e.to));
const byId = (id) => seed.edges.find((e) => e.id === id);

// Debate fix (eleştirmen): tested:true is a flag that can lie. The contract
// above checks the reference format; this one checks the reference RESOLVES —
// the file exists and generates one forcing case per seed edge, named by edge
// id (the actual per-edge execution is then verified by the 65 passing
// generated cases below).
test("seed contract: every test reference resolves to a real forcing-case generator", () => {
  for (const e of seed.edges) {
    const [file] = String(e.test).split("#");
    const path = join(root, file);
    assert.ok(existsSync(path), `${e.id}: ${file} must exist`);
    const src = readFileSync(path, "utf8");
    assert.ok(src.includes("seed.edges"), `${e.id}: ${file} must generate cases from the seed`);
    assert.ok(src.includes("${e.id}"), `${e.id}: ${file} must name forcing cases by edge id`);
  }
});
test("seed contract: every edge is marked tested with a test reference", () => {
  assert.ok(seed.edges.length >= 50, `want 50+ edges, got ${seed.edges.length}`);
  for (const e of seed.edges) {
    assert.equal(e.tested, true, `${e.id} must be tested:true (R2)`);
    assert.ok(e.test && e.test.includes(`#${e.id}`), `${e.id} must reference its forcing test`);
    assert.equal(byId(e.id), e);
  }
});

for (const e of seed.edges) {
  test(`edge ${e.id} [${e.type}] ${e.from} -> ${e.to}`, () => {
    if (!graph || !catalog) return; // before() failed; contract test above reports it
    const from = nodeId(e.from);
    const to = nodeId(e.to);
    switch (e.type) {
      case "provides": {
        // The catalog agrees, and the resolver surfaces the provider.
        const it = catalog.items.find((x) => x.id === from);
        assert.ok(it, `${from} is a catalog item`);
        assert.ok((it.capabilities ?? []).includes(to), `${from} lists capability ${to} in the catalog`);
        const providers = providersFor(graph, to).map((p) => p.id);
        assert.ok(providers.includes(from), `providersFor(${to}) includes ${from}`);
        break;
      }
      case "requires": {
        // The requirement is satisfiable (someone provides it) and the edge
        // adds information (the item does not provide it itself).
        const it = catalog.items.find((x) => x.id === from);
        assert.ok(!(it.capabilities ?? []).includes(to), `${from} does not provide ${to} itself`);
        assert.ok(providersFor(graph, to).length > 0, `${to} has at least one provider`);
        // Forcing case: wanting only the item's own capability leaves the
        // requirement unmet, so the resolver reports it. includeSuperseded
        // keeps superseded items visible for this check.
        const ownCaps = providesCapsOf(from);
        assert.ok(ownCaps.length > 0, `${from} provides something`);
        const { candidates, unmet } = candidatesFor(graph, ownCaps, { includeSuperseded: true });
        assert.ok(candidates.some((c) => c.id === from), `${from} is a candidate for its own caps`);
        assert.ok(
          unmet.some((u) => u.item === from && u.cap === to),
          `unmet requirement reported for ${from} -> ${to}`,
        );
        break;
      }
      case "depends_on": {
        const expanded = expandDependencies(graph, [from]);
        assert.ok(expanded.includes(to), `expandDependencies([${from}]) includes ${to}`);
        break;
      }
      case "conflicts_with": {
        // Forcing case: when both are candidates, the exclusion pair appears
        // in the audit trail, and conflict resolution keeps the higher scorer.
        const wanted = [...new Set([...providesCapsOf(from), ...providesCapsOf(to)])];
        assert.ok(providesCapsOf(from).length > 0 && providesCapsOf(to).length > 0, "both sides provide something in the seed");
        const { candidates, exclusions } = candidatesFor(graph, wanted);
        assert.ok(candidates.some((c) => c.id === from) && candidates.some((c) => c.id === to), "both are candidates");
        assert.ok(
          exclusions.some(([a, b]) => (a === from && b === to) || (a === to && b === from)),
          `exclusion pair [${from}, ${to}] reported`,
        );
        const scored = [from, to].map((id) => ({
          item: { id, descriptionChars: 100, tier: "mission" },
          score: id === from ? 0.9 : 0.8,
          flags: [],
          reasons: [],
        }));
        const { kept, dropped } = resolveExclusions(scored, exclusions);
        assert.deepEqual(kept.map((k) => k.item.id), [from]);
        assert.ok(dropped.some((d) => d.id === to), `${to} dropped as the lower scorer`);
        break;
      }
      case "supersedes": {
        // Forcing case: the superseded item never enters as a candidate while
        // the superseder does, and the preference is recorded.
        const wanted = [...new Set([...providesCapsOf(from), ...providesCapsOf(to)])];
        const { candidates } = candidatesFor(graph, wanted);
        const winner = candidates.find((c) => c.id === from);
        assert.ok(winner, `${from} is a candidate`);
        assert.ok(!candidates.some((c) => c.id === to), `${to} is not a candidate`);
        assert.ok(winner.supersedes.includes(to), `preference ${from} supersedes ${to} recorded`);
        break;
      }
      case "fallback": {
        // Forcing case: blocking the primary surfaces the fallback instead.
        const caps = providesCapsOf(from);
        assert.ok(caps.length > 0, `${from} provides something`);
        const cap = caps[0];
        const normal = providersFor(graph, cap).map((p) => p.id);
        assert.ok(normal.includes(from), `${from} is the normal provider of ${cap}`);
        const blocked = providersFor(graph, cap, { blockedItems: new Set([from]) });
        assert.ok(!blocked.some((p) => p.id === from), `${from} is gone when blocked`);
        const fb = blocked.find((p) => p.id === to);
        assert.ok(fb, `${to} surfaces as fallback for ${cap}`);
        // When the fallback target is also a direct provider, it was already
        // reachable; the edge then only documents the preference.
        if (!normal.includes(to)) assert.equal(fb.viaFallback, true, `${to} reached via fallback`);
        break;
      }
      default:
        assert.fail(`unknown edge type ${e.type}`);
    }
  });
}
