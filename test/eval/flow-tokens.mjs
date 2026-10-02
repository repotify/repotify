#!/usr/bin/env node
// What one Repotify setup costs the agent in context: everything it reads in the flow the repotify skill describes
// (the start output, the skill itself, `questions --json`, the `recommend` table and the install summary), for each
// fixture project. Tokens are characters / 3.5, the conservative rule Repotify uses for budgets (src/util.mjs).
// Offline and deterministic: the install summary is the one a successful install of the default set prints.
// Usage: node test/eval/flow-tokens.mjs
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatInstallSummary } from "../../src/cli.mjs";
import { estimateTokens } from "../../src/util.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const bin = join(root, "bin", "repotify.mjs");
const PROJECTS = ["nextjs-saas", "fastapi-llm", "go-cli", "flutter-app", "news-site", "solidity-dapp", "monorepo-mixed"];

export function flowTokens(fixture) {
  const cwd = mkdtempSync(join(tmpdir(), "rp-flow-tokens-"));
  try {
    cpSync(fixture, cwd, { recursive: true });
    const env = { ...process.env, REPOTIFY_HOME: join(cwd, ".repotify-home"), REPOTIFY_OFFLINE: "1", REPOTIFY_TELEMETRY: "0", CLAUDECODE: "1" };
    const run = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: "utf8" }).stdout;
    const parts = { start: run(), skill: readFileSync(join(root, "skill", "repotify", "SKILL.md"), "utf8"), questions: run("questions", "--json"), recommend: run("recommend") };
    const rec = JSON.parse(run("recommend", "--json"));
    const results = rec.defaultSet.map((id) => {
      const row = rec.rows.find((r) => r.id === id);
      return row.userEnables ? { id, ok: true, type: row.type, written: false, userEnables: `repotify enable ${id}` } : { id, ok: true, type: row.type, written: true, steps: ["see the tool's docs"] };
    });
    parts.install = formatInstallSummary({ agents: ["claude-code"], results });
    return Object.fromEntries([...Object.entries(parts).map(([k, v]) => [k, estimateTokens(v)]), ["total", estimateTokens(Object.values(parts).join(""))]]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rows = PROJECTS.map((p) => ({ project: p, ...flowTokens(join(root, "test", "fixtures", "projects", p)) }));
  console.table(rows);
  const totals = rows.map((r) => r.total);
  console.log(`tokens per setup: mean ${Math.round(totals.reduce((a, b) => a + b, 0) / totals.length)}, range ${Math.min(...totals)}–${Math.max(...totals)}`);
}
