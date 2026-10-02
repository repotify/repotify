# Changelog

## 2.0.0 (2026-10-02)

A new recommendation engine and a catalog whose every skill was read in full before it was classified.

### What changes for you

- **Every skill classified by a decision model.** At catalog build time Jev (TypeSafe, via OpenRouter's Decisions API;
  any Jev-compatible model works) reads each `SKILL.md` and answers five typed questions: off-topic gate, main job,
  language or framework, tied to one product, and lifecycle (pays off once, on every task, or now and then). Rules act
  only on confident answers and hand-curated items are never relabelled. Against 49 hand labels: main job 94% (the
  jury's free-form labels 52%), language 100% (86%), off-topic 98% (88%), lifecycle 85%. Nothing calls a model on
  your machine.
- **One pick per job.** A capability graph maps every item to the job it does. The default set holds one item per job
  (cluster or exclusive group), the core backbone always, hand-vetted picks before lab finds, no skill written for a
  stack the project does not use, and optional items only with a fit of 0.6 or more. What the project already has
  (installed by Repotify or copied into an agent's skills folder) keeps its job and its share of the context budget,
  and nothing that conflicts with it is offered. The table the agent reads has one row per job.
- **Skills that pay off once.** `repotify audit` flags a codebase map or onboarding skill two weeks after install, and
  every audit line shows its token cost: always-on per session and per use. ⏳ marks them in the table.
- **Stack experts.** Angular, Vue, Django, FastAPI, Python, Go, Rust, Java and Spring, Kotlin, Swift, Flutter, PHP and
  WordPress, Laravel, Rails, .NET, C++, NestJS, TypeScript and React Native projects get an expert for their stack, and
  only theirs, from [jeffallan/claude-skills](https://github.com/jeffallan/claude-skills) (MIT) and other sources.
- **Catalog: 91 items** (86 skills, 3 MCP servers, 1 tool, 1 config) from 17 repositories. Off-topic collections
  (digital forensics, malware analysis, marketing), math-contest skills, a Telegram bot setup and skills that only
  drive one product were removed; ten unsure lab finds wait for review.
- **Security.** Scanner 1.3.0: a file's level comes from its most severe findings (before, ten harmless mentions of a
  pattern could hide a critical one further down), and long lines of hidden characters no longer slow it down. Since
  2026-10-01 it also catches `xargs`/`parallel` pipes into a shell, `curl` redirects, clone-and-build chains and more
  `rm` and `sudo` forms, and the package guard checks `npx -p`, `npm exec` and registry overrides in the environment.
  The jury no longer flags a skill for instructing its agent; only text aimed at the jury itself counts.
- **Codex.** Removing or updating an MCP server keeps everything else in `.codex/config.toml` (array tables and
  commented headers after the server were deleted before).
- **Telemetry stays on your machine.** Usage signals are logged locally after a first-run notice; `repotify sync` is
  the only way out, it asks first, and no collection server runs yet. Kill switches: `repotify telemetry off`,
  `REPOTIFY_TELEMETRY=0`, `DO_NOT_TRACK=1`, `NO_ANALYTICS=1` (the last one now stops both local logs).
- `recommend --arbitrate` (opt-in, needs a Jev key) asks only about the optional candidates; it used to ask which of
  four core skills fits best. Exploration is off unless `REPOTIFY_EXPLORE=1`, and it never doubles a job.

### Measured

- Recommendation quality on 49 scenarios, run against the engine the CLI serves: 108/108 must-include, 0 violations,
  0 duplicate jobs; the default set averages 12.1 items and 3,790 of 6,000 characters.
- One setup costs the agent about 3,000 tokens (2,822–3,130 over seven fixture projects, `test/eval/flow-tokens.mjs`).
- 822 tests: all pass on Node 22 and 24; on Node 18 and 20, six worker tests that need `node:sqlite` are skipped.
  Coverage 94% of lines.

### Built, not live

The learning loop (LinUCB with off-policy evaluation, `lib/learn/`) and the fleet server (`lib/telemetry/server/`) are
built and tested in simulation. They are not wired into `recommend` and nothing is deployed, so rankings do not learn
from use yet. An evaluation harness (`test/harness/`) compares routing strategies on pilot scale; its series 3 results
are on the website's leaderboard as mean [min–max] at n = 3 per cell.

### For maintainers

- The quality bar measures the served engine; before the review it scored the frozen v1 engine while users got v2
  (which scored 80.6% with 176 duplicate jobs at the time).
- `npm run check` also runs the harness tests and the gate's sensitivity sweep, which now calls the production
  `selectSet()` instead of a copy that had drifted (the catalog workflow's coverage-pilot job was failing).
- The capability graph is derived from the catalog (`pipeline/graph-seed.mjs`): one PROVIDES edge per item job (91),
  curated edges kept (113 in all).
- Unwired modules were removed: the per-candidate test runner, the keyword classifier and seed-context collector the Jev
  classifier replaced, a second unused audit, and information-gain question ordering. The npm package ships only the
  files the CLI loads, and a test checks it.
- A source of leaked system prompts is denylisted (`pipeline/denylist.json`); the four skills taken from it were removed.
- The lab's automatic publishing is paused; it will publish again once it applies the classifier's gate.

## 0.2.0 (2026-09-29)

Smarter picks, an audit of what is already installed, and a setup your agent's safety layer can trust.

- **Recommendations by evidence, platform and coverage.** Dependencies narrow broad needs (openpyxl: spreadsheets, not
  every office format); apps without a web target get no web-only skills; needs are weighted by how sure Repotify is;
  an optional item joins the default set only if it covers something nothing else does, and the table says which item
  covers the rest (`covered-by:`). On 42 scenarios: must-include hits 89/91 → 91/91, wrong picks 14 → 0.
- **`repotify audit`** judges the skills already installed, including ones Repotify did not install: keep, consider
  removing (another stack, a job nothing here needs, the same job twice, delisted) or remove (fails the security scan),
  each with the reason and the context it frees. It never deletes anything.
- **`repotify suggest`** offers your own skill or repository to the catalog: it scans it locally and prints a pre-filled
  submission form; nothing is sent.
- **Hooks and MCP servers are the user's to switch on.** `install` installs skills only and prints `repotify enable <id>`
  for hooks and MCP servers; `enable` shows the change and asks in a terminal, and needs `--yes` typed by the user
  without one. `update --enable-auto-check` follows the same rule. Breaking: scripts that installed MCP servers or the
  guard with `install --yes` now need `enable <id> --yes`.
- The fingerprint reports platforms and capability evidence; the table marks hooks and MCP servers with ⚙.
- Scanner: a long line with many downloads scans about four times faster (CI was failing on Node 18); verdicts on the
  127-skill corpus are unchanged.
- Windows and macOS: the scanner reads link targets written with backslashes (a link out of a skill folder went
  unnoticed on Windows), and the home folder is recognised under another spelling of its path (on macOS Repotify
  could install itself into a home folder reached through a symlink).
- The npm package is the primary install path in every README and in AGENTS.md; the agent block reads as the user's
  request, not an order.
- Repository layout: a short root; documentation in `docs/` (`ARCHITECTURE.md` with why JavaScript, `BENCHMARKS.md`,
  `RELEASING.md`, worked examples, translations, reports), community files and README images in `.github/`, the
  evaluation in `test/eval/`, the analytics worker in `pipeline/worker/`; a test keeps documentation links working.
- Taxonomy: capabilities can be marked `platform: web`; building an MCP server also wants docs lookup.
  `pipeline/rehash.mjs` rewrites the hashes after a taxonomy edit.
- CI also runs on Node 24, and on Windows and macOS; `.gitignore` covers `.env` files, `.npmrc` and `*.pem`.
- Security review before release ([report](docs/reports/security-review-2026-09-30.md)): `update --apply` of a hook or
  MCP server now needs the same consent as `enable`; `audit` and `suggest` print names from the project safely and only
  suggest `repotify remove` for real catalog ids; oversized SKILL.md files are not parsed; the docs no longer claim the
  consent gate is a sandbox.
- A website at repotify.github.io/repotify in 24 languages (right-to-left for Arabic, Persian and Hebrew): one static
  page per language with hreflang, Open Graph, Twitter cards and JSON-LD, a sitemap, no trackers and no framework
  (`site/`, deployed by `.github/workflows/pages.yml`).
- A new look: the logo is a pair of code braces drawn as headphones around a play button; the README and the website
  are black and terminal-style, with the tagline "Thousands of agent skills. The right ones for your repo." The README
  is short, with the details in `docs/GUIDE.md`; the website uses JetBrains Mono and shows a roadmap.
- After the first install that writes something, the CLI thanks the user once and points to the GitHub star button.
- The fingerprint ignores test fixtures, examples and templates inside a project (Repotify's own repository looked
  like a 14-stack project). Repotify develops itself with its own recommendations; three project subagents live in
  `.claude/agents/`.

## 0.1.0 (2026-09-29)

First public preview. The npm package is `@repotify/repotify`; the command is `repotify`.

- `repotify` reads a project without reading its code, asks at most three questions and recommends a conflict-free set
  of skills, MCP servers and tools within a context budget.
- Installs for Claude Code, Cursor, Codex, Gemini CLI and any agent that reads `.agents/skills`, from pinned commits,
  checked against SHA-256 hashes, re-scanned locally and recorded in `repotify.lock.json`.
- Security scanner 1.2.0: reads shell structure and URLs the way the shell and curl do; four trust levels.
- Package guard for Claude Code that blocks installs of packages that do not exist and asks before brand-new ones.
- Catalog pipeline with discovery, a security gate with OSV advisories and a three-model LLM jury. The starter catalog
  has 29 hand-picked items.
- 300 tests, a 37-scenario evaluation set, documentation in English, Turkish and Simplified Chinese.
