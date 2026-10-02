// The rules that turn Jev's answers into catalog decisions (pipeline/jev-classify.mjs).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { decide, recordOf, extendTaxonomy, needsFor, questionsFor, BARS, NEW_CAPABILITIES } from "../pipeline/jev-classify.mjs";
import { rebuildSeedGraph } from "../pipeline/graph-seed.mjs";

const taxonomy = extendTaxonomy(JSON.parse(readFileSync(new URL("../catalog/taxonomy.json", import.meta.url), "utf8")));
const item = (over = {}) => ({ id: "x", tier: "mission", capabilities: ["implementation-planning"], needs: ["agent-skills"], stacks: ["*"], cluster: "implementation-planning", ...over });
const rec = (over = {}) => ({ model: "m", coding: 0.97, job: "database", jobP: 0.95, lifecycle: "occasional", lifecycleP: 0.9, productBound: 0.05, stack: "any", stackP: 0.95, ...over });

test("a confident main job relabels a lab item: one capability, its cluster, needs from the taxonomy", () => {
  const d = decide(item(), rec(), { taxonomy });
  assert.equal(d.action, "keep");
  assert.deepEqual(d.item.capabilities, ["database"]);
  assert.equal(d.item.cluster, "database");
  assert.deepEqual(d.item.needs, needsFor("database", taxonomy));
  assert.equal(d.item.lifecycle, "occasional");
  assert.equal(d.item.origin, "lab");
});

test("off-topic and product-bound lab items leave the catalog; unsure ones are held for review", () => {
  assert.equal(decide(item(), rec({ coding: 0.3 }), { taxonomy }).action, "drop");
  assert.equal(decide(item(), rec({ productBound: 0.9 }), { taxonomy }).action, "drop");
  assert.equal(decide(item(), rec({ coding: 0.7 }), { taxonomy }).action, "review");
  assert.equal(decide(item(), rec({ jobP: 0.5 }), { taxonomy }).action, "review");
  assert.equal(decide(item(), rec({ job: "none", jobP: 0.99 }), { taxonomy }).action, "review");
});

test("a lower-confidence job counts when the jury listed the same capability", () => {
  const d = decide(item({ capabilities: ["code-review", "database"] }), rec({ jobP: BARS.jobAgree }), { taxonomy });
  assert.equal(d.action, "keep");
  assert.deepEqual(d.item.capabilities, ["database"]);
});

test("expertise for a specific stack makes a stack expert; the stack answer narrows a lab item", () => {
  const ts = decide(item(), rec({ job: "typescript-expertise", stack: "any", stackP: 0.4 }), { taxonomy });
  assert.equal(ts.item.tier, "stack");
  assert.deepEqual(ts.item.stacks, ["typescript"]);
  const wp = decide(item({ stacks: ["php", "node"] }), rec({ job: "php-expertise", stack: "php", stackP: 0.99 }), { taxonomy });
  assert.deepEqual(wp.item.stacks, ["php"]);
  assert.equal(wp.item.tier, "stack");
  const dotnet = decide(item({ tier: "stack", stacks: ["csharp"] }), rec({ job: "dotnet-expertise", stack: "csharp", stackP: 0.99 }), { taxonomy });
  assert.equal(dotnet.item.tier, "stack", "an expertise without a same-named stack keeps its stack tier");
});

test("curated items are never relabelled or dropped; a confident disagreement only goes to review", () => {
  const curated = item({ capabilities: ["static-analysis"] });
  const d = decide(curated, rec({ job: "database", coding: 0.2 }), { taxonomy, curated: true });
  assert.equal(d.action, "review");
  assert.deepEqual(d.item.capabilities, ["static-analysis"]);
  assert.equal(d.item.origin, "curated");
  const core = decide(item({ tier: "core" }), rec({ coding: 0.1, lifecycle: "once", lifecycleP: 0.8 }), { taxonomy });
  assert.equal(core.action, "keep");
  assert.equal(core.item.lifecycle, "once");
});

test("lifecycle is recorded only above its bar", () => {
  assert.equal(decide(item(), rec({ lifecycle: "once", lifecycleP: 0.69 }), { taxonomy }).item.lifecycle, undefined);
  assert.equal(decide(item(), rec({ lifecycle: "once", lifecycleP: 0.7 }), { taxonomy }).item.lifecycle, "once");
});

test("the taxonomy gains the capabilities it lacked, linked to evidence-only needs", () => {
  for (const id of Object.keys(NEW_CAPABILITIES)) assert.ok(taxonomy.capabilities[id], id);
  assert.ok(taxonomy.needs.infra.capabilities.includes("devops-infra"));
  assert.ok(taxonomy.needs.database.capabilities.includes("database"));
  assert.ok(!taxonomy.needs.deploy.capabilities.includes("devops-infra"), "a project-type guess must not pull in DevOps skills");
});

test("questions: one request asks the gate, main job, lifecycle, product-bound and stack", () => {
  const q = questionsFor({ a: "A" }, { any: "any" });
  assert.deepEqual(Object.keys(q).sort(), ["coding", "job", "lifecycle", "productBound", "stack"]);
  assert.ok("none" in q.job.criteria);
  assert.equal(q.coding.type, "noul");
});

test("recordOf flattens parsed answers", () => {
  const r = recordOf({ coding: { probability: 0.912 }, job: { option: "database", probability: 0.8 }, lifecycle: { option: "once", probability: 0.75 }, productBound: { probability: 0.1 }, stack: { option: "any", probability: 1 } }, "m");
  assert.deepEqual(r, { model: "m", coding: 0.91, job: "database", jobP: 0.8, lifecycle: "once", lifecycleP: 0.75, productBound: 0.1, stack: "any", stackP: 1 });
});

test("the graph seed derives one PROVIDES edge per item capability and keeps curated edges whose items exist", () => {
  const seed = { edges: [
    { id: "p01", type: "provides", from: "item:old", to: "cap:x" },
    { id: "c01", type: "conflicts_with", from: "item:a", to: "item:b" },
    { id: "c02", type: "conflicts_with", from: "item:a", to: "item:gone" },
  ] };
  const g = rebuildSeedGraph(seed, [{ id: "a", capabilities: ["database"] }, { id: "b", capabilities: ["code-review", "static-analysis"] }]);
  assert.deepEqual(g.edges.map((e) => e.id), ["p:a:database", "p:b:code-review", "p:b:static-analysis", "c01"]);
  assert.ok(g.edges.filter((e) => e.type === "provides").every((e) => e.tested && e.test.endsWith(`#${e.id}`)));
});
