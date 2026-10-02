import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { enableAutoCheck } from "../src/update.mjs";

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

const bin = fileURLToPath(new URL("../bin/repotify.mjs", import.meta.url));
function project(lockItems) {
  const cwd = mkTemp("rp-cliupd-");
  writeFileSync(join(cwd, "repotify.lock.json"), JSON.stringify({ version: 1, catalogVersion: "2026.01.01.1", items: lockItems }));
  return cwd;
}
const run = (cwd, args) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env: { ...process.env, REPOTIFY_OFFLINE: "1", REPOTIFY_TELEMETRY: "0", REPOTIFY_HOME: join(cwd, ".home") } });
const old = { type: "skill", repo: "obra/superpowers", path: "skills/test-driven-development", commit: "0".repeat(40), files: [], targets: [".claude/skills/test-driven-development"], agents: ["claude-code"], installedAt: "2026-09-01T00:00:00Z" };

test("update --check lists vetted updates and items that left the catalog", () => {
  const cwd = project({ "test-driven-development": old, "ghost-item": { ...old, repo: "x/y" } });
  const r = run(cwd, ["update", "--check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 update available/);
  assert.match(r.stdout, /test-driven-development 0000000 → [0-9a-f]{7}/);
  assert.match(r.stdout, /ghost-item is no longer in the catalog/);
  assert.match(r.stdout, /repotify update --apply test-driven-development/);
});

test("--quiet prints nothing when everything is current, and --weekly runs once a week", () => {
  const cwd = project({});
  assert.equal(run(cwd, ["update", "--check", "--quiet"]).stdout, "");
  const withUpdate = project({ "test-driven-development": old });
  assert.match(run(withUpdate, ["update", "--check", "--quiet", "--weekly"]).stdout, /update available/);
  assert.equal(run(withUpdate, ["update", "--check", "--quiet", "--weekly"]).stdout, "", "second weekly check within 7 days is silent");
});

test("update --enable-auto-check needs the user: without a terminal or --yes it changes nothing", () => {
  const cwd = project({ repotify: { type: "self", version: "0.1.0", targets: [], launcher: 'node "/opt/repotify/bin/repotify.mjs"' } });
  const r = run(cwd, ["update", "--enable-auto-check"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /changes how your coding agent runs/);
  assert.equal(existsSync(join(cwd, ".claude/settings.json")), false);
});

test("update --enable-auto-check --yes writes the SessionStart hook with the recorded launcher", () => {
  const cwd = project({ repotify: { type: "self", version: "0.1.0", targets: [], launcher: 'node "/opt/repotify/bin/repotify.mjs"' } });
  assert.equal(run(cwd, ["update", "--enable-auto-check", "--yes"]).status, 0);
  const s = JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf8"));
  assert.equal(s.hooks.SessionStart.length, 1);
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, 'node "/opt/repotify/bin/repotify.mjs" update --check --quiet --weekly');
});

test("update --apply reports failures for ids it cannot update", () => {
  const cwd = project({});
  const r = run(cwd, ["update", "--apply", "not-installed"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /not installed by Repotify/);
});

test("enableAutoCheck works in a project without a .claude folder", () => {
  const cwd = mkTemp("rp-cliupd-");
  assert.equal(enableAutoCheck({ cwd }).written, true);
  assert.ok(existsSync(join(cwd, ".claude/settings.json")));
});

test("update --apply of a hook or MCP server needs the user, like enable", () => {
  const mcp = { type: "mcp", repo: "upstash/context7", targets: [".mcp.json#mcpServers.context7"], agents: ["claude-code"], installedAt: "2026-09-01T00:00:00Z", setup: { steps: ["x"], mcp: { command: "npx", args: ["-y", "@upstash/context7-mcp@0.0.1"] } } };
  const cwd = project({ context7: mcp });
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp@0.0.1"] } } }));
  const before = readFileSync(join(cwd, ".mcp.json"), "utf8");
  const refused = run(cwd, ["update", "--apply", "context7"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /changes how your coding agent runs/);
  assert.equal(readFileSync(join(cwd, ".mcp.json"), "utf8"), before, "nothing rewritten");
  const skills = run(project({ "test-driven-development": old }), ["update", "--apply", "test-driven-development"]);
  assert.doesNotMatch(skills.stderr, /changes how your coding agent runs/, "skill updates are not gated");
  assert.notEqual(run(cwd, ["update", "--apply", "context7", "--yes"]).status, 2, "--yes typed by the user passes the gate");
});
