import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFiles, scanDir } from "../src/scan/index.mjs";
import { checkTyposquat, levenshtein } from "../src/scan/typosquat.mjs";
import { networkDomains } from "../src/scan/files.mjs";

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const rules = (r) => r.findings.map((f) => f.rule);

test("executables and binaries in unknown formats are quarantined", () => {
  assert.equal(scanFiles([{ path: "tool.bin", content: ELF }]).level, "quarantined");
  assert.equal(scanFiles([{ path: "helper", content: ELF }]).level, "quarantined");
  assert.equal(scanFiles([{ path: "data.dat", content: Buffer.from([1, 2, 0, 4]) }]).level, "quarantined");
  assert.ok(rules(scanFiles([{ path: "x.pyc", content: Buffer.from("abc") }])).includes("binary-file"));
});

test("image and font assets with matching magic bytes are allowed", () => {
  assert.equal(scanFiles([{ path: "logo.png", content: PNG }]).level, "verified");
  assert.equal(scanFiles([{ path: "font.ttf", content: Buffer.from([0, 1, 0, 0, 0, 12]) }]).level, "verified");
});

test("an asset whose magic bytes do not match its extension is quarantined", () => {
  assert.equal(scanFiles([{ path: "logo.png", content: ELF }]).level, "quarantined");
});

test("symlinks pointing outside the skill folder are quarantined; inside ones are fine", () => {
  assert.equal(scanFiles([{ path: "a", content: "", isSymlink: true, linkTarget: "../../etc/passwd" }]).level, "quarantined");
  assert.equal(scanFiles([{ path: "a", content: "", isSymlink: true, linkTarget: "/etc/passwd" }]).level, "quarantined");
  assert.equal(scanFiles([{ path: "docs/a", content: "", isSymlink: true, linkTarget: "../README.md" }]).level, "verified");
});

test("link targets written with Windows separators are checked the same way", () => {
  // Node on Windows stores and reads link targets with backslashes.
  const level = (linkTarget) => scanFiles([{ path: "a", content: "", isSymlink: true, linkTarget }]).level;
  assert.equal(level("..\\..\\..\\etc\\passwd"), "quarantined");
  assert.equal(level("\\\\?\\C:\\Users\\me\\.ssh\\id_rsa"), "quarantined");
  assert.equal(level("\\Windows\\win.ini"), "quarantined");
  assert.equal(level("docs\\guide.md"), "verified");
});

test("scanDir reports real symlinks without following them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-scan-"));
  writeFileSync(join(dir, "SKILL.md"), "# ok\n");
  symlinkSync("/etc/passwd", join(dir, "leak"));
  const r = await scanDir(dir);
  assert.equal(r.level, "quarantined");
  assert.ok(rules(r).includes("symlink"));
});

test("oversized files and oversized trees are quarantined", () => {
  const big = { path: "big.txt", content: "", size: 6 * 1024 * 1024 };
  assert.ok(rules(scanFiles([big])).includes("oversized"));
  assert.equal(scanFiles([big]).level, "quarantined");
  const many = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, content: "", size: 4.5 * 1024 * 1024 }));
  assert.equal(scanFiles(many).level, "quarantined");
});

test("agent config files that auto-run commands are quarantined", () => {
  const hooks = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node x.js" }] }] } });
  assert.equal(scanFiles([{ path: ".claude/settings.json", content: hooks }]).level, "quarantined");
  assert.equal(scanFiles([{ path: "hooks/hooks.json", content: "{}" }]).level, "quarantined");
  assert.equal(scanFiles([{ path: ".mcp.json", content: "{}" }]).level, "quarantined");
  assert.equal(scanFiles([{ path: "conf.json", content: hooks }]).level, "quarantined");
  assert.equal(scanFiles([{ path: "x.json", content: '{"enableAllProjectMcpServers": true}' }]).level, "quarantined");
  assert.equal(scanFiles([{ path: ".vscode/tasks.json", content: '{"tasks":[{"runOptions":{"runOn":"folderOpen"}}]}' }]).level, "quarantined");
  assert.equal(scanFiles([{ path: "data.json", content: '{"name":"x"}' }]).level, "verified");
});

test("package install scripts are caution", () => {
  const pkg = JSON.stringify({ name: "x", scripts: { postinstall: "node setup.js", test: "node --test" } });
  const r = scanFiles([{ path: "package.json", content: pkg }]);
  assert.equal(r.level, "caution");
  assert.ok(rules(r).includes("install-script"));
  assert.equal(scanFiles([{ path: "package.json", content: JSON.stringify({ scripts: { test: "x" } }) }]).level, "verified");
  assert.equal(scanFiles([{ path: "setup.py", content: "setup(cmdclass={'install': Custom})\n" }]).level, "caution");
});

test("network calls in scripts list their domains; allowlisted domains stay verified", () => {
  const r = scanFiles([{ path: "a.js", content: 'await fetch("https://api.example.com/v1/x")\n' }]);
  assert.equal(r.level, "caution");
  assert.match(r.findings.find((f) => f.rule === "network-call").note, /api\.example\.com/);
  assert.equal(scanFiles([{ path: "a.js", content: 'fetch("https://registry.npmjs.org/x")\n' }]).level, "verified");
  assert.equal(scanFiles([{ path: "SKILL.md", content: "See https://docs.example.com for more.\n" }]).level, "verified");
  assert.deepEqual(networkDomains([{ path: "a.py", content: "requests.get('https://api.example.com/x')\nurllib.request.urlopen('https://b.example.org')\n" }]), ["api.example.com", "b.example.org"]);
});

test("levenshtein distance", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("abc", "abc"), 0);
});

test("typosquats of popular items from young repos are caution", () => {
  const now = new Date("2026-09-28T00:00:00Z");
  const known = [{ id: "brainstorming", name: "brainstorming", repo: "obra/superpowers", stars: 50000 }];
  const young = new Date(now - 10 * 86400000).toISOString();
  const old = new Date(now - 200 * 86400000).toISOString();
  const f = checkTyposquat({ id: "brainstorrming", name: "brainstorrming", repo: "evil/x", createdAt: young }, known, now);
  assert.equal(f.severity, "medium");
  assert.equal(f.rule, "typosquat");
  assert.equal(checkTyposquat({ id: "brainstorming", repo: "obra/superpowers", createdAt: young }, known, now), null);
  assert.equal(checkTyposquat({ id: "brainstorrming", repo: "evil/x", createdAt: old }, known, now), null);
  assert.equal(checkTyposquat({ id: "completely-different", repo: "evil/x", createdAt: young }, known, now), null);
  assert.equal(checkTyposquat({ id: "brainstorrming", repo: "evil/x", createdAt: young }, [{ ...known[0], stars: 10 }], now), null);
});

test("archives cannot be scanned and are quarantined for review", () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  const r = scanFiles([{ path: "Archive.zip", content: zip }]);
  assert.equal(r.level, "quarantined");
  assert.match(r.findings[0].note, /archive/);
});
