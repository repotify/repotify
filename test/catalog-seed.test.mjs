import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, snapshotSkill } from "../pipeline/collect.mjs";
import { validateCatalog } from "../src/catalog.mjs";
import { SCANNER_VERSION, levelFromFindings } from "../src/scan/index.mjs";
import { sha256 } from "../src/util.mjs";
import { GATE_VERSION } from "../pipeline/gate.mjs";

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

test("parseFrontmatter reads plain, quoted, folded and multi-line values", () => {
  assert.deepEqual(parseFrontmatter("---\nname: pdf\ndescription: Reads PDFs.\n---\n# x"), { name: "pdf", description: "Reads PDFs." });
  assert.equal(parseFrontmatter('---\nname: b\ndescription: "You MUST use this: before work."\n---\n').description, "You MUST use this: before work.");
  assert.equal(parseFrontmatter("---\nname: s\ndescription: >-\n  Runs a scan:\n  detects languages.\nlicense: MIT\n---\n").description, "Runs a scan: detects languages.");
  assert.equal(parseFrontmatter("---\nname: s\ndescription: |\n  line one\n  line two\n---\n").description, "line one\nline two");
  const multi = parseFrontmatter("---\nname: c\ndescription:\n  React composition patterns that scale. Use\n  when refactoring.\nmetadata:\n  author: vercel\n---\n");
  assert.equal(multi.description, "React composition patterns that scale. Use when refactoring.");
  assert.equal(multi.metadata, undefined);
  assert.equal(parseFrontmatter("---\nname: q\ndescription: 'it''s fine'\n---\n").description, "it's fine");
  assert.deepEqual(parseFrontmatter("# no frontmatter"), {});
  assert.equal(parseFrontmatter("\u{FEFF}---\r\nname: crlf\r\ndescription: Windows.\r\n---\r\n").description, "Windows.");
});

test("snapshotSkill hashes files in sorted order and skips .git", async () => {
  const dir = mkTemp("rp-snap-");
  mkdirSync(join(dir, "skills", "demo", "scripts"), { recursive: true });
  mkdirSync(join(dir, "skills", "demo", ".git"), { recursive: true });
  writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill.\n---\nBody\n");
  writeFileSync(join(dir, "skills", "demo", "scripts", "run.py"), "print(1)\n");
  writeFileSync(join(dir, "skills", "demo", ".git", "HEAD"), "x");
  const snap = await snapshotSkill(dir, "skills/demo");
  assert.deepEqual(snap.files.map((f) => f.path), ["SKILL.md", "scripts/run.py"]);
  assert.equal(snap.files[1].sha256, sha256("print(1)\n"));
  assert.equal(snap.files[1].size, 9);
  assert.equal(snap.frontmatter.name, "demo");
  assert.equal(snap.descriptionChars, "Demo skill.".length);
});

const read = (f) => JSON.parse(readFileSync(new URL(`../catalog/${f}`, import.meta.url), "utf8"));

test("the bundled catalog is valid", () => {
  const catalog = { items: read("items.json"), taxonomy: read("taxonomy.json"), loadouts: read("loadouts.json"), core: read("core.json") };
  assert.deepEqual(validateCatalog(catalog), []);
  assert.ok(catalog.items.length >= 25, `only ${catalog.items.length} items`);
  assert.ok(catalog.loadouts.length >= 8);
});

test("every bundled item passed the current scanner", () => {
  for (const item of read("items.json")) {
    assert.ok(["verified", "caution"].includes(item.security.level), item.id);
    assert.equal(item.security.scannerVersion, SCANNER_VERSION, item.id);
    assert.equal(item.security.gateVersion, GATE_VERSION, `${item.id} was gated by an older pipeline`);
    // The recorded findings must justify the level: only a human-reviewed quarantined item may sit above them.
    const fromFindings = levelFromFindings(item.security.findings ?? []);
    if (item.security.review) assert.equal(fromFindings, "quarantined", `${item.id}: only quarantined items can be reviewed`);
    else assert.ok(["verified", "caution"].includes(fromFindings), `${item.id}: findings say ${fromFindings}`);
  }
});

test("core entries are tier core and cover the mandatory core", () => {
  const items = new Map(read("items.json").map((i) => [i.id, i]));
  const core = read("core.json").map((c) => c.id);
  for (const id of core) assert.equal(items.get(id).tier, "core", id);
  for (const cap of ["codebase-map", "tdd-discipline", "verification-gate", "debugging-method", "design-brainstorming", "implementation-planning", "security-review", "package-guard"]) {
    assert.ok(core.some((id) => items.get(id).capabilities.includes(cap)), `core lacks ${cap}`);
  }
});

test("meta.json hashes match the catalog files", () => {
  const meta = read("meta.json");
  assert.equal(meta.schemaVersion, 1);
  assert.match(meta.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
  for (const f of ["items.json", "taxonomy.json", "loadouts.json", "core.json"]) {
    assert.equal(meta.files[f], sha256(readFileSync(new URL(`../catalog/${f}`, import.meta.url))), f);
  }
});
