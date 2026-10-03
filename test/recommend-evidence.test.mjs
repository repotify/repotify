import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptionOf, qualityOf } from "../lib/pipeline/recommend/score.mjs";
import { platformMismatch } from "../lib/pipeline/recommend/narrow.mjs";
import { selectSet, sourceRank, uncertaintyOf, GATE_REASONS } from "../lib/pipeline/recommend/present.mjs";
import { adoptionScore } from "../src/recommend.mjs";
import { fingerprint } from "../src/fingerprint.mjs";

const tempDirs = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test("quality: the decision model's score for derived items, the jury's otherwise", () => {
  assert.equal(qualityOf({ quality: 0.9, jury: { quality: 0.1, specificity: 0.1, maintenance: 0.1 } }), 0.9);
  assert.equal(qualityOf({ quality: 4 }), 1);
  assert.ok(Math.abs(qualityOf({ jury: { quality: 0.6, specificity: 0.9, maintenance: 0.9 } }) - 0.8) < 1e-9);
  assert.equal(qualityOf({ jury: null }), 0.5);
});

test("adoption: installs and reputation count; inflated stars do not; a collection's stars are shared by its skills", () => {
  const plain = { signals: { stars: 4000 } };
  assert.equal(adoptionOf(plain), adoptionScore(plain.signals), "items without the new evidence keep the original measure");
  const installed = adoptionOf({ signals: { stars: 0, installs: 100000 } });
  const starred = adoptionOf({ signals: { stars: 100000, installs: 0 } });
  assert.ok(installed > 0.2 && Math.abs(installed - starred) < 1e-9, "100k installs weigh what 5k+ stars do");
  const honest = adoptionOf({ signals: { stars: 50000, installs: 10 }, reputation: { score: 0.5, inflated: false, starTrust: 1 } });
  const bought = adoptionOf({ signals: { stars: 50000, installs: 10 }, reputation: { score: 0.5, inflated: true, starTrust: 0.1 } });
  assert.ok(bought < honest / 2, `${bought} vs ${honest}`);
  const alone = adoptionOf({ signals: { stars: 3000, repoSkills: 1 } });
  const shared = adoptionOf({ signals: { stars: 3000, repoSkills: 300 } });
  assert.ok(shared < alone, "300 skills share the stars of their repository");
  assert.ok(adoptionOf({ signals: { stars: 1e9, installs: 1e9 }, reputation: { score: 1 } }) <= 0.5 + 1e-9, "same scale as before");
});

test("platforms: a mobile-only job is noise for a web app and a web-only job for a phone app; unknown platforms keep both", () => {
  const capPlatforms = { "mobile-testing": "mobile", "web-design-review": "web" };
  const mobile = { capabilities: ["mobile-testing"] };
  const web = { capabilities: ["web-design-review"] };
  const both = { capabilities: ["mobile-testing", "tdd-discipline"] };
  assert.equal(platformMismatch(mobile, { platforms: ["web"], capPlatforms }), true);
  assert.equal(platformMismatch(mobile, { platforms: ["mobile"], capPlatforms }), false);
  assert.equal(platformMismatch(web, { platforms: ["mobile"], capPlatforms }), true);
  assert.equal(platformMismatch(web, { platforms: ["web", "mobile"], capPlatforms }), false);
  assert.equal(platformMismatch(mobile, { platforms: [], capPlatforms }), false);
  assert.equal(platformMismatch(both, { platforms: ["web"], capPlatforms }), false, "a job that also works elsewhere stays");
  assert.equal(platformMismatch(web, { platforms: ["mobile"], webOnlyCaps: new Set(["web-design-review"]) }), true, "older demands still work");
});

const row = (id, { cluster = id, origin = "curated", derive, defaultEligible, score = 0.6, fit = 0.9, tier = "mission", chars = 100 } = {}) => ({
  item: { id, cluster, origin, ...(derive ? { derive } : {}), ...(defaultEligible === undefined ? {} : { defaultEligible }), tier, capabilities: [cluster], needs: [], stacks: ["*"], descriptionChars: chars },
  score, parts: { classFit: fit }, flags: [],
});

test("who wins a job: a hand-vetted pick, then a vetted catalog item, then a derived one, whatever the score", () => {
  assert.deepEqual([sourceRank({ origin: "curated" }), sourceRank({ origin: "lab" }), sourceRank({ origin: "lab", derive: "1" })], [0, 1, 2]);
  const scored = [
    row("derived-best", { cluster: "job", origin: "lab", derive: "1", score: 0.9 }),
    row("lab-vetted", { cluster: "job", origin: "lab", score: 0.7 }),
    row("curated", { cluster: "job", score: 0.5 }),
  ];
  const { selected } = selectSet(scored, { demand: { capabilitiesWanted: ["job"] } });
  assert.deepEqual(selected.map((s) => s.item.id), ["curated"]);
  const noCurated = selectSet(scored.slice(0, 2), { demand: { capabilitiesWanted: ["job"] } });
  assert.deepEqual(noCurated.selected.map((s) => s.item.id), ["lab-vetted"]);
});

test("a derived item without evidence is listed, never defaulted; it cannot make the engine unsure either", () => {
  const scored = [row("listed-only", { origin: "lab", derive: "1", defaultEligible: false, score: 0.9 }), row("proven", { origin: "lab", derive: "1", defaultEligible: true, score: 0.8 })];
  const { selected, skipped } = selectSet(scored, { demand: { capabilitiesWanted: ["listed-only", "proven"] } });
  assert.deepEqual(selected.map((s) => s.item.id), ["proven"]);
  assert.equal(skipped.find((s) => s.id === "listed-only").reason, GATE_REASONS.EVIDENCE_THIN);
  const thin = { capabilitiesWanted: ["x"], answered: [] };
  const tie = [row("a", { score: 0.8 }), row("b", { origin: "lab", derive: "1", defaultEligible: false, score: 0.79 })];
  assert.equal(uncertaintyOf(tie, thin).reason !== "thin-demand-tie", true);
  assert.equal(uncertaintyOf([row("a", { score: 0.8 }), row("c", { score: 0.79 })], thin).reason, "thin-demand-tie");
});

test("the fingerprint finds the products a project uses, from package families and files", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-products-"));
  tempDirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15", "@supabase/supabase-js": "2", "@aws-sdk/client-s3": "3", stripe: "18", "next-intl": "4", tailwindcss: "4" } }));
  mkdirSync(join(root, "prisma"));
  writeFileSync(join(root, "prisma", "schema.prisma"), "model User { id Int @id }\n");
  writeFileSync(join(root, "turbo.json"), "{}");
  mkdirSync(join(root, "messages"));
  mkdirSync(join(root, "locales"));
  writeFileSync(join(root, "locales", "tr.json"), "{}");
  const fp = await fingerprint(root);
  for (const s of ["supabase", "aws", "stripe", "prisma", "tailwind", "nextjs"]) assert.ok(fp.stacks.includes(s), `stack ${s}: ${fp.stacks}`);
  for (const n of ["i18n", "monorepo", "payments", "database"]) assert.ok(fp.inferredNeeds.includes(n), `need ${n}: ${fp.inferredNeeds}`);
  const py = mkdtempSync(join(tmpdir(), "rp-products-"));
  tempDirs.push(py);
  writeFileSync(join(py, "requirements.txt"), "google-cloud-storage==2\nazure-identity\nscanpy\npygame\n");
  const fp2 = await fingerprint(py);
  for (const s of ["gcp", "azure", "python"]) assert.ok(fp2.stacks.includes(s), `stack ${s}: ${fp2.stacks}`);
  for (const n of ["scientific", "game-dev"]) assert.ok(fp2.inferredNeeds.includes(n), `need ${n}: ${fp2.inferredNeeds}`);
  const android = mkdtempSync(join(tmpdir(), "rp-products-"));
  tempDirs.push(android);
  mkdirSync(join(android, "app", "src", "main"), { recursive: true });
  writeFileSync(join(android, "app", "src", "main", "AndroidManifest.xml"), "<manifest/>");
  writeFileSync(join(android, "app", "src", "main", "Main.kt"), "fun main() {}\n");
  writeFileSync(join(android, "settings.gradle.kts"), "\n");
  const fp3 = await fingerprint(android);
  assert.ok(fp3.platforms.includes("mobile") && fp3.inferredNeeds.includes("mobile"), JSON.stringify(fp3));
});
