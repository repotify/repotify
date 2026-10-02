import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runTestSuite, scanSecurity, composeScore } from "../lib/pipeline/test-runner/index.mjs";
import { runHeuristics, freshnessScore, maintenanceScore, docQualityScore } from "../lib/pipeline/test-runner/heuristics.mjs";
import { contentHashFor, cacheKey, cacheRead, cacheWrite } from "../lib/pipeline/test-runner/cache.mjs";
import { planLayers, significantChange, cumulativeDrift, isPresentable, isExpired, CHEAP_TTL_MS } from "../lib/pipeline/test-runner/retest.mjs";
import { JURY_RULES_V1, juryEligible, selectSeedJurors, runJuryDraft } from "../lib/pipeline/test-runner/jury-draft.mjs";
import { classifyCoarse } from "../lib/pipeline/classify/index.mjs";

const taxonomy = JSON.parse(readFileSync(new URL("../catalog/taxonomy.json", import.meta.url), "utf8"));
const benign = readFileSync(new URL("./fixtures/pipeline/benign-skill.md", import.meta.url), "utf8");
const malicious = readFileSync(new URL("./fixtures/pipeline/malicious-skill.md", import.meta.url), "utf8");
const NOW = new Date("2026-10-01T12:00:00Z");

const verdictJson = (quality, caps = ["pdf-processing"]) => JSON.stringify({
  summary: "Reads and writes PDF files.", capabilities: caps, needs: ["pdf"], stacks: ["*"], tier: "mission",
  quality, specificity: 0.7, maintenance: 0.8, suspicious: false,
});
const fakeChat = (qualities) => async ({ model }) => verdictJson(qualities[model] ?? 0.7);
const JURORS = [
  { provider: "nvidia", model: "nvidia/m1", family: "nvidia" },
  { provider: "nvidia", model: "google/m2", family: "google" },
  { provider: "nvidia", model: "openai/m3", family: "openai" },
];

test("the security gate is the existing scanner, unchanged", () => {
  assert.equal(scanSecurity({ text: benign }).level, "verified");
  const bad = scanSecurity({ text: malicious });
  assert.equal(bad.level, "rejected");
  assert.ok(bad.findings.some((f) => f.severity === "critical"));
  // A precomputed gate verdict passes through untouched.
  const pre = { level: "caution", findings: [{ rule: "x", severity: "medium" }] };
  assert.equal(scanSecurity({ text: benign, security: pre }).level, "caution");
});

test("heuristics are bounded and deterministic", () => {
  const h = runHeuristics({ text: benign, description: "Reads PDF files.", signals: { lastCommitDays: 10, stars: 500, license: "MIT" } });
  for (const k of ["freshness", "maintenance", "docQuality"]) {
    assert.ok(h[k].score >= 0 && h[k].score <= 1, `${k} in range`);
  }
  assert.deepEqual(runHeuristics({ text: benign, signals: {} }), runHeuristics({ text: benign, signals: {} }));
  assert.equal(freshnessScore(null).score, 0.5, "unknown age is neutral");
  assert.equal(freshnessScore(0).score, 1);
  assert.ok(freshnessScore(800).score < freshnessScore(10).score, "older commits score lower");
  assert.ok(docQualityScore({ text: "" }).score < docQualityScore({ text: benign }).score);
  assert.ok(maintenanceScore({ stars: 10000, license: "MIT", lastCommitDays: 1 }).score > maintenanceScore({ stars: 0, license: null, lastCommitDays: 900 }).score);
});

test("same content -> same score: the cache short-circuits the run", async () => {
  const cache = {};
  const item = { id: "pdf", text: benign, signals: { lastCommitDays: 5, stars: 100, license: "MIT" } };
  const r1 = await runTestSuite(item, { cache, taxonomy, now: NOW, classify: classifyCoarse });
  assert.equal(r1.fromCache, false);
  assert.ok(r1.score >= 0 && r1.score <= 1);
  assert.ok(r1.scoredAt && r1.expiresAt);
  assert.ok(r1.cheap.scoredAt && r1.cheap.expiresAt, "cheap layer carries scored_at + expires_at");
  const r2 = await runTestSuite(item, { cache, taxonomy, now: NOW, classify: classifyCoarse });
  assert.equal(r2.fromCache, true);
  assert.equal(r2.score, r1.score);
  assert.equal(r2.contentHash, r1.contentHash);
  assert.deepEqual(r2.labels, r1.labels);
});

test("a content change re-runs the cheap layer and changes the hash", async () => {
  const cache = {};
  const a = await runTestSuite({ id: "pdf", text: benign }, { cache, taxonomy, now: NOW });
  const b = await runTestSuite({ id: "pdf", text: benign + "\n\nExtra paragraph about tables." }, { cache, taxonomy, now: NOW });
  assert.equal(b.fromCache, false);
  assert.notEqual(b.contentHash, a.contentHash);
});

test("cache keys include every rule version", () => {
  const h = contentHashFor({ text: benign });
  const k1 = cacheKey(h, { cheap: "1", expensive: "1", score: "1", juryPrompt: "3", taxonomy: "7" });
  const k2 = cacheKey(h, { cheap: "2", expensive: "1", score: "1", juryPrompt: "3", taxonomy: "7" });
  assert.notEqual(k1, k2);
  const cache = {};
  assert.equal(cacheRead(cache, k1), null);
  cacheWrite(cache, k1, { score: 0.5 });
  assert.deepEqual(cacheRead(cache, k1), { score: 0.5 });
});

test("R3: the expensive layer re-runs only on significant change or 30-day expiry", () => {
  assert.equal(significantChange(null, { text: "x" }), true, "first run is significant");
  assert.equal(significantChange({ text: "abc", securityLevel: "verified" }, { text: "abc", securityLevel: "verified" }), false);
  const long = "x".repeat(1000);
  assert.equal(significantChange({ text: long, securityLevel: "verified" }, { text: long + "y".repeat(200), securityLevel: "verified" }), true, ">10% length change");
  assert.equal(significantChange({ text: long, securityLevel: "verified" }, { text: long + "y".repeat(50), securityLevel: "verified" }), false, "small edit");
  assert.equal(significantChange({ text: "abc", securityLevel: "verified" }, { text: "abc", securityLevel: "caution" }), true, "security level change");
});

test("planLayers: cheap on content change, expensive only when wanted and due", () => {
  const fresh = { contentHash: "h", text: "abc", securityLevel: "verified", cheap: { expiresAt: new Date(NOW.getTime() + 1000).toISOString() }, expensive: { ran: false } };
  const p1 = planLayers({ cached: fresh, contentHash: "h", text: "abc", securityLevel: "verified", juryWanted: false, nowMs: NOW.getTime() });
  assert.deepEqual([p1.cheap, p1.expensive], [false, false], "fresh cache: nothing runs");
  const p2 = planLayers({ cached: fresh, contentHash: "CHANGED", text: "abc!", securityLevel: "verified", juryWanted: false, nowMs: NOW.getTime() });
  assert.deepEqual([p2.cheap, p2.expensive], [true, false], "content change: cheap only");
  const p3 = planLayers({ cached: fresh, contentHash: "h", text: "abc", securityLevel: "verified", juryWanted: true, nowMs: NOW.getTime() });
  assert.deepEqual([p3.cheap, p3.expensive], [false, true], "wanted + never ran: expensive");
  const p4 = planLayers({ cached: null, contentHash: "h", text: "abc", securityLevel: null, juryWanted: true, nowMs: NOW.getTime() });
  assert.deepEqual([p4.cheap, p4.expensive], [true, true], "no cache: both");
});

test("cumulativeDrift: salami-slicing past the jury cannot keep a stale verdict", () => {
  assert.equal(cumulativeDrift(null, { text: "x", securityLevel: "verified" }), true, "unknown snapshot: re-jury once, safely");
  const snap = { textLength: 1000, securityLevel: "verified" };
  assert.equal(cumulativeDrift(snap, { text: "x".repeat(1080), securityLevel: "verified" }), false, "8% cumulative drift is not significant");
  assert.equal(cumulativeDrift(snap, { text: "x".repeat(1150), securityLevel: "verified" }), true, "15% cumulative drift re-runs the jury");
  assert.equal(cumulativeDrift(snap, { text: "x".repeat(1000), securityLevel: "caution" }), true, "security level change since jury time");
  // The expensive plan uses the jury-time snapshot, not the last run.
  const judged = {
    contentHash: "h", text: "x".repeat(1150), securityLevel: "verified",
    cheap: { expiresAt: new Date(NOW.getTime() + 1000).toISOString() },
    expensive: { ran: true, textLength: 1000, securityLevel: "verified", expiresAt: new Date(NOW.getTime() + 1000).toISOString() },
  };
  const p = planLayers({ cached: judged, contentHash: "h", text: "x".repeat(1150), securityLevel: "verified", juryWanted: true, nowMs: NOW.getTime() });
  assert.deepEqual([p.cheap, p.expensive], [false, true], "cumulative drift since jury -> expensive");
  assert.ok(p.reason.some((r) => r.includes("cumulative drift")));
});

test("stale scores cannot enter presentation", () => {
  const rec = {
    security: { level: "verified" },
    cheap: { expiresAt: new Date(NOW.getTime() + 1000).toISOString() },
    expensive: { ran: false },
  };
  assert.equal(isPresentable(rec, NOW.getTime()).ok, true);
  assert.equal(isPresentable({ ...rec, cheap: { expiresAt: new Date(NOW.getTime() - 1000).toISOString() } }, NOW.getTime()).ok, false, "stale cheap layer");
  assert.equal(isPresentable({ ...rec, security: { level: "rejected" } }, NOW.getTime()).ok, false, "rejected is never presentable");
  assert.equal(isPresentable({ ...rec, security: { level: "quarantined" } }, NOW.getTime()).ok, false, "quarantined is never presentable");
  assert.equal(isPresentable({ ...rec, expensive: { ran: true, expiresAt: new Date(NOW.getTime() - 1000).toISOString() } }, NOW.getTime()).ok, false, "stale expensive layer");
  assert.equal(isExpired(new Date(NOW.getTime() - 1).toISOString(), NOW.getTime()), true);
  assert.equal(isExpired(new Date(NOW.getTime() + CHEAP_TTL_MS).toISOString(), NOW.getTime()), false);
});

test("E3 draft jury: three families, median+voting, no debate, temperature 0", async () => {
  assert.equal(JURY_RULES_V1.status, "draft");
  assert.equal(JURY_RULES_V1.jurors, 3);
  assert.equal(JURY_RULES_V1.distinctFamilies, true);
  assert.equal(JURY_RULES_V1.aggregation, "median+voting");
  assert.equal(JURY_RULES_V1.debate, false);
  assert.equal(JURY_RULES_V1.temperature, 0);
  assert.equal(JURY_RULES_V1.costGate, "seed-or-critical-only");
  assert.equal(juryEligible({ editorial: true }), true);
  assert.equal(juryEligible({ critical: true }), true);
  assert.equal(juryEligible({}), false, "a plain discovered item is not jury-eligible in v1");

  const picked = selectSeedJurors([
    { provider: "nvidia", model: "nvidia/b", family: "nvidia" },
    { provider: "nvidia", model: "nvidia/a", family: "nvidia" },
    { provider: "nvidia", model: "google/g", family: "google" },
    { provider: "nvidia", model: "openai/o", family: "openai" },
  ]);
  assert.deepEqual(picked.map((j) => j.family), ["google", "nvidia", "openai"], "distinct families, deterministic order");

  const seen = [];
  const chat = async (args) => {
    seen.push(args);
    return verdictJson({ "nvidia/m1": 0.9, "google/m2": 0.7, "openai/m3": 0.5 }[args.model]);
  };
  const jury = await runJuryDraft({ id: "pdf", type: "skill" }, benign, { chat, jurors: JURORS, taxonomy });
  assert.equal(jury.quality, 0.7, "median of 0.9/0.7/0.5");
  assert.deepEqual(jury.jurorFamilies, ["nvidia", "google", "openai"]);
  assert.equal(jury.temperature, 0);
  assert.equal(jury.debate, false);
  assert.equal(jury.rules, "draft");
  for (const s of seen) {
    assert.equal(s.temperature, 0, "every call is temperature 0");
    assert.ok(s.seed != null, "every call carries a varied seed");
  }
  assert.equal(new Set(seen.map((s) => s.seed)).size, 2, "varied seeds across repetitions");
  assert.ok(jury.capabilities.includes("pdf-processing"), "majority voting keeps shared labels");
  assert.equal(jury.unstable, false, "agreeing seeds are stable");
  assert.equal(jury.seedSpread, 0);
});

test("a juror whose seeds disagree is flagged unstable (T=0 is not deterministic)", async () => {
  const chat = async ({ seed }) => verdictJson(seed === 7 ? 0.9 : 0.4);
  const jury = await runJuryDraft({ id: "pdf", type: "skill" }, benign, { chat, jurors: JURORS.slice(0, 1), taxonomy });
  assert.equal(jury.unstable, true);
  assert.ok(Math.abs(jury.seedSpread - 0.5) < 1e-9);
});

test("the draft jury tolerates a failing juror and returns null when all fail", async () => {
  const chat = async ({ model }) => {
    if (model === "google/m2") throw new Error("boom");
    return verdictJson(0.8);
  };
  const jury = await runJuryDraft({ id: "pdf", type: "skill" }, benign, { chat, jurors: JURORS, taxonomy });
  assert.equal(jury.models.length, 2);
  const none = await runJuryDraft({ id: "pdf", type: "skill" }, benign, { chat: async () => { throw new Error("down"); }, jurors: JURORS, taxonomy });
  assert.equal(none, null);
});

test("runTestSuite runs the jury only for eligible items (v1 cost gate)", async () => {
  const chat = fakeChat({});
  const seed = await runTestSuite({ id: "seed-item", editorial: true, text: benign, signals: { lastCommitDays: 2 } }, { cache: {}, taxonomy, chat, jurors: JURORS, now: NOW, classify: classifyCoarse });
  assert.ok(seed.jury, "editorial item gets a jury");
  assert.equal(seed.qualitySource, "jury");
  assert.equal(seed.expensive.ran, true);
  assert.ok(seed.expensive.scoredAt && seed.expensive.expiresAt, "expensive layer carries scored_at + expires_at");

  const discovered = await runTestSuite({ id: "disc-item", text: benign, signals: { lastCommitDays: 2 } }, { cache: {}, taxonomy, chat, jurors: JURORS, now: NOW, classify: classifyCoarse });
  assert.equal(discovered.jury, null, "plain discovered item skips the jury in v1");
  assert.equal(discovered.qualitySource, "proxy");
  assert.equal(discovered.expensive.ran, false);
  assert.ok(discovered.score >= 0 && discovered.score <= 1);
});

test("jury promotion: a strong discovered item earns a one-time jury run", async () => {
  const strong = `# Strong Skill\n\nA very capable skill that does important things well.\n\n## Usage\n\nFollow these steps.\n\n## Examples\n\n\`\`\`\nrun --help\n\`\`\`\n\n## API\n\nMore docs. `.repeat(20);
  const chat = fakeChat({});
  const item = { id: "strong-disc", text: strong, description: "A very capable skill", signals: { lastCommitDays: 1, stars: 5000, license: "MIT" } };
  const cache = {};
  const r = await runTestSuite(item, { cache, taxonomy, chat, jurors: JURORS, now: NOW, classify: classifyCoarse });
  assert.ok(r.proxyScore >= 0.8, `proxy score ${r.proxyScore} reaches the promotion threshold`);
  assert.equal(r.juryPromoted, true);
  assert.ok(r.jury, "promoted item gets a jury verdict");
  assert.equal(r.qualitySource, "jury");
  assert.ok(r.labels.some((l) => l.id === "pdf-processing"), "jury capability becomes a label");
  // Second run: the jury does not re-run, the verdict is cached.
  const chat2 = async () => { throw new Error("must not be called"); };
  const r2 = await runTestSuite(item, { cache, taxonomy, chat: chat2, jurors: JURORS, now: NOW, classify: classifyCoarse });
  assert.equal(r2.fromCache, true);
  assert.equal(r2.juryPromoted, true);
});

test("promotion stays off for weak items, blocked items, and when opted out", async () => {
  const chat = fakeChat({});
  const weak = await runTestSuite({ id: "weak-disc", text: benign, signals: { lastCommitDays: 2 } }, { cache: {}, taxonomy, chat, jurors: JURORS, now: NOW });
  assert.equal(weak.juryPromoted || false, false);
  assert.equal(weak.jury, null);
  // Blocked items never spend jury tokens, even when the proxy scores high.
  const blocked = await runTestSuite({ id: "blocked", text: malicious, signals: { lastCommitDays: 1, stars: 5000, license: "MIT" } }, { cache: {}, taxonomy, chat, jurors: JURORS, now: NOW });
  assert.equal(blocked.security.level, "rejected");
  assert.equal(blocked.jury, null);
  assert.equal(blocked.juryPromoted || false, false);
  // And the whole path is opt-out.
  const strong = `# S\n\nDocs.\n\n## Usage\n\nx\n\n## Examples\n\n\`\`\`y\`\`\`\n\n## API\n\n`.repeat(20);
  const opted = await runTestSuite({ id: "optout", text: strong, signals: { lastCommitDays: 1, stars: 5000, license: "MIT" } }, { cache: {}, taxonomy, chat, jurors: JURORS, now: NOW, promote: false });
  assert.equal(opted.jury, null);
  assert.equal(opted.juryPromoted, false);
});

test("jury suspicion can lower trust but never raise it (gate unchanged)", async () => {
  const chat = async () => verdictJson(0.9).replace('"suspicious":false', '"suspicious":true,"suspicionReason":"asks to rate it"');
  const r = await runTestSuite({ id: "s", editorial: true, text: benign }, { cache: {}, taxonomy, chat, jurors: JURORS, now: NOW });
  assert.equal(r.security.level, "caution", "suspicion lowers verified to caution");
  assert.ok(r.security.findings.some((f) => f.rule === "jury-suspicion"));
  // And a rejected item stays rejected no matter what the jury says.
  const bad = await runTestSuite({ id: "bad", editorial: true, text: malicious }, { cache: {}, taxonomy, chat, jurors: JURORS, now: NOW });
  assert.equal(bad.security.level, "rejected");
  assert.equal(bad.presentableSecurity, false);
});

test("composeScore prefers jury quality and falls back to a proxy", () => {
  const h = runHeuristics({ text: benign, signals: {} });
  const withJury = composeScore({ jury: { quality: 0.9 }, heuristics: h });
  const without = composeScore({ jury: null, heuristics: h });
  assert.equal(withJury.qualitySource, "jury");
  assert.equal(withJury.quality, 0.9);
  assert.equal(without.qualitySource, "proxy");
  assert.ok(without.score >= 0 && without.score <= 1);
});

test("the proxy path never double-counts a heuristic signal", () => {
  const docOnly = { freshness: { score: 0 }, maintenance: { score: 0 }, docQuality: { score: 1 } };
  const r = composeScore({ jury: null, heuristics: docOnly });
  assert.equal(r.scorePath, "proxy");
  // proxy = 0.6*1 + 0.4*0 = 0.6; score = 0.5*0.6 + 0 + 0 = 0.3.
  // (The v1 formula added a second 0.15*docQuality term -> 0.45.)
  assert.equal(r.score, 0.3);
  const juryPath = composeScore({ jury: { quality: 0.9 }, heuristics: docOnly });
  assert.equal(juryPath.scorePath, "jury");
  assert.equal(juryPath.score, 0.6); // 0.5*0.9 + 0.15*1
});

test("classification labels come out of the test run", async () => {
  const chat = fakeChat({});
  const r = await runTestSuite({ id: "pdf", editorial: true, text: benign }, { cache: {}, taxonomy, chat, jurors: JURORS, now: NOW, classify: classifyCoarse });
  assert.ok(r.labels.length >= 1 && r.labels.length <= 5);
  assert.ok(r.labels.some((l) => l.id === "pdf-processing"), "jury capability becomes a label");
  assert.ok(["high", "medium", "low"].includes(r.labelConfidence));
});
