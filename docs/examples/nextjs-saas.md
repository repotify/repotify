# Example: a Next.js SaaS project

Real output, not a mock-up: Repotify 2.0.0, run from its package (`npm pack`, then `npx`) with an empty home folder and
npm cache, Claude Code as the agent, on the `test/fixtures/projects/nextjs-saas` project in this repository (Next.js,
React, Prisma, Stripe, OpenAI, Playwright, Vitest, Docker, Vercel). The project already had one skill of its own.

## 1. Read the project

The first run installs the `repotify` skill for the detected agent and prints a fingerprint. It reads manifests and
file names only; no code is read or sent anywhere.

```text
$ npx -y @repotify/repotify@latest
Repotify 2.0.0
Detected agent: claude-code
Installed the repotify skill: .claude/skills/repotify

Repotify measures which skills actually work and shares anonymous usage counts to improve recommendations. Turn off any time: `repotify telemetry off`.

Project fingerprint (local scan, code not read or sent):
- Languages: typescript 4
- Stacks: docker, nextjs, node, react, typescript, vercel | Platforms: web
- Frameworks: next, react, tailwind
- Tests: playwright, vitest | Data: prisma | LLM SDKs: openai
- Infra: docker, github-actions, vercel
- Inferred needs: auth, ci, database, deploy, e2e-testing, frontend-ui, infra, llm-calls, payments, testing
- Size: 9 files | Agent config: claude-code (skills: my-own)

This project already has 1 skill; `repotify audit` shows which ones earn their place and why.
Next: follow the repotify skill. In short: `repotify questions --json` (only if needed), then `repotify recommend`, then `repotify install <ids> --yes`.
```

## 2. Ask what it cannot tell

Only the questions the fingerprint cannot answer. The agent asks them in its own words and passes the answers back.

```text
$ repotify questions
1. What matters most right now? (pick several)
   - cost: Low cost
   - quality: Quality and tests
   - security: Security
   - speed: Ship fast
2. Which of these will the project need? (pick several)
   - pdf: Reads or makes PDFs
   - office-docs: Word, Excel or PowerPoint files
   - scraping: Scrapes or crawls the web
   - security: Security matters
   - github-workflow: Works through GitHub PRs and issues
   - docs-writing: Writes docs or content
   - large-codebase: Large or unfamiliar codebase
```

## 3. Recommend

One row per job (`cluster`), within a 6,000-character context budget. `★` marks the default set; `·` rows are the best
alternative for a job nothing in the set does yet. Badges: `✓` verified, `⚠` caution, `⚙` a hook or MCP server that
the user switches on, `⏳` pays off once. The `why` column says which part of the project each item serves.

```text
$ repotify recommend
Repotify candidates (★ = default set; ⚙ = hook or MCP server, the user enables it; ⏳ = pays off once, `repotify audit` says when to remove it; context 5767/6000 chars)
mark id | type | cluster | score | badges | summary | why
★ test-driven-development | skill | tdd-discipline | 0.73 | ✓ | Enforces red-green-refactor: no production code wi… | core,cap:tdd-discipline,need:testing
★ writing-plans | skill | implementation-planning | 0.73 | ✓ | Breaks an approved design into small test-first ta… | core
★ differential-review | skill | security-review | 0.72 | ✓ | Security-focused review of each diff: blast radius… | core,cap:security-review,need:auth
★ systematic-debugging | skill | debugging-method | 0.72 | ✓ | Finds root causes with a four-phase method instead… | core,need:testing
★ verification-before-completion | skill | verification-gate | 0.72 | ✓ | Requires fresh command output as evidence before t… | core,need:testing
★ brainstorming | skill | design-brainstorming | 0.59 | ⚠ | Turns a rough idea into an approved design through… | core
★ property-based-testing | skill | property-testing | 0.58 | ✓ | Adds property-based tests that find edge cases exa… | cap:property-testing,need:testing
★ composition-patterns | skill | component-architecture | 0.57 | ✓ | React composition patterns that scale: compound co… | need:frontend-ui,stack:react,stack:nextjs
★ react-best-practices | skill | react-performance | 0.57 | ✓ | Vercel's React and Next.js performance rules: data… | need:frontend-ui,stack:react,stack:nextjs
★ frontend-design | skill | frontend-design | 0.56 | ✓ | Produces distinctive, production-grade interfaces … | cap:frontend-design,need:frontend-ui
★ webapp-testing | skill | webapp-testing | 0.56 | ✓ | Tests local web apps with Playwright: screenshots,… | cap:webapp-testing,need:e2e-testing,need:testing
★ sql-pro | skill | database | 0.56 | ✓ | SQL Pro skill optimizes queries, designs schemas, … | cap:database,need:database
★ monitoring-expert | skill | devops-infra | 0.56 | ✓ | Implements monitoring, logging, metrics, tracing, … | cap:devops-infra,need:infra
★ web-design-guidelines | skill | web-design-review | 0.55 | ✓ | Reviews UI code for accessibility, UX and web inte… | cap:web-design-review,need:frontend-ui
★ graphify | tool | codebase-map | 0.53 | ✓⏳ | Maps your whole project into a queryable knowledge… | core
★ repotify-guard | config | package-guard | 0.53 | ✓⚙ | Blocks installs of packages that do not exist and … | core
★ context7 | mcp | docs-lookup | 0.42 | ✓⚙ | Fetches current, version-specific library docs int… | cap:docs-lookup,need:llm-calls,need:frontend-ui
· playwright-mcp | mcp | browser-automation | 0.42 | ✓⚙ | Lets the agent drive a real browser: navigate, cli… | cap:browser-automation,need:e2e-testing
★ typescript-pro | skill | typescript-expertise | 0.41 | ✓ | Implements advanced TypeScript type systems, custo… | stack:typescript
· requesting-code-review | skill | code-review | 0.36 | ✓ | Sends finished work to an independent reviewer wit… | need:testing
· github-mcp | mcp | github-integration | 0.26 | ✓⚙ | Official GitHub server: issues, pull requests, cod… | need:ci
```

The agent reads this table, keeps the mandatory core and writes one sentence per item on why it matters for this
project, then asks for approval.

## 4. Install the skills

Each skill is downloaded from its pinned commit, checked against the catalog's SHA-256 hashes and scanned again on this
machine before it is written. Tools are never run for you: Repotify prints their steps. Hooks and MCP servers are not
installed here: they change how the agent itself runs, so Repotify prints the command for the user.

```text
$ repotify install <approved set> --yes --accept-caution
Agents: claude-code
Skills folder: .claude/skills
✓ test-driven-development
✓ writing-plans
✓ differential-review
✓ systematic-debugging
✓ verification-before-completion
✓ brainstorming ⚠
• graphify (tool, run it yourself): 1) uv tool install graphifyy==0.9.71 2) graphify install | verify: graphify --version
• repotify-guard (hook) changes how the agent runs; the user enables it: npx -y @repotify/repotify@latest enable repotify-guard
✓ web-design-guidelines
✓ frontend-design
✓ webapp-testing
✓ composition-patterns
✓ react-best-practices
✓ typescript-pro
✓ monitoring-expert
✓ sql-pro
✓ property-based-testing
• context7 (MCP server) changes how the agent runs; the user enables it: npx -y @repotify/repotify@latest enable context7

★ Did Repotify help? A star on GitHub helps other developers find it: https://github.com/repotify/repotify
```

## 5. The user switches on the hook and the MCP server

In a terminal, `repotify enable` shows each change and asks `Enable <id>? [y/N]` before writing it. The `--yes` below is
the user's own confirmation; an agent that runs `enable` without it changes nothing.

```text
$ npx -y @repotify/repotify@latest enable context7 repotify-guard --yes
context7: adds an MCP server your agent starts itself (`npx -y @upstash/context7-mcp@4.1.1`) to .mcp.json.
✓ context7 → .mcp.json
repotify-guard: Adds .claude/hooks/repotify-guard.mjs and a PreToolUse hook in .claude/settings.json. Blocks installs of packages that do not exist and warns on brand-new ones, stopping hallucinated-package attacks.
✓ repotify-guard → .claude/hooks/repotify-guard.mjs
```

## 6. Audit what is installed

`repotify audit` judges every skill in the agent's folders, including ones Repotify did not install (`my-own` here),
with what each costs in context. In a project full of unrelated or duplicated skills it would say which to remove and
why.

```text
$ repotify audit
.claude/skills: 17 skills, 5238 chars (~1310 tokens) of always-on context
  keep     brainstorming                   Forces a design conversation before code, the cheapest place to catch wrong assumptions.
  keep     composition-patterns            Expertise for react, nextjs, which this project uses.
  keep     differential-review             A security pass on every diff catches what functional tests never look for.
  keep     frontend-design                 Serves distinctive frontend design.
  keep     monitoring-expert               Serves devOps and infrastructure: CI/CD, containers, cloud, monitoring.
  keep     my-own                          No sign it is out of place here.
  keep     property-based-testing          Serves property-based testing.
  keep     react-best-practices            Expertise for react, nextjs, which this project uses.
  keep     repotify                        Repotify's own skill.
  keep     sql-pro                         Serves databases: SQL, schema and query performance.
  keep     systematic-debugging            Root-cause debugging stops the patch-on-patch spiral that burns tokens.
  keep     test-driven-development         Tests written first are the agent's main defence against confident but wrong code.
  keep     typescript-pro                  Expertise for typescript, which this project uses.
  keep     verification-before-completion  Evidence before 'done' removes the most common agent failure: claiming success without checking.
  keep     web-design-guidelines           Serves UI and accessibility review.
  keep     webapp-testing                  Serves web app end-to-end testing.
  keep     writing-plans                   Turns designs into small verified steps, which keeps long agent sessions on track.

Every installed skill earns its place.
```

## 7. Run it again

What is installed keeps its job: the table lists it as `installed`, offers nothing else for those jobs, and counts its
context against the budget. Only the tool (run by the user, so not recorded) and the open jobs remain.

```text
$ repotify recommend
Repotify candidates (★ = default set; ⚙ = hook or MCP server, the user enables it; ⏳ = pays off once, `repotify audit` says when to remove it; context 5767/6000 chars)
mark id | type | cluster | score | badges | summary | why
· test-driven-development | skill | tdd-discipline | 0.73 | ✓ installed | Enforces red-green-refactor: no production code without a failin… | 
· writing-plans | skill | implementation-planning | 0.73 | ✓ installed | Breaks an approved design into small test-first tasks with exact… | 
…
★ graphify | tool | codebase-map | 0.53 | ✓⏳ | Maps your whole project into a queryable knowledge graph so the … | core
· playwright-mcp | mcp | browser-automation | 0.42 | ✓⚙ | Lets the agent drive a real browser: navigate, click, fill forms… | cap:browser-automation,need:e2e-testing
· requesting-code-review | skill | code-review | 0.36 | ✓ | Sends finished work to an independent reviewer with the right co… | need:testing
· github-mcp | mcp | github-integration | 0.26 | ✓⚙ | Official GitHub server: issues, pull requests, code search and A… | need:ci
```

Everything Repotify wrote is recorded in `repotify.lock.json`, so `repotify update --check` and `repotify remove <id>`
know exactly what belongs to Repotify.
