import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const tmpHome = mkTemp("rp-cli-home-");
const offline = (cwd, ...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", cwd, env: { ...process.env, REPOTIFY_OFFLINE: "1", REPOTIFY_TELEMETRY: "0", REPOTIFY_HOME: tmpHome, REPOTIFY_NO_EXPLORE: "1" } });

test("questions lists only what is unknown and would change the picks", () => {
  const r = offline(projects + "empty", "questions");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^1\. What are you building\? \(pick one\)/);
  const j = JSON.parse(offline(projects + "nextjs-saas", "questions", "--json").stdout);
  assert.ok(Array.isArray(j) && !j.some((q) => q.id === "projectType"));
  for (const q of j) {
    assert.ok(typeof q.text === "string" && typeof q.multi === "boolean" && q.expected > 0, JSON.stringify(q));
    assert.ok(q.options.length && q.options.every((o) => o.id && o.label && o.changes > 0), JSON.stringify(q));
  }
  const answered = JSON.parse(offline(projects + "empty", "questions", "--json", "--type", "web-app").stdout);
  assert.ok(!answered.some((q) => q.id === "projectType"), "an answer given as a flag is not asked again");
});

test("ui serves the decision tree on 127.0.0.1 until stopped, with the answers given as flags", async () => {
  const child = spawn(process.execPath, [bin, "ui", "--type", "web-app"], { cwd: projects + "empty", env: { ...process.env, REPOTIFY_OFFLINE: "1", REPOTIFY_TELEMETRY: "0", REPOTIFY_HOME: tmpHome } });
  let out = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no link in time: ${out}`)), 30000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}&a=\S+/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.on("exit", (code) => reject(new Error(`exited ${code}: ${out}`)));
  });
  assert.match(decodeURIComponent(url), /a=\{"projectType":"web-app"\}/);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Repotify picks<\/title>/);
  const code = await new Promise((resolve) => {
    child.on("exit", (c) => resolve(c));
    child.kill("SIGTERM");
  });
  // Windows has no signals: there the process is simply ended.
  if (process.platform !== "win32") assert.equal(code, 0, "Ctrl+C or a stop signal ends it cleanly");
});

test("recommend prints the candidate table from the bundled catalog when offline", () => {
  const r = offline(projects + "nextjs-saas", "recommend");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Repotify candidates/);
  assert.match(r.stdout, /^★ \S+ \|/m);
  const j = JSON.parse(offline(projects + "nextjs-saas", "recommend", "--json").stdout);
  assert.equal(j.decision, "recommend");
  assert.ok(j.rows.length > 0);
  assert.deepEqual(j.defaultSet, j.set);
  assert.ok(j.defaultSet.includes("webapp-testing"));
});

test("recommend accepts answers as flags for projects that cannot be inferred", () => {
  const j = JSON.parse(offline(projects + "empty", "recommend", "--type", "content-site", "--needs", "pdf,foo", "--json").stdout);
  assert.equal(j.loadout, "content-site");
  assert.ok(j.needs.includes("pdf"));
  assert.ok(!j.needs.includes("foo"));
});
