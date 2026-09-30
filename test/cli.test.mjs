import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = fileURLToPath(new URL("../bin/repotify.mjs", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });

test("--version prints the package version", () => {
  const r = run("--version");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${pkg.version}\n`);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test("unknown command exits 2 with a message", () => {
  const r = run("frobnicate");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown command/);
});

const projects = fileURLToPath(new URL("./fixtures/projects/", import.meta.url));
const runIn = (cwd, ...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", cwd });

test("fingerprint prints a short summary and JSON on request", () => {
  const r = runIn(projects + "nextjs-saas", "fingerprint");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Stacks: .*nextjs/);
  const j = runIn(projects + "nextjs-saas", "fingerprint", "--json");
  assert.ok(JSON.parse(j.stdout).stacks.includes("nextjs"));
});

test("questions lists only what is unknown", () => {
  const r = runIn(projects + "empty", "questions");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^1\. What are you building\?/);
  const j = JSON.parse(runIn(projects + "nextjs-saas", "questions", "--json").stdout);
  assert.ok(!j.some((q) => q.id === "projectType"));
});

const tmpHome = mkdtempSync(join(tmpdir(), "rp-cli-home-"));
const offline = (cwd, ...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", cwd, env: { ...process.env, REPOTIFY_OFFLINE: "1", REPOTIFY_TELEMETRY: "0", REPOTIFY_HOME: tmpHome } });

test("recommend prints the candidate table from the bundled catalog when offline", () => {
  const r = offline(projects + "nextjs-saas", "recommend");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Repotify candidates/);
  assert.match(r.stdout, /★ graphify \|/);
  const j = JSON.parse(offline(projects + "nextjs-saas", "recommend", "--json").stdout);
  assert.ok(j.rows.length > 0);
  assert.ok(j.defaultSet.includes("react-best-practices"));
});

test("recommend accepts answers as flags for projects that cannot be inferred", () => {
  const j = JSON.parse(offline(projects + "empty", "recommend", "--type", "content-site", "--needs", "pdf,foo", "--json").stdout);
  assert.equal(j.loadout, "content-site");
  assert.ok(j.needs.includes("pdf"));
  assert.ok(!j.needs.includes("foo"));
});
