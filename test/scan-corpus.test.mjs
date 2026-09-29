import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { scanDir } from "../src/scan/index.mjs";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const expectations = JSON.parse(readFileSync(join(fixtures, "expectations.json"), "utf8"));
const RANK = { verified: 0, caution: 1, quarantined: 2, rejected: 3 };
const bin = fileURLToPath(new URL("../bin/repotify.mjs", import.meta.url));

// The escaping symlink is created at runtime so the repository never contains it.
const linkPath = join(fixtures, "malicious", "symlink-escape", "leak");
test.before(() => {
  if (existsSync(linkPath)) rmSync(linkPath);
  symlinkSync("../../../../../../../etc/passwd", linkPath);
});
test.after(() => rmSync(linkPath, { force: true }));

test("every fixture folder has an expectation and vice versa", () => {
  for (const kind of ["malicious", "benign"]) {
    const dirs = readdirSync(join(fixtures, kind)).sort();
    assert.deepEqual(dirs, Object.keys(expectations[kind]).sort(), kind);
  }
  assert.ok(Object.keys(expectations.malicious).length >= 20);
  assert.ok(Object.keys(expectations.benign).length >= 20);
});

test("malicious set: 100% caught at or above the expected level with the expected rule", async () => {
  const misses = [];
  for (const [name, exp] of Object.entries(expectations.malicious)) {
    const r = await scanDir(join(fixtures, "malicious", name));
    const hasRule = r.findings.some((f) => f.rule === exp.rule && RANK[{ critical: "rejected", high: "quarantined", medium: "caution", low: "verified" }[f.severity]] >= RANK[exp.minLevel]);
    if (RANK[r.level] < RANK[exp.minLevel] || !hasRule) misses.push(`${name}: got ${r.level} [${[...new Set(r.findings.map((f) => f.rule))]}]`);
  }
  assert.deepEqual(misses, []);
});

test("benign set: at most 5% blocked and no case above its expected level", async () => {
  let blocked = 0;
  const over = [];
  const names = Object.keys(expectations.benign);
  for (const name of names) {
    const r = await scanDir(join(fixtures, "benign", name));
    if (RANK[r.level] >= RANK.quarantined) blocked++;
    if (RANK[r.level] > RANK[expectations.benign[name].maxLevel]) over.push(`${name}: got ${r.level} ${JSON.stringify(r.findings.map((f) => [f.rule, f.severity, f.excerpt]))}`);
  }
  assert.ok(blocked / names.length <= 0.05, `blocked ${blocked}/${names.length}`);
  assert.deepEqual(over, []);
});

test("repotify scan exits 1 for blocked folders and 0 for clean ones", () => {
  const bad = spawnSync(process.execPath, [bin, "scan", join(fixtures, "malicious", "curl-pipe-bash")], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /rejected/);
  assert.match(bad.stdout, /remote-exec/);
  const ok = spawnSync(process.execPath, [bin, "scan", join(fixtures, "benign", "pdf-helper")], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /verified/);
  const json = spawnSync(process.execPath, [bin, "scan", join(fixtures, "benign", "pdf-helper"), "--json"], { encoding: "utf8" });
  assert.equal(JSON.parse(json.stdout).level, "verified");
});

test("repotify scan on a missing folder exits 2", () => {
  const r = spawnSync(process.execPath, [bin, "scan", join(fixtures, "does-not-exist")], { encoding: "utf8" });
  assert.equal(r.status, 2);
});
