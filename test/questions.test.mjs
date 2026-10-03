import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint } from "../src/fingerprint.mjs";
import { resolveNeeds } from "../src/needs.mjs";
import { adaptiveQuestions, formatAdaptive, priorOf, PRIOR } from "../src/questions.mjs";
import { demandFor, recommendLocal } from "../lib/pipeline/recommend/index.mjs";
import { loadSeedGraph } from "../lib/pipeline/graph/loader.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(root, "catalog", f), "utf8"));
const catalog = { items: read("items.json"), taxonomy: read("taxonomy.json"), loadouts: read("loadouts.json"), core: read("core.json") };
const graph = loadSeedGraph(join(root, "data", "graph-seed.json"));
const project = (name) => fingerprint(join(root, "test", "fixtures", "projects", name));

const picks = (fp, answers) => {
  const needs = resolveNeeds({ fingerprint: fp, answers, taxonomy: catalog.taxonomy });
  return new Set(recommendLocal({ catalog, graph, demand: demandFor({ catalog, fingerprint: fp, needs, answers }), answers }).set);
};
const answer = (q, option) => (q.id === "projectType" ? { projectType: option } : { [q.id]: [option] });

test("every option offered changes the picks, by exactly the count it shows", async () => {
  for (const name of ["empty", "nextjs-saas", "go-cli"]) {
    const fp = await project(name);
    const base = picks(fp, {});
    const r = adaptiveQuestions({ catalog, graph, fingerprint: fp });
    assert.ok(r.questions.length >= 1 && r.questions.length <= 3, `${name}: ${r.questions.length} questions`);
    for (const q of r.questions) {
      assert.ok(q.options.length >= 1 && q.options.length <= 4, `${name} ${q.id}`);
      for (const o of q.options) {
        const after = picks(fp, answer(q, o.id));
        const changed = [...after].filter((x) => !base.has(x)).length + [...base].filter((x) => !after.has(x)).length;
        assert.ok(o.changes > 0 && o.changes === changed, `${name} ${q.id}=${o.id}: shows ${o.changes}, changes ${changed}`);
      }
    }
  }
});

test("the project type is asked first when the files cannot tell it, and never when they or an answer do", async () => {
  const empty = await project("empty");
  assert.equal(adaptiveQuestions({ catalog, graph, fingerprint: empty }).questions[0].id, "projectType");
  const typed = adaptiveQuestions({ catalog, graph, fingerprint: empty, answers: { projectType: "web-app" } });
  assert.ok(!typed.questions.some((q) => q.id === "projectType"));
  assert.equal(typed.projectType, "web-app");
  const saas = adaptiveQuestions({ catalog, graph, fingerprint: await project("nextjs-saas") });
  assert.ok(!saas.questions.some((q) => q.id === "projectType"));
  assert.equal(saas.projectType, "web-app");
});

test("the same thing is never offered twice: a security priority is the security need", async () => {
  for (const name of ["empty", "nextjs-saas", "go-cli", "flutter-app", "news-site", "fastapi-llm"]) {
    const r = adaptiveQuestions({ catalog, graph, fingerprint: await project(name) });
    const offered = (id) => new Set(r.questions.find((q) => q.id === id)?.options.map((o) => o.id) ?? []);
    const needs = offered("needs");
    const priorities = offered("priorities");
    assert.ok(!(needs.has("security") && priorities.has("security")), name);
    assert.ok(!(needs.has("testing") && priorities.has("quality")), name);
  }
});

test("an answer already given is not asked again, and what it settles drops out", async () => {
  const fp = await project("nextjs-saas");
  const first = adaptiveQuestions({ catalog, graph, fingerprint: fp });
  const top = first.questions[0];
  const second = adaptiveQuestions({ catalog, graph, fingerprint: fp, answers: answer(top, top.options[0].id) });
  const again = second.questions.find((q) => q.id === top.id);
  assert.ok(!again || !again.options.some((o) => o.id === top.options[0].id));
});

test("nothing to ask when no answer can change the picks", async () => {
  const coreOnly = { ...catalog, items: catalog.items.filter((i) => i.tier === "core") };
  const r = adaptiveQuestions({ catalog: coreOnly, graph, fingerprint: await project("empty") });
  assert.deepEqual(r.questions, []);
  assert.match(formatAdaptive(r), /^No answer would change the picks for this project \(\d+ picked from \d+ candidates\)/);
});

test("likely answers weigh more: a need typical for the project type, then other needs, then one that makes it another kind of project", () => {
  const needs = { id: "needs", multi: true };
  const ctx = { typical: new Set(["seo"]), projectType: "content-site" };
  assert.equal(priorOf(needs, "seo", ctx), PRIOR.typicalNeed);
  assert.equal(priorOf(needs, "payments", ctx), PRIOR.need);
  assert.equal(priorOf(needs, "smart-contracts", ctx), PRIOR.otherKind);
  assert.equal(priorOf(needs, "smart-contracts", { typical: new Set(), projectType: null }), PRIOR.need, "unknown kind: no long shot");
  assert.equal(priorOf(needs, "smart-contracts", { typical: new Set(), projectType: "smart-contracts" }), PRIOR.need);
  assert.equal(priorOf({ id: "projectType", multi: false, options: new Array(11) }, "web-app", ctx), 1 / 11);
  assert.ok(PRIOR.typicalNeed > PRIOR.need && PRIOR.need > PRIOR.otherKind);
});

test("the text lists each option with the picks it changes", async () => {
  const text = formatAdaptive(adaptiveQuestions({ catalog, graph, fingerprint: await project("empty") }));
  assert.match(text, /^1\. What are you building\? \(pick one\)\n {3}- [a-z-]+: .+ \(changes \d+ picks?\)/);
});
