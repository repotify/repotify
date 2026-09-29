import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recommend, formatTable, pickLoadout } from "../src/recommend.mjs";
import { fingerprint } from "../src/fingerprint.mjs";
import { resolveNeeds } from "../src/needs.mjs";

const read = (f) => JSON.parse(readFileSync(new URL(`../catalog/${f}`, import.meta.url), "utf8"));
const catalog = { items: read("items.json"), taxonomy: read("taxonomy.json"), loadouts: read("loadouts.json"), core: read("core.json") };
const projects = fileURLToPath(new URL("./fixtures/projects/", import.meta.url));
const CORE = catalog.core.map((c) => c.id);

async function scenario(project, answers = {}, extra = {}) {
  const fp = await fingerprint(join(projects, project));
  const needs = resolveNeeds({ fingerprint: fp, answers, taxonomy: catalog.taxonomy });
  return { fp, rec: recommend({ catalog, fingerprint: fp, needs, ...extra }) };
}

function invariants(rec) {
  const byId = new Map(catalog.items.map((i) => [i.id, i]));
  const clusters = rec.rows.map((r) => r.cluster);
  assert.equal(new Set(clusters).size, clusters.length, "cluster duplicates");
  for (const r of rec.rows) {
    for (const c of byId.get(r.id).conflicts ?? []) assert.ok(!rec.rows.some((x) => x.id === c), `${r.id} conflicts with ${c}`);
    assert.ok(["verified", "caution"].includes(byId.get(r.id).security.level));
  }
  assert.ok(rec.budget.used <= rec.budget.limit, "budget");
  assert.ok(rec.rows.length <= 30);
  const used = rec.defaultSet.reduce((s, id) => s + byId.get(id).descriptionChars, 0);
  assert.ok(used <= rec.budget.used);
}

test("golden: Next.js SaaS", async () => {
  const { rec } = await scenario("nextjs-saas");
  invariants(rec);
  for (const id of [...CORE, "react-best-practices", "webapp-testing", "context7"]) assert.ok(rec.defaultSet.includes(id), id);
  assert.ok(!rec.rows.some((r) => r.id === "omniroute"), "quarantined (GHSA-hf57-cqmx-p4gr) items are never listed");
  assert.ok(!rec.rows.some((r) => r.id === "react-native-skills"));
  assert.ok(!rec.rows.some((r) => r.id === "guidelines-advisor"));
  assert.equal(rec.loadout, null);
});

test("golden: FastAPI + LLM", async () => {
  const { rec } = await scenario("fastapi-llm");
  invariants(rec);
  for (const id of [...CORE, "context7", "semgrep", "property-based-testing"]) assert.ok(rec.defaultSet.includes(id), id);
  assert.ok(!rec.rows.some((r) => r.id === "omniroute"), "quarantined items are never listed");
  assert.ok(!rec.rows.some((r) => r.id === "react-best-practices"));
  const weak = rec.rows.find((r) => r.id === "webapp-testing");
  assert.ok(weak && weak.default === false, "need-only matches are listed but not defaulted");
});

test("golden: empty folder + content site answer uses the content-site loadout", async () => {
  const { rec } = await scenario("empty", { projectType: "content-site" });
  invariants(rec);
  assert.equal(rec.loadout, "content-site");
  for (const id of [...CORE, "web-design-guidelines", "frontend-design", "writing-guidelines"]) assert.ok(rec.defaultSet.includes(id), id);
  assert.ok(rec.rows.find((r) => r.id === "playwright-mcp"), "playwright-mcp listed");
});

test("pickLoadout prefers the matching project type, then need overlap", () => {
  assert.equal(pickLoadout(catalog.loadouts, { projectType: "mobile", needs: [] }).id, "mobile-app");
  assert.equal(pickLoadout(catalog.loadouts, { projectType: null, needs: ["smart-contracts", "security"] }).id, "smart-contracts");
  assert.equal(pickLoadout(catalog.loadouts, { projectType: null, needs: [] }), null);
});

test("a tight budget keeps core and drops the rest from the default set", async () => {
  const { rec } = await scenario("nextjs-saas", {}, { budgetChars: 500 });
  invariants(rec);
  assert.ok(rec.defaultSet.includes("repotify-guard"));
  assert.ok(rec.droppedForBudget.length > 0);
  for (const id of rec.droppedForBudget) assert.equal(rec.rows.find((r) => r.id === id)?.default ?? false, false);
});

test("installed items are marked, not defaulted, and count toward the budget", async () => {
  const { rec } = await scenario("nextjs-saas", {}, { installed: ["brainstorming"] });
  const row = rec.rows.find((r) => r.id === "brainstorming");
  assert.equal(row.installed, true);
  assert.equal(row.default, false);
  assert.ok(!rec.defaultSet.includes("brainstorming"));
});

test("conflicts and exclusive groups are resolved by score", () => {
  const base = catalog.items.find((i) => i.id === "writing-guidelines");
  const a = { ...base, id: "meta-a", capabilities: ["workflow-meta"], cluster: "workflow-meta", tier: "core" };
  const b = { ...base, id: "meta-b", capabilities: ["workflow-meta", "writing-quality"], cluster: "writing-quality", tier: "core" };
  const c = { ...base, id: "rival", tier: "core", cluster: "codebase-map", conflicts: ["meta-a"] };
  const small = { ...catalog, items: [a, b, c], core: [] };
  const rec = recommend({ catalog: small, fingerprint: { empty: false, stacks: [], inferredNeeds: [], agents: { skills: [] } }, needs: { projectType: null, priorities: [], needs: [] } });
  const ids = rec.rows.map((r) => r.id);
  assert.equal(ids.filter((id) => id === "meta-a" || id === "meta-b").length, 1, "exclusive group");
  assert.ok(!(ids.includes("rival") && ids.includes("meta-a")), "conflict pair");
});

test("formatTable fits 30 rows in 3150 characters and marks defaults", async () => {
  const { rec } = await scenario("nextjs-saas");
  const many = { ...rec, rows: Array.from({ length: 30 }, (_, i) => ({ ...rec.rows[i % rec.rows.length], id: `${rec.rows[i % rec.rows.length].id}-${i}` })) };
  const text = formatTable(many);
  assert.ok(text.length <= 3150, `${text.length}`);
  assert.equal(text.split("\n").filter((l) => /^[★·] /.test(l)).length, 30);
  const real = formatTable(rec);
  assert.match(real, /^Repotify candidates/);
  assert.match(real, /\n★ graphify \|/);
});
