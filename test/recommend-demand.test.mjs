import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDemand, platformsOf, platformMismatch, fitScore, recommend } from "../src/recommend.mjs";
import { resolveNeeds, NEED_WEIGHTS } from "../src/needs.mjs";
import { fingerprint } from "../src/fingerprint.mjs";
import { validateCatalog } from "../src/catalog.mjs";
import { rehashCatalog } from "../pipeline/rehash.mjs";
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

const read = (f) => JSON.parse(readFileSync(new URL(`../catalog/${f}`, import.meta.url), "utf8"));
const catalog = { items: read("items.json"), taxonomy: read("taxonomy.json"), loadouts: read("loadouts.json"), core: read("core.json") };
const { taxonomy } = catalog;
const fpOf = (o) => ({ empty: false, stacks: [], inferredNeeds: [], agents: { configured: [], skills: [] }, ...o });
const run = (fp, answers = {}) => recommend({ catalog, fingerprint: fp, needs: resolveNeeds({ fingerprint: fp, answers, taxonomy }) });

test("platforms come from the fingerprint, or from stacks when it has none", () => {
  assert.deepEqual(platformsOf({ platforms: ["mobile", "web"] }), ["mobile", "web"]);
  assert.deepEqual(platformsOf({ stacks: ["node", "react", "react-native", "expo"] }), ["mobile"], "React alone is not web in a React Native app");
  assert.deepEqual(platformsOf({ stacks: ["node", "react"] }), ["web"]);
  assert.deepEqual(platformsOf({ stacks: ["electron", "react"] }), ["desktop", "web"]);
  assert.deepEqual(platformsOf({ stacks: ["dart", "flutter"] }), ["mobile"]);
  assert.deepEqual(platformsOf({ stacks: ["python"] }), [], "unknown platform: nothing is filtered");
});

test("web-only items do not fit an app without a web target; everything else is untouched", () => {
  const web = { id: "w", tier: "mission", stacks: ["*"], capabilities: ["webapp-testing"], needs: ["testing"] };
  const demand = (fp) => buildDemand({ taxonomy, fingerprint: fp, needs: { needs: ["testing"] } });
  const mobile = { ...demand(fpOf({ stacks: ["dart", "flutter"] })), stacks: [] };
  assert.equal(platformMismatch(web, mobile), true);
  assert.equal(fitScore(web, mobile).fit, 0);
  assert.equal(platformMismatch(web, demand(fpOf({ stacks: ["vue"] }))), false);
  assert.equal(platformMismatch(web, demand(fpOf({ stacks: ["python"] }))), false);
  assert.equal(platformMismatch({ ...web, capabilities: ["webapp-testing", "tdd-discipline"] }, mobile), false, "mixed items stay");
});

test("dependency evidence narrows a broad need to the facets it shows, unless the user named the need", () => {
  const fp = fpOf({ stacks: ["python"], inferredNeeds: ["office-docs"], capabilityHints: ["spreadsheets"] });
  const inferred = buildDemand({ taxonomy, fingerprint: fp, needs: resolveNeeds({ fingerprint: fp, taxonomy }) });
  assert.deepEqual(inferred.narrowed, ["office-docs"]);
  assert.ok(inferred.capabilitiesWanted.includes("spreadsheets"));
  assert.ok(!inferred.capabilitiesWanted.includes("docx-documents"));
  assert.ok(!inferred.needs.includes("office-docs"), "a narrowed need no longer matches items directly");
  const said = buildDemand({ taxonomy, fingerprint: fp, needs: resolveNeeds({ fingerprint: fp, answers: { needs: ["office-docs"] }, taxonomy }) });
  assert.deepEqual(said.narrowed, []);
  assert.ok(said.capabilitiesWanted.includes("docx-documents"));
});

test("need weights: evidence and answers beat priorities, which beat project-type defaults", () => {
  const fp = fpOf({ stacks: ["python"], inferredNeeds: ["pdf"] });
  const r = resolveNeeds({ fingerprint: fp, answers: { projectType: "api", needs: ["auth"], priorities: ["security"] }, taxonomy });
  assert.equal(r.weights.pdf, NEED_WEIGHTS.evidence);
  assert.equal(r.weights.auth, NEED_WEIGHTS.answer);
  assert.equal(r.weights.security, NEED_WEIGHTS.priority, "a priority outweighs the same need as a type default");
  assert.equal(r.weights.deploy, NEED_WEIGHTS.projectType);
  assert.deepEqual(r.answered, ["auth"]);
  const item = { id: "p", tier: "mission", stacks: ["*"], capabilities: ["pdf-processing"], needs: [] };
  const d = buildDemand({ taxonomy, fingerprint: fp, needs: { needs: ["pdf"], weights: { pdf: 0.75 } } });
  assert.ok(Math.abs(fitScore(item, d).fit - 0.8 * 0.75) < 1e-9, "a capability match is scaled by the evidence behind it");
});

test("Excel evidence gets the spreadsheet skill, not Word or PowerPoint; a stated office need gets all three", () => {
  const fp = fpOf({ stacks: ["node"], inferredNeeds: ["office-docs", "data-processing"], capabilityHints: ["spreadsheets"] });
  const narrow = run(fp).defaultSet;
  assert.ok(narrow.includes("xlsx"));
  for (const id of ["docx", "pptx"]) assert.ok(!narrow.includes(id), id);
  const broad = run(fpOf({ stacks: ["node"] }), { needs: ["office-docs"] }).defaultSet;
  for (const id of ["docx", "pptx", "xlsx"]) assert.ok(broad.includes(id), id);
});

test("mobile apps get no web-only skills; web apps still do", () => {
  // web-design-guidelines left the catalog with the cleanup; webapp-testing is
  // the surviving web-only skill that the web fixture defaults.
  const mobile = run(fpOf({ stacks: ["node", "react", "react-native", "typescript"], inferredNeeds: ["frontend-ui", "mobile"] }));
  assert.ok(mobile.defaultSet.includes("react-native-skills"));
  for (const id of ["webapp-testing", "react-best-practices"]) assert.ok(!mobile.rows.some((r) => r.id === id), id);
  assert.deepEqual(mobile.demand.platforms, ["mobile"]);
  const web = run(fpOf({ stacks: ["node", "typescript", "vue"], inferredNeeds: ["frontend-ui", "e2e-testing"] }));
  assert.ok(web.defaultSet.includes("webapp-testing"), "webapp-testing");
});

test("an optional item that adds nothing the set does not already serve stays out, with the item that covers it", () => {
  const extra = {
    id: "second-reviewer", type: "skill", name: "Second reviewer", repo: "a/b", tier: "mission", commit: "a".repeat(40),
    files: [{ path: "SKILL.md", sha256: "b".repeat(64) }], summary: "Reviews changes for security.", capabilities: ["code-review"],
    needs: ["auth", "security"], stacks: ["*"], agents: ["claude-code"], cluster: "code-review", descriptionChars: 100, security: { level: "verified" },
  };
  const items = catalog.items.filter((i) => i.id !== "requesting-code-review").concat(extra);
  const fp = fpOf({ stacks: ["python"], inferredNeeds: ["auth", "security"] });
  const rec = recommend({ catalog: { ...catalog, items }, fingerprint: fp, needs: resolveNeeds({ fingerprint: fp, taxonomy }) });
  const row = rec.rows.find((r) => r.id === "second-reviewer");
  assert.ok(row && !row.default, "listed as an alternative, not defaulted");
  assert.equal(rec.coveredBy["second-reviewer"], "differential-review");
  assert.equal(row.reasons[0], "covered-by:differential-review");
});

test("the fingerprint reports platforms and capability evidence from dependencies", async () => {
  const dir = mkTemp("repotify-fp-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { expo: "51.0.0", "react-native": "0.74.0", exceljs: "4.4.0" } }));
  const fp = await fingerprint(dir);
  assert.deepEqual(fp.platforms, ["mobile"]);
  assert.deepEqual(fp.capabilityHints, ["spreadsheets"]);
  const web = mkTemp("repotify-fp-");
  writeFileSync(join(web, "package.json"), JSON.stringify({ dependencies: { expo: "51.0.0", "react-dom": "18.3.1", "react-native-web": "0.19.0" } }));
  assert.deepEqual((await fingerprint(web)).platforms, ["mobile", "web"], "an Expo app with a web target keeps web skills");
});

test("taxonomy platforms are validated, and rehash rewrites hashes only for a valid catalog", () => {
  const bad = { ...taxonomy, capabilities: { ...taxonomy.capabilities, "webapp-testing": { ...taxonomy.capabilities["webapp-testing"], platform: "moon" } } };
  assert.ok(validateCatalog({ ...catalog, taxonomy: bad }).some((e) => e.includes("unknown platform moon")));
  const dir = mkTemp("repotify-cat-");
  for (const f of ["items.json", "taxonomy.json", "loadouts.json", "core.json", "meta.json"]) writeFileSync(join(dir, f), readFileSync(new URL(`../catalog/${f}`, import.meta.url)));
  const meta = rehashCatalog(dir, { now: new Date("2031-01-02T00:00:00Z") });
  assert.equal(meta.version, "2031.01.02.1");
  assert.equal(meta.files["taxonomy.json"], sha256(readFileSync(join(dir, "taxonomy.json"))));
  writeFileSync(join(dir, "taxonomy.json"), JSON.stringify(bad));
  assert.throws(() => rehashCatalog(dir), /invalid catalog/);
});
