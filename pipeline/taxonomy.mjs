// The taxonomy the catalog is classified into, as it grows with the crawl: jobs (capabilities) grouped into domains,
// the needs a project can have and the jobs that serve them, and the stacks a skill can be written for — languages,
// frameworks, and products a project uses (Supabase, Stripe, AWS): a skill for one product is offered only to projects
// whose manifests show that product. Additions only: existing ids keep their meaning, so classified items stay valid.

// Domains: the first branches of the catalog tree (the `repotify ui` graph groups jobs under them).
export const DOMAINS = Object.freeze({
  process: "How the agent works: planning, tests first, debugging, review",
  frontend: "Frontend and design",
  backend: "Backend, data and APIs",
  languages: "Language and framework expertise",
  mobile: "Mobile apps",
  testing: "Testing and automation",
  security: "Security",
  devops: "DevOps, cloud and delivery",
  ai: "AI, LLM and agent tooling",
  docs: "Documents, writing and knowledge",
  media: "Media and games",
  science: "Science and research computing",
});

// The domain of every job id, existing and new.
export const DOMAIN_OF = Object.freeze({
  "implementation-planning": "process", "tdd-discipline": "process", "debugging-method": "process", "verification-gate": "process",
  "code-review": "process", "workflow-meta": "process", "design-brainstorming": "process", refactoring: "process", "git-workflow": "process",
  "agent-memory": "process", "skill-authoring": "ai", "agent-orchestration": "ai",
  "frontend-design": "frontend", "component-architecture": "frontend", "react-performance": "frontend", "web-design-review": "frontend",
  accessibility: "frontend", "seo-optimization": "frontend", "i18n-localization": "frontend", "data-visualization": "frontend",
  "architecture-design": "backend", database: "backend", "auth-implementation": "backend", "payments-integration": "backend",
  "performance-optimization": "backend",
  "angular-expertise": "languages", "cpp-expertise": "languages", "django-expertise": "languages", "dotnet-expertise": "languages",
  "fastapi-expertise": "languages", "flutter-expertise": "languages", "go-expertise": "languages", "java-expertise": "languages",
  "kotlin-expertise": "languages", "laravel-expertise": "languages", "nestjs-expertise": "languages", "php-expertise": "languages",
  "python-expertise": "languages", "python-tooling": "languages", "rails-expertise": "languages", "rust-expertise": "languages",
  "swift-expertise": "languages", "typescript-expertise": "languages", "vue-expertise": "languages",
  "react-native": "mobile", "mobile-testing": "mobile",
  "webapp-testing": "testing", "browser-automation": "testing", "property-testing": "testing", "agent-evaluation": "testing",
  "security-review": "security", "static-analysis": "security", "supply-chain-audit": "security", "ci-security-audit": "security",
  "package-guard": "security", "smart-contract-security": "security", "compliance-privacy": "security", "security-operations": "security",
  "devops-infra": "devops", "deploy-vercel": "devops", "cloud-services": "devops", "build-tooling": "devops", "github-integration": "devops",
  "llm-gateway": "ai", "mcp-development": "ai", "prompt-engineering": "ai", "data-ml": "ai", "web-research": "ai", "docs-lookup": "ai",
  "writing-quality": "docs", "pdf-processing": "docs", "docx-documents": "docs", spreadsheets: "docs", presentations: "docs",
  "codebase-map": "docs",
  "media-generation": "media", "game-development": "media",
  "scientific-computing": "science",
});

// Jobs the first taxonomy had no slot for, found by classifying a random sample of 300 crawled skills (2026-10-02):
// a fifth of them fit no job.
export const ADDED_CAPABILITIES = Object.freeze({
  refactoring: { label: "Refactoring and code cleanup" },
  "git-workflow": { label: "Git workflow: commits, branches, pull request hygiene" },
  "agent-memory": { label: "Agent memory and context across sessions" },
  accessibility: { label: "Accessibility (a11y) audits and fixes", platform: "web" },
  "seo-optimization": { label: "SEO: search visibility, metadata, structured data", platform: "web" },
  "i18n-localization": { label: "Internationalization and localization" },
  "data-visualization": { label: "Charts, dashboards and data visualization" },
  "auth-implementation": { label: "Adding sign-in and user accounts to an app (OAuth, sessions, tokens)" },
  "payments-integration": { label: "Adding payments to an app: checkout, subscriptions, billing APIs" },
  "performance-optimization": { label: "Performance profiling and optimization" },
  "mobile-testing": { label: "Testing a mobile app: UI tests, emulators and device automation (not security testing)", platform: "mobile" },
  "agent-evaluation": { label: "Evaluating an LLM app or agent the project builds (evals, benchmarks)" },
  "compliance-privacy": { label: "Privacy, licensing and compliance (GDPR and others)" },
  "security-operations": { label: "Security operations: hardening, incident response, threat intel" },
  "cloud-services": { label: "Building on cloud platforms and managed backends (AWS, Azure, GCP, Supabase, Firebase)" },
  "build-tooling": { label: "Build tools, bundlers and monorepos" },
  "prompt-engineering": { label: "Prompt design and prompt libraries" },
  "web-research": { label: "Web search and research for agents" },
  "media-generation": { label: "Generating video, images or audio" },
  "game-development": { label: "Game development: engines, rendering, gameplay" },
  "scientific-computing": { label: "Scientific computing: bioinformatics, chemistry, physics, research data" },
});

// Stacks a skill can be written for that are products a project uses, detected from its manifests and files
// (src/stackmap.mjs). Without the product, the skill is noise; with it, it is often the most useful skill there is.
export const PRODUCT_STACKS = Object.freeze({
  supabase: { label: "Supabase", kind: "product" },
  firebase: { label: "Firebase", kind: "product" },
  prisma: { label: "Prisma", kind: "product" },
  stripe: { label: "Stripe", kind: "product" },
  aws: { label: "AWS", kind: "product" },
  azure: { label: "Azure", kind: "product" },
  gcp: { label: "Google Cloud", kind: "product" },
  cloudflare: { label: "Cloudflare Workers", kind: "product" },
  remotion: { label: "Remotion", kind: "product" },
  tailwind: { label: "Tailwind CSS", kind: "product" },
  kubernetes: { label: "Kubernetes", kind: "product" },
  terraform: { label: "Terraform", kind: "product" },
  postgres: { label: "PostgreSQL", kind: "product" },
  mongodb: { label: "MongoDB", kind: "product" },
  redis: { label: "Redis", kind: "product" },
  unity: { label: "Unity", kind: "product" },
  godot: { label: "Godot", kind: "product" },
});

export const ADDED_NEEDS = Object.freeze({
  i18n: { label: "Translated into several languages", capabilities: ["i18n-localization"] },
  media: { label: "Generates video, images or audio", capabilities: ["media-generation"] },
  "game-dev": { label: "Is a game", capabilities: ["game-development"] },
  accessibility: { label: "Accessibility matters", capabilities: ["accessibility"] },
  monorepo: { label: "Monorepo with several packages", capabilities: ["build-tooling"] },
  research: { label: "Researches the web", capabilities: ["web-research"] },
  compliance: { label: "Privacy, licensing or compliance rules", capabilities: ["compliance-privacy"] },
  scientific: { label: "Scientific or research computing", capabilities: ["scientific-computing"] },
  "security-ops": { label: "Runs security operations (hardening, incident response)", capabilities: ["security-operations"] },
  "agent-memory": { label: "Wants the agent to remember context across sessions", capabilities: ["agent-memory"] },
});

// Existing needs that more jobs now serve.
export const ADDED_NEED_LINKS = Object.freeze({
  auth: ["auth-implementation"],
  payments: ["payments-integration"],
  seo: ["seo-optimization"],
  performance: ["performance-optimization"],
  "data-processing": ["data-visualization"],
  "e2e-testing": ["mobile-testing"],
  mobile: ["mobile-testing"],
  "llm-calls": ["prompt-engineering", "agent-evaluation"],
  "github-workflow": ["git-workflow"],
  deploy: ["cloud-services"],
});

export const ADDED_PROJECT_TYPE_NEEDS = Object.freeze({ game: ["game-dev"], mobile: ["e2e-testing"] });

// The taxonomy with every addition, leaving existing entries as they are. Idempotent.
export function extendTaxonomyV2(taxonomy) {
  const t = structuredClone(taxonomy);
  for (const [id, c] of Object.entries(ADDED_CAPABILITIES)) t.capabilities[id] ??= { ...c };
  for (const [id, c] of Object.entries(t.capabilities)) if (DOMAIN_OF[id] && !c.domain) c.domain = DOMAIN_OF[id];
  t.domains ??= {};
  for (const [id, label] of Object.entries(DOMAINS)) t.domains[id] ??= { label };
  for (const [id, s] of Object.entries(PRODUCT_STACKS)) t.stacks[id] ??= { ...s };
  for (const [id, n] of Object.entries(ADDED_NEEDS)) t.needs[id] ??= { ...n, capabilities: [...n.capabilities] };
  for (const [need, caps] of Object.entries(ADDED_NEED_LINKS)) {
    const n = t.needs[need];
    if (n) n.capabilities = [...new Set([...(n.capabilities ?? []), ...caps])];
  }
  for (const [type, needs] of Object.entries(ADDED_PROJECT_TYPE_NEEDS)) {
    const p = t.projectTypes[type];
    if (p) p.needs = [...new Set([...(p.needs ?? []), ...needs])];
  }
  return t;
}
