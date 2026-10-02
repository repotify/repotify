// Information-gain question ordering: ask the question that prunes the most
// candidate branches first. Cascade: signal (fingerprint) -> memory (answered,
// demand) -> question. A question is only worth asking when the prior tiers
// left genuine ambiguity; the ordering picks the maximum expected elimination
// per question, so the agent asks the fewest questions possible.
//
// Expected elimination for a question q with options o:
//   E[q] = sum_o P(o) * (1 - |C_o| / |C|)
// where C_o is the candidate subset surviving answer o. Single-choice uses a
// uniform prior over options; multi-select treats each option as an
// independent yes/no with P(yes) from the demand need weights (default 0.5).
// Deterministic: ties break by question id.

import { questionBank } from "../../../src/needs.mjs";

const intersect = (a = [], b = []) => a.filter((x) => b.includes(x));

// Which candidates would an answer to this question keep?
function survivorsForOption(question, optionId, candidates, taxonomy) {
  if (question.id === "projectType") {
    const needs = taxonomy.projectTypes?.[optionId]?.needs ?? [];
    return candidates.filter((c) => {
      const it = c.item;
      return intersect(it.needs ?? [], needs).length > 0 ||
        needs.some((n) => intersect(it.capabilities ?? [], taxonomy.needs?.[n]?.capabilities ?? []).length > 0);
    });
  }
  if (question.id === "priorities") {
    // Priorities map to needs via the same table src/needs.mjs uses.
    const map = { security: ["security"], quality: ["testing"] };
    const needs = map[optionId] ?? [];
    return candidates.filter((c) => intersect(c.item.needs ?? [], needs).length > 0);
  }
  // "needs" question: the need's capabilities or the need itself.
  const caps = taxonomy.needs?.[optionId]?.capabilities ?? [];
  return candidates.filter(
    (c) => (c.item.needs ?? []).includes(optionId) || intersect(c.item.capabilities ?? [], caps).length > 0,
  );
}

function expectedElimination(question, candidates, taxonomy, demand) {
  const n = candidates.length;
  if (!n || !question.options?.length) return 0;
  if (!question.multi) {
    const p = 1 / question.options.length;
    return question.options.reduce((sum, o) => {
      const kept = survivorsForOption(question, o.id, candidates, taxonomy).length;
      return sum + p * (1 - kept / n);
    }, 0);
  }
  // Multi-select: independent yes/no per option; "no" keeps the complement.
  const weights = demand?.needWeights ?? {};
  return question.options.reduce((sum, o) => {
    const kept = survivorsForOption(question, o.id, candidates, taxonomy).length;
    const pYes = weights[o.id] ?? 0.5;
    const elimYes = 1 - kept / n;
    const elimNo = 1 - (n - kept) / n;
    return sum + pYes * elimYes + (1 - pYes) * elimNo;
  }, 0) / Math.max(1, question.options.length);
}

// Order the question bank by expected information gain. Returns
// [{ question, expectedElimination }] sorted best-first.
export function orderQuestions(questions, candidates, taxonomy, demand) {
  return questions
    .map((q) => ({ question: q, expectedElimination: expectedElimination(q, candidates, taxonomy, demand) }))
    .sort((a, b) => b.expectedElimination - a.expectedElimination || (a.question.id < b.question.id ? -1 : 1));
}

// Convenience: build the bank from the fingerprint and order it in one call.
export function questionsByGain({ taxonomy, fingerprint, candidates, demand }) {
  return orderQuestions(questionBank(taxonomy, fingerprint), candidates, taxonomy, demand);
}

// The cascade decision: do we even need to ask? Returns null when the signal
// and memory tiers already settled it, otherwise the top-ranked question.
// Expected-elimination ordering (myopic VoI): the question whose answers
// prune the most candidates goes first. ASSUMPTION: uniform prior over
// answers — expected over what distribution is unmodeled (no answer priors
// exist yet; Stage 0 telemetry should supply them). maxQuestions=3 is a
// hand-set UX bound, not a measurement.
export function nextQuestion(ranked, { scored, minGain = 0.05, maxQuestions = 3, asked = 0 } = {}) {
  if (asked >= maxQuestions) return null;
  if (!scored?.length) return ranked[0]?.question ?? null;
  // Settled: a clear winner with no low-confidence flags on it.
  const [top, second] = scored;
  const clear = second ? top.score - second.score >= 0.08 : true;
  if (clear && !(top.flags ?? []).some((f) => ["thin-demand", "unmet-requirements", "low-margin"].includes(f))) return null;
  const best = ranked[0];
  if (!best || best.expectedElimination < minGain) return null;
  return best.question;
}
