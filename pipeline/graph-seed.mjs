#!/usr/bin/env node
// Rebuild the capability graph seed (data/graph-seed.json) from the catalog.
//
// PROVIDES edges are derived, one per item capability, so the graph covers the
// whole catalog and moves with it: when the classifier relabels a skill, its
// edge follows instead of going stale. Every other edge type (requires,
// depends_on, conflicts_with, supersedes, fallback) is a curator's judgement
// and is kept as written, as long as both ends still exist. Each edge names its
// forcing case in test/graph-edges.test.mjs, which generates one per seed edge (R2).
//   node pipeline/graph-seed.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../src/util.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST = "test/graph-edges.test.mjs";

export function rebuildSeedGraph(seed, items, { classification = {}, generatedAt = new Date().toISOString().slice(0, 10) } = {}) {
  const ids = new Set(items.map((i) => i.id));
  const exists = (ref) => !ref.startsWith("item:") || ids.has(ref.slice(5));
  const curatedEdges = seed.edges.filter((e) => e.type !== "provides" && exists(e.from) && exists(e.to));
  const provides = [];
  for (const it of [...items].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const cap of it.capabilities ?? []) {
      const id = `p:${it.id}:${cap}`;
      const c = classification[it.id];
      const why = c?.apply === "auto" && c.job === cap
        ? `Classified by ${c.model ?? "the decision model"}: main job ${cap} (p=${c.jobP}).`
        : `Curated catalog label: ${it.id} provides ${cap}.`;
      provides.push({ id, from: `item:${it.id}`, to: `cap:${cap}`, type: "provides", rationale: why, test: `${TEST}#${id}`, tested: true });
    }
  }
  return {
    ...seed,
    generatedAt,
    note: "Capability graph seed for Repotify v2. Node refs: 'item:<catalog-id>' and 'cap:<taxonomy-capability>'. PROVIDES edges are derived from the catalog by pipeline/graph-seed.mjs; every other edge was authored by a curator. Each edge must pass its forcing-case test (R2).",
    edges: [...provides, ...curatedEdges],
  };
}

if (isMain(import.meta.url)) {
  const path = join(root, "data", "graph-seed.json");
  const seed = JSON.parse(readFileSync(path, "utf8"));
  const items = JSON.parse(readFileSync(join(root, "catalog", "items.json"), "utf8"));
  let classification = {};
  try {
    classification = JSON.parse(readFileSync(join(root, "pipeline", "classification.json"), "utf8")).items;
  } catch {}
  const next = rebuildSeedGraph(seed, items, { classification });
  const dropped = seed.edges.filter((e) => e.type !== "provides" && !next.edges.some((x) => x.id === e.id)).map((e) => e.id);
  writeFileSync(path, JSON.stringify(next) + "\n");
  console.log(`graph seed: ${next.edges.filter((e) => e.type === "provides").length} provides edges (derived), ${next.edges.length} edges in all${dropped.length ? `; curated edges whose items left: ${dropped.join(", ")}` : ""}`);
}
