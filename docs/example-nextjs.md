# Example: a Next.js SaaS project

Real output, not a mock-up: Repotify run with Claude Code on the `test/fixtures/projects/nextjs-saas` project in this
repository (Next.js, React, Prisma, Stripe, OpenAI, Playwright, Vitest, Docker, Vercel).

## 1. Read the project

The first run installs the `repotify` skill for the detected agent and prints a fingerprint. It reads manifests and
file names only; no code is read or sent anywhere.

```text
$ repotify
Repotify 0.1.0
Detected agent: claude-code
Installed the repotify skill: .claude/skills/repotify

Project fingerprint (local scan, code not read or sent):
- Languages: typescript 4
- Stacks: docker, nextjs, node, react, typescript, vercel
- Frameworks: next, react, tailwind
- Tests: playwright, vitest | Data: prisma | LLM SDKs: openai
- Infra: docker, github-actions, vercel
- Inferred needs: auth, ci, deploy, e2e-testing, frontend-ui, llm-calls, payments, testing
- Size: 9 files | Agent config: none

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

One item per job (`cluster`), within a 6,000-character context budget. `★` marks the default set; `·` rows are listed
but not picked by default. Badges: `✓` verified, `⚠` caution, `💎` hidden gem (high quality and fit, little adoption yet).
The `why` column says which part of the project each item serves.

```text
$ repotify recommend
Repotify candidates (★ = default set; context 4350/6000 chars)
mark id | type | cluster | score | badges | summary | why
★ test-driven-development | skill | tdd-discipline | 0.73 | ✓💎 | Enforces red-green-refactor: no production code without a failing test first. | core
★ writing-plans | skill | implementation-planning | 0.73 | ✓💎 | Breaks an approved design into small test-first tasks with exact files, interface… | core
★ differential-review | skill | security-review | 0.72 | ✓💎 | Security-focused review of each diff: blast radius, callers, test coverage and a … | core
★ systematic-debugging | skill | debugging-method | 0.72 | ✓💎 | Finds root causes with a four-phase method instead of guess-and-patch fixes. | core
★ verification-before-completion | skill | verification-gate | 0.72 | ✓💎 | Requires fresh command output as evidence before the agent claims work is done. | core
★ brainstorming | skill | design-brainstorming | 0.62 | ⚠💎 | Turns a rough idea into an approved design through focused questions and trade-of… | core
★ graphify | tool | codebase-map | 0.53 | ✓ | Maps your whole project into a queryable knowledge graph so the agent navigates b… | core
★ repotify-guard | config | package-guard | 0.53 | ✓ | Blocks installs of packages that do not exist and warns on brand-new ones, stoppi… | core
★ property-based-testing | skill | property-testing | 0.58 | ✓💎 | Adds property-based tests that find edge cases example tests miss, for parsers, s… | cap:property-testing,need:testing
★ composition-patterns | skill | component-architecture | 0.57 | ✓💎 | React composition patterns that scale: compound components, slots and state lifti… | need:frontend-ui,stack:react,stack:nextjs
★ react-best-practices | skill | react-performance | 0.57 | ✓💎 | Vercel's React and Next.js performance rules: data fetching, bundles, rendering a… | need:frontend-ui,stack:react,stack:nextjs
★ frontend-design | skill | frontend-design | 0.56 | ✓💎 | Produces distinctive, production-grade interfaces instead of generic AI-looking l… | cap:frontend-design,need:frontend-ui
★ webapp-testing | skill | webapp-testing | 0.56 | ✓💎 | Tests local web apps with Playwright: screenshots, console logs and interaction c… | cap:webapp-testing,need:e2e-testing,need:testing
★ web-design-guidelines | skill | web-design-review | 0.55 | ✓💎 | Reviews UI code for accessibility, UX and web interface best practices. | cap:web-design-review,need:frontend-ui
★ context7 | mcp | docs-lookup | 0.42 | ✓ | Fetches current, version-specific library docs into context so generated code mat… | cap:docs-lookup,need:llm-calls,need:frontend-ui
· playwright-mcp | mcp | browser-automation | 0.42 | ✓ | Lets the agent drive a real browser: navigate, click, fill forms and read pages v… | cap:browser-automation,need:e2e-testing
· requesting-code-review | skill | code-review | 0.36 | ✓ | Sends finished work to an independent reviewer with the right context and acts on… | need:testing
· github-mcp | mcp | github-integration | 0.26 | ✓ | Official GitHub server: issues, pull requests, code search and Actions from insid… | need:ci
```

The agent reads this table, keeps the mandatory core and writes one sentence per item on why it matters for this
project, then asks for approval.

## 4. Install

Each skill is downloaded from its pinned commit, checked against the catalog's SHA-256 hashes and scanned again on this
machine before it is written. Tools are never run for you: Repotify prints their steps. MCP servers are added to the
agent's MCP config.

```text
$ repotify install <default set> --yes --accept-caution
Agents: claude-code
Skills folder: .claude/skills
✓ test-driven-development
✓ writing-plans
✓ differential-review
✓ systematic-debugging
✓ verification-before-completion
✓ brainstorming ⚠
• graphify (tool, run it yourself): 1) uv tool install graphifyy==0.9.71 2) graphify install | verify: graphify --version
✓ repotify-guard → .claude/hooks/repotify-guard.mjs
✓ property-based-testing
✓ composition-patterns
✓ react-best-practices
✓ frontend-design
✓ webapp-testing
✓ web-design-guidelines
✓ context7 → .mcp.json
```

The whole run took a few seconds, and everything it wrote is recorded in `repotify.lock.json`, so
`repotify update --check` and `repotify remove <id>` know exactly what belongs to Repotify.
