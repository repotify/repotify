import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fitScore, qualityScore, trustScore, adoptionScore, freshnessScore, communityScore, scoreItem, WEIGHTS,
} from "../src/recommend.mjs";

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} ${a} != ${b}`);
const base = {
  id: "x", type: "skill", tier: "mission", stacks: ["*"], capabilities: ["pdf-processing"], needs: ["pdf"],
  signals: { stars: 0, starVelocity30d: 0, coUsage: 0, mentions30d: 0, lastCommitDays: null },
  jury: null, community: { shown: 0, selected: 0, kept7d: 0, removed: 0, rating: 0, votes: 0 },
  security: { level: "verified" }, badges: [],
};
const ctx = (o = {}) => ({ stacks: [], needs: [], capabilitiesWanted: [], loadoutIds: [], ...o });

test("weights are the documented ones", () => {
  assert.deepEqual(WEIGHTS, { quality: 0.35, trust: 0.25, adoption: 0.2, freshness: 0.1, community: 0.1 });
});

test("fit: core is always 1", () => {
  assert.deepEqual(fitScore({ ...base, tier: "core" }, ctx()), { fit: 1, reasons: ["core"] });
});

test("fit: capability matches are strong, need-only matches are weaker", () => {
  close(fitScore(base, ctx({ capabilitiesWanted: ["pdf-processing"], needs: ["pdf"] })).fit, 0.8);
  close(fitScore({ ...base, capabilities: ["pdf-processing", "docx-documents"] }, ctx({ capabilitiesWanted: ["pdf-processing", "docx-documents"] })).fit, 0.9);
  close(fitScore(base, ctx({ needs: ["pdf"] })).fit, 0.5);
  close(fitScore({ ...base, needs: ["pdf", "office-docs"] }, ctx({ needs: ["pdf", "office-docs"] })).fit, 0.6);
  assert.equal(fitScore(base, ctx()).fit, 0);
  assert.deepEqual(fitScore(base, ctx({ capabilitiesWanted: ["pdf-processing"], needs: ["pdf"] })).reasons, ["cap:pdf-processing", "need:pdf"]);
});

test("fit: stack tier needs a matching stack; mission items with foreign stacks are halved", () => {
  const stackItem = { ...base, tier: "stack", stacks: ["react", "nextjs"], capabilities: ["react-performance"], needs: ["performance"] };
  assert.equal(fitScore(stackItem, ctx({ stacks: ["python"] })).fit, 0);
  close(fitScore(stackItem, ctx({ stacks: ["nextjs"] })).fit, 0.6);
  close(fitScore(stackItem, ctx({ stacks: ["nextjs"], capabilitiesWanted: ["react-performance"] })).fit, 0.6 + 0.4 * 0.8);
  assert.ok(fitScore(stackItem, ctx({ stacks: ["nextjs"] })).reasons.includes("stack:nextjs"));
  const foreign = { ...base, stacks: ["python"] };
  close(fitScore(foreign, ctx({ stacks: ["node"], capabilitiesWanted: ["pdf-processing"] })).fit, 0.4);
});

test("fit: loadout membership lifts to 0.9", () => {
  const r = fitScore(base, ctx({ loadoutIds: ["x"] }));
  close(r.fit, 0.9);
  assert.ok(r.reasons.includes("loadout"));
});

test("quality: prior without jury, mean of sub-scores, clipped when jurors disagree", () => {
  assert.equal(qualityScore(null), 0.5);
  close(qualityScore({ quality: 0.8, specificity: 0.6, maintenance: 1, agreement: 1 }), 0.8);
  close(qualityScore({ quality: 0.8, specificity: 0.6, maintenance: 1, agreement: 0.2 }), 0.8 - 0.4 * 0.5);
  assert.equal(qualityScore({ quality: 0, specificity: 0, maintenance: 0, agreement: 0 }), 0);
});

test("trust: verified 1, caution 0.6, anything else excluded", () => {
  assert.equal(trustScore("verified"), 1);
  assert.equal(trustScore("caution"), 0.6);
  assert.equal(trustScore("quarantined"), null);
  assert.equal(trustScore("rejected"), null);
});

test("adoption is log-scaled with a popularity cap", () => {
  close(adoptionScore({ stars: 5000, starVelocity30d: 100, coUsage: 999, mentions30d: 10 }), 0.85);
  close(adoptionScore({ stars: 500000, starVelocity30d: 0, coUsage: 0, mentions30d: 0 }), 0.5);
  assert.equal(adoptionScore({ stars: null }), 0);
});

test("freshness decays from 30 to 365 days", () => {
  assert.equal(freshnessScore(10), 1);
  assert.equal(freshnessScore(30), 1);
  close(freshnessScore(197.5), 0.5);
  assert.equal(freshnessScore(400), 0);
  assert.equal(freshnessScore(null), 0.5);
});

test("community uses a Bayesian average so new items are not punished", () => {
  close(communityScore({ shown: 0, selected: 0, kept7d: 0, rating: 0, votes: 0 }), 0.4 * 0.3 + 0.4 * 0.7 + 0.2 * 0.5);
  const strong = communityScore({ shown: 1000, selected: 900, kept7d: 880, rating: 0.95, votes: 400 });
  const weak = communityScore({ shown: 1000, selected: 50, kept7d: 5, rating: 0.1, votes: 400 });
  assert.ok(strong > 0.8 && weak < 0.2, `${strong} ${weak}`);
});

test("scoreItem combines the parts with the documented weights", () => {
  const item = { ...base, tier: "core", jury: { quality: 0.8, specificity: 0.6, maintenance: 1, agreement: 1 },
    signals: { stars: 5000, starVelocity30d: 100, coUsage: 999, mentions30d: 10, lastCommitDays: 30 } };
  const r = scoreItem(item, ctx());
  close(r.score, 0.85);
  close(r.parts.adoption, 0.85);
  assert.ok(r.badges.includes("verified"));
  assert.ok(r.badges.includes("trending"));
});

test("a small precise repo beats a huge irrelevant one (R9)", () => {
  const small = { ...base, id: "small", capabilities: ["pdf-processing", "docx-documents", "spreadsheets"], jury: { quality: 0.9, specificity: 0.9, maintenance: 0.9, agreement: 1 },
    signals: { stars: 100, starVelocity30d: 0, coUsage: 0, mentions30d: 0, lastCommitDays: 5 } };
  const big = { ...base, id: "big", capabilities: ["frontend-design"], needs: ["pdf"], stacks: ["python"], jury: { quality: 0.9, specificity: 0.9, maintenance: 0.9, agreement: 1 },
    signals: { stars: 50000, starVelocity30d: 500, coUsage: 5000, mentions30d: 50, lastCommitDays: 1 } };
  const c = ctx({ stacks: ["node"], needs: ["pdf", "office-docs"], capabilitiesWanted: ["pdf-processing", "docx-documents", "spreadsheets"] });
  assert.ok(scoreItem(small, c).score > scoreItem(big, c).score);
});

test("badges: gem for high quality, high fit, low adoption; trending; caution", () => {
  const gem = { ...base, jury: { quality: 0.9, specificity: 0.9, maintenance: 0.9, agreement: 1 }, signals: { stars: 40, starVelocity30d: 0, coUsage: 0, mentions30d: 0, lastCommitDays: 2 } };
  const c = ctx({ capabilitiesWanted: ["pdf-processing", "docx-documents"], needs: ["pdf"] });
  assert.ok(scoreItem({ ...gem, capabilities: ["pdf-processing", "docx-documents"] }, c).badges.includes("gem"));
  assert.ok(scoreItem({ ...gem, signals: { ...gem.signals, starVelocity30d: 150 } }, c).badges.includes("trending"));
  assert.ok(scoreItem({ ...gem, security: { level: "caution" } }, c).badges.includes("caution"));
});

test("excluded items return null", () => {
  assert.equal(scoreItem({ ...base, security: { level: "quarantined" } }, ctx({ capabilitiesWanted: ["pdf-processing"] })), null);
  assert.equal(scoreItem(base, ctx()), null);
});

test("fit: loadout membership also lifts stack items when an empty project has no stacks yet", () => {
  const stackItem = { ...base, id: "rbp", tier: "stack", stacks: ["react", "nextjs"], capabilities: ["react-performance"], needs: ["performance"] };
  const r = fitScore(stackItem, ctx({ stacks: [], loadoutIds: ["rbp"], loadout: "nextjs-saas" }));
  close(r.fit, 0.9);
  assert.ok(r.reasons.includes("loadout:nextjs-saas"));
});
