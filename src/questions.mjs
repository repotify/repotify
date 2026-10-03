// Which questions are worth asking: the ones whose answer changes what Repotify would pick for this project. Every
// option of every candidate question is tried against the real engine; an option that changes nothing is dropped, and
// a question whose options change little is not asked. Questions come most useful first, with how many picks each
// option changes, so an agent asks two good questions instead of three generic ones, and none when the project
// already says enough.
import { questionBank, resolveNeeds, inferProjectType, PRIORITY_NEEDS } from "./needs.mjs";
import { demandFor, recommendLocal } from "../lib/pipeline/recommend/index.mjs";

const PLATFORMS = { web: "Web (runs in a browser)", mobile: "Mobile app (iOS or Android)", desktop: "Desktop app" };

// How likely an option is to be the answer before anyone is asked. A question is worth the picks its options change,
// each weighed by this: one project type out of all of them; a need typical for that type is a coin flip; another
// need, a product the files did not show, or a priority is a long shot; a need that would make the project another
// kind of project (smart contracts for a news site) is almost never the answer.
export const PRIOR = Object.freeze({ typicalNeed: 0.5, need: 0.1, otherKind: 0.02, product: 0.1, priority: 0.25, platform: 1 / 3 });

// Needs that make a project a kind of its own.
const KIND_OF_NEED = Object.freeze({ "smart-contracts": "smart-contracts", mobile: "mobile", "game-dev": "game" });

// One run of the deterministic engine for a set of answers.
function outcome(ctx, answers) {
  const { catalog, graph, fingerprint, machine, installed, blocked, budgetChars } = ctx;
  const needs = resolveNeeds({ fingerprint, answers, taxonomy: catalog.taxonomy });
  const demand = { ...demandFor({ catalog, fingerprint, needs, answers }), ...(machine ? { machine } : {}) };
  const rec = recommendLocal({ catalog, graph, demand, installed, blocked, budgetChars, answers });
  return { set: new Set(rec.set), candidates: rec.narrowed.candidates.length };
}

const change = (a, b) => [...a.set].filter((x) => !b.set.has(x)).length + [...b.set].filter((x) => !a.set.has(x)).length;

// Candidate questions: the static bank (project type, priorities, needs), plus the products and platforms the files
// did not show. Options are limited to what the catalog can act on.
export function candidateQuestions(catalog, fingerprint, answers = {}) {
  const t = catalog.taxonomy;
  const bank = questionBank(t, fingerprint).filter((q) => !(q.id === "projectType" && answers.projectType));
  const known = new Set([...(fingerprint?.stacks ?? []), ...(answers.stacks ?? [])]);
  const served = new Set(catalog.items.flatMap((i) => i.stacks ?? []));
  const products = Object.entries(t.stacks ?? {}).filter(([id, s]) => s.kind === "product" && served.has(id) && !known.has(id));
  const told = new Set([...(fingerprint?.inferredNeeds ?? []), ...(answers.needs ?? [])]);
  const out = bank.map((q) => (q.id === "needs" ? { ...q, options: Object.keys(t.needs).filter((n) => !told.has(n)).map((id) => ({ id, label: t.needs[id].label })) } : q));
  if (products.length) out.push({ id: "stacks", text: "Which of these does the project use?", multi: true, options: products.map(([id, s]) => ({ id, label: s.label })) });
  if (!(fingerprint?.platforms ?? []).length && !(answers.platforms ?? []).length) {
    out.push({ id: "platforms", text: "Where does it run?", multi: true, options: Object.entries(PLATFORMS).map(([id, label]) => ({ id, label })) });
  }
  return out;
}

const withAnswer = (answers, q, option) => {
  if (q.id === "projectType") return { ...answers, projectType: option };
  return { ...answers, [q.id]: [...new Set([...(answers[q.id] ?? []), option])] };
};

export function priorOf(q, option, { typical, projectType }) {
  if (!q.multi) return 1 / q.options.length;
  if (q.id === "needs") {
    if (typical.has(option)) return PRIOR.typicalNeed;
    return projectType && KIND_OF_NEED[option] && KIND_OF_NEED[option] !== projectType ? PRIOR.otherKind : PRIOR.need;
  }
  return { priorities: PRIOR.priority, stacks: PRIOR.product, platforms: PRIOR.platform }[q.id] ?? PRIOR.need;
}

// What an answer says, so the same thing is not asked twice: the security priority is the security need.
const meaningOf = (q, option) => {
  if (q.id === "needs") return `need:${option}`;
  if (q.id === "priorities" && PRIORITY_NEEDS[option]) return `need:${PRIORITY_NEEDS[option].join("+")}`;
  return `${q.id}:${option}`;
};

const round = (x) => Math.round(x * 100) / 100;

// The questions to ask, most useful first. Each keeps the options that change the picks, the likeliest decisive ones
// first (at most `maxOptions`); `expected` is how many picks asking it changes, weighed by how likely each option is.
// An option that means what an earlier question already offers (a security priority and a security need) is not
// offered twice. The project type, when unknown, is asked first: it sets what the other answers weigh.
export function adaptiveQuestions({ catalog, graph, fingerprint, answers = {}, machine = null, installed = [], blocked = [], budgetChars, max = 3, maxOptions = 4, minExpected = 0.5 }) {
  const ctx = { catalog, graph, fingerprint, machine, installed, blocked, budgetChars };
  const base = outcome(ctx, answers);
  const projectType = (catalog.taxonomy.projectTypes?.[answers.projectType] ? answers.projectType : null) ?? inferProjectType(fingerprint);
  const typical = new Set(catalog.taxonomy.projectTypes?.[projectType]?.needs ?? []);
  const worth = (options) => options.reduce((n, o) => n + o.weight * o.changes, 0);
  const tried = candidateQuestions(catalog, fingerprint, answers).map((q) => {
    const options = q.options
      .map((o) => {
        const r = outcome(ctx, withAnswer(answers, q, o.id));
        return { id: o.id, label: o.label, changes: change(r, base), meaning: meaningOf(q, o.id), weight: priorOf(q, o.id, { typical, projectType }) };
      })
      .filter((o) => o.changes > 0)
      .sort((a, b) => b.weight * b.changes - a.weight * a.changes || b.changes - a.changes || (a.id < b.id ? -1 : 1));
    return { q, options, expected: worth(options.slice(0, maxOptions)) };
  });
  const first = (a, b) => (b.q.id === "projectType") - (a.q.id === "projectType") || b.expected - a.expected;
  const offered = new Set();
  const ranked = [];
  for (const t of tried.filter((t) => t.options.length).sort(first)) {
    const options = t.options.filter((o) => !offered.has(o.meaning)).slice(0, maxOptions);
    const expected = worth(options);
    if (!options.length || (expected < minExpected && t.q.id !== "projectType")) continue;
    for (const o of options) offered.add(o.meaning);
    ranked.push({ id: t.q.id, text: t.q.text, multi: t.q.multi, expected: round(expected), options: options.map(({ id, label, changes }) => ({ id, label, changes })) });
  }
  ranked.sort((a, b) => (b.id === "projectType") - (a.id === "projectType") || b.expected - a.expected);
  return { questions: ranked.slice(0, max), picks: base.set.size, candidates: base.candidates, projectType: projectType ?? null };
}

// The JSON an agent reads: one question a line, which costs a third fewer tokens than indented JSON.
export function questionsJson(questions) {
  return questions.length ? `[\n${questions.map((q) => JSON.stringify(q)).join(",\n")}\n]` : "[]";
}

export function formatAdaptive(r) {
  if (!r.questions.length) return `No answer would change the picks for this project (${r.picks} picked from ${r.candidates} candidates). Run \`repotify recommend\`.`;
  return r.questions
    .map((q, i) => `${i + 1}. ${q.text} (${q.multi ? "pick several" : "pick one"})\n` + q.options.map((o) => `   - ${o.id}: ${o.label} (changes ${o.changes} pick${o.changes === 1 ? "" : "s"})`).join("\n"))
    .join("\n");
}
