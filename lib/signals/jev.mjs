// Jev (TypeSafe's "System One" decision model) client.
//
// Jev answers typed questions about a state with probabilities instead of text:
//   noul   — yes/no, answer { noul: p(yes) }
//   choice — one of named options, answer { choice, confidence, probabilities }
//   score  — a position on an ordered scale, answer { score, confidence, probabilities, legend }
// Docs: https://openrouter.ai/docs/guides/community/jev-tutorial
//
// Jev is a SIGNAL, never the decision maker: deterministic rules decide, and a
// Jev answer only counts when its probability clears the caller's bar. Every
// call degrades gracefully: no key, disabled, slow, HTTP error or a malformed
// answer all return null, and the caller carries on without it.
//
// The endpoint, key and model come from the environment, so any Jev-compatible
// decision model works unchanged (e.g. Cloudflare's open-weight Clef):
//   JEV_API_KEY (or OPENROUTER_API_KEY), JEV_ENDPOINT, JEV_MODEL, REPOTIFY_JEV=off.

export const DEFAULT_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_MODEL = "typesafe/jev-1.13";
export const DEFAULT_TIMEOUT_MS = 30000;

export function jevConfig(env = process.env) {
  return {
    key: env.JEV_API_KEY || env.OPENROUTER_API_KEY || null,
    endpoint: env.JEV_ENDPOINT || DEFAULT_ENDPOINT,
    model: env.JEV_MODEL || DEFAULT_MODEL,
    disabled: env.REPOTIFY_JEV === "off",
  };
}

// One request: every question is about the same state and is answered in
// parallel by the model. Returns { answers, usage, model } or null.
export async function decide(state, questions, { env = process.env, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, key, endpoint, model } = {}) {
  const cfg = jevConfig(env);
  if (cfg.disabled) return null;
  const apiKey = key ?? cfg.key;
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetchImpl(endpoint ?? cfg.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: model ?? cfg.model, state, questions }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || typeof body.answers !== "object" || body.answers === null) return null;
    return { answers: body.answers, usage: body.usage ?? null, model: body.model ?? null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const probs = (p) => Object.fromEntries(Object.entries(p ?? {}).map(([k, v]) => [k, num(v)]).filter(([, v]) => v !== null).map(([k, v]) => [k, clamp01(v)]));

// Parse one answer by type. Returns null when it is not the shape Jev documents.
export function parseAnswer(answer, question) {
  if (!answer || typeof answer !== "object") return null;
  if (question.type === "noul") {
    const p = num(answer.noul);
    return p === null ? null : { value: p >= 0.5, probability: clamp01(p) };
  }
  if (question.type === "choice") {
    const options = Object.keys(question.criteria ?? {});
    if (typeof answer.choice !== "string" || !options.includes(answer.choice)) return null;
    const probabilities = probs(answer.probabilities);
    return { option: answer.choice, probability: probabilities[answer.choice] ?? null, confidence: num(answer.confidence), probabilities };
  }
  if (question.type === "score") {
    const s = num(answer.score);
    return s === null ? null : { score: s, confidence: num(answer.confidence), probabilities: probs(answer.probabilities), legend: answer.legend ?? null };
  }
  return null;
}

// Ask several typed questions about one state. Returns { [id]: parsed answer | null } or null when the call failed.
export async function ask(state, questions, opts = {}) {
  const res = await decide(state, questions, opts);
  if (!res) return null;
  const out = {};
  for (const [id, q] of Object.entries(questions)) out[id] = parseAnswer(res.answers[id], q);
  return out;
}

// Pick one of several named options. options: { key: "description" }.
export async function jevChoice(state, options, instructions, opts = {}) {
  const r = await ask(state, { pick: { type: "choice", instructions, criteria: options } }, opts);
  return r?.pick ?? null;
}

// Yes/no on one or more named criteria, asked together. criteria: { name: "what yes means" }.
// Returns { truth: { name: boolean }, probability: { name } } only when every criterion parsed.
export async function jevNoul(state, criteria, instructions, opts = {}) {
  const questions = {};
  for (const [name, yes] of Object.entries(criteria ?? {})) {
    questions[name] = { type: "noul", instructions: instructions ? `${instructions} ${yes}` : yes, criteria: { true: yes, false: `not: ${yes}` } };
  }
  const r = await ask(state, questions, opts);
  if (!r) return null;
  const truth = {};
  const probability = {};
  for (const name of Object.keys(questions)) {
    if (!r[name]) return null;
    truth[name] = r[name].value;
    probability[name] = r[name].probability;
  }
  return { truth, probability };
}

// Place the state on an ordered scale. levels: ["lowest", ..., "highest"].
export async function jevScore(state, levels, instructions, opts = {}) {
  const r = await ask(state, { rank: { type: "score", instructions, criteria: [...levels] } }, opts);
  return r?.rank ?? null;
}

// The recommendV1 `arbitrate` contract: async (ids) => Record<id, 0..1> | null.
// One choice question over the ambiguous candidates; each candidate's
// probability of being the best fit is its signal.
export async function arbitrateWithJev(ids, { state = {}, describe = (id) => id, ...opts } = {}) {
  if (!Array.isArray(ids) || ids.length < 2) return null;
  const options = Object.fromEntries(ids.map((id) => [String(id), String(describe(id) ?? id)]));
  const r = await jevChoice(state, options, "Which skill fits this project best?", opts);
  if (!r) return null;
  return Object.fromEntries(ids.map((id) => [String(id), r.probabilities[String(id)] ?? 0]));
}

// Cheap offline gate: is there a key and is Jev not switched off? The real proof is a successful call.
export function jevLooksAvailable({ env = process.env } = {}) {
  const cfg = jevConfig(env);
  return !cfg.disabled && Boolean(cfg.key);
}

// Local fallback with the same shape as a choice: the best-scoring option wins, ties are reported.
export function localChoice(options, scoreFn) {
  const keys = Object.keys(options ?? {});
  if (!keys.length) return null;
  let best = keys[0];
  let bestScore = scoreFn(keys[0]);
  let tie = false;
  for (const k of keys.slice(1)) {
    const s = scoreFn(k);
    if (s > bestScore) {
      best = k;
      bestScore = s;
      tie = false;
    } else if (s === bestScore) {
      tie = true;
    }
  }
  return { option: best, probability: tie ? null : 1, tied: tie };
}
