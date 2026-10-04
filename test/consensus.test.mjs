import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../pipeline/store.mjs";
import { consensusKeyer, consensusToAnswers, validateConsensusEntry } from "../pipeline/consensus.mjs";
import { deriveItems, RULES } from "../pipeline/derive.mjs";
import { skillQuestions } from "../pipeline/observe.mjs";
import { extendTaxonomyV2 } from "../pipeline/taxonomy.mjs";
import { extendTaxonomy } from "../pipeline/jev-classify.mjs";

const tempDirs = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
const newStore = () => {
  const d = mkdtempSync(join(tmpdir(), "rp-consensus-"));
  tempDirs.push(d);
  return createStore(d);
};
const base = JSON.parse(readFileSync(new URL("../catalog/taxonomy.json", import.meta.url), "utf8"));
const taxonomy = extendTaxonomyV2(extendTaxonomy(base));
const validJobs = new Set([...Object.keys(taxonomy.capabilities), "none"]);
const validStacks = new Set([...Object.keys(taxonomy.stacks), "any"]);

const entry22 = (over = {}) => ({
  id: "tdd",
  coding: { deger: true, duzey: "uzlasilmis" },
  job: { deger: "tdd-discipline", duzey: "uzlasilmis" },
  lifecycle: { deger: "every_task", duzey: "uzlasilmis" },
  stack: { deger: ["any"], duzey: "uzlasilmis" },
  productBound: { deger: false, duzey: "uzlasilmis" },
  ...over,
});

test("consensusToAnswers: a 2/2 job maps to jobP 0.95 with source consensus", () => {
  const a = consensusToAnswers(entry22());
  assert.equal(a.source, "consensus");
  assert.equal(a.job, "tdd-discipline");
  assert.equal(a.jobP, 0.95);
  assert.equal(a.coding, 0.95);
  assert.equal(a.stack, "any");
  assert.equal(a.productBound, null, "productBound is unknown, not used for rejection");
  assert.equal(a.quality, null);
  assert.equal(a.purpose, null);
});

test("consensusToAnswers: a non-2/2 job is not a candidate", () => {
  assert.equal(consensusToAnswers(entry22({ job: { deger: "tdd-discipline", duzey: "cogunluk" } })), null);
  assert.equal(consensusToAnswers(entry22({ job: { deger: null, duzey: "kararsiz" } })), null);
  assert.equal(consensusToAnswers({ id: "x" }), null);
});

test("consensusToAnswers: a multi-stack collapses to any", () => {
  const a = consensusToAnswers(entry22({ stack: { deger: ["python", "go"], duzey: "uzlasilmis" } }));
  assert.equal(a.stack, "any");
  const b = consensusToAnswers(entry22({ stack: { deger: ["python"], duzey: "uzlasilmis" } }));
  assert.equal(b.stack, "python");
  assert.equal(b.stackP, 0.95);
});

test("validateConsensusEntry: accepts a good entry, rejects bad shapes and unknown options", () => {
  assert.deepEqual(validateConsensusEntry(entry22(), { validJobs, validStacks }), []);
  const badJob = entry22({ job: { deger: "not-a-job", duzey: "uzlasilmis" } });
  assert.ok(validateConsensusEntry(badJob, { validJobs, validStacks }).some((p) => p.includes("unknown option")));
  const badShape = { id: "x", job: { deger: "tdd-discipline" } };
  assert.ok(validateConsensusEntry(badShape, { validJobs, validStacks }).length > 0);
  // Null deger is legitimate for an undecided axis.
  const undecided = entry22({ productBound: { deger: null, duzey: "kararsiz" } });
  assert.deepEqual(validateConsensusEntry(undecided, { validJobs, validStacks }), []);
});

// A store with one skill and a consensus observation for it (no jev answer).
function storeWithConsensus({ name = "tdd", job = "tdd-discipline", jobDuzey = "uzlasilmis" } = {}) {
  const store = newStore();
  const text = `---\nname: ${name}\ndescription: Helps with ${name} in a clear and practical way.\n---\nWrite the failing test first, then the code.\n`;
  const md = store.putBlob(text);
  const tree = store.putTree([{ path: "SKILL.md", sha256: md, size: text.length }]);
  const repo = "acme/skills";
  store.putRepo(repo, {
    repo, head: "a".repeat(40), license: "MIT",
    meta: { stars: 100, createdAt: "2026-01-01T00:00:00Z", pushedAt: "2026-09-30T00:00:00Z" },
    skills: [{ path: `skills/${name}`, tree, skillMd: md, files: 1, bytes: 10, hidden: false }],
  });
  const keyOf = consensusKeyer();
  const entry = entry22({ id: name, job: { deger: job, duzey: jobDuzey } });
  const answers = consensusToAnswers(entry);
  if (answers) store.putObs("consensus", keyOf(md), { ...answers, id: name, repo, levels: { job: jobDuzey } });
  return { store, md };
}

const derive = (store) => deriveItems(store, { taxonomy, model: "test/jev", now: new Date("2026-10-02T00:00:00Z") });

test("derive: a 2/2 consensus skill becomes a backup item, never a default", () => {
  const { store } = storeWithConsensus();
  const r = derive(store);
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.equal(it.id, "tdd");
  assert.equal(it.classifiedBy, "consensus", "the item records its classification source");
  assert.equal(it.defaultEligible, false, "consensus items stay out of default sets");
  assert.deepEqual(it.capabilities, ["tdd-discipline"]);
});

test("derive: a consensus skill without a 2/2 job is not a candidate", () => {
  const { store } = storeWithConsensus({ jobDuzey: "cogunluk" });
  const r = derive(store);
  assert.equal(r.items.length, 0, "majority job is not usable");
  assert.equal(r.considered, 1);
});

test("derive: the paid model's answer wins over consensus", async () => {
  const { store, md } = storeWithConsensus({ name: "tdd" });
  // Add a jev observation for the same skillMd: derive must prefer it.
  const { jevKeyer } = await import("../pipeline/observe.mjs");
  const { skillQuestions } = await import("../pipeline/observe.mjs");
  const keyOf = jevKeyer(skillQuestions(taxonomy), "test/jev");
  store.putObs("jev", keyOf(md), {
    coding: 0.99, job: "tdd-discipline", jobP: 0.97, stack: "any", stackP: 0.99,
    lifecycle: "every_task", lifecycleP: 0.9, purpose: "workflow", purposeP: 0.92,
    productBound: 0.05, quality: 0.9, qualityConfidence: 0.8,
  });
  const r = derive(store);
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.ok(!("classifiedBy" in it) || it.classifiedBy !== "consensus", "jev answer takes precedence");
  assert.equal(it.quality, 0.9, "the jev quality traveled with the item");
});
