import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { sha256 } from "../src/util.mjs";

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
const bundled = fileURLToPath(new URL("../catalog/", import.meta.url));
const COMMIT = "e".repeat(40);
const SKILL = { "SKILL.md": "---\nname: e2e-skill\ndescription: End-to-end demo skill.\n---\nUse it.\n", "references/notes.md": "# Notes\nPlain text.\n" };

function buildCatalog() {
  const items = JSON.parse(readFileSync(join(bundled, "items.json"), "utf8"));
  items.push({
    id: "e2e-skill", type: "skill", name: "E2E Skill", repo: "acme/e2e", path: "skills/e2e-skill", commit: COMMIT,
    files: Object.entries(SKILL).map(([path, c]) => ({ path, sha256: sha256(c) })), license: "MIT",
    summary: "End-to-end demo skill.", capabilities: ["writing-quality"], needs: [], stacks: ["*"], agents: ["claude-code", "cursor", "codex"],
    tier: "mission", cluster: "writing-quality", conflicts: [], descriptionChars: 22, signals: {}, jury: null, community: {},
    security: { level: "verified", findings: [], scannedAt: "2026-09-28T00:00:00Z", scannerVersion: "1.0.0" }, badges: [], setup: null,
  });
  const files = { "items.json": JSON.stringify(items) };
  for (const f of ["taxonomy.json", "loadouts.json", "core.json"]) files[f] = readFileSync(join(bundled, f), "utf8");
  const meta = { schemaVersion: 1, version: "2999.01.01.1", generatedAt: "2999-01-01T00:00:00.000Z", files: {} };
  for (const [k, v] of Object.entries(files)) meta.files[k] = sha256(v);
  files["meta.json"] = JSON.stringify(meta);
  return files;
}

function serve(catalogFiles) {
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url);
    if (url.startsWith("/catalog/")) {
      const body = catalogFiles[url.slice("/catalog/".length)];
      res.writeHead(body ? 200 : 404).end(body ?? "");
      return;
    }
    const prefix = `/raw/acme/e2e/${COMMIT}/skills/e2e-skill/`;
    if (url.startsWith(prefix) && SKILL[url.slice(prefix.length)]) {
      res.writeHead(200).end(SKILL[url.slice(prefix.length)]);
      return;
    }
    res.writeHead(404).end("");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function run(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("CLI installs one skill for Claude Code, Cursor and Codex from a served catalog", async () => {
  const server = await serve(buildCatalog());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cwd = mkTemp("rp-e2e-");
  const env = { REPOTIFY_CATALOG_URL: `${base}/catalog`, REPOTIFY_RAW_BASE: `${base}/raw`, REPOTIFY_HOME: join(cwd, ".home"), REPOTIFY_TELEMETRY: "0" };
  try {
    const r = await run(["install", "e2e-skill", "--agent", "claude-code,cursor,codex", "--yes"], env, cwd);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const dir of [".claude/skills", ".cursor/skills", ".agents/skills"]) {
      assert.equal(readFileSync(join(cwd, dir, "e2e-skill/SKILL.md"), "utf8"), SKILL["SKILL.md"], dir);
      assert.ok(existsSync(join(cwd, dir, "e2e-skill/references/notes.md")));
    }
    const lock = JSON.parse(readFileSync(join(cwd, "repotify.lock.json"), "utf8"));
    assert.deepEqual(lock.items["e2e-skill"].targets, [".claude/skills/e2e-skill", ".cursor/skills/e2e-skill", ".agents/skills/e2e-skill"]);
    assert.equal(lock.catalogVersion, "2999.01.01.1");
    assert.ok(r.stdout.length <= 1050, `summary ${r.stdout.length}`);
    assert.match(r.stdout, /e2e-skill/);

    const unknown = await run(["install", "made-up-skill", "--yes"], env, cwd);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stdout + unknown.stderr, /not in the catalog/);

    const rm = await run(["remove", "e2e-skill"], env, cwd);
    assert.equal(rm.status, 0, rm.stderr);
    assert.equal(existsSync(join(cwd, ".cursor/skills/e2e-skill")), false);
  } finally {
    server.close();
  }
});
