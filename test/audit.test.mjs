import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { auditSkills, formatAudit, findInstalledSkills } from "../src/audit.mjs";
import { fingerprint } from "../src/fingerprint.mjs";
import { resolveNeeds } from "../src/needs.mjs";

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

const read = (f) => JSON.parse(readFileSync(new URL(`../catalog/${f}`, import.meta.url), "utf8"));
const catalog = { items: read("items.json"), taxonomy: read("taxonomy.json"), loadouts: read("loadouts.json"), core: read("core.json"), meta: read("meta.json") };
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const bin = fileURLToPath(new URL("../bin/repotify.mjs", import.meta.url));

function skill(root, dir, id, description) {
  mkdirSync(join(root, dir, id), { recursive: true });
  writeFileSync(join(root, dir, id, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\n\nSteps.\n`);
}

// A Next.js app that makes PDFs, with a mix of useful, useless, duplicated and unsafe skills installed.
function project() {
  const root = mkTemp("repotify-audit-");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0", pdfkit: "0.15.0" } }));
  skill(root, ".claude/skills", "test-driven-development", "Use when implementing any feature: write the failing test first.");
  skill(root, ".claude/skills", "pptx", "Create and edit PowerPoint slide decks.");
  skill(root, ".claude/skills", "react-native-skills", "React Native and Expo best practices.");
  skill(root, ".claude/skills", "flutter-widgets", "Flutter widget patterns for mobile apps. Covers layout and state.");
  skill(root, ".claude/skills", "pdf-export", "Generate PDF invoices from order data.");
  skill(root, ".claude/skills", "release-notes-a", "Drafts release notes from merged pull requests grouped by label with contributor credits");
  skill(root, ".claude/skills", "release-notes-b", "Drafts release notes from merged pull requests grouped by label with contributor credits and emoji");
  cpSync(join(fixtures, "malicious/aws-creds-md"), join(root, ".claude/skills/cloud-helper"), { recursive: true });
  skill(root, ".agents/skills", "pptx", "Create and edit PowerPoint slide decks.");
  return root;
}

async function audit(root, extra = {}) {
  const fp = await fingerprint(root);
  return auditSkills({ root, catalog, fingerprint: fp, needs: resolveNeeds({ fingerprint: fp, taxonomy: catalog.taxonomy }), ...extra });
}
const verdicts = (report, skillsDir = ".claude/skills") => Object.fromEntries(report.skills.filter((s) => s.skillsDir === skillsDir).map((s) => [s.id, s.verdict]));
const codes = (report, id) => report.skills.find((s) => s.dir === `.claude/skills/${id}`).reasons.map((r) => r.code);

test("findInstalledSkills lists skill folders with a SKILL.md under every agent's skills directory", () => {
  const root = project();
  mkdirSync(join(root, ".claude/skills/empty-folder"), { recursive: true });
  const dirs = findInstalledSkills(root).map((s) => s.dir);
  assert.ok(dirs.includes(".claude/skills/pptx") && dirs.includes(".agents/skills/pptx"));
  assert.ok(!dirs.includes(".claude/skills/empty-folder"));
});

test("audit: keeps what serves the project, questions the rest with a reason, and flags unsafe skills for removal", async () => {
  const r = await audit(project());
  assert.deepEqual(verdicts(r), {
    "cloud-helper": "remove",
    "flutter-widgets": "consider",
    "pdf-export": "keep",
    pptx: "consider",
    "react-native-skills": "consider",
    "release-notes-a": "keep",
    "release-notes-b": "consider",
    "test-driven-development": "keep",
  });
  assert.deepEqual(codes(r, "cloud-helper"), ["security"]);
  assert.deepEqual(codes(r, "pptx"), ["unneeded"], "a catalog skill for a job this project does not have");
  assert.deepEqual(codes(r, "react-native-skills"), ["stack"]);
  assert.deepEqual(codes(r, "flutter-widgets"), ["stack"], "an unknown skill named for a stack this project does not use");
  assert.deepEqual(codes(r, "release-notes-b"), ["overlap"], "the heavier of two near-identical skills");
  assert.deepEqual(codes(r, "test-driven-development"), ["core"]);
  assert.match(r.skills.find((s) => s.id === "pdf-export").reasons[0].text, /PDF/);
});

test("audit: the same skill for two different agents is not an overlap", async () => {
  const r = await audit(project());
  assert.equal(verdicts(r, ".agents/skills").pptx, "consider");
  assert.ok(!r.skills.find((s) => s.dir === ".agents/skills/pptx").reasons.some((x) => x.code === "overlap"));
});

test("audit: web-only skills are questioned in a mobile app, kept in a web app", async () => {
  const root = mkTemp("repotify-audit-");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { expo: "51.0.0", "react-native": "0.74.0" } }));
  skill(root, ".claude/skills", "webapp-testing", "Test web apps with Playwright.");
  const r = await audit(root);
  assert.equal(r.skills[0].verdict, "consider");
  assert.equal(r.skills[0].reasons[0].code, "platform");
  const web = project();
  skill(web, ".claude/skills", "webapp-testing", "Test web apps with Playwright.");
  assert.notEqual((await audit(web)).skills.find((s) => s.id === "webapp-testing").reasons[0].code, "platform");
});

test("audit: Repotify-installed items get a remove command, others a folder; the text never claims a deletion", async () => {
  const root = project();
  writeFileSync(join(root, "repotify.lock.json"), JSON.stringify({ version: 1, items: { pptx: { type: "skill", targets: [".claude/skills/pptx"] } } }));
  const r = await audit(root, { lock: JSON.parse(readFileSync(join(root, "repotify.lock.json"), "utf8")) });
  assert.equal(r.skills.find((s) => s.dir === ".claude/skills/pptx").removeWith, "repotify remove pptx");
  const text = formatAudit(r);
  assert.match(text, /REMOVE\s+cloud-helper/);
  assert.match(text, /Nothing was deleted\. Ask the user before removing anything\./);
  assert.match(text, /Installed by Repotify: repotify remove pptx/);
  assert.match(text, /\.claude\/skills\/flutter-widgets/);
  assert.ok(existsSync(join(root, ".claude/skills/cloud-helper/SKILL.md")), "audit is read-only");
});

test("repotify audit --json runs end to end, and start points to it when skills are already installed", () => {
  const root = project();
  const env = { ...process.env, REPOTIFY_OFFLINE: "1", REPOTIFY_TELEMETRY: "0", REPOTIFY_HOME: join(root, ".home"), CLAUDECODE: "1" };
  const r = spawnSync(process.execPath, [bin, "audit", "--json"], { cwd: root, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.skills.find((s) => s.id === "cloud-helper").verdict, "remove");
  const s = spawnSync(process.execPath, [bin], { cwd: root, encoding: "utf8", env });
  assert.match(s.stdout, /already has \d+ skills; `repotify audit`/);
});

test("audit with no skills says so", async () => {
  const root = mkTemp("repotify-audit-");
  assert.match(formatAudit(await audit(root)), /no installed skills found/);
});

test("audit in the home folder judges security and overlaps only, and says so", async () => {
  const root = project();
  const fp = await fingerprint(root, { homeDir: root });
  const r = await auditSkills({ root, catalog, fingerprint: fp, needs: resolveNeeds({ fingerprint: fp, taxonomy: catalog.taxonomy }) });
  assert.equal(r.relevance, false);
  assert.equal(verdicts(r).pptx, "keep", "no project, so no claim that it is unneeded");
  assert.equal(verdicts(r)["cloud-helper"], "remove");
  assert.equal(verdicts(r)["release-notes-b"], "consider");
  assert.match(formatAudit(r), /^Not a project folder/);
});

test("names a cloned repository controls are shown safely, and only real catalog ids become commands", { skip: process.platform === "win32" }, async () => {
  const root = mkTemp("repotify-audit-");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" } }));
  skill(root, ".claude/skills", "odd;name", "Flutter widget patterns for mobile apps.");
  skill(root, ".claude/skills", "esc\u001bname", "Flutter widget patterns for mobile apps.");
  skill(root, ".claude/skills", "pptx", "Create and edit PowerPoint slide decks.");
  const lock = { version: 1, items: { "pptx;x": { type: "skill", targets: [".claude/skills/pptx"] } } };
  const text = formatAudit(await audit(root, { lock }));
  assert.ok(!/\u001b/.test(text), "no raw escape character reaches the terminal");
  assert.match(text, /'esc\\u\{1B\}name'/);
  assert.match(text, /'\.claude\/skills\/odd;name'/, "a suggested folder is quoted for the shell");
  assert.doesNotMatch(text, /repotify remove pptx;x/, "a lock key that is not a catalog id never becomes a command");
});

test("a SKILL.md over 1 MiB is not parsed and is questioned", async () => {
  const root = mkTemp("repotify-audit-");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
  mkdirSync(join(root, ".claude/skills/huge"), { recursive: true });
  writeFileSync(join(root, ".claude/skills/huge/SKILL.md"), "---\nname: huge\ndescription: x\n---\n" + "a".repeat(1024 * 1024 + 10));
  const r = await audit(root);
  const huge = r.skills.find((s) => s.id === "huge");
  assert.equal(huge.verdict, "consider");
  assert.equal(huge.reasons[0].code, "oversized");
});
