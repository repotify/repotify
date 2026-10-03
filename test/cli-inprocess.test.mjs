import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, main } from "../src/cli.mjs";

// The newer commands run in this process, so their branches are measured (a spawned CLI is not).
const root = fileURLToPath(new URL("..", import.meta.url));
const projects = join(root, "test", "fixtures", "projects");
const tempDirs = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "rp-inproc-"));
  tempDirs.push(d);
  return d;
};
const home = tempDir();
function io(cwd, env = {}) {
  const out = [];
  const err = [];
  return { cwd, env: { REPOTIFY_OFFLINE: "1", REPOTIFY_TELEMETRY: "0", REPOTIFY_NO_EXPLORE: "1", REPOTIFY_HOME: home, ...env }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, stdin: { isTTY: false }, out: () => out.join(""), err: () => err.join("") };
}
const copyOf = (name) => {
  const d = tempDir();
  cpSync(join(projects, name), d, { recursive: true });
  return d;
};

test("questions: text and JSON, closed by an answer, shaped by the asking agent", async () => {
  const text = io(join(projects, "empty"));
  assert.equal(await runCli(["questions"], text), 0);
  assert.match(text.out(), /^1\. What are you building\? \(pick one\)\n {3}- web-app: Web app or SaaS \(changes \d+ picks\)/);
  const json = io(join(projects, "empty"));
  await runCli(["questions", "--json", "--type", "web-app", "--needs", "security"], json);
  const qs = JSON.parse(json.out());
  assert.ok(!qs.some((q) => q.id === "projectType" || q.id === "needs"), "answered questions are closed");
  const cursor = io(join(projects, "nextjs-saas"));
  assert.equal(await runCli(["questions", "--json", "--agent", "cursor", "--blocked", "context7"], cursor), 0);
  assert.ok(Array.isArray(JSON.parse(cursor.out())));
  const unknown = io(join(projects, "nextjs-saas"));
  assert.equal(await runCli(["questions", "--json", "--agent", "not-an-agent"], unknown), 0, "an unknown agent name holds nothing back");
  const settled = io(join(projects, "empty"));
  await runCli(["questions", "--answers", JSON.stringify({ projectType: "cli", needs: [], priorities: [], platforms: [], stacks: [] })], settled);
  assert.match(settled.out(), /^No answer would change the picks for this project \(\d+ picked from \d+ candidates\)\. Run `repotify recommend`\./);
});

test("recommend: answers about stacks and platforms count, and a hook for another agent is held back", async () => {
  const claude = io(join(projects, "go-cli"), { CLAUDECODE: "1" });
  await runCli(["recommend", "--json"], claude);
  assert.ok(JSON.parse(claude.out()).defaultSet.includes("repotify-router"));
  const cursor = io(join(projects, "go-cli"));
  await runCli(["recommend", "--json", "--agent", "cursor"], cursor);
  const set = JSON.parse(cursor.out()).defaultSet;
  assert.ok(!set.includes("repotify-router") && !set.includes("repotify-tracker") && set.includes("writing-plans"));
  const answered = io(join(projects, "empty"));
  await runCli(["recommend", "--json", "--type", "web-app", "--stacks", "supabase,not-a-stack", "--platforms", "web,tv"], answered);
  const rec = JSON.parse(answered.out());
  assert.equal(rec.projectType, "web-app");
  assert.ok(rec.defaultSet.length > 8);
});

test("track: remembers, reports once, lists updates weekly, and never fails a session as a hook", async () => {
  const cwd = copyOf("go-cli");
  const own = tempDir();
  const env = { REPOTIFY_HOME: own };
  const first = io(cwd, env);
  assert.equal(await runCli(["track"], first), 0);
  assert.match(first.out(), /^Nothing new since the last look\./);
  mkdirSync(join(cwd, "web"));
  writeFileSync(join(cwd, "web", "package.json"), JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }));
  const grown = io(cwd, env);
  await runCli(["track", "--json"], grown);
  const lines = JSON.parse(grown.out()).lines;
  assert.equal(lines.length, 1);
  assert.match(lines[0], /new: .*nextjs/);
  const quiet = io(cwd, env);
  assert.equal(await runCli(["track", "--hook"], quiet), 0);
  assert.equal(quiet.out(), "");
  // A week later an installed item has a vetted update: the tracker says so at session start.
  const stale = copyOf("go-cli");
  const staleHome = tempDir();
  writeFileSync(join(stale, "repotify.lock.json"), JSON.stringify({ version: 1, catalogVersion: "2026.01.01.1", items: { "test-driven-development": { type: "skill", repo: "obra/superpowers", path: "skills/test-driven-development", commit: "0".repeat(40), files: [], targets: [".claude/skills/test-driven-development"], agents: ["claude-code"], installedAt: "2026-09-01T00:00:00Z" } } }));
  const weekly = io(stale, { REPOTIFY_HOME: staleHome });
  await runCli(["track", "--hook"], weekly);
  assert.match(weekly.out(), /1 update available[\s\S]*repotify update --apply test-driven-development/);
  const sameWeek = io(stale, { REPOTIFY_HOME: staleHome });
  await runCli(["track", "--hook"], sameWeek);
  assert.equal(sameWeek.out(), "", "the update check runs once a week");
  // A folder that is not there is an empty project: nothing to say.
  const gone = io(join(tempDir(), "missing"), env);
  assert.equal(await runCli(["track", "--hook"], gone), 0);
  assert.equal(gone.out(), "");
  // Whatever goes wrong inside, a hook ends quietly; run by hand, the failure is said.
  const asHook = { ...io(cwd, env), cwd: 42 };
  assert.equal(await runCli(["track", "--hook"], asHook), 0);
  assert.equal(asHook.out(), "");
  const byHand = { ...io(cwd, env), cwd: 42 };
  assert.equal(await main(["track"], byHand), 1);
  assert.match(byHand.err(), /^repotify: /);
});
