import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { meetsCoreCondition } from "../src/needs.mjs";
import { demandFor, recommendLocal, GATE_REASONS } from "../lib/pipeline/recommend/index.mjs";
import { loadSeedGraph } from "../lib/pipeline/graph/loader.mjs";
import { resolveNeeds } from "../src/needs.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(here, "..", "catalog", f), "utf8"));
const catalog = {
  items: read("items.json"),
  taxonomy: read("taxonomy.json"),
  loadouts: read("loadouts.json"),
  core: read("core.json"),
};
const graph = loadSeedGraph(join(here, "..", "data", "graph-seed.json"));

const fpOf = (o) => ({
  empty: false, stacks: [], inferredNeeds: [], frameworks: [],
  agents: { configured: [], skills: [] }, ...o,
});
const recommend = (fp, answers = {}) => {
  const needs = resolveNeeds({ fingerprint: fp, answers, taxonomy: catalog.taxonomy });
  const demand = demandFor({ catalog, fingerprint: fp, needs, answers });
  return { out: recommendLocal({ catalog, graph, demand, answers }), demand };
};
const inSet = (r, id) => r.set.includes(id);
const inScored = (r, id) => r.scored.some((s) => s.item.id === id);
const itemOf = (id) => catalog.items.find((i) => i.id === id);

// --- meetsCoreCondition unit tests ---

test("meetsCoreCondition: no condition means always default", () => {
  assert.equal(meetsCoreCondition(null, {}), true);
  assert.equal(meetsCoreCondition(undefined, { empty: true }), true);
});

test("meetsCoreCondition: empty / notEmpty", () => {
  assert.equal(meetsCoreCondition({ empty: true }, { empty: true }), true);
  assert.equal(meetsCoreCondition({ empty: true }, { empty: false }), false);
  assert.equal(meetsCoreCondition({ empty: true }, {}), false);
  assert.equal(meetsCoreCondition({ notEmpty: true }, { empty: false }), true);
  assert.equal(meetsCoreCondition({ notEmpty: true }, { empty: true }), false);
});

test("meetsCoreCondition: needsAny", () => {
  assert.equal(meetsCoreCondition({ needsAny: ["security"] }, { needs: ["security", "testing"] }), true);
  assert.equal(meetsCoreCondition({ needsAny: ["security"] }, { needs: ["testing"] }), false);
  assert.equal(meetsCoreCondition({ needsAny: ["security"] }, {}), false);
});

test("meetsCoreCondition: combined conditions are conjunctive", () => {
  const cond = { notEmpty: true, needsAny: ["large-codebase"] };
  assert.equal(meetsCoreCondition(cond, { empty: false, needs: ["large-codebase"] }), true);
  assert.equal(meetsCoreCondition(cond, { empty: false, needs: ["testing"] }), false);
  assert.equal(meetsCoreCondition(cond, { empty: true, needs: ["large-codebase"] }), false);
});

// --- demand carries the signals the gate needs ---

test("demandFor threads empty and coreConditions from catalog/core.json", () => {
  const { demand } = recommend(fpOf({ empty: true }));
  assert.equal(demand.empty, true);
  assert.deepEqual(demand.coreConditions.graphify, { notEmpty: true, needsAny: ["large-codebase", "monorepo"] });
  assert.deepEqual(demand.coreConditions.brainstorming, { empty: true });
  assert.deepEqual(demand.coreConditions["differential-review"], { needsAny: ["security", "auth", "payments", "compliance", "smart-contracts"] });
  assert.deepEqual(demand.coreConditions["repotify-tracker"], { empty: true });
  // Unconditional core has no entry: the gate keeps the historic bypass.
  assert.equal(demand.coreConditions["systematic-debugging"], undefined);
  const { demand: d2 } = recommend(fpOf({ empty: false }));
  assert.equal(d2.empty, false);
});

// --- conditional core: empty project ---

test("empty project: brainstorming and repotify-tracker default; graphify does not", () => {
  const { out } = recommend(fpOf({ empty: true }));
  assert.equal(inSet(out, "brainstorming"), true, "brainstorming defaults for greenfield");
  assert.equal(inSet(out, "repotify-tracker"), true, "repotify-tracker defaults for greenfield");
  assert.equal(inSet(out, "graphify"), false, "graphify needs code to map");
  assert.equal(inScored(out, "graphify"), true, "graphify stays in the table as backup");
  assert.equal(inSet(out, "differential-review"), false, "no security signal, no default review");
  assert.equal(inScored(out, "differential-review"), true, "differential-review stays in the table");
});

// --- conditional core: non-empty project ---

test("non-empty project without the signals: brainstorming/tracker leave the default set", () => {
  const { out } = recommend(fpOf({ empty: false, stacks: ["node"], inferredNeeds: ["testing"] }));
  assert.equal(inSet(out, "brainstorming"), false, "design conversation is for starting, not for mid-flight");
  assert.equal(inScored(out, "brainstorming"), true, "still a backup pick");
  assert.equal(inSet(out, "repotify-tracker"), false);
  assert.equal(inScored(out, "repotify-tracker"), true);
});

test("large codebase: graphify earns its default", () => {
  const { out } = recommend(fpOf({ empty: false, stacks: ["node", "typescript"], inferredNeeds: ["large-codebase", "testing"] }));
  assert.equal(inSet(out, "graphify"), true, "large codebase is where the graph pays off");
});

test("security need: differential-review earns its default", () => {
  const { out } = recommend(fpOf({ empty: false, stacks: ["node"], inferredNeeds: ["security", "auth", "testing"] }));
  assert.equal(inSet(out, "differential-review"), true, "security context warrants the review pass");
});

test("unconditional core keeps the historic bypass everywhere", () => {
  for (const fp of [fpOf({ empty: true }), fpOf({ empty: false, stacks: ["go"], inferredNeeds: ["testing"] })]) {
    const { out } = recommend(fp);
    for (const id of ["test-driven-development", "systematic-debugging", "verification-before-completion", "repotify-guard"]) {
      assert.equal(inSet(out, id), true, `${id} defaults (empty=${fp.empty})`);
    }
  }
});

// --- xlsx: spreadsheet need, not generic data-processing ---

test("xlsx claims only the office-docs need", () => {
  assert.deepEqual(itemOf("xlsx").needs, ["office-docs"]);
});

test("xlsx defaults with office-docs evidence", () => {
  const { out } = recommend(fpOf({ empty: false, stacks: ["node"], inferredNeeds: ["office-docs", "data-processing"] }));
  assert.equal(inSet(out, "xlsx"), true);
});

// --- data-engineer: python data tooling, not stack-agnostic ---

test("data-engineer is scoped to the python stack", () => {
  assert.deepEqual(itemOf("data-engineer").stacks, ["python"]);
});

test("data-engineer does not surface for a non-python project", () => {
  const { out } = recommend(fpOf({ empty: false, stacks: ["go"], inferredNeeds: ["data-processing", "testing"] }));
  assert.equal(inScored(out, "data-engineer"), false, "a Go project has no use for python data tooling");
});

test("data-engineer still surfaces for a python data project", () => {
  const { out } = recommend(fpOf({ empty: false, stacks: ["python"], inferredNeeds: ["data-processing", "testing"] }));
  assert.equal(inScored(out, "data-engineer"), true);
});

// --- catalog/core.json follows the seed ---

test("catalog core conditions match the seed's defaultWhen", () => {
  const seed = JSON.parse(readFileSync(join(here, "..", "pipeline", "seed-sources.json"), "utf8"));
  for (const c of catalog.core) {
    const s = seed.core.find((x) => x.id === c.id);
    assert.ok(s, `core ${c.id} in seed`);
    assert.deepEqual(c.defaultWhen ?? null, s.defaultWhen ?? null, `defaultWhen for ${c.id}`);
  }
  assert.ok(GATE_REASONS.CORE_CONDITION_UNMET, "gate reason exists");
});
