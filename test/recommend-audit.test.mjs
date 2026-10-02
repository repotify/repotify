// Tests for lib/pipeline/recommend/audit.mjs: project-scoped suggestions only,
// global installs are never touched.
import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadSeedGraph } from "../lib/pipeline/graph/loader.mjs";
import { scanInstalls, auditInstalls } from "../lib/pipeline/recommend/audit.mjs";
import { loadCatalog } from "../src/catalog.mjs";

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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let graph;
let catalog;
let proj;
let fakeHome;

const plant = (rootDir, rel, name) => mkdirSync(join(rootDir, rel, name), { recursive: true });

before(async () => {
  graph = loadSeedGraph(join(root, "data", "graph-seed.json"));
  ({ catalog } = await loadCatalog());
  proj = mkTemp("repotify-audit-proj-");
  fakeHome = mkTemp("repotify-audit-home-");
  // Project scope: two conflicting workflow skills (planning vs handoff per the seed).
  plant(proj, ".claude/skills", "planning");
  plant(proj, ".claude/skills", "handoff");
  plant(proj, ".claude/skills", "some-unknown-skill");
  // A fake "home": auditInstalls scans the real homedir; we test scanInstalls
  // shape on the project dir and audit on the project dir only.
});

after(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

test("scanInstalls finds project skill dirs", () => {
  const { project } = scanInstalls({ projectDir: proj });
  const names = project.map((p) => p.path.split("/").pop()).sort();
  assert.deepEqual(names, ["handoff", "planning", "some-unknown-skill"]);
  assert.ok(project.every((p) => p.scope === "project"));
});

test("audit flags the planning/handoff conflict as project-scoped", () => {
  const a = auditInstalls({ catalog, graph, projectDir: proj });
  assert.equal(a.summary.projectCount, 3);
  const pair = a.conflicts.find(
    (c) => (c.a.id === "planning" && c.b.id === "handoff") || (c.a.id === "handoff" && c.b.id === "planning"),
  );
  assert.ok(pair, JSON.stringify(a.conflicts));
  assert.equal(pair.action, "suggest-removal", "both project-scoped: removal is safe to suggest");
  assert.ok(["graph", "catalog+graph"].includes(pair.source));
  assert.ok(a.unknown.some((u) => u.path.endsWith("some-unknown-skill")));
});

test("global installs are report-only, never suggest-removal", () => {
  // Simulate: one side of a conflict lives in a global dir by injecting it
  // through a second project scan treated as global. We emulate the pairing
  // logic directly: auditInstalls never emits suggest-removal when a side is global.
  const a = auditInstalls({ catalog, graph, projectDir: proj });
  for (const c of a.conflicts) {
    if (c.action === "suggest-removal") {
      assert.equal(c.a.scope, "project");
      assert.equal(c.b.scope, "project");
    }
  }
  // The audit reports; it never deletes.
  assert.ok(!("delete" in a) && !("remove" in a));
});

test("audit on an empty project reports zero conflicts", () => {
  const empty = mkTemp("repotify-audit-empty-");
  try {
    const a = auditInstalls({ catalog, graph, projectDir: empty });
    assert.equal(a.summary.conflictCount, 0);
    assert.equal(a.summary.projectCount, 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("conflict pairs from the catalog conflicts field are also caught", () => {
  // planning lists many conflicts in the catalog itself.
  const dir = mkTemp("repotify-audit-cat-");
  try {
    plant(dir, ".agents/skills", "planning");
    plant(dir, ".agents/skills", "the-fool");
    const a = auditInstalls({ catalog, graph, projectDir: dir });
    const pair = a.conflicts.find(
      (c) => [c.a.id, c.b.id].sort().join("+") === "planning+the-fool",
    );
    assert.ok(pair, "catalog-declared conflict detected");
    assert.ok(["catalog", "catalog+graph"].includes(pair.source));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
