#!/usr/bin/env node
// Classify the whole catalog with Jev and apply the rules in pipeline/jev-classify.mjs.
//   JEV_API_KEY=... node pipeline/classify-catalog.mjs [--dry-run] [--cache DIR]
// Writes:
//   catalog/taxonomy.json            + the capabilities and needs the old taxonomy lacked
//   catalog/items.json, meta.json    labels applied; off-topic and product-bound lab items out
//   pipeline/classification.json     every answer, so a catalog rebuild re-applies them
//   pipeline/classification-review.json  what a human should look at (held out of the catalog
//                                    when it came from the lab; kept when it was curated)
//   pipeline/seed-sources.json       lab entries that left the catalog are removed from the seed
//   data/graph-seed.json             PROVIDES edges re-derived from the new labels (pipeline/graph-seed.mjs)
// Curated items (core, and the hand-written seed entries) are never relabelled automatically.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { classifyItem, skillText, capabilityOptions, stackOptions, mapLimit, decide, recordOf, extendTaxonomy } from "./jev-classify.mjs";
import { writeCatalogFiles } from "./publish.mjs";
import { validateCatalog } from "../src/catalog.mjs";
import { jevConfig } from "../lib/signals/jev.mjs";
import { rebuildSeedGraph } from "./graph-seed.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const cacheDir = argv.includes("--cache") ? argv[argv.indexOf("--cache") + 1] : join(homedir(), ".cache", "repotify-classify");
const json = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const taxonomy = extendTaxonomy(json("catalog/taxonomy.json"));
const items = json("catalog/items.json");
const seedPath = join(root, "pipeline", "seed-sources.json");
const seedText = readFileSync(seedPath, "utf8");
// Lab entries are the one-line seed entries the autopublisher writes; the rest were written by hand.
const labIds = new Set([...seedText.matchAll(/^\s*\{"id":"([^"]+)"/gm)].map((m) => m[1]));
const seedConflicts = new Map(JSON.parse(seedText).items.map((s) => [s.id, s.conflicts ?? []]));
const model = jevConfig().model;
const capabilities = capabilityOptions(taxonomy);
const stacks = stackOptions(taxonomy);

const results = await mapLimit(items, 4, async (item) => {
  const text = await skillText(item, { cacheDir });
  const answers = await classifyItem(item, { capabilities, stacks, text, cacheDir });
  if (!answers) return { item, decision: null };
  const record = recordOf(answers, model);
  return { item, decision: { ...decide(item, record, { taxonomy, curated: !labIds.has(item.id) }), record } };
});

const failed = results.filter((r) => !r.decision).map((r) => r.item.id);
if (failed.length) {
  console.error(`no answer for ${failed.length} item(s): ${failed.join(", ")} — nothing written`);
  process.exit(1);
}

const classification = {};
const review = [];
const out = [];
const gone = [];
for (const { item, decision } of results) {
  classification[item.id] = { ...decision.record, apply: labIds.has(item.id) ? "auto" : "annotate" };
  if (decision.action === "drop") {
    gone.push({ id: item.id, repo: item.repo ?? null, reason: decision.reasons.join("; ") });
    continue;
  }
  if (decision.action === "review") {
    review.push({ id: item.id, repo: item.repo ?? null, held: labIds.has(item.id), reasons: decision.reasons, ...decision.record });
    if (labIds.has(item.id)) {
      gone.push({ id: item.id, repo: item.repo ?? null, reason: `held for review: ${decision.reasons.join("; ")}` });
      continue;
    }
  }
  out.push(decision.item);
}

// Conflicts: the hand-written ones plus one per shared exclusive group (pipeline/graph.mjs rule), recomputed
// because jobs moved and some items left.
const ids = new Set(out.map((i) => i.id));
const groupsOf = (i) => new Set((i.capabilities ?? []).map((c) => taxonomy.capabilities[c]?.exclusiveGroup).filter(Boolean));
const finalItems = out.map((i) => {
  const mine = groupsOf(i);
  const shared = out.filter((o) => o.id !== i.id && [...groupsOf(o)].some((g) => mine.has(g))).map((o) => o.id);
  return { ...i, conflicts: [...new Set([...(seedConflicts.get(i.id) ?? []), ...shared])].filter((x) => ids.has(x)).sort() };
});

const count = (k) => finalItems.filter((i) => i.lifecycle === k).length;
console.log(`classified ${items.length} with ${model}: kept ${finalItems.length}, out ${gone.length}, to review ${review.length}`);
console.log(`lifecycle: once ${count("once")}, every_task ${count("every_task")}, occasional ${count("occasional")}, unsure ${finalItems.filter((i) => !i.lifecycle).length}`);
for (const g of gone) console.log(`  out     ${g.id.padEnd(40)} ${g.reason}`);
for (const r of review.filter((x) => !x.held)) console.log(`  review  ${r.id.padEnd(40)} ${r.reasons.join("; ")}`);
const relabelled = finalItems.filter((i) => {
  const before = items.find((x) => x.id === i.id);
  return before.capabilities[0] !== i.capabilities[0] || before.tier !== i.tier;
});
for (const i of relabelled) {
  const b = items.find((x) => x.id === i.id);
  console.log(`  relabel ${i.id.padEnd(40)} ${b.capabilities.join(",")} -> ${i.capabilities.join(",")}${b.tier !== i.tier ? ` (tier ${b.tier} -> ${i.tier})` : ""}`);
}

const errors = validateCatalog({ items: finalItems, taxonomy, loadouts: json("catalog/loadouts.json"), core: json("catalog/core.json") });
if (errors.length) {
  console.error(`invalid catalog, nothing written:\n  ${errors.slice(0, 10).join("\n  ")}`);
  process.exit(1);
}
if (dryRun) process.exit(0);

writeCatalogFiles(join(root, "catalog"), { items: finalItems, taxonomy });
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(join(root, "pipeline", "classification.json"), JSON.stringify({ note: "Jev answers per catalog item (pipeline/classify-catalog.mjs). apply: auto = lab item, labels applied; annotate = curated, lifecycle only.", items: sorted(classification) }, null, 2) + "\n");
writeFileSync(join(root, "pipeline", "classification-review.json"), JSON.stringify({ note: "For a human: held = a lab item kept out of the catalog until reviewed.", items: review }, null, 2) + "\n");
const outIds = new Set(gone.map((g) => g.id));
const seedLines = seedText.split("\n").filter((line) => {
  const m = /^\s*\{"id":"([^"]+)"/.exec(line);
  return !(m && outIds.has(m[1]));
});
const seedOut = seedLines.join("\n").replace(/,(\s*\n\s*\])/g, "$1");
JSON.parse(seedOut);
writeFileSync(seedPath, seedOut);
const graphPath = join(root, "data", "graph-seed.json");
const graph = rebuildSeedGraph(JSON.parse(readFileSync(graphPath, "utf8")), finalItems, { classification });
writeFileSync(graphPath, JSON.stringify(graph) + "\n");
console.log(`written: catalog, taxonomy, pipeline/classification.json, pipeline/classification-review.json, seed, graph (${graph.edges.length} edges)`);
