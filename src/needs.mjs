// Intent: the few questions an agent may ask, and turning answers + fingerprint into need codes.

const FRONTEND = ["nextjs", "react", "vue", "nuxt", "svelte", "angular"];
const BACKEND = ["fastapi", "django", "flask", "express", "fastify", "nestjs", "rails", "laravel"];
const CLI_FRAMEWORKS = ["cobra", "urfave-cli", "clap"];
const COMMON_NEEDS = ["llm-calls", "payments", "auth", "pdf", "office-docs", "scraping", "e2e-testing", "deploy", "security", "github-workflow", "docs-writing", "large-codebase"];

const PRIORITY_NEEDS = { security: ["security"], quality: ["testing"] };

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

export function resolveNeeds({ fingerprint: fp, answers = {}, taxonomy }) {
  const projectType = taxonomy.projectTypes[answers.projectType] ? answers.projectType : inferProjectType(fp);
  const priorities = (answers.priorities ?? []).filter((p) => taxonomy.priorities[p]);
  const needs = new Set([
    ...(fp?.inferredNeeds ?? []),
    ...(answers.needs ?? []),
    ...(projectType ? taxonomy.projectTypes[projectType].needs : []),
    ...priorities.flatMap((p) => PRIORITY_NEEDS[p] ?? []),
  ]);
  return { projectType: projectType ?? null, priorities, needs: [...needs].filter((n) => taxonomy.needs[n]).sort() };
}

export function formatQuestions(questions) {
  return questions
    .map((q, i) => `${i + 1}. ${q.text} (${q.multi ? "pick several" : "pick one"})\n` + q.options.map((o) => `   - ${o.id}: ${o.label}`).join("\n"))
    .join("\n");
}
