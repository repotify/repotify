import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSeedContext, CONTEXT_BUDGET_MS } from "../lib/pipeline/context/index.mjs";

const dirent = (name, isDir) => ({ name, isDirectory: () => isDir });

// In-memory project trees keep the tests offline and fast.
function fakeFs(tree) {
  const readFile = async (path) => {
    const hit = tree.files[path];
    if (hit == null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return hit;
  };
  const readdir = async (path, { withFileTypes } = {}) => {
    const hit = tree.dirs[path];
    if (hit == null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return withFileTypes ? hit.map(([n, d]) => dirent(n, d)) : hit.map(([n]) => n);
  };
  return { readFile, readdir };
}

const nodeProject = fakeFs({
  files: {
    "/p/package.json": JSON.stringify({ name: "shop", dependencies: { next: "^14.0.0", react: "^18.0.0" }, devDependencies: { vitest: "^1.0.0" }, scripts: { dev: "next dev" } }),
  },
  dirs: {
    "/p": [["package.json", false], ["src", true], [".agents", true], ["README.md", false]],
    "/p/src": [["index.ts", false]],
    "/p/.agents": [["skills", true]],
    "/p/.agents/skills": [["pdf-reader", true], ["code-review", true]],
    "/root/.claude/skills": [["global-skill", true]],
  },
});

test("a node project yields manifest, skeleton and skill inventory with high confidence", async () => {
  const ctx = await collectSeedContext("/p", { fs: nodeProject, home: "/root", now: new Date("2026-10-01T12:00:00Z") });
  assert.equal(ctx.manifests.length, 1);
  assert.equal(ctx.manifests[0].kind, "node");
  assert.equal(ctx.manifests[0].name, "shop");
  assert.ok(ctx.manifests[0].deps.includes("next"));
  assert.ok(ctx.manifests[0].deps.includes("vitest"));
  assert.ok(ctx.skeleton.entries.some((e) => e.name === "src" && e.type === "dir"));
  assert.ok(ctx.skeleton.entries.some((e) => e.name === "src/index.ts"));
  const project = ctx.inventory.find((i) => i.scope === "project");
  assert.deepEqual(project.skills, ["code-review", "pdf-reader"]);
  const global = ctx.inventory.find((i) => i.scope === "global");
  assert.deepEqual(global.skills, ["global-skill"]);
  assert.equal(ctx.confidence, "high");
  assert.equal(ctx.lowConfidence, false);
  assert.ok(ctx.durationMs <= CONTEXT_BUDGET_MS, `collect took ${ctx.durationMs}ms, budget is ${CONTEXT_BUDGET_MS}ms`);
  assert.equal(ctx.withinBudget, true);
});

test("an empty directory is flagged low-confidence", async () => {
  const empty = fakeFs({ files: {}, dirs: { "/e": [], "/root/.claude/skills": [] } });
  const ctx = await collectSeedContext("/e", { fs: empty, home: "/root" });
  assert.deepEqual(ctx.manifests, []);
  assert.deepEqual(ctx.inventory, []);
  assert.equal(ctx.confidence, "low");
  assert.equal(ctx.lowConfidence, true, "no context -> low-confidence flag");
});

test("a project with files but no manifest gets medium confidence", async () => {
  const fs = fakeFs({ files: {}, dirs: { "/m": [["main.py", false]], "/root/.claude/skills": [] } });
  const ctx = await collectSeedContext("/m", { fs, home: "/root" });
  assert.equal(ctx.confidence, "medium");
  assert.equal(ctx.lowConfidence, false);
});

test("manifest parsers stay shallow: go, python, rust, ruby, php, java", async () => {
  const fs = fakeFs({
    files: {
      "/g/go.mod": "module example.com/shop\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n",
      "/g/pyproject.toml": '[project]\nname = "shop"\ndependencies = [\n  "fastapi",\n]\n',
      "/g/requirements.txt": "# web\nfastapi==0.110\nuvicorn\n",
      "/g/Cargo.toml": '[package]\nname = "shop"\n\n[dependencies]\nserde = "1"\n',
      "/g/Gemfile": "source 'https://rubygems.org'\ngem 'rails'\n",
      "/g/composer.json": JSON.stringify({ name: "acme/shop", require: { "php": ">=8.1", "laravel/framework": "^10.0" } }),
      "/g/pom.xml": "<project><artifactId>shop</artifactId><dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-core</artifactId></dependency></dependencies></project>",
    },
    dirs: { "/g": [], "/root/.claude/skills": [] },
  });
  const ctx = await collectSeedContext("/g", { fs, home: "/root" });
  const byKind = Object.fromEntries(ctx.manifests.map((m) => [m.kind, m]));
  assert.ok(byKind.go.deps.some((d) => d.includes("gin-gonic")), "go.mod deps parsed");
  assert.ok(byKind.python.deps.includes("fastapi"), "pyproject + requirements deps parsed");
  assert.ok(byKind.rust.deps.includes("serde"), "Cargo.toml deps parsed");
  assert.ok(byKind.ruby.deps.includes("rails"), "Gemfile deps parsed");
  assert.ok(byKind.php.deps.some((d) => d.includes("laravel")), "composer.json deps parsed");
  assert.ok(byKind.java.deps.some((d) => d.includes("spring-core")), "pom.xml deps parsed");
  assert.ok(ctx.manifests.every((m) => m.deps.length <= 60), "dep lists are capped");
});

test("the skeleton is bounded: heavy dirs are skipped, entries capped, sorted", async () => {
  const many = Array.from({ length: 298 }, (_, i) => [`f${String(i).padStart(3, "0")}.js`, false]);
  const fs = fakeFs({
    files: {},
    dirs: { "/b": [["node_modules", true], [".git", true], ["src", true], ...many], "/b/src": [["a.js", false]], "/root/.claude/skills": [] },
  });
  const ctx = await collectSeedContext("/b", { fs, home: "/root" });
  assert.ok(ctx.skeleton.entries.length <= 300, "entry cap holds");
  assert.equal(ctx.skeleton.truncated, true);
  const nm = ctx.skeleton.entries.find((e) => e.name === "node_modules");
  assert.equal(nm.skipped, true, "node_modules is listed but not descended into");
  assert.ok(!ctx.skeleton.entries.some((e) => e.name.startsWith("node_modules/")));
  const names = ctx.skeleton.entries.map((e) => e.name);
  assert.deepEqual(names, [...names].sort(), "skeleton is sorted (deterministic)");
});

test("an unreadable directory degrades to low confidence instead of throwing", async () => {
  const fs = fakeFs({ files: {}, dirs: {} });
  const ctx = await collectSeedContext("/nope", { fs, home: "/root" });
  assert.equal(ctx.lowConfidence, true);
  assert.equal(ctx.confidence, "low");
});
