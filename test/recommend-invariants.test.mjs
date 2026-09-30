import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recommend } from "../src/recommend.mjs";
import { resolveNeeds } from "../src/needs.mjs";
import { PUBLISHABLE_LEVELS } from "../src/catalog.mjs";

// Hundreds of generated projects against the real catalog. The eval checks chosen scenarios; this checks the rules that
// must hold for every project, so a change that breaks one shows up with the exact project that broke it.
const read = (f) => JSON.parse(readFileSync(new URL(`../catalog/${f}`, import.meta.url), "utf8"));
const catalog = { items: read("items.json"), taxonomy: read("taxonomy.json"), loadouts: read("loadouts.json"), core: read("core.json") };
const byId = new Map(catalog.items.map((i) => [i.id, i]));
const { taxonomy } = catalog;
const webOnly = (item) => item.capabilities.length > 0 && item.capabilities.every((c) => taxonomy.capabilities[c]?.platform === "web");

function prng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
const some = (r, list, expected) => list.filter(() => r() < expected / list.length);
const one = (r, list) => list[Math.floor(r() * list.length)];

function project(seed) {
  const r = prng(seed);
  const empty = r() < 0.15;
  const fingerprint = {
    empty,
    stacks: empty ? [] : some(r, Object.keys(taxonomy.stacks), 2.5),
    platforms: empty ? [] : one(r, [[], ["web"], ["mobile"], ["desktop"], ["web", "mobile"]]),
    inferredNeeds: empty ? [] : some(r, Object.keys(taxonomy.needs), 3),
    frameworks: [],
    agents: { configured: [], skills: r() < 0.2 ? some(r, catalog.items.map((i) => i.id), 2) : [] },
  };
  const answers = {};
  if (r() < 0.5) answers.projectType = one(r, Object.keys(taxonomy.projectTypes));
  if (r() < 0.5) answers.needs = some(r, Object.keys(taxonomy.needs), 2);
  if (r() < 0.3) answers.priorities = some(r, Object.keys(taxonomy.priorities), 1);
  return { fingerprint, needs: resolveNeeds({ fingerprint, answers, taxonomy }) };
}

const PROJECTS = 400;

test(`for ${PROJECTS} generated projects the recommendation keeps its rules`, () => {
  const broken = [];
  for (let seed = 1; seed <= PROJECTS; seed++) {
    const { fingerprint, needs } = project(seed);
    const rec = recommend({ catalog, fingerprint, needs });
    const fail = (rule) => broken.push(`project ${seed}: ${rule}`);
    const again = recommend({ catalog, fingerprint, needs });
    if (JSON.stringify(again) !== JSON.stringify(rec)) fail("the same project got a different answer");
    const clusters = rec.rows.map((r) => r.cluster);
    if (new Set(clusters).size !== clusters.length) fail(`two picks share a cluster (${clusters.join(", ")})`);
    const installed = new Set(fingerprint.agents.skills);
    const cost = rec.rows.filter((r) => r.default || (r.installed && installed.has(r.id))).reduce((sum, r) => sum + byId.get(r.id).descriptionChars, 0);
    if (rec.budget.used > rec.budget.limit) fail(`over the context budget (${rec.budget.used} > ${rec.budget.limit})`);
    if (cost !== rec.budget.used) fail(`budget says ${rec.budget.used} chars, the picks cost ${cost}`);
    for (const row of rec.rows) {
      const item = byId.get(row.id);
      if (!item) fail(`${row.id} is not in the catalog`);
      else {
        if (!PUBLISHABLE_LEVELS.includes(item.security.level)) fail(`${row.id} is ${item.security.level}`);
        if (!row.reasons.length && item.tier !== "core") fail(`${row.id} is listed without a reason`);
        const stackOnly = item.tier === "stack" && !item.stacks.includes("*");
        if (stackOnly && !item.stacks.some((s) => fingerprint.stacks.includes(s)) && !row.reasons.some((x) => x.startsWith("loadout"))) {
          fail(`${row.id} is for ${item.stacks.join("/")}, the project is ${fingerprint.stacks.join("/") || "empty"}`);
        }
        const platforms = rec.demand.platforms ?? [];
        if (platforms.length && !platforms.includes("web") && webOnly(item)) fail(`${row.id} is web-only, the project is ${platforms.join("/")}`);
        for (const other of rec.rows) if (other !== row && (item.conflicts ?? []).includes(other.id)) fail(`${row.id} and ${other.id} conflict`);
      }
    }
    for (const id of rec.defaultSet) if (!rec.rows.some((r) => r.id === id)) fail(`default ${id} has no row`);
    for (const row of rec.rows) {
      if (byId.get(row.id)?.tier === "core" && !row.default && !row.installed && !rec.droppedForBudget.includes(row.id)) fail(`core item ${row.id} left out`);
    }
  }
  assert.deepEqual(broken.slice(0, 10), [], `${broken.length} broken rule(s)`);
});
