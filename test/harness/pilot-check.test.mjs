// Unit tests for the catalog-change pilot regression gate:
//   - checkPilotOutcome() in test/harness/pilot-coverage.mjs (the --check verdict)
//   - .github/workflows/catalog.yml wiring: catalog changes must trigger the
//     pilot + sensitivity sweep, while the manual catalog build stays
//     workflow_dispatch-only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPilotOutcome } from "./pilot-coverage.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..");

const mkRow = (arm, recall, ndcg, f1) => ({
  event: "coverage_pilot", scenario: "s", arm, rep: 0,
  routing_recall: recall, routing_precision: 0.5, routing_f1: f1, routing_ndcg: ndcg,
});

describe("checkPilotOutcome", () => {
  it("passes when jaccard beats strict on recall and ndcg", () => {
    const out = [
      mkRow("repotify", 0.5, 0.6, 0.55),
      mkRow("repotify-jaccard", 0.857, 0.655, 0.55),
      mkRow("repotify-loose", 0.6, 0.62, 0.5),
    ];
    const v = checkPilotOutcome(out);
    assert.equal(v.pass, true, JSON.stringify(v.failures));
    assert.equal(v.summary["repotify-jaccard"].recall, 0.857);
  });

  it("fails when jaccard recall regresses below strict", () => {
    const out = [mkRow("repotify", 0.8, 0.6, 0.6), mkRow("repotify-jaccard", 0.5, 0.65, 0.6)];
    const v = checkPilotOutcome(out);
    assert.equal(v.pass, false);
    assert.ok(v.failures.some((f) => f.includes("recall")), v.failures.join("; "));
  });

  it("fails when jaccard ndcg regresses below strict", () => {
    const out = [mkRow("repotify", 0.8, 0.7, 0.6), mkRow("repotify-jaccard", 0.8, 0.5, 0.6)];
    const v = checkPilotOutcome(out);
    assert.equal(v.pass, false);
    assert.ok(v.failures.some((f) => f.includes("ndcg")), v.failures.join("; "));
  });

  it("fails when jaccard f1 regresses more than the 0.05 tolerance", () => {
    const out = [mkRow("repotify", 0.8, 0.7, 0.7), mkRow("repotify-jaccard", 0.8, 0.7, 0.6)];
    const v = checkPilotOutcome(out);
    assert.equal(v.pass, false);
    assert.ok(v.failures.some((f) => f.includes("f1")), v.failures.join("; "));
  });

  it("tolerates a small f1 dip within 0.05", () => {
    const out = [mkRow("repotify", 0.8, 0.7, 0.7), mkRow("repotify-jaccard", 0.8, 0.7, 0.66)];
    assert.equal(checkPilotOutcome(out).pass, true);
  });

  it("fails when an arm is missing from the output", () => {
    const v = checkPilotOutcome([mkRow("repotify", 0.8, 0.7, 0.7)]);
    assert.equal(v.pass, false);
    assert.ok(v.failures.some((f) => f.includes("repotify-jaccard")));
  });
});

describe("catalog.yml pilot wiring", () => {
  const yml = readFileSync(join(repoRoot, ".github", "workflows", "catalog.yml"), "utf8");

  it("has a coverage-pilot job", () => {
    assert.match(yml, /^  coverage-pilot:/m);
  });

  it("triggers on catalog, pipeline and harness changes", () => {
    assert.match(yml, /paths:\s*\n(\s+-\s+"[^"]+"\n)+/);
    for (const p of ['"catalog/**"', '"lib/pipeline/**"', '"test/harness/**"']) {
      assert.ok(yml.includes(p), `trigger path ${p} present`);
    }
  });

  it("pilot job runs the pilot --check and the sensitivity sweep", () => {
    assert.ok(yml.includes("pilot-coverage.mjs --check"), "pilot --check step");
    assert.ok(yml.includes("jaccard-sensitivity.mjs"), "sensitivity sweep step");
  });

  it("keeps the manual catalog build workflow_dispatch-only", () => {
    // The build job holds LLM keys: it must not fire on catalog pushes/PRs.
    const buildBlock = yml.slice(yml.indexOf("\n  build:"));
    const firstJobEnd = buildBlock.search(/\n  \w[\w-]*:\n/);
    const block = firstJobEnd > 0 ? buildBlock.slice(0, firstJobEnd) : buildBlock;
    assert.match(block, /if:\s*github\.event_name\s*==\s*['"]workflow_dispatch['"]/);
  });

  it("pilot job does not request write permissions", () => {
    const pilotIdx = yml.indexOf("\n  coverage-pilot:");
    assert.ok(pilotIdx > 0);
    const tail = yml.slice(pilotIdx);
    const nextJob = tail.slice("\n  coverage-pilot:".length).search(/\n  \w[\w-]*:\n/);
    const block = nextJob > 0 ? tail.slice(0, "\n  coverage-pilot:".length + nextJob) : tail;
    assert.ok(!block.includes("contents: write"), "pilot job must not get write permissions");
  });
});
