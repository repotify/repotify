import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateItem, validateCatalog, ITEM_TYPES, TIERS, LEVELS } from "../src/catalog.mjs";

const taxonomy = JSON.parse(readFileSync(new URL("../catalog/taxonomy.json", import.meta.url), "utf8"));
const H40 = "a".repeat(40);
const H64 = "b".repeat(64);

export function sampleItem(over = {}) {
  return {
    id: "tdd",
    type: "skill",
    name: "Test-Driven Development",
    repo: "obra/superpowers",
    path: "skills/test-driven-development",
    commit: H40,
    files: [{ path: "SKILL.md", sha256: H64 }],
    license: "MIT",
    summary: "Red-green-refactor discipline: write the failing test first.",
    capabilities: ["tdd-discipline"],
    needs: ["testing"],
    stacks: ["*"],
    agents: ["claude-code", "cursor", "codex"],
    tier: "core",
    cluster: "tdd-discipline",
    conflicts: [],
    descriptionChars: 120,
    signals: { stars: 1000, starVelocity30d: 10, lastCommitDays: 3, coUsage: 0, mentions30d: 0 },
    jury: null,
    community: { shown: 0, selected: 0, kept7d: 0, removed: 0, rating: 0, votes: 0 },
    security: { level: "verified", findings: [], scannedAt: "2026-09-28T00:00:00Z", scannerVersion: "1.0.0" },
    badges: [],
    setup: null,
    ...over,
  };
}

test("enums are exported", () => {
  assert.deepEqual(ITEM_TYPES, ["skill", "plugin", "mcp", "tool", "config"]);
  assert.deepEqual(TIERS, ["core", "stack", "mission"]);
  assert.deepEqual(LEVELS, ["verified", "caution", "quarantined", "rejected"]);
});

test("a valid item has no errors", () => {
  assert.deepEqual(validateItem(sampleItem(), taxonomy), []);
});

test("bad ids, commits, paths, hashes and summaries are reported", () => {
  const has = (errs, word) => assert.ok(errs.some((e) => e.includes(word)), `${word} not in ${JSON.stringify(errs)}`);
  has(validateItem(sampleItem({ id: "Bad Id" }), taxonomy), "id");
  has(validateItem(sampleItem({ commit: "abc" }), taxonomy), "commit");
  has(validateItem(sampleItem({ files: [{ path: "../x", sha256: H64 }] }), taxonomy), "path");
  has(validateItem(sampleItem({ files: [{ path: "SKILL.md", sha256: "zz" }] }), taxonomy), "sha256");
  has(validateItem(sampleItem({ files: [] }), taxonomy), "files");
  has(validateItem(sampleItem({ summary: "x".repeat(141) }), taxonomy), "summary");
  has(validateItem(sampleItem({ repo: "not-a-repo" }), taxonomy), "repo");
  has(validateItem(sampleItem({ type: "widget" }), taxonomy), "type");
  has(validateItem(sampleItem({ tier: "gold" }), taxonomy), "tier");
});

test("vocabulary must come from the taxonomy", () => {
  const has = (errs, word) => assert.ok(errs.some((e) => e.includes(word)), `${word} not in ${JSON.stringify(errs)}`);
  has(validateItem(sampleItem({ capabilities: ["time-travel"] }), taxonomy), "capabilit");
  has(validateItem(sampleItem({ needs: ["world-peace"] }), taxonomy), "need");
  has(validateItem(sampleItem({ stacks: ["cobol"] }), taxonomy), "stack");
  has(validateItem(sampleItem({ cluster: "nope" }), taxonomy), "cluster");
  has(validateItem(sampleItem({ agents: ["notepad"] }), taxonomy), "agent");
  has(validateItem(sampleItem({ capabilities: [] }), taxonomy), "capabilit");
});

test("blocked security levels are not allowed in the published catalog", () => {
  assert.ok(validateItem(sampleItem({ security: { ...sampleItem().security, level: "quarantined" } }), taxonomy).some((e) => e.includes("security")));
  assert.ok(validateItem(sampleItem({ security: { ...sampleItem().security, level: "rejected" } }), taxonomy).some((e) => e.includes("security")));
  assert.deepEqual(validateItem(sampleItem({ security: { ...sampleItem().security, level: "caution" } }), taxonomy), []);
});

test("mcp and tool items need setup instead of files", () => {
  const tool = sampleItem({ id: "omniroute", type: "tool", tier: "mission", files: undefined, commit: undefined, path: undefined,
    capabilities: ["llm-gateway"], cluster: "llm-gateway", setup: { steps: ["npm install -g omniroute@3.8.50"], verify: "curl -s localhost:20128/v1/models" } });
  assert.deepEqual(validateItem(tool, taxonomy), []);
  assert.ok(validateItem({ ...tool, setup: null }, taxonomy).some((e) => e.includes("setup")));
  const mcp = sampleItem({ id: "playwright", type: "mcp", tier: "mission", files: undefined, commit: undefined, path: undefined,
    capabilities: ["browser-automation"], cluster: "browser-automation", setup: { steps: ["Add the server to your MCP config"], mcp: { command: "npx", args: ["-y", "@playwright/mcp@0.0.41"] } } });
  assert.deepEqual(validateItem(mcp, taxonomy), []);
  assert.ok(validateItem({ ...mcp, setup: { steps: ["x"] } }, taxonomy).some((e) => e.includes("mcp")));
});

test("builtin config items do not need a repo", () => {
  const guard = sampleItem({ id: "repotify-guard", type: "config", builtin: true, repo: undefined, commit: undefined, files: undefined, path: undefined,
    capabilities: ["package-guard"], cluster: "package-guard", setup: { steps: ["repotify install repotify-guard"] } });
  assert.deepEqual(validateItem(guard, taxonomy), []);
});

test("validateCatalog checks ids, references and loadout conflicts", () => {
  const a = sampleItem();
  const b = sampleItem({ id: "tdd-2" });
  const c = sampleItem({ id: "planner", capabilities: ["implementation-planning"], cluster: "implementation-planning", conflicts: ["ghost"] });
  const ok = { items: [a, c], taxonomy, loadouts: [{ id: "lo-x", label: "X", projectType: "web-app", needs: ["testing"], items: ["tdd", "planner"] }], core: [{ id: "tdd", reason: "r" }] };
  assert.ok(validateCatalog(ok).some((e) => e.includes("ghost")));
  const fixed = { ...ok, items: [a, { ...c, conflicts: [] }] };
  assert.deepEqual(validateCatalog(fixed), []);
  assert.ok(validateCatalog({ ...fixed, items: [a, a] }).some((e) => e.includes("duplicate")));
  assert.ok(validateCatalog({ ...fixed, core: [{ id: "missing", reason: "r" }] }).some((e) => e.includes("missing")));
  assert.ok(validateCatalog({ ...fixed, items: [a, b], loadouts: [{ id: "lo-y", label: "Y", projectType: "web-app", needs: [], items: ["tdd", "tdd-2"] }] }).some((e) => e.includes("cluster")));
  assert.ok(validateCatalog({ ...fixed, loadouts: [{ id: "lo-z", label: "Z", projectType: "spaceship", needs: [], items: [] }] }).some((e) => e.includes("projectType")));
});

test("the bundled taxonomy is internally consistent", () => {
  for (const [id, need] of Object.entries(taxonomy.needs)) for (const c of need.capabilities) assert.ok(taxonomy.capabilities[c], `${id} -> ${c}`);
  for (const [id, pt] of Object.entries(taxonomy.projectTypes)) for (const n of pt.needs) assert.ok(taxonomy.needs[n], `${id} -> ${n}`);
});
