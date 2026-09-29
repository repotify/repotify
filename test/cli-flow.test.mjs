import { test } from "node:test";
import { main } from "../src/cli.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { COMMANDS } from "../src/cli.mjs";

const bin = fileURLToPath(new URL("../bin/repotify.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/projects/nextjs-saas", import.meta.url));
const skillSrc = fileURLToPath(new URL("../skill/repotify/SKILL.md", import.meta.url));

function project() {
  const dir = mkdtempSync(join(tmpdir(), "rp-flow-"));
  cpSync(fixture, dir, { recursive: true });
  return dir;
}
const run = (cwd, args, env = {}) =>
  spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env: { ...process.env, REPOTIFY_OFFLINE: "1", REPOTIFY_TELEMETRY: "0", REPOTIFY_HOME: join(cwd, ".home"), ...env } });

test("running with no command installs the repotify skill for the detected agent", () => {
  const cwd = project();
  const r = run(cwd, [], { CLAUDECODE: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Detected agent: claude-code/);
  assert.equal(readFileSync(join(cwd, ".claude/skills/repotify/SKILL.md"), "utf8"), readFileSync(skillSrc, "utf8"));
  assert.match(r.stdout, /Stacks: .*nextjs/);
  assert.match(r.stdout, /repotify recommend/);
  const lock = JSON.parse(readFileSync(join(cwd, "repotify.lock.json"), "utf8"));
  assert.equal(lock.items.repotify.type, "self");
  assert.equal(lock.items.repotify.launcher, `node "${bin}"`, "a clone records its own path as the launcher");
});

test("a second run leaves an up-to-date skill untouched", () => {
  const cwd = project();
  run(cwd, ["start"], { CLAUDECODE: "1" });
  const before = statSync(join(cwd, ".claude/skills/repotify/SKILL.md")).mtimeMs;
  const r = run(cwd, ["start"], { CLAUDECODE: "1" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /up to date/);
  assert.equal(statSync(join(cwd, ".claude/skills/repotify/SKILL.md")).mtimeMs, before);
});

test("a user's own folder named repotify is not overwritten", () => {
  const cwd = project();
  mkdirSync(join(cwd, ".claude/skills/repotify"), { recursive: true });
  writeFileSync(join(cwd, ".claude/skills/repotify/SKILL.md"), "mine");
  const r = run(cwd, [], { CLAUDECODE: "1" });
  assert.equal(r.status, 0);
  assert.equal(readFileSync(join(cwd, ".claude/skills/repotify/SKILL.md"), "utf8"), "mine");
  assert.match(r.stdout, /left untouched/);
});

test("--agent installs for several agents at once", () => {
  const cwd = project();
  const r = run(cwd, ["start", "--agent", "cursor,codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(cwd, ".cursor/skills/repotify/SKILL.md")));
  assert.ok(existsSync(join(cwd, ".agents/skills/repotify/SKILL.md")));
});

test("guard --self-test and guard --hook work from the CLI", () => {
  const cwd = project();
  assert.match(run(cwd, ["guard", "--self-test"]).stdout, /guard ok/);
  const r = spawnSync(process.execPath, [bin, "guard", "--hook"], { cwd, input: JSON.stringify({ tool_name: "Read" }), encoding: "utf8" });
  assert.equal(r.status, 0);
});

test("--help lists every command", () => {
  const r = run(project(), ["--help"]);
  for (const name of Object.keys(COMMANDS)) assert.match(r.stdout, new RegExp(`\\b${name}\\b`), name);
});

import { formatInstallSummary } from "../src/cli.mjs";

test("the install summary stays under 1,050 characters and never cuts a line", () => {
  const results = Array.from({ length: 30 }, (_, i) => ({ id: `some-long-skill-name-${i}`, ok: true, type: "skill", written: true, entry: { targets: [`.claude/skills/some-long-skill-name-${i}`], level: "verified" } }));
  results.push({ id: "omniroute", ok: true, type: "tool", steps: ["npm install -g omniroute@3.8.50", "omniroute"], verify: "curl -s http://localhost:20128/v1/models", level: "caution" });
  results.push({ id: "bad-one", ok: false, error: "Hash mismatch for SKILL.md" });
  const text = formatInstallSummary({ agents: ["claude-code"], results, notice: "Catalog unavailable (HTTP 404); using the bundled catalog (x)." });
  assert.ok(text.length <= 1050, `${text.length}`);
  const lines = text.split("\n");
  assert.match(lines.at(-1), /^… \d+ more \(use --json\)$/);
  assert.match(text, /Skills folder: \.claude\/skills/);
  for (const l of lines.slice(0, -1)) assert.ok(/^(Catalog|Agents|Skills folder|✓|•|✗|⚠)/.test(l), l);
  const small = formatInstallSummary({ agents: ["claude-code"], results: results.slice(-2) });
  assert.match(small, /✗ bad-one: Hash mismatch/);
  assert.match(small, /• omniroute \(tool, run it yourself ⚠ caution\): 1\) npm install -g omniroute@3\.8\.50 2\) omniroute \| verify: /);
  const mcp = formatInstallSummary({ agents: ["claude-code"], results: [{ id: "github-mcp", ok: true, type: "mcp", written: true, steps: ["Export GITHUB_PERSONAL_ACCESS_TOKEN in your shell"], results: [{ written: true, file: ".mcp.json" }] }] });
  assert.match(mcp, /✓ github-mcp → \.mcp\.json \(next: Export GITHUB_PERSONAL_ACCESS_TOKEN in your shell\)/);
});

test("I1: an unwritable home folder never breaks the main flow", () => {
  const cwd = project();
  const blocker = join(cwd, "not-a-dir");
  writeFileSync(blocker, "x");
  const env = { CLAUDECODE: "1", REPOTIFY_HOME: join(blocker, "home"), REPOTIFY_TELEMETRY: "" };
  const rec = run(cwd, ["recommend"], env);
  assert.equal(rec.status, 0, rec.stderr);
  assert.match(rec.stdout, /Repotify candidates/);
  const start = run(cwd, [], env);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /Stacks:/);
  const lock = JSON.parse(readFileSync(join(cwd, "repotify.lock.json"), "utf8"));
  lock.items.graphify = { type: "tool", targets: [] };
  writeFileSync(join(cwd, "repotify.lock.json"), JSON.stringify(lock));
  assert.equal(run(cwd, ["vote", "graphify", "up"], env).status, 0);
});

test("unexpected errors print one line, not a stack trace", async () => {
  const io = { cwd: project(), env: {}, stdout: { write() {} }, stderr: { text: "", write(t) { this.text += t; } } };
  const code = await main(["scan", "."], io, async () => { throw new Error("disk vanished"); });
  assert.equal(code, 1);
  assert.equal(io.stderr.text, "repotify: disk vanished\n");
  const debug = { ...io, env: { REPOTIFY_DEBUG: "1" }, stderr: { text: "", write(t) { this.text += t; } } };
  await main([], debug, async () => { throw new Error("boom"); });
  assert.match(debug.stderr.text, /\n\s+at /, "the stack only with REPOTIFY_DEBUG");
  assert.equal(readFileSync(bin, "utf8").includes("main("), true, "bin/ goes through main()");
});

test("M1: in the home folder repotify does not install itself or write a lock", () => {
  const home = mkdtempSync(join(tmpdir(), "rp-homedir-"));
  const r = run(home, [], { CLAUDECODE: "1", HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /home folder or filesystem root/);
  assert.equal(existsSync(join(home, ".claude/skills/repotify")), false);
  assert.equal(existsSync(join(home, "repotify.lock.json")), false);
});
