// Intent: the few questions an agent may ask, and turning answers + fingerprint into need codes.

const FRONTEND = ["nextjs", "react", "vue", "nuxt", "svelte", "angular"];
const BACKEND = ["fastapi", "django", "flask", "express", "fastify", "nestjs", "rails", "laravel"];
const CLI_FRAMEWORKS = ["cobra", "urfave-cli", "clap", "click", "typer", "fire", "commander", "yargs", "oclif"];
const COMMON_NEEDS = ["llm-calls", "payments", "auth", "pdf", "office-docs", "scraping", "e2e-testing", "deploy", "security", "github-workflow", "docs-writing", "large-codebase"];

// The need a stated priority stands for.
export const PRIORITY_NEEDS = Object.freeze({ security: ["security"], quality: ["testing"] });

export function inferProjectType(fp) {
  if (!fp || fp.empty) return null;
  const has = (list, x) => list.includes(x);
  const stacks = fp.stacks ?? [];
  const needs = fp.inferredNeeds ?? [];
  if (has(needs, "smart-contracts")) return "smart-contracts";
  if (has(needs, "mobile")) return "mobile";
  if (has(needs, "mcp-server")) return "agent-tooling";
  if (has(stacks, "astro") || (has(needs, "seo") && has(needs, "scraping"))) return "content-site";
  if (stacks.some((s) => FRONTEND.includes(s))) return "web-app";
  if (stacks.some((s) => BACKEND.includes(s))) return "api";
  if ((fp.frameworks ?? []).some((f) => CLI_FRAMEWORKS.includes(f))) return "cli";
  if (has(needs, "data-processing") || (has(stacks, "python") && has(needs, "llm-calls"))) return "data-ai";
  if (has(needs, "scraping")) return "automation";
  return null;
}

const option = (taxonomy, group, id) => ({ id, label: taxonomy[group][id].label });

export function questionBank(taxonomy, fp) {
  const questions = [];
  const projectType = inferProjectType(fp);
  if (!projectType) {
    questions.push({
      id: "projectType",
      text: "What are you building?",
      multi: false,
      options: Object.keys(taxonomy.projectTypes).map((id) => option(taxonomy, "projectTypes", id)),
    });
  }
  questions.push({
    id: "priorities",
    text: "What matters most right now?",
    multi: true,
    options: Object.keys(taxonomy.priorities).map((id) => option(taxonomy, "priorities", id)),
  });
  const known = new Set(fp?.inferredNeeds ?? []);
  const typeNeeds = projectType ? taxonomy.projectTypes[projectType].needs : [];
  const ordered = [...new Set([...typeNeeds, ...COMMON_NEEDS])].filter((n) => taxonomy.needs[n] && !known.has(n));
  questions.push({
    id: "needs",
    text: "Which of these will the project need?",
    multi: true,
    options: ordered.slice(0, 8).map((id) => option(taxonomy, "needs", id)),
  });
  return questions;
}

// How strongly each source says the project has a need: seen in the project or said by the user beats a stated
// priority, which beats what projects of this type usually need.
export const NEED_WEIGHTS = { evidence: 1, answer: 1, priority: 0.85, projectType: 0.75 };

export function resolveNeeds({ fingerprint: fp, answers = {}, taxonomy }) {
  const projectType = taxonomy.projectTypes[answers.projectType] ? answers.projectType : inferProjectType(fp);
  const priorities = (answers.priorities ?? []).filter((p) => taxonomy.priorities[p]);
  const weights = {};
  const add = (list, weight) => {
    for (const n of list) if (taxonomy.needs[n]) weights[n] = Math.max(weights[n] ?? 0, weight);
  };
  add(fp?.inferredNeeds ?? [], NEED_WEIGHTS.evidence);
  add(answers.needs ?? [], NEED_WEIGHTS.answer);
  add(priorities.flatMap((p) => PRIORITY_NEEDS[p] ?? []), NEED_WEIGHTS.priority);
  add(projectType ? taxonomy.projectTypes[projectType].needs : [], NEED_WEIGHTS.projectType);
  const needs = Object.keys(weights).sort();
  const answered = (answers.needs ?? []).filter((n) => taxonomy.needs[n]).sort();
  return { projectType: projectType ?? null, priorities, needs, weights: Object.fromEntries(needs.map((n) => [n, weights[n]])), answered };
}

export function formatQuestions(questions) {
  return questions
    .map((q, i) => `${i + 1}. ${q.text} (${q.multi ? "pick several" : "pick one"})\n` + q.options.map((o) => `   - ${o.id}: ${o.label}`).join("\n"))
    .join("\n");
}

// Whether a conditional core item earns its default slot for this demand.
// A catalog core entry may carry `defaultWhen` naming the project situations
// where the item is worth recommending without further evidence; everywhere
// else the item stays in the candidate table as a backup pick. No condition
// (undefined/null) keeps the historic behavior: always a default.
// Shape: { empty?: true, notEmpty?: true, needsAny?: string[] }.
export function meetsCoreCondition(cond, demand = {}) {
  if (!cond) return true;
  if (cond.empty && !demand.empty) return false;
  if (cond.notEmpty && demand.empty) return false;
  if (Array.isArray(cond.needsAny) && cond.needsAny.length) {
    const needs = new Set(demand.needs ?? []);
    if (!cond.needsAny.some((n) => needs.has(n))) return false;
  }
  return true;
}
