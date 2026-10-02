// Cheap, deterministic heuristics for the v1 test runner (FAZ 2.1).
// All scores are in [0, 1] and derived from observable item signals only —
// no LLM, no network. Every function is pure and fully deterministic.
export const HEURISTICS_VERSION = "1";

// Freshness from the repo's last-commit age. Unknown age is neutral (0.5),
// never a reward and never a punishment.
export function freshnessScore(lastCommitDays) {
  if (lastCommitDays == null || !Number.isFinite(lastCommitDays)) {
    return { score: 0.5, days: null, basis: "unknown" };
  }
  const days = Math.max(0, Math.floor(lastCommitDays));
  const score = days <= 0 ? 1 : Math.max(0, 1 - days / 730);
  return { score: round3(score), days, basis: "last-commit" };
}

// Maintenance: does the repo look cared for? Stars are log-scaled so a
// viral outlier cannot dominate; a recognizable license counts; recency
// is reused from freshness.
export function maintenanceScore({ stars = null, license = null, lastCommitDays = null } = {}) {
  const starScore = stars == null || !Number.isFinite(stars) ? 0.5 : Math.min(1, Math.log10(Math.max(0, stars) + 1) / 4);
  const licenseScore = typeof license === "string" && license && license !== "unknown" && license !== "NOASSERTION" ? 1 : 0;
  const recency = freshnessScore(lastCommitDays).score;
  const score = 0.4 * starScore + 0.3 * licenseScore + 0.3 * recency;
  return { score: round3(score), starScore: round3(starScore), licenseScore, recency };
}

// Documentation quality: length, structure and worked examples. A skill is
// read by an agent, so structure (headings, code blocks) matters more than
// raw character count.
export function docQualityScore({ text = "", description = "" } = {}) {
  const body = String(text ?? "");
  const lengthScore = Math.min(1, body.length / 4000);
  const headings = (body.match(/^#{1,4}\s+\S/gm) ?? []).length;
  const headingScore = Math.min(1, headings / 8);
  const fences = (body.match(/```/g) ?? []).length;
  const codeScore = Math.min(1, Math.floor(fences / 2) / 4);
  const desc = String(description ?? "").trim();
  const descScore = desc.length >= 20 ? 1 : desc.length > 0 ? 0.5 : 0;
  const score = 0.4 * lengthScore + 0.2 * headingScore + 0.2 * codeScore + 0.2 * descScore;
  return {
    score: round3(score),
    chars: body.length,
    headings,
    codeBlocks: Math.floor(fences / 2),
    lengthScore: round3(lengthScore),
    headingScore: round3(headingScore),
    codeScore: round3(codeScore),
    descScore,
  };
}

export function runHeuristics({ text = "", description = "", signals = {} } = {}) {
  const freshness = freshnessScore(signals.lastCommitDays);
  const maintenance = maintenanceScore({ stars: signals.stars, license: signals.license, lastCommitDays: signals.lastCommitDays });
  const docQuality = docQualityScore({ text, description });
  return { freshness, maintenance, docQuality, version: HEURISTICS_VERSION };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
