import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, detectAgents, skillTargets, parseAgentList } from "../src/agents.mjs";

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

const tmp = () => mkTemp("rp-ag-");

test("the registry pins the documented project paths", () => {
  assert.equal(AGENTS["claude-code"].skillsDir, ".claude/skills");
  assert.equal(AGENTS.cursor.skillsDir, ".cursor/skills");
  assert.equal(AGENTS.codex.skillsDir, ".agents/skills");
  assert.equal(AGENTS["gemini-cli"].skillsDir, ".gemini/skills");
  assert.equal(AGENTS.generic.skillsDir, ".agents/skills");
  assert.deepEqual(AGENTS["claude-code"].mcp, { file: ".mcp.json", format: "json", key: "mcpServers" });
  assert.deepEqual(AGENTS.cursor.mcp, { file: ".cursor/mcp.json", format: "json", key: "mcpServers" });
  assert.deepEqual(AGENTS.codex.mcp, { file: ".codex/config.toml", format: "toml", key: "mcp_servers" });
  assert.deepEqual(AGENTS["gemini-cli"].mcp, { file: ".gemini/settings.json", format: "json", key: "mcpServers" });
  assert.equal(AGENTS.generic.mcp, null);
});

test("environment variables identify the running agent first", () => {
  assert.deepEqual(detectAgents({ env: { CLAUDECODE: "1" }, cwd: tmp() }), ["claude-code"]);
  assert.deepEqual(detectAgents({ env: { AI_AGENT: "claude-code_2-1-284_agent" }, cwd: tmp() }), ["claude-code"]);
  assert.deepEqual(detectAgents({ env: { CURSOR_AGENT: "1" }, cwd: tmp() }), ["cursor"]);
  assert.deepEqual(detectAgents({ env: { CODEX_SANDBOX: "seatbelt" }, cwd: tmp() }), ["codex"]);
  assert.deepEqual(detectAgents({ env: { GEMINI_CLI: "1" }, cwd: tmp() }), ["gemini-cli"]);
});

test("project folders are used when no agent environment is present", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".cursor"));
  writeFileSync(join(dir, "AGENTS.md"), "# x");
  assert.deepEqual(detectAgents({ env: {}, cwd: dir }), ["cursor", "codex"]);
});

test("nothing detected falls back to the shared .agents/skills folder", () => {
  assert.deepEqual(detectAgents({ env: {}, cwd: tmp() }), ["generic"]);
});

test("skill targets are de-duplicated", () => {
  assert.deepEqual(skillTargets(["codex", "generic"]), [".agents/skills"]);
  assert.deepEqual(skillTargets(["claude-code", "cursor", "codex"]), [".claude/skills", ".cursor/skills", ".agents/skills"]);
});

test("parseAgentList validates --agent values", () => {
  assert.deepEqual(parseAgentList("claude-code,cursor"), ["claude-code", "cursor"]);
  assert.throws(() => parseAgentList("notepad"), /Unknown agent/);
});
