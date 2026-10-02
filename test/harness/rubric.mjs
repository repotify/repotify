// Deterministic scoring: routing (agent's declared skill list vs ground truth)
// and task rubric (deterministic content checks on the deliverable). No LLM judge.
const norm = (s) => (s ?? "").toLowerCase();

// Extract the agent's declared skill ids from the SKILLS: contract line.
export function parseChosenSkills(text, offeredIds = []) {
  const offered = new Set(offeredIds.map((x) => x.toLowerCase()));
  const m = /^skills:\s*(.*)$/gim.exec(text ?? "");
  if (!m) return { found: false, chosen: [], valid: [], hallucinated: [] };
  const raw = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.length === 1 && /^none$/i.test(raw[0])) return { found: true, chosen: [], valid: [], hallucinated: [] };
  const chosen = [...new Set(raw.map((s) => s.toLowerCase()))];
  return {
    found: true,
    chosen,
    valid: chosen.filter((c) => offered.has(c)),
    hallucinated: chosen.filter((c) => !offered.has(c)),
  };
}

// Deliverable = text after the DELIVERABLE: marker (fallback: whole reply).
export function extractDeliverable(text) {
  const i = norm(text ?? "").indexOf("deliverable:");
  if (i < 0) return (text ?? "").trim();
  return text.slice(i + "deliverable:".length).trim();
}

// One rubric check: contains | regex | not-contains. Regex is case-insensitive.
export function scoreCheck(text, check) {
  const t = text ?? "";
  if (check.check === "contains") return norm(t).includes(norm(check.pattern)) ? check.points : 0;
  if (check.check === "not-contains") return norm(t).includes(norm(check.pattern)) ? 0 : check.points;
  if (check.check === "regex") return new RegExp(check.pattern, "i").test(t) ? check.points : 0;
  throw new Error(`unknown check type: ${check.check}`);
}

export function scoreRubric(deliverable, rubric = []) {
  const perCheck = rubric.map((c) => ({ id: c.id, earned: scoreCheck(deliverable, c), max: c.points }));
  const earned = perCheck.reduce((n, c) => n + c.earned, 0);
  const max = perCheck.reduce((n, c) => n + c.max, 0);
  return { earned, max, score: max ? earned / max : 0, perCheck };
}

// nDCG@k: position-aware routing quality. precision/recall/F1 are set-based —
// they score the chosen SET; recommendation is a RANKING problem and the user
// sees the top first. Binary relevance: 1 if the chosen skill is must-include.
// FAZ 11 (Q-B).
export function ndcgAtK(chosenValid, scenario, k = 5) {
  const must = new Set((scenario.mustInclude ?? []).map((s) => s.toLowerCase()));
  if (!must.size || !chosenValid.length || k <= 0) return 0;
  const kk = Math.min(k, chosenValid.length);
  let dcg = 0;
  for (let i = 0; i < kk; i++) {
    if (must.has(chosenValid[i])) dcg += 1 / Math.log2(i + 2);
  }
  // Ideal: all must-hits at the top, capped at k.
  const idealHits = Math.min(must.size, kk);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? +(dcg / idcg).toFixed(3) : 0;
}

// Routing: recall on must-include; precision against the offered set; violations on must-not-include.
export function scoreRouting(chosenValid, scenario, offeredCount = 0) {
  const must = new Set((scenario.mustInclude ?? []).map((s) => s.toLowerCase()));
  const mustNot = new Set((scenario.mustNotInclude ?? []).map((s) => s.toLowerCase()));
  const hits = chosenValid.filter((c) => must.has(c));
  const violations = chosenValid.filter((c) => mustNot.has(c));
  const recall = must.size ? hits.length / must.size : 1;
  const precision = chosenValid.length ? hits.length / chosenValid.length : (must.size ? 0 : 1);
  const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
  return {
    recall, precision: +precision.toFixed(3), f1: +f1.toFixed(3),
    ndcg: ndcgAtK(chosenValid, scenario),
    hits: hits.length, of: must.size, chosen: chosenValid.length,
    violations: violations.length, violationIds: violations,
  };
}

// Token estimate: the NIM path used by the nvidia skill does not surface usage,
// so we estimate 1 token ≈ 4 chars (documented limitation in METHOD.md).
export const estTokens = (chars) => Math.round(chars / 4);
