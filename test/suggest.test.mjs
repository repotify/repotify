import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseGitHubRepo, originOf, skillFolders, buildSuggestion, formatSuggestion, submissionUrl, KINDS } from "../src/suggest.mjs";

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

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const bin = fileURLToPath(new URL("../bin/repotify.mjs", import.meta.url));

function repo({ remote = "git@github.com:octo/pdf-skill.git", skills = [""], license = "MIT License\n\nCopyright (c) 2026" } = {}) {
  const dir = mkTemp("repotify-suggest-");
  mkdirSync(join(dir, ".git"));
  if (remote) writeFileSync(join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  for (const rel of skills) {
    mkdirSync(join(dir, rel), { recursive: true });
    writeFileSync(join(dir, rel, "SKILL.md"), `---\nname: ${rel || "pdf-skill"}\ndescription: Fills and merges PDF forms for invoice workflows.\n---\n\nSteps.\n`);
  }
  if (license) writeFileSync(join(dir, "LICENSE"), license);
  return dir;
}

test("GitHub repositories are read from URLs, SSH remotes and owner/repo", () => {
  assert.deepEqual(parseGitHubRepo("https://github.com/octo/tools/tree/main/skills/pdf"), { owner: "octo", repo: "tools", ref: "main", path: "skills/pdf", url: "https://github.com/octo/tools/tree/main/skills/pdf" });
  assert.equal(parseGitHubRepo("git@github.com:octo/tools.git").url, "https://github.com/octo/tools");
  assert.equal(parseGitHubRepo("https://github.com/octo/tools.git").repo, "tools");
  assert.equal(parseGitHubRepo("octo/tools").url, "https://github.com/octo/tools");
  assert.equal(parseGitHubRepo("https://gitlab.com/octo/tools"), null);
  assert.equal(parseGitHubRepo("not a repo"), null);
});

test("the origin remote and the skill folders come from the local clone", () => {
  const dir = repo({ skills: ["skills/a", "skills/b", ".claude/skills/dev-only"] });
  assert.equal(originOf(dir).url, "https://github.com/octo/pdf-skill");
  assert.deepEqual(skillFolders(dir), ["skills/a", "skills/b"], "an agent's own installed skills are not the product");
});

test("a clean local skill becomes a pre-filled form link; nothing is sent", async () => {
  const s = await buildSuggestion({ cwd: repo() });
  assert.equal(s.ok, true);
  assert.equal(s.kind, "skill");
  assert.equal(s.license, "MIT");
  assert.equal(s.scan.level, "verified");
  const url = new URL(s.url);
  assert.equal(url.origin + url.pathname, "https://github.com/repotify/repotify/issues/new");
  assert.equal(url.searchParams.get("template"), "catalog_submission.yml");
  assert.equal(url.searchParams.get("repository"), "https://github.com/octo/pdf-skill");
  assert.equal(url.searchParams.get("kind"), KINDS.skill, "the dropdown value matches the form option exactly");
  assert.match(url.searchParams.get("why"), /PDF forms[\s\S]*Submitted by its author\./);
  assert.match(formatSuggestion(s), /Nothing was sent\./);
});

test("several skills make a plugin; flags override what was detected", async () => {
  const s = await buildSuggestion({ cwd: repo({ skills: ["skills/a", "skills/b"] }), why: "Two PDF helpers.", own: false });
  assert.equal(s.kind, "plugin");
  assert.equal(new URL(s.url).searchParams.get("why"), "Two PDF helpers.");
  assert.equal((await buildSuggestion({ cwd: repo(), kind: "mcp" })).kind, "mcp");
  assert.equal((await buildSuggestion({ cwd: repo(), kind: "nope" })).code, "bad-kind");
});

test("a skill the gate would reject gets no link, only what to fix", async () => {
  const dir = repo({ skills: [] });
  cpSync(join(fixtures, "malicious/aws-creds-md"), join(dir, "skills/cloud"), { recursive: true });
  const s = await buildSuggestion({ cwd: dir });
  assert.equal(s.ok, false);
  assert.equal(s.code, "blocked");
  assert.ok(!("url" in s));
  assert.match(formatSuggestion(s), /Fix these first[\s\S]*credential-access/);
});

test("no GitHub remote asks for one; a URL works without a clone", async () => {
  assert.equal((await buildSuggestion({ cwd: repo({ remote: null }) })).code, "no-github");
  const remote = await buildSuggestion({ cwd: tmpdir(), target: "https://github.com/octo/tools" });
  assert.equal(remote.ok, true);
  assert.equal(remote.scan, null);
  assert.match(formatSuggestion(remote), /Not scanned locally/);
  assert.equal((await buildSuggestion({ cwd: tmpdir(), target: "./definitely-missing-folder" })).code, "not-found");
});

test("a missing license is called out before submitting", async () => {
  const s = await buildSuggestion({ cwd: repo({ license: null }) });
  assert.equal(s.license, "");
  assert.match(formatSuggestion(s), /Add a LICENSE file first/);
});

test("repotify suggest runs end to end", () => {
  const dir = repo();
  const r = spawnSync(process.execPath, [bin, "suggest", "--json"], { cwd: dir, encoding: "utf8", env: { ...process.env, REPOTIFY_OFFLINE: "1", REPOTIFY_TELEMETRY: "0", REPOTIFY_HOME: join(dir, ".home") } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).repo.url, "https://github.com/octo/pdf-skill");
  assert.equal(submissionUrl({ repo: { owner: "a", repo: "b", url: "https://github.com/a/b" }, kind: "tool", why: "x & y", license: "" }).includes("why=x%20%26%20y"), true);
});

test("a license field that is not a license name is not echoed", async () => {
  const dir = repo({ license: null, skills: [""] });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ license: "MIT\u001b[2J" }));
  const s = await buildSuggestion({ cwd: dir });
  assert.equal(s.license, "");
  assert.ok(!/\u001b/.test(formatSuggestion(s)));
});

test("finding paths in a blocked suggestion are shown safely", async () => {
  const dir = repo({ skills: [] });
  cpSync(join(fixtures, "malicious/aws-creds-md"), join(dir, "skills/my tool"), { recursive: true });
  const text = formatSuggestion(await buildSuggestion({ cwd: dir }));
  assert.match(text, /'skills\/my tool\/SKILL\.md'/);
});
