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
// The skill text is long enough to pass the content rules (not a thin stub).
function storeWithConsensus({ name = "tdd", job = "tdd-discipline", jobDuzey = "uzlasilmis" } = {}) {
  const store = newStore();
  const paras = [
    "Write the failing test first, then the code. This is the core discipline of test-driven development, and it changes how you think about design.",
    "When you write the test first, you are forced to think about the interface before the implementation. What should this function be called? What arguments does it take? What does it return? These are design questions, and TDD makes you answer them upfront.",
    "A common objection is that TDD slows you down. In the short term, it does: you write more code (tests plus implementation). But in the medium term, you save time because you catch bugs earlier, when they are cheaper to fix, and because the tests document the intended behavior.",
  ];
  const text = `---\nname: ${name}\ndescription: Helps with ${name} in a clear and practical way for software teams.\n---\n# ${name}\n\n${paras.join("\n\n")}\n\n## Steps\n\n1. Describe the behavior you want in a test. Be specific about inputs, outputs, and edge cases. A vague test leads to vague code.\n2. Run the test and watch it fail. If it passes, the test is wrong: either the behavior already exists or the test does not check anything.\n3. Write the smallest code that makes it pass. Do not add extra features or speculative generality.\n4. Refactor while keeping the tests green. Clean up duplication and clarify names.\n5. Repeat for the next behavior. Small steps keep you safe.\n\n## When to use\n\nUse this whenever you add a feature or fix a bug. Do not skip the failing-test step. Skipping leads to untested code and regressions that are expensive to diagnose later.\n\n## Common mistakes\n\n- Writing too much code before testing anything.\n- Testing implementation details instead of observable behavior.\n- Not refactoring because the code already works.\n- Writing tests after the code, which usually means testing what the code does rather than what it should do.\n\n## Example\n\n\`\`\`js\n// test: addition works\nassert.equal(add(2, 3), 5);\nassert.equal(add(-1, 1), 0);\n// implementation\nfunction add(a, b) { return a + b; }\n\`\`\`\n\nThe example above shows the full cycle on a trivial function. On real code the cycle is the same, only the tests are more involved.\n`;
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
