import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "../src/util.mjs";
import { fingerprint, formatFingerprint } from "../src/fingerprint.mjs";
import { resolveNeeds } from "../src/needs.mjs";
import { adaptiveQuestions, questionsJson } from "../src/questions.mjs";
import { loadSeedGraph } from "../lib/pipeline/graph/loader.mjs";
import { recommend, formatTable } from "../src/recommend.mjs";
import { scanFiles } from "../src/scan/index.mjs";
import { COMMANDS } from "../src/cli.mjs";
import { parseFrontmatter } from "../pipeline/collect.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const catalog = Object.fromEntries(["items", "taxonomy", "loadouts", "core"].map((k) => [k, JSON.parse(read(`catalog/${k}.json`))]));
const projects = join(root, "test/fixtures/projects");
const SKILL = read("skill/repotify/SKILL.md");

// Token budgets for everything the agent reads.
const BUDGET = { skill: 1500, fingerprint: 400, questions: 400, table: 900, agentWriting: 1200, install: 300, total: 5000 };

test("SKILL.md stays within 1,500 tokens and has valid frontmatter", () => {
  assert.ok(estimateTokens(SKILL) <= BUDGET.skill, `${estimateTokens(SKILL)} tokens`);
  const fm = parseFrontmatter(SKILL);
  assert.equal(fm.name, "repotify");
  assert.ok(fm.description.length >= 80 && fm.description.length <= 400, `${fm.description.length}`);
});

test("the whole discovery-to-install flow fits in 5,000 tokens", async () => {
  let fpTokens = 0;
  for (const p of ["nextjs-saas", "monorepo-mixed", "news-site", "fastapi-llm"]) {
    fpTokens = Math.max(fpTokens, estimateTokens(formatFingerprint(await fingerprint(join(projects, p)))));
  }
  // The agent reads `questions --json`; an empty project gets the most questions.
  const emptyFp = await fingerprint(join(projects, "empty"));
  const graph = loadSeedGraph(join(root, "data", "graph-seed.json"));
  const qTokens = estimateTokens(questionsJson(adaptiveQuestions({ catalog, graph, fingerprint: emptyFp }).questions));
  const fp = await fingerprint(join(projects, "nextjs-saas"));
  const rec = recommend({ catalog, fingerprint: fp, needs: resolveNeeds({ fingerprint: fp, answers: {}, taxonomy: catalog.taxonomy }) });
  const thirty = { ...rec, rows: Array.from({ length: 30 }, (_, i) => ({ ...rec.rows[i % rec.rows.length], id: `${rec.rows[i % rec.rows.length].id}-${i}` })) };
  const tableTokens = estimateTokens(formatTable(thirty));
  const installTokens = Math.ceil(1050 / 3.5);
  assert.ok(fpTokens <= BUDGET.fingerprint, `fingerprint ${fpTokens}`);
  assert.ok(qTokens <= BUDGET.questions, `questions ${qTokens}`);
  assert.ok(tableTokens <= BUDGET.table, `table ${tableTokens}`);
  assert.ok(installTokens <= BUDGET.install, `install ${installTokens}`);
  const total = estimateTokens(SKILL) + fpTokens + qTokens + tableTokens + installTokens + BUDGET.agentWriting;
  assert.ok(total <= BUDGET.total, `total ${total}`);
});

test("every repotify command named in SKILL.md exists", () => {
  const named = [...SKILL.matchAll(/`repotify ([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(named.length >= 4);
  for (const cmd of named) assert.ok(COMMANDS[cmd], `SKILL.md mentions unknown command: ${cmd}`);
});

// The npm name is published by the maintainers, so the package is the primary instruction; the clone path stays in
// AGENTS.md as the from-source alternative (review I7).
test("README opens with the agent instruction block using the npm package", () => {
  const head = read("README.md").split("\n").slice(0, 20).join("\n");
  assert.match(head, /For AI agents/);
  assert.match(head, /npx -y @repotify\/repotify@latest/);
});

test("AGENTS.md carries the same instruction and docs/i18n/README.tr.md exists", () => {
  assert.match(read("AGENTS.md"), /npx -y @repotify\/repotify@latest/);
  assert.match(read("AGENTS.md"), /node <clone>\/bin\/repotify\.mjs/);
  assert.match(read("docs/i18n/README.tr.md"), /npx -y @repotify\/repotify@latest/);
  assert.match(read("skill/repotify/SKILL.md"), /items\.repotify\.launcher/);
  assert.match(read(".github/SECURITY.md"), /Reporting/i);
});

test("our own agent-facing files pass our scanner", () => {
  for (const p of ["skill/repotify/SKILL.md", "README.md", "AGENTS.md"]) {
    const r = scanFiles([{ path: p.split("/").pop(), content: read(p) }]);
    assert.equal(r.level, "verified", `${p}: ${JSON.stringify(r.findings)}`);
  }
});
