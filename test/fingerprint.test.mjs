import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, formatFingerprint } from "../src/fingerprint.mjs";

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

const projects = fileURLToPath(new URL("./fixtures/projects/", import.meta.url));
const fp = (name, opts) => fingerprint(join(projects, name), opts);
const includes = (arr, expected, label) => {
  for (const x of expected) assert.ok(arr.includes(x), `${label}: missing ${x} in ${JSON.stringify(arr)}`);
};

test("Next.js SaaS: stacks, needs, tests, infra and agent config", async () => {
  const f = await fp("nextjs-saas");
  assert.equal(f.empty, false);
  includes(f.stacks, ["node", "typescript", "nextjs", "react"], "stacks");
  includes(f.inferredNeeds, ["payments", "auth", "llm-calls", "testing", "e2e-testing", "deploy", "ci", "frontend-ui"], "needs");
  includes(f.tests, ["vitest", "playwright"], "tests");
  includes(f.llm, ["openai"], "llm");
  includes(f.data, ["prisma"], "data");
  includes(f.infra, ["docker", "github-actions", "vercel"], "infra");
  includes(f.agents.configured, ["claude-code"], "agents");
  includes(f.agents.skills, ["my-own"], "skills");
  assert.equal(f.languages[0].lang, "typescript");
});

test("FastAPI + LLM from pyproject.toml", async () => {
  const f = await fp("fastapi-llm");
  includes(f.stacks, ["python", "fastapi"], "stacks");
  includes(f.llm, ["openai"], "llm");
  includes(f.tests, ["pytest"], "tests");
  includes(f.data, ["sqlalchemy"], "data");
  includes(f.inferredNeeds, ["llm-calls", "testing"], "needs");
  includes(f.manifests, ["pyproject.toml"], "manifests");
});

test("Flutter from pubspec.yaml", async () => {
  const f = await fp("flutter-app");
  includes(f.stacks, ["dart", "flutter"], "stacks");
  includes(f.inferredNeeds, ["mobile"], "needs");
});

test("an almost empty folder is empty", async () => {
  const f = await fp("empty");
  assert.equal(f.empty, true);
  assert.match(formatFingerprint(f), /No project detected/);
});

test("Go CLI from go.mod", async () => {
  const f = await fp("go-cli");
  includes(f.stacks, ["go"], "stacks");
  includes(f.frameworks, ["cobra"], "frameworks");
  includes(f.tests, ["go-test"], "tests");
});

test("monorepo manifests are merged and node_modules is ignored", async () => {
  const f = await fp("monorepo-mixed");
  includes(f.stacks, ["node", "react", "python", "flask"], "stacks");
  assert.ok(!f.stacks.includes("angular"));
  includes(f.manifests, ["package.json", "packages/web/package.json", "services/api/requirements.txt"], "manifests");
});

test("a BOM manifest is read and an invalid one is skipped without crashing", async () => {
  const f = await fp("broken-manifests");
  includes(f.frameworks, ["express"], "frameworks");
  includes(f.stacks, ["express"], "stacks");
});

test("news site: astro, feeds, scraping, llm and seo", async () => {
  const f = await fp("news-site");
  includes(f.stacks, ["astro"], "stacks");
  includes(f.inferredNeeds, ["scraping", "llm-calls", "seo", "frontend-ui"], "needs");
});

test("solidity projects are detected", async () => {
  const f = await fp("solidity-dapp");
  includes(f.stacks, ["solidity"], "stacks");
  includes(f.inferredNeeds, ["smart-contracts"], "needs");
});

test("the walk is bounded by maxFiles and stays fast", async () => {
  const dir = mkTemp("rp-big-");
  for (let d = 0; d < 10; d++) {
    mkdirSync(join(dir, `d${d}`));
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `d${d}`, `f${i}.js`), "x");
  }
  const t = Date.now();
  const f = await fingerprint(dir, { maxFiles: 50 });
  assert.equal(f.truncated, true);
  assert.ok(f.size.files <= 50);
  assert.ok(Date.now() - t < 2000);
});

test("the home directory and filesystem root are treated as no project", async () => {
  const dir = mkTemp("rp-home-");
  writeFileSync(join(dir, "package.json"), '{"dependencies":{"react":"1"}}');
  const f = await fingerprint(dir, { homeDir: dir });
  assert.equal(f.empty, true);
  assert.equal(f.stacks.length, 0);
  assert.equal((await fingerprint("/", { maxFiles: 10 })).empty, true);
});

test("the home directory is recognised under another spelling of its path", async () => {
  // macOS: the temp folder is /var/..., the working directory /private/var/...
  const dir = mkTemp("rp-home-");
  writeFileSync(join(dir, "package.json"), '{"dependencies":{"react":"1"}}');
  const alias = join(mkTemp("rp-alias-"), "home");
  symlinkSync(dir, alias, "dir");
  assert.equal((await fingerprint(dir, { homeDir: alias })).reason, "home-or-root");
  assert.equal((await fingerprint(alias, { homeDir: dir })).reason, "home-or-root");
});

test("large projects infer large-codebase", async () => {
  const dir = mkTemp("rp-large-");
  writeFileSync(join(dir, "package.json"), "{}");
  for (let i = 0; i < 1600; i++) writeFileSync(join(dir, `m${i}.ts`), "");
  const f = await fingerprint(dir);
  includes(f.inferredNeeds, ["large-codebase"], "needs");
});

test("formatFingerprint stays within 1400 characters", async () => {
  for (const name of ["nextjs-saas", "monorepo-mixed", "news-site"]) {
    const text = formatFingerprint(await fp(name));
    assert.ok(text.length <= 1400, `${name}: ${text.length}`);
    assert.match(text, /Stacks:/);
  }
});

test("projects kept inside the project (fixtures, examples, templates) do not change its stacks", async () => {
  const dir = mkTemp("repotify-fp-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cli-tool", bin: "cli.mjs" }));
  for (const sub of ["test/fixtures/web", "examples/next-demo", "templates/flutter-app", "internal/testdata/py"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "test/fixtures/web/package.json"), JSON.stringify({ dependencies: { react: "19.0.0", stripe: "17.0.0" } }));
  writeFileSync(join(dir, "examples/next-demo/package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
  writeFileSync(join(dir, "templates/flutter-app/pubspec.yaml"), "name: x\ndependencies:\n  flutter:\n    sdk: flutter\n");
  writeFileSync(join(dir, "internal/testdata/py/requirements.txt"), "fastapi\n");
  const f = await fingerprint(dir);
  assert.deepEqual(f.stacks, ["node"]);
  assert.deepEqual(f.inferredNeeds, []);
  assert.deepEqual(f.platforms, []);
});

test("pyproject dependency groups: included group names are not packages", async () => {
  const { manifestDeps } = await import("../src/fingerprint.mjs");
  const deps = manifestDeps("pyproject.toml", '[project]\ndependencies = ["rich>=13"]\n\n[dependency-groups]\ndev = [\n  {include-group = "tests"},\n  "ruff==0.6.0",\n]\ntests = ["pytest"]\n');
  assert.deepEqual(deps, ["rich", "ruff", "pytest"]);
});
