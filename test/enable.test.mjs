import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { recommend, formatTable } from "../src/recommend.mjs";
import { resolveNeeds } from "../src/needs.mjs";

const bin = fileURLToPath(new URL("../bin/repotify.mjs", import.meta.url));
const read = (f) => JSON.parse(readFileSync(new URL(`../catalog/${f}`, import.meta.url), "utf8"));
const catalog = { items: read("items.json"), taxonomy: read("taxonomy.json"), loadouts: read("loadouts.json"), core: read("core.json") };

function project() {
  const cwd = mkdtempSync(join(tmpdir(), "rp-enable-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" } }));
  return cwd;
}
// spawnSync gives the child no terminal, like an agent's shell.
const run = (cwd, args) =>
  spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env: { ...process.env, REPOTIFY_OFFLINE: "1", REPOTIFY_TELEMETRY: "0", REPOTIFY_HOME: join(cwd, ".home"), CLAUDECODE: "1" } });

test("install --yes never writes a hook or an MCP server; it prints the command the user runs", () => {
  const cwd = project();
  const r = run(cwd, ["install", "playwright-mcp", "repotify-guard", "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /playwright-mcp \(MCP server\) changes how the agent runs; the user enables it: .*enable playwright-mcp/);
  assert.match(r.stdout, /repotify-guard \(hook\) changes how the agent runs; the user enables it: .*enable repotify-guard/);
  assert.equal(existsSync(join(cwd, ".mcp.json")), false);
  assert.equal(existsSync(join(cwd, ".claude/settings.json")), false);
});

test("enable without a terminal or --yes refuses and changes nothing", () => {
  const cwd = project();
  const r = run(cwd, ["enable", "repotify-guard"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /changes how your coding agent runs\. Run this yourself/);
  assert.equal(existsSync(join(cwd, ".claude/settings.json")), false);
});

test("enable --yes, typed by the user, shows the change and writes it", () => {
  const cwd = project();
  const r = run(cwd, ["enable", "playwright-mcp", "repotify-guard", "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /playwright-mcp: adds an MCP server your agent starts itself \(`npx -y @playwright\/mcp@/);
  assert.ok(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")).mcpServers["playwright-mcp"]);
  assert.match(JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command, /repotify-guard\.mjs/);
  const lock = JSON.parse(readFileSync(join(cwd, "repotify.lock.json"), "utf8"));
  assert.ok(lock.items["playwright-mcp"] && lock.items["repotify-guard"]);
});

test("enable is only for hooks and MCP servers", () => {
  const cwd = project();
  const r = run(cwd, ["enable", "test-driven-development", "--yes"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a skill, not a hook or MCP server; use `repotify install test-driven-development`/);
  assert.match(run(cwd, ["enable", "--yes"]).stderr, /Usage: repotify enable/);
});

test("the candidate table marks what the user must enable", () => {
  const fp = { empty: false, stacks: ["node", "typescript", "nextjs", "react"], inferredNeeds: ["e2e-testing", "frontend-ui", "llm-calls"], agents: { configured: [], skills: [] } };
  const rec = recommend({ catalog, fingerprint: fp, needs: resolveNeeds({ fingerprint: fp, taxonomy: catalog.taxonomy }) });
  assert.equal(rec.rows.find((r) => r.id === "context7").userEnables, true);
  assert.equal(rec.rows.find((r) => r.id === "frontend-design").userEnables, false);
  const table = formatTable(rec);
  assert.match(table, /⚙ = hook or MCP server, the user enables it/);
  assert.match(table.split("\n").find((l) => l.includes(" context7 ")), /⚙/);
});

// A terminal the user types into: stdin is a TTY and answers the prompt.
async function interactive(cwd, args, answer) {
  const { runCli } = await import("../src/cli.mjs");
  const { PassThrough, Readable } = await import("node:stream");
  const stdin = Readable.from([answer]);
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let text = "";
  stdout.on("data", (d) => (text += d));
  stderr.on("data", (d) => (text += d));
  const env = { REPOTIFY_OFFLINE: "1", REPOTIFY_TELEMETRY: "0", REPOTIFY_HOME: join(cwd, ".home"), CLAUDECODE: "1" };
  const code = await runCli(args, { cwd, env, stdin, stdout, stderr });
  return { code, text };
}

test("in a terminal, enable asks first: yes writes, anything else changes nothing", async () => {
  const no = project();
  const skipped = await interactive(no, ["enable", "repotify-guard"], "n\n");
  assert.equal(skipped.code, 0);
  assert.match(skipped.text, /Enable repotify-guard\? \[y\/N\][\s\S]*Skipped repotify-guard; nothing changed\./);
  assert.equal(existsSync(join(no, ".claude/settings.json")), false);
  const yes = project();
  const done = await interactive(yes, ["enable", "repotify-guard"], "y\n");
  assert.equal(done.code, 0, done.text);
  assert.ok(existsSync(join(yes, ".claude/settings.json")));
});
