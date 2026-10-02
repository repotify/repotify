// 20-pilot end-to-end run of the v1 test runner: the full package
// (security gate + heuristics + draft jury + labels + content-hash cache)
// on twenty synthetic items, plus the determinism check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runTestSuite, PROMOTE_THRESHOLD } from "../../lib/pipeline/test-runner/index.mjs";
import { isPresentable } from "../../lib/pipeline/test-runner/retest.mjs";
import { classifyCoarse } from "../../lib/pipeline/classify/index.mjs";

const taxonomy = JSON.parse(readFileSync(new URL("../../catalog/taxonomy.json", import.meta.url), "utf8"));
const benign = readFileSync(new URL("../fixtures/pipeline/benign-skill.md", import.meta.url), "utf8");
const malicious = readFileSync(new URL("../fixtures/pipeline/malicious-skill.md", import.meta.url), "utf8");
const NOW = new Date("2026-10-01T12:00:00Z");

const TOPICS = [
  ["pdf-processing", "Reads and writes PDF files with page-level precision."],
  ["code-review", "Reviews pull requests for bugs, style and security issues."],
  ["docx-documents", "Creates Word documents from templates with mail merge."],
  ["browser-automation", "Drives a headless browser to fill forms and scrape pages."],
  ["api-testing", "Sends HTTP requests and asserts on JSON responses."],
  ["database-migrations", "Authors and applies SQL migrations with rollback support."],
  ["docker-containers", "Builds minimal container images for Node services."],
  ["ci-security-audit", "Scans CI pipelines for leaked secrets and unsafe steps."],
  ["frontend-design", "Drafts accessible UI layouts with spacing scales."],
  ["unit-testing", "Writes table-driven unit tests for Go packages."],
  ["e2e-testing", "Scripts end-to-end flows with Playwright fixtures."],
  ["markdown-docs", "Generates API reference docs from JSDoc comments."],
  ["git-workflows", "Manages stacked diffs and clean rebases."],
  ["shell-scripting", "Writes POSIX-safe shell scripts with strict mode."],
  ["json-transform", "Reshapes nested JSON with declarative mappings."],
  ["csv-processing", "Parses large CSV files in streaming fashion."],
  ["email-templates", "Renders transactional email templates with inlined CSS."],
  ["cron-jobs", "Schedules and monitors recurring background jobs."],
];

function skillText([cap, desc]) {
  return `---\nname: ${cap}\ndescription: ${desc}\n---\n\n# ${cap}\n\n${desc}\n\n## Usage\n\nFollow the steps below carefully.\n\n## Examples\n\n\`\`\`\nrun --help\n\`\`\`\n`;
}

function buildPilotItems() {
  const items = TOPICS.map(([cap, desc], i) => ({
    id: `pilot-${cap}`,
    text: skillText([cap, desc]),
    description: desc,
    editorial: i < 4, // first four are seed items -> jury-eligible
    signals: { lastCommitDays: (i * 37) % 400, stars: 50 + i * 120, license: i % 5 === 0 ? null : "MIT" },
  }));
  items.push({ id: "pilot-malicious", text: malicious, signals: { lastCommitDays: 3, stars: 9000, license: "MIT" } });
  items.push({ id: "pilot-malicious-seed", editorial: true, text: malicious, signals: { lastCommitDays: 3, stars: 12, license: "MIT" } });
  return items;
}

const verdictJson = (quality, caps) => JSON.stringify({
  summary: "A useful skill.", capabilities: caps, needs: [], stacks: ["*"], tier: "mission",
  quality, specificity: 0.7, maintenance: 0.8, suspicious: false,
});
const chat = async ({ model }) => {
  const q = { "nvidia/m1": 0.9, "google/m2": 0.7, "openai/m3": 0.6 }[model] ?? 0.7;
  const caps = model === "nvidia/m1" ? ["pdf-processing"] : model === "google/m2" ? ["pdf-processing", "code-review"] : ["pdf-processing"];
  return verdictJson(q, caps);
};
const jurors = [
  { provider: "nvidia", model: "nvidia/m1", family: "nvidia" },
  { provider: "nvidia", model: "google/m2", family: "google" },
  { provider: "nvidia", model: "openai/m3", family: "openai" },
];

test("the runner works end to end on 20 pilot items", async () => {
  const items = buildPilotItems();
  assert.equal(items.length, 20);
  const cache = {};
  const results = [];
  for (const item of items) {
    results.push(await runTestSuite(item, { cache, taxonomy, chat, jurors, now: NOW, classify: classifyCoarse }));
  }
  for (const r of results) {
    assert.ok(r.score >= 0 && r.score <= 1, `${r.itemId} score in range`);
    assert.ok(r.scoredAt && r.expiresAt, `${r.itemId} has scored_at + expires_at`);
    assert.ok(r.cheap.scoredAt && r.cheap.expiresAt, `${r.itemId} cheap layer timestamps`);
    assert.ok(r.contentHash && r.contentHash.length === 64, `${r.itemId} content hash`);
    assert.ok(r.labels.length <= 5, `${r.itemId} at most 5 labels`);
    assert.ok(["high", "medium", "low"].includes(r.labelConfidence));
  }
  const seed = results.filter((r) => items.find((i) => i.id === r.itemId).editorial && r.itemId !== "pilot-malicious-seed");
  for (const r of seed) assert.ok(r.jury, `${r.itemId} (editorial) got a jury`);
  const discovered = results.filter((r) => !items.find((i) => i.id === r.itemId).editorial);
  for (const r of discovered) {
    if (r.proxyScore >= PROMOTE_THRESHOLD && r.presentableSecurity) {
      assert.equal(r.juryPromoted, true, `${r.itemId} (strong discovered) promoted to the jury`);
      assert.ok(r.jury, `${r.itemId} has a jury verdict`);
    } else {
      assert.equal(r.jury, null, `${r.itemId} (discovered, proxy ${r.proxyScore}) skipped the jury`);
    }
  }
  const bad = results.find((r) => r.itemId === "pilot-malicious");
  assert.equal(bad.security.level, "rejected");
  assert.equal(bad.presentableSecurity, false);
  assert.equal(isPresentable(bad, NOW.getTime()).ok, false);
  const badSeed = results.find((r) => r.itemId === "pilot-malicious-seed");
  assert.equal(badSeed.security.level, "rejected", "the gate wins over the jury, even for seed items");
});

test("pilot determinism: same content -> same score, served from cache", async () => {
  const items = buildPilotItems();
  const cache = {};
  const first = [];
  for (const item of items) first.push(await runTestSuite(item, { cache, taxonomy, chat, jurors, now: NOW, classify: classifyCoarse }));
  for (const item of items) {
    const again = await runTestSuite(item, { cache, taxonomy, chat, jurors, now: NOW, classify: classifyCoarse });
    const orig = first.find((r) => r.itemId === item.id);
    assert.equal(again.fromCache, true, `${item.id} served from cache`);
    assert.equal(again.score, orig.score, `${item.id} score identical`);
    assert.deepEqual(again.labels, orig.labels, `${item.id} labels identical`);
  }
});
