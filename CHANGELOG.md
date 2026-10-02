# Changelog

## Unreleased (fixes on top of 2.0.0)

Review on 2026-10-02: the quality bar scored the frozen v1 engine while `repotify recommend` served v2, so a 100%
eval sat next to v2 sets that offered Spring Boot and rootkit analysis to a Flask app and Active Directory abuse to a
Next.js shop. Served through v2, the same 49 scenarios scored 80.6% with 176 duplicate jobs.

- **The eval measures the served engine.** `test/eval/run.mjs` runs `lib/pipeline/recommend` (the CLI's
  deterministic path, shared through `demandFor` and `recommendLocal`). 108/108, 0 violations, 0 duplicate jobs.
- **Fit means "does a job this project wants".** A specialist matching one wanted capability (semgrep) now fits
  fully; the old matched/all-wanted ratio scored it near 0.2. Ranking multiplies fit by merit — jury quality, trust,
  adoption, freshness, community — instead of adding near-constant gate and freshness terms.
- **One item per job.** A cluster or exclusive group is served once, by its best item; core items claim theirs first.
- **No off-stack skills.** An item written for specific stacks is a candidate only when the project uses one of them.
- **The core backbone always ships**, also when the demand is too thin for extras (the reply still says why).
  Empty projects get their curated loadout again. Optional items need a fit of 0.6 to join the default set.
- **Exploration is off by default.** It swapped a random candidate into 1 in 20 sets while no learning loop reads
  the logs (no telemetry endpoint yet). `REPOTIFY_EXPLORE=1` turns it on; episodes say `randomized` only then.
- **Catalog: 103 items** (98 skills, 3 MCP servers, 1 tool, 1 config). Removed 39 off-topic items: a digital-forensics
  and malware-analysis collection, a marketing collection, a Telegram bot setup and two math-contest skills, plus
  the five graph edges that pointed at them. Fixed noisy tags on nextjs-developer, react-native-expert,
  microservices-architect, ai-agents-architect and data-engineer.
- `test/served-engine.test.mjs` locks all of the above.
- **Every skill classified by a decision model.** Jev (TypeSafe, via OpenRouter's Decisions API; any Jev-compatible
  model works) reads each `SKILL.md` at catalog build time and answers five typed questions: off-topic gate, main job,
  language or framework, product-bound, lifecycle. Rules act only on confident answers; curated items are never
  relabelled. Against 49 hand labels: main job 94% (jury 52%), language 100% (86%), off-topic 98% (88%),
  lifecycle 85%. No model calls on the user's machine. The old Jev wrapper never ran (it needed a script that
  only existed on one VM and parsed a response shape the API does not return); it now calls the real API.
- **Taxonomy:** architecture, database, DevOps/infra, data/ML, agent orchestration and TypeScript capabilities;
  infra and database needs come only from evidence (Dockerfile, Terraform, a database client).
- **Capability graph derived from the catalog:** one PROVIDES edge per item job (92), curated edges kept (114 in all).
- **`repotify audit` flags skills that pay off once** (a codebase map, onboarding) two weeks after install, and every
  audit line shows its token cost: always-on per session and per use. ⏳ marks them in the candidate table.
- Catalog 103 → 92: one more off-topic skill out, ten unsure lab finds held for review
  (`pipeline/classification-review.json`).
- README and GUIDE: the learning loop is described as built but not live (it is not wired into `recommend` and no
  collection server runs); the unused "every candidate runs its own tests" step is no longer claimed.

## 2.0.0 (2026-10-01)

The recommendation engine now runs a full five-step pipeline — test, classify, map, narrow, present — and learns
in a closed loop: recommend → measure → learn. Built in ten phases (FAZ 0–10), each defended in an adversarial
debate (advocate, critic, pragmatist) before its results were accepted.

- **FAZ 0 — locked design.** 50-record decision log and a locked v2 design document.
- **FAZ 1 — Stage 0 telemetry.** JSONL event stream with reward-agnostic validation: the validator rejects
  reward/score/weight fields, so the client can never fabricate outcomes. Nothing is recorded before a first-run
  notice on stderr. Off switches: `repotify telemetry off`, `REPOTIFY_TELEMETRY=0`, `DO_NOT_TRACK=1`. 32/32 tests.
- **FAZ 2+3 — test runner and coarse classification.** Every catalog candidate runs its own tests; a jury
  promotion path (proxy ≥ 0.8, verified or caution only — blocked never promotes), cumulative-drift checks
  against the jury snapshot, and context labels that may only boost, never invent, evidence. 36/36 tests.
- **FAZ 4+5 — capability graph and recommend v1.** A deterministic capability DAG (65 seeded edges, multi-parent
  allowed) with "try this if that fails" fallback edges; recommend v1; a Jev decision model used only as a
  signal inside classification and ranking, never as the sole decider. 163/163 tests.
- **FAZ 7-harness — in-house evaluation harness.** Six arms (repotify, none, naive, jev, oracle, placebo),
  two-phase protocol (routing → task), precision/F1. 40/40 harness tests; full suite 570/570. Pilot series 2
  (z-ai/glm-5.3 via NVIDIA NIM, 30 runs): routing recall Δ +0.30 vs none, +0.20 vs naive; precision 1.0.
- **FAZ 6 — learning bandit.** LinUCB contextual bandit over recommendation scores: 200-round simulation regret
  ratio 0.664 (bar ≤ 0.80), worst of 5 seeds 0.762; jury scores warm-start the priors. 54/54 tests.
- **FAZ 7-mini — acceptance series.** Series 3: 36 runs, 4 arms, z-ai/glm-5.3. Gates: must-include capture
  9/9 = 100% (bar ≥ 85%) PASS; zero breakage PASS; task-score delta repotify−none +0.129, 95% CI [−0.01, 0.264]
  — a weak pass at n=9; the 100-repo series is pre-registered in `test/harness/ACCEPTANCE-RULES.md`.
  Budget: 92 of 100 model calls.
- **FAZ 8 — site v2.** 168 pages in 24 languages; per-skill comments (moderation controls only behind
  `?demo=moderation`, never on public pages); an effectiveness leaderboard reporting mean [min–max] over the
  series-3 harness results — measured evidence, no stars, no ratings. Suite 647/647; eval 108/108, 0 violations.
- **FAZ 9 — fleet telemetry.** Server-side nightly job (admit → snapshot → policy → gate → distribute);
  production schema (4 tables; no install_id, nonce or IP columns, tested); the fleet policy blends into the v2
  recommender; the public leaderboard stays gated behind 200 cumulative installs and k-anonymity (at least 5
  contributing syncs per published bucket, 24-hour quarantine). `repotify sync` sends only anonymous aggregates,
  and only after you confirm on the terminal. Full suite 662/662.
- **FAZ 10 — release.** Version 2.0.0, this changelog, documentation refresh. `repotify recommend` now runs the
  v2 pipeline (`lib/pipeline/recommend/`) directly: demand from project signals, capability-graph fallbacks,
  `--blocked` list, fleet policy blending, opt-in Jev arbitration (`--arbitrate` / `REPOTIFY_JEV=1`), and Stage 0
  propensity telemetry. Deferred per DL-051: serving-path exploration (quota semantics, arbitrate interaction,
  and propensity-log consumer are open preconditions).

Catalog: 142 items from 24 repositories — 137 skills, 3 MCP servers, 1 tool, 1 config.

Telemetry policy: default-ON with a first-run notice; kill switches above. Code, prompts, file names, repository
names, user names and IP addresses are never collected. What gets published is the proof (which skills measure
best at which jobs), never the recipe (raw data, taste profiles, scoring formulas, bandit weights).

## Unreleased

- **Stack experts for many more stacks.** Angular, Vue and Nuxt, Django, FastAPI, Python, Go, Rust, Java and Spring,
  Kotlin, Swift, Flutter, PHP, Laravel, Rails, C# and .NET, C and C++, and NestJS projects now get an expert skill for
  their stack, from [jeffallan/claude-skills](https://github.com/jeffallan/claude-skills) (MIT), security-scanned and
  scored by the jury. Each one has its own capability, so it is picked only for its stack and never takes the place of
  a core item. The catalog updates without a new npm release.
- The scenario set gains Angular, Laravel, Rails, Java and .NET projects; the Django, FastAPI, Go, Rust, Vue and Flutter
  scenarios require their expert, and scenarios on other stacks must not get it.
- **Fewer false alarms from the jury.** Jurors flagged skills as suspicious for giving their agent instructions, which
  is what a skill is for, and about a fifth of new findings lost their verified mark. Now only content aimed at the
  jury itself counts: asking for a score, telling it to ignore its rules, posing as a system message.
- `npm run check` names the failing tests.
- The lab now adds vetted skills to the catalog on its own, every 30 minutes, only after the security scan, the jury,
  the scenario set and `npm run check` pass. Four skills it added from a collection of leaked system prompts were
  removed and that source is denylisted: its license is not the uploader's to give.
- **No skills that only work with one product.** A skill written to drive one tool (a terminal multiplexer, a vendor
  CLI, an agent add-on) does nothing in a project without it. The jury now names such a product and the lab declines
  the skill; ten of them left the catalog.
- The lab searches Codex topics too, and works through the most-starred Claude Code and Codex collections first.

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
