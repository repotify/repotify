// Unit tests for test/harness/rubric.mjs — pure functions.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseChosenSkills, extractDeliverable, scoreCheck, scoreRubric, scoreRouting, ndcgAtK, estTokens } from "./rubric.mjs";

describe("rubric", () => {
  it("parses the SKILLS: line, splits valid vs hallucinated", () => {
    const p = parseChosenSkills("SKILLS: react-best-practices, MadeUp\nDELIVERABLE:\nx", ["react-best-practices", "semgrep"]);
    assert.equal(p.found, true);
    assert.deepEqual(p.valid, ["react-best-practices"]);
    assert.deepEqual(p.hallucinated, ["madeup"]);
  });

  it("treats SKILLS: NONE as an empty choice", () => {
    const p = parseChosenSkills("SKILLS: NONE\nDELIVERABLE:\nx", ["a"]);
    assert.equal(p.found, true);
    assert.deepEqual(p.valid, []);
  });

  it("reports found=false when the contract line is missing", () => {
    assert.equal(parseChosenSkills("no contract here", ["a"]).found, false);
  });

  it("extracts the deliverable after the marker", () => {
    assert.equal(extractDeliverable("SKILLS: NONE\nDELIVERABLE:\nhello"), "hello");
    assert.equal(extractDeliverable("plain text"), "plain text");
  });

  it("scores contains / regex / not-contains checks", () => {
    assert.equal(scoreCheck("UseEffect here", { check: "contains", pattern: "useeffect", points: 1 }), 1);
    assert.equal(scoreCheck("nothing", { check: "contains", pattern: "useeffect", points: 1 }), 0);
    assert.equal(scoreCheck("@app.post('/items')", { check: "regex", pattern: "@app\\.post\\(['\"]\\/items['\"]", points: 1 }), 1);
    assert.equal(scoreCheck("clean", { check: "not-contains", pattern: "setInterval", points: 1 }), 1);
    assert.equal(scoreCheck("setInterval boom", { check: "not-contains", pattern: "setInterval", points: 1 }), 0);
  });

  it("regex checks are case-insensitive", () => {
    assert.equal(scoreCheck("## Quickstart", { check: "regex", pattern: "#{1,3}\\s*quickstart", points: 1 }), 1);
  });

  it("scoreRubric sums points and returns a fraction", () => {
    const r = scoreRubric("useEffect and clearTimeout", [
      { id: "a", check: "contains", pattern: "useeffect", points: 1 },
      { id: "b", check: "contains", pattern: "cleartimeout", points: 1 },
      { id: "c", check: "contains", pattern: "missing", points: 1 },
    ]);
    assert.equal(r.earned, 2); assert.equal(r.max, 3);
    assert.ok(Math.abs(r.score - 2 / 3) < 1e-9);
    assert.equal(r.perCheck.length, 3);
  });

  it("scoreRouting computes recall, precision, F1 and violations", () => {
    const s = { mustInclude: ["A", "B"], mustNotInclude: ["X"] };
    const r = scoreRouting(["a", "x", "zzz"], s);
    assert.equal(r.recall, 0.5);
    assert.equal(r.precision, 0.333);
    assert.equal(r.hits, 1); assert.equal(r.of, 2); assert.equal(r.chosen, 3);
    assert.equal(r.violations, 1); assert.deepEqual(r.violationIds, ["x"]);
    assert.ok(r.f1 > 0 && r.f1 < 1);
  });

  it("scoreRouting precision is 1 when nothing is chosen and nothing is required", () => {
    const r = scoreRouting([], { mustInclude: [], mustNotInclude: [] });
    assert.equal(r.recall, 1);
    assert.equal(r.precision, 1);
  });

  it("estTokens is roughly chars/4", () => {
    assert.equal(estTokens(400), 100);
  });

  it("ndcgAtK rewards top-ranked hits and is 1 for ideal ranking", () => {
    const s = { mustInclude: ["A", "B"] };
    assert.equal(ndcgAtK(["a", "b", "x"], s), 1); // ideal: both hits on top
    const worse = ndcgAtK(["x", "y", "a", "b"], s);
    const better = ndcgAtK(["a", "x", "b"], s);
    assert.ok(better > worse, `better=${better} worse=${worse}`);
    assert.ok(worse >= 0 && worse <= 1);
  });

  it("ndcgAtK is 0 with no hits or no requirements", () => {
    assert.equal(ndcgAtK(["x", "y"], { mustInclude: ["A"] }), 0);
    assert.equal(ndcgAtK([], { mustInclude: ["A"] }), 0);
    assert.equal(ndcgAtK(["a"], { mustInclude: [] }), 0);
  });

  it("scoreRouting includes ndcg", () => {
    const r = scoreRouting(["a", "x"], { mustInclude: ["A", "B"], mustNotInclude: [] });
    assert.equal(r.ndcg, ndcgAtK(["a", "x"], { mustInclude: ["A", "B"] }));
  });
});
