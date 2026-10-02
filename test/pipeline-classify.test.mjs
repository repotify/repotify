import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyCoarse, fromJury, fromText, fromContext, tokens } from "../lib/pipeline/classify/index.mjs";

const taxonomy = JSON.parse(readFileSync(new URL("../catalog/taxonomy.json", import.meta.url), "utf8"));
const BENIGN = readFileSync(new URL("./fixtures/pipeline/benign-skill.md", import.meta.url), "utf8");

test("jury capabilities become labels with high confidence", () => {
  const { labels, confidence } = classifyCoarse({
    testResult: { text: BENIGN, jury: { capabilities: ["pdf-processing", "code-review"] } },
    taxonomy,
  });
  assert.ok(labels.some((l) => l.id === "pdf-processing" && l.sources.includes("jury")));
  assert.ok(labels.some((l) => l.id === "code-review"));
  assert.ok(labels.length <= 5);
  assert.equal(confidence, "high");
});

test("unknown jury ids are dropped, not invented", () => {
  const labels = fromJury({ capabilities: ["pdf-processing", "time-travel"] }, taxonomy);
  assert.deepEqual(labels.map((l) => l.id), ["pdf-processing"]);
});

test("text fallback finds capabilities by keyword overlap", () => {
  const text = "This skill performs thorough code review of pull requests, finding bugs and style issues.";
  const found = fromText(text, taxonomy);
  assert.ok(found.some((c) => c.id === "code-review"), `code-review matched in ${JSON.stringify(found.map((f) => f.id))}`);
  const { labels, confidence } = classifyCoarse({ testResult: { text, jury: null }, taxonomy });
  assert.ok(labels.length >= 1 && labels.length <= 5);
  assert.ok(labels.every((l) => taxonomy.capabilities[l.id]), "every label is a real taxonomy id");
  assert.equal(confidence, "low", "a single heuristic label is a thin signal");
});

test("three agreeing heuristic labels reach medium confidence", () => {
  const text = "A code review workflow for pull requests, systematic debugging of flaky failures, and browser automation with a headless browser.";
  const { labels, confidence } = classifyCoarse({ testResult: { text, jury: null }, taxonomy });
  assert.ok(labels.length >= 3, `got ${JSON.stringify(labels.map((l) => l.id))}`);
  assert.equal(confidence, "medium");
});

test("seed context boosts stack-related capabilities, but never creates them alone", () => {
  const context = { manifests: [{ kind: "node", file: "package.json", name: "x", deps: ["@angular/core"] }] };
  // Text evidence first: "angular" and "expertise" match the angular-expertise capability.
  const withEvidence = classifyCoarse({ testResult: { text: "Angular expertise for building components", jury: null }, context, taxonomy });
  const ng = withEvidence.labels.find((l) => l.id === "angular-expertise");
  assert.ok(ng, "text match produces the label");
  assert.ok(ng.sources.includes("context"), "context attaches as a boost source");
  assert.equal(ng.weight, 1, "boost caps at 1");
  // No text/jury evidence: the dep alone must NOT conjure a label out of thin air.
  const noEvidence = classifyCoarse({ testResult: { text: "Deploys things.", jury: null }, context, taxonomy });
  assert.ok(!noEvidence.labels.some((l) => l.id === "angular-expertise"), "context alone creates no labels");
});

test("sources merge instead of duplicating a label", () => {
  const { labels } = classifyCoarse({
    testResult: { text: "code review of pull requests", jury: { capabilities: ["code-review"] } },
    taxonomy,
  });
  const cr = labels.find((l) => l.id === "code-review");
  assert.ok(cr.sources.includes("jury") && cr.sources.includes("text"));
  assert.equal(labels.filter((l) => l.id === "code-review").length, 1);
});

test("no signal -> no labels, low confidence", () => {
  const { labels, confidence } = classifyCoarse({ testResult: { text: "", jury: null }, taxonomy });
  assert.deepEqual(labels, []);
  assert.equal(confidence, "low");
});

test("labels are capped at five and sorted by weight", () => {
  const caps = Object.keys(taxonomy.capabilities).slice(0, 10);
  const { labels } = classifyCoarse({ testResult: { text: "", jury: { capabilities: caps } }, taxonomy });
  assert.ok(labels.length <= 5);
  const weights = labels.map((l) => l.weight);
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a));
});

test("tokens() strips stopwords and short words", () => {
  assert.deepEqual(tokens("The PDF reader"), ["pdf", "reader"]);
});
