# Example: a Next.js SaaS project

Real output, not a mock-up: Repotify 0.2.0, run from its npm package on a clean machine (empty home folder, empty npm
cache) with Claude Code as the agent, on the `test/fixtures/projects/nextjs-saas` project in this repository (Next.js,
React, Prisma, Stripe, OpenAI, Playwright, Vitest, Docker, Vercel). The project already had one skill of its own.

## 1. Read the project

The first run installs the `repotify` skill for the detected agent and prints a fingerprint. It reads manifests and
file names only; no code is read or sent anywhere.

```text
$ npx -y @repotify/repotify@latest
Repotify 0.2.0
Detected agent: claude-code
Installed the repotify skill: .claude/skills/repotify

Project fingerprint (local scan, code not read or sent):
- Languages: typescript 4
- Stacks: docker, nextjs, node, react, typescript, vercel | Platforms: web
- Frameworks: next, react, tailwind
- Tests: playwright, vitest | Data: prisma | LLM SDKs: openai
- Infra: docker, github-actions, vercel
- Inferred needs: auth, ci, deploy, e2e-testing, frontend-ui, llm-calls, payments, testing
- Size: 10 files | Agent config: claude-code (skills: my-own)

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

One item per job (`cluster`), within a 6,000-character context budget. `★` marks the default set; `·` rows are listed
but not picked by default. Badges: `✓` verified, `⚠` caution, `💎` hidden gem (high quality and fit, little adoption
yet), `⚙` a hook or MCP server that the user switches on. The `why` column says which part of the project each item
serves.

```text
$ repotify recommend
Repotify candidates (★ = default set; ⚙ = hook or MCP server, the user enables it; context 4350/6000 chars)
mark id | type | cluster | score | badges | summary | why
★ test-driven-development | skill | tdd-discipline | 0.73 | ✓💎 | Enforces red-green-refactor: no production code without a failing test first. | core
★ writing-plans | skill | implementation-planning | 0.73 | ✓💎 | Breaks an approved design into small test-first tasks with exact files, interf… | core
★ differential-review | skill | security-review | 0.72 | ✓💎 | Security-focused review of each diff: blast radius, callers, test coverage and… | core
★ systematic-debugging | skill | debugging-method | 0.72 | ✓💎 | Finds root causes with a four-phase method instead of guess-and-patch fixes. | core
★ verification-before-completion | skill | verification-gate | 0.72 | ✓💎 | Requires fresh command output as evidence before the agent claims work is done. | core
★ brainstorming | skill | design-brainstorming | 0.62 | ⚠💎 | Turns a rough idea into an approved design through focused questions and trade… | core
★ graphify | tool | codebase-map | 0.53 | ✓ | Maps your whole project into a queryable knowledge graph so the agent navigate… | core
★ repotify-guard | config | package-guard | 0.53 | ✓⚙ | Blocks installs of packages that do not exist and warns on brand-new ones, sto… | core
★ property-based-testing | skill | property-testing | 0.58 | ✓💎 | Adds property-based tests that find edge cases example tests miss, for parsers… | cap:property-testing,need:testing
★ composition-patterns | skill | component-architecture | 0.57 | ✓💎 | React composition patterns that scale: compound components, slots and state li… | need:frontend-ui,stack:react,stack:nextjs
★ react-best-practices | skill | react-performance | 0.57 | ✓💎 | Vercel's React and Next.js performance rules: data fetching, bundles, renderin… | need:frontend-ui,stack:react,stack:nextjs
★ frontend-design | skill | frontend-design | 0.56 | ✓💎 | Produces distinctive, production-grade interfaces instead of generic AI-lookin… | cap:frontend-design,need:frontend-ui
★ webapp-testing | skill | webapp-testing | 0.56 | ✓💎 | Tests local web apps with Playwright: screenshots, console logs and interactio… | cap:webapp-testing,need:e2e-testing,need:testing
★ web-design-guidelines | skill | web-design-review | 0.55 | ✓💎 | Reviews UI code for accessibility, UX and web interface best practices. | cap:web-design-review,need:frontend-ui
★ context7 | mcp | docs-lookup | 0.42 | ✓⚙ | Fetches current, version-specific library docs into context so generated code … | cap:docs-lookup,need:llm-calls,need:frontend-ui
· playwright-mcp | mcp | browser-automation | 0.42 | ✓⚙ | Lets the agent drive a real browser: navigate, click, fill forms and read page… | cap:browser-automation,need:e2e-testing
· requesting-code-review | skill | code-review | 0.36 | ✓ | Sends finished work to an independent reviewer with the right context and acts… | need:testing
· github-mcp | mcp | github-integration | 0.26 | ✓⚙ | Official GitHub server: issues, pull requests, code search and Actions from in… | need:ci
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
✓ property-based-testing
✓ composition-patterns
✓ react-best-practices
✓ frontend-design
✓ webapp-testing
✓ web-design-guidelines
• context7 (MCP server) changes how the agent runs; the user enables it: npx -y @repotify/repotify@latest enable context7
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

`repotify audit` judges every skill in the agent's folders, including ones Repotify did not install (`my-own` here).
In a project full of unrelated or duplicated skills it would say which to remove and why.

```text
$ repotify audit
.claude/skills: 14 skills, 3783 chars of always-on context
  keep     brainstorming                   Forces a design conversation before code, the cheapest place to catch wrong assumptions.
  keep     composition-patterns            Expertise for react, nextjs, which this project uses.
  keep     differential-review             A security pass on every diff catches what functional tests never look for.
  keep     frontend-design                 Serves distinctive frontend design.
  keep     my-own                          No sign it is out of place here.
  keep     property-based-testing          Serves property-based testing.
  keep     react-best-practices            Expertise for react, nextjs, which this project uses.
  keep     repotify                        Repotify's own skill.
  keep     systematic-debugging            Root-cause debugging stops the patch-on-patch spiral that burns tokens.
  keep     test-driven-development         Tests written first are the agent's main defence against confident but wrong code.
  keep     verification-before-completion  Evidence before 'done' removes the most common agent failure: claiming success without checking.
  keep     web-design-guidelines           Serves UI and accessibility review.
  keep     webapp-testing                  Serves web app end-to-end testing.
  keep     writing-plans                   Turns designs into small verified steps, which keeps long agent sessions on track.

Every installed skill earns its place.
```

The whole run took a few seconds, and everything it wrote is recorded in `repotify.lock.json`, so
`repotify update --check` and `repotify remove <id>` know exactly what belongs to Repotify.
