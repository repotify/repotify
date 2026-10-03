import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { demandFor, recommendLocal } from "../lib/pipeline/recommend/index.mjs";
import { loadSeedGraph } from "../lib/pipeline/graph/loader.mjs";
import { resolveNeeds } from "../src/needs.mjs";
import { missingRuntime, TOOLS } from "../src/machine.mjs";
import { PUBLISHABLE_LEVELS } from "../src/catalog.mjs";
import { runEval, loadScenarios } from "./eval/run.mjs";

// Hundreds of generated projects against the real catalog, through the engine the CLI serves
// (lib/pipeline/recommend). The eval checks chosen scenarios; this checks the rules that must hold for every project,
// so a change that breaks one shows up with the exact project that broke it. test/recommend-invariants.test.mjs is the
// same sweep over the frozen v1 engine, which `repotify audit` still reads; it says nothing about what users are served.
const read = (f) => JSON.parse(readFileSync(new URL(`../catalog/${f}`, import.meta.url), "utf8"));
const catalog = { items: read("items.json"), taxonomy: read("taxonomy.json"), loadouts: read("loadouts.json"), core: read("core.json") };
const graph = loadSeedGraph(fileURLToPath(new URL("../data/graph-seed.json", import.meta.url)));
const byId = new Map(catalog.items.map((i) => [i.id, i]));
const { taxonomy } = catalog;
const ALL_TOOLS = Object.fromEntries(Object.keys(TOOLS).map((t) => [t, true]));
const NO_TOOLS = Object.fromEntries(Object.keys(TOOLS).map((t) => [t, false]));

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
    agents: { configured: [], skills: [] },
  };
  const answers = {};
  if (r() < 0.5) answers.projectType = one(r, Object.keys(taxonomy.projectTypes));
  if (r() < 0.5) answers.needs = some(r, Object.keys(taxonomy.needs), 2);
  if (r() < 0.3) answers.priorities = some(r, Object.keys(taxonomy.priorities), 1);
  const installed = r() < 0.2 ? some(r, catalog.items.map((i) => i.id), 2) : [];
  // What the computer can run: everything, nothing, or a random half.
  const pick = r();
  const tools = pick < 0.4 ? ALL_TOOLS : pick < 0.6 ? NO_TOOLS : Object.fromEntries(Object.keys(TOOLS).map((t) => [t, r() < 0.5]));
  const needs = resolveNeeds({ fingerprint, answers, taxonomy });
  const demand = { ...demandFor({ catalog, fingerprint, needs, answers }), machine: { os: "linux", arch: "x64", tools } };
  return { fingerprint, answers, installed, demand };
}

const PROJECTS = 400;

test(`for ${PROJECTS} generated projects the served recommendation keeps its rules`, () => {
  const broken = [];
  let picked = 0;
  for (let seed = 1; seed <= PROJECTS; seed++) {
    const { answers, installed, demand } = project(seed);
    const run = () => recommendLocal({ catalog, graph, demand, installed, answers });
    const rec = run();
    const fail = (rule) => broken.push(`project ${seed}: ${rule}`);
    const again = run();
    if (JSON.stringify([again.set, again.table, again.budget]) !== JSON.stringify([rec.set, rec.table, rec.budget])) fail("the same project got a different answer");
    const picks = rec.set.map((id) => byId.get(id));
    picked += picks.length;
    if (picks.some((i) => !i)) fail(`a pick is not in the catalog (${rec.set.filter((id) => !byId.has(id))})`);
    const clusters = picks.map((i) => i?.cluster);
    if (new Set(clusters).size !== clusters.length) fail(`two picks share a job (${clusters.join(", ")})`);
    if (rec.budget.used > rec.budget.limit) fail(`over the context budget (${rec.budget.used} > ${rec.budget.limit})`);
    const held = new Set(installed);
    for (const item of picks.filter(Boolean)) {
      if (held.has(item.id)) fail(`${item.id} is already installed and was picked again`);
      if (!PUBLISHABLE_LEVELS.includes(item.security.level)) fail(`${item.id} is ${item.security.level}`);
      const stackOnly = item.tier === "stack" && !item.stacks.includes("*");
      if (stackOnly && !item.stacks.some((s) => demand.stacks.includes(s)) && !demand.loadoutIds.includes(item.id)) {
        fail(`${item.id} is for ${item.stacks.join("/")}, the project is ${demand.stacks.join("/") || "empty"}`);
      }
      // A pick whose every job belongs to a platform needs the project to target one of them.
      const platforms = item.capabilities.map((c) => taxonomy.capabilities[c]?.platform ?? null);
      if (demand.platforms.length && platforms.length && platforms.every(Boolean) && !platforms.some((p) => demand.platforms.includes(p))) {
        fail(`${item.id} is ${[...new Set(platforms)].join("/")}-only, the project is ${demand.platforms.join("/")}`);
      }
      const missing = missingRuntime(item, demand.machine);
      if (missing.length) fail(`${item.id} needs ${missing.join(", ")}, which this computer does not have`);
      for (const other of picks) if (other && other !== item && (item.conflicts ?? []).includes(other.id)) fail(`${item.id} and ${other.id} conflict`);
    }
    for (const id of rec.set) if (!rec.table.some((row) => row.id === id && row.default)) fail(`default ${id} has no row in the table`);
  }
  assert.deepEqual(broken.slice(0, 10), [], `${broken.length} broken rule(s)`);
  assert.ok(picked > PROJECTS * 5, `the sweep looked at real picks (${picked})`);
});

test("SEC-REC-001/003: the eval can pin the machine, and what the machine cannot run is never a default pick", () => {
  const scenarios = loadScenarios();
  const open = runEval(scenarios, catalog);
  const full = runEval(scenarios, catalog, { machine: { os: "linux", arch: "x64", tools: ALL_TOOLS } });
  assert.deepEqual(full.perScenario.map((s) => s.defaultSet), open.perScenario.map((s) => s.defaultSet), "a machine with every tool changes nothing");
  const bare = { os: "linux", arch: "x64", tools: NO_TOOLS };
  const none = runEval(scenarios, catalog, { machine: bare });
  let withRuntime = 0;
  for (const s of none.perScenario) {
    for (const id of s.defaultSet) assert.deepEqual(missingRuntime(byId.get(id), bare), [], `${s.name}: ${id}`);
  }
  for (const s of open.perScenario) withRuntime += s.defaultSet.filter((id) => missingRuntime(byId.get(id), bare).length).length;
  assert.ok(withRuntime > 0, "the scenarios do pick items that need a runtime, so the check above is not vacuous");
  // A scenario can carry its own machine.
  const pinned = runEval([{ ...scenarios[0], machine: bare }], catalog);
  assert.deepEqual(pinned.perScenario[0].defaultSet, none.perScenario[0].defaultSet);
});
