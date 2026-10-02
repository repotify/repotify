import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpSnippet, applyMcp, removeMcp } from "../src/mcpconfig.mjs";
import { installItem, removeItem } from "../src/install.mjs";
import { readLock } from "../src/lock.mjs";

// Test temp dirs: track every mkdtempSync dir and remove them all in after(),
// or a day of test runs fills /tmp (512M tmpfs) and later runs fail with ENOSPC.
const tempDirs = [];
const mkTemp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
};
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const tmp = () => mkTemp("rp-mcp-");
const playwright = { id: "playwright-mcp", type: "mcp", setup: { steps: ["x"], mcp: { command: "npx", args: ["-y", "@playwright/mcp@0.0.82"] } }, security: { level: "verified" } };
const context7 = { id: "context7", type: "mcp", setup: { steps: ["x"], mcp: { command: "npx", args: ["-y", "@upstash/context7-mcp@4.1.1"], env: { TOKEN: "<your token>" } } }, security: { level: "verified" } };

test("snippets match each agent's config format", () => {
  const j = mcpSnippet(playwright, "claude-code");
  assert.equal(j.file, ".mcp.json");
  assert.deepEqual(JSON.parse(j.text), { mcpServers: { "playwright-mcp": { command: "npx", args: ["-y", "@playwright/mcp@0.0.82"] } } });
  const t = mcpSnippet(context7, "codex");
  assert.equal(t.file, ".codex/config.toml");
  assert.equal(t.text, '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp@4.1.1"]\n');
});

test("placeholder env values are never written; real values are, with quoted TOML keys", () => {
  const withEnv = { ...context7, setup: { ...context7.setup, mcp: { ...context7.setup.mcp, env: { TOKEN: "<your token>", MODE: "fast" } } } };
  assert.deepEqual(JSON.parse(mcpSnippet(withEnv, "claude-code").text).mcpServers.context7.env, { MODE: "fast" });
  assert.match(mcpSnippet(withEnv, "codex").text, /\[mcp_servers\.context7\.env\]\n"MODE" = "fast"\n$/);
  assert.ok(!mcpSnippet(withEnv, "cursor").text.includes("<your token>"));
});

test("the Codex duplicate check understands quoted table names and ignores comments", () => {
  const cwd = tmp();
  mkdirSync(join(cwd, ".codex"));
  writeFileSync(join(cwd, ".codex/config.toml"), '# [mcp_servers.context7] was here once\n[mcp_servers."playwright-mcp"]\ncommand = "x"\n');
  assert.equal(applyMcp(context7, "codex", { cwd }).written, true, "a comment is not a table");
  assert.equal(applyMcp(playwright, "codex", { cwd }).reason, "exists", "quoted table name");
});

test("applyMcp creates the JSON file, keeps other servers and refuses duplicates", () => {
  const cwd = tmp();
  assert.equal(applyMcp(playwright, "claude-code", { cwd }).written, true);
  const cfg = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
  assert.ok(cfg.mcpServers["playwright-mcp"]);
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "x" } }, other: 1 }));
  applyMcp(playwright, "claude-code", { cwd });
  const merged = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ["mine", "playwright-mcp"]);
  assert.equal(merged.other, 1);
  const again = applyMcp(playwright, "claude-code", { cwd });
  assert.deepEqual([again.written, again.reason], [false, "exists"]);
});

test("an unparseable config is never rewritten; the snippet is returned instead", () => {
  const cwd = tmp();
  mkdirSync(join(cwd, ".cursor"));
  const original = '{\n  // my servers\n  "mcpServers": {}\n}\n';
  writeFileSync(join(cwd, ".cursor/mcp.json"), original);
  const r = applyMcp(playwright, "cursor", { cwd });
  assert.deepEqual([r.written, r.reason], [false, "unparseable"]);
  assert.match(r.snippet, /playwright-mcp/);
  assert.equal(readFileSync(join(cwd, ".cursor/mcp.json"), "utf8"), original);
});

test("Codex TOML gets one table per server and is not duplicated", () => {
  const cwd = tmp();
  mkdirSync(join(cwd, ".codex"));
  writeFileSync(join(cwd, ".codex/config.toml"), 'model = "gpt-5"\n');
  assert.equal(applyMcp(context7, "codex", { cwd }).written, true);
  assert.equal(applyMcp(context7, "codex", { cwd }).reason, "exists");
  const text = readFileSync(join(cwd, ".codex/config.toml"), "utf8");
  assert.equal(text.match(/\[mcp_servers\.context7\]/g).length, 1);
  assert.ok(text.startsWith('model = "gpt-5"\n'));
});

test("removeMcp removes only the named server", () => {
  const cwd = tmp();
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "x" } } }));
  applyMcp(playwright, "claude-code", { cwd });
  removeMcp("playwright-mcp", "claude-code", { cwd });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")).mcpServers), ["mine"]);
  mkdirSync(join(cwd, ".codex"));
  writeFileSync(join(cwd, ".codex/config.toml"), 'a = 1\n');
  applyMcp(context7, "codex", { cwd });
  removeMcp("context7", "codex", { cwd });
  assert.equal(readFileSync(join(cwd, ".codex/config.toml"), "utf8"), "a = 1\n");
});

test("installItem: MCP writes only with confirmation and records the lock; removal undoes it", async () => {
  const cwd = tmp();
  const preview = await installItem(playwright, { cwd, agents: ["claude-code"], confirm: false });
  assert.equal(preview.written, false);
  assert.equal(existsSync(join(cwd, ".mcp.json")), false);
  const done = await installItem(playwright, { cwd, agents: ["claude-code"], confirm: true, now: new Date("2026-09-28T00:00:00Z") });
  assert.equal(done.written, true);
  assert.deepEqual(readLock(cwd).items["playwright-mcp"].targets, [".mcp.json#mcpServers.playwright-mcp"]);
  removeItem("playwright-mcp", { cwd });
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")).mcpServers, {});
  assert.equal(readLock(cwd).items["playwright-mcp"], undefined);
});

test("installItem: tools are never executed, only described", async () => {
  const tool = { id: "omniroute", type: "tool", setup: { steps: ["npm install -g omniroute@3.8.50"], verify: "curl -s http://localhost:20128/v1/models" }, security: { level: "caution" } };
  const r = await installItem(tool, { cwd: tmp(), agents: ["claude-code"], confirm: true });
  assert.deepEqual(r.steps, tool.setup.steps);
  assert.equal(r.verify, tool.setup.verify);
  assert.equal(r.executed, false);
  const src = readFileSync(new URL("../src/install.mjs", import.meta.url), "utf8") + readFileSync(new URL("../src/mcpconfig.mjs", import.meta.url), "utf8");
  assert.ok(!src.includes("child_process"), "installer must not spawn processes");
});

test("removing a Codex server keeps the user's array tables and commented headers that follow it", () => {
  const cwd = tmp();
  mkdirSync(join(cwd, ".codex"));
  const mine = '[[skills.config]]\npath = "/x"\nenabled = false\n\n[profiles.fast] # mine\nmodel = "o3"\n';
  writeFileSync(join(cwd, ".codex/config.toml"), `[mcp_servers.context7]\ncommand = "npx"\n\n[mcp_servers.context7.env]\nTOKEN = "t"\n\n${mine}`);
  removeMcp("context7", "codex", { cwd });
  assert.equal(readFileSync(join(cwd, ".codex/config.toml"), "utf8"), mine);
});

test("updating a Codex server reads env only from its own env table", () => {
  const cwd = tmp();
  mkdirSync(join(cwd, ".codex"));
  writeFileSync(join(cwd, ".codex/config.toml"), '[mcp_servers.context7]\ncommand = "npx"\n\n[mcp_servers.context7.env]\n"TOKEN" = "t"\n\n[[profiles]]\n"name" = "x"\n');
  assert.equal(applyMcp(context7, "codex", { cwd, replace: true }).written, true);
  const text = readFileSync(join(cwd, ".codex/config.toml"), "utf8");
  assert.match(text, /\[mcp_servers\.context7\.env\]\n"TOKEN" = "t"\n/);
  assert.doesNotMatch(text, /\[mcp_servers\.context7\.env\][^[]*"name"/);
  assert.match(text, /\[\[profiles\]\]\n"name" = "x"/);
});
