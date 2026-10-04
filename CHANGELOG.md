# Changelog

## 2.0.0 (2026-10-03)

A new recommendation engine, a catalog built from a crawl instead of a hand-kept list, and a setup that keeps working
after the install.

### What changes for you

- **Questions that earn their place.** `repotify questions` tries every possible answer against the engine and lists
  only the questions whose answer would change your picks, the likeliest decisive options first: one or two for a
  project with files, three for an empty folder, none when nothing would change. A question is asked once, and
  "none of these" is an answer. `recommend` also takes `--stacks` and `--platforms`.
- **See the decision.** `repotify ui` draws the catalog as a tree on a page served from your own computer: orange is
  still in play, green is picked, and each answer settles a branch until only the picks are left. It is read-only,
  needs the token in its link on every request and answers to no other host name.
- **It keeps up with the project.** Two hooks you switch on yourself (`repotify enable repotify-tracker
  repotify-router`). The tracker remembers which stacks and needs the project showed and tells your agent once when a
  change brings a new pick; weekly it checks for vetted updates and for skills that no longer earn their place. The
  router hears what kind of work each request is (26 kinds, English and Turkish, symptoms included) and names the
  installed skills made for it, or says nothing. Measured on 240 requests another model wrote: a fitting skill named
  for 94% of the requests a skill should handle, silent on 78% of those none should.
- **MCP servers, picked by real use.** The catalog now reads the official MCP registry (more than 36,000 servers,
  13,547 of them installable locally). 24 are listed: each has at least 10,000 downloads a month and a repository
  people starred, a command that starts a server, and the exact pinned version checked for install scripts and known
  vulnerabilities. A mobile app gets a device-automation server, a Supabase, Firebase, MongoDB, ClickHouse, Nx or
  Svelte project gets its vendor's own. A server whose runtime (uv, Docker) your computer lacks is listed with what it
  needs, not picked.
- **`audit` reads your MCP servers too.** A configured server whose command fails the security scan is marked for
  removal; one that is not pinned to a version, or whose config file holds a secret, is marked for review. The audit
  names the variable, never the value.
- **A catalog from a crawl: 442 items** (411 skills, 27 MCP servers, 1 tool, 3 hooks) from 106 repositories. Every
  skill folder is fetched once into a content store; scans, the decision model's answers and research are kept as
  observations, and rules turn them into items with no network, so a changed rule rebuilds the catalog in seconds.
  The crawl read 12,525 repositories and 419,581 skill folders; the 25,015 from the best-known repositories were
  judged and 325 passed. A skill is listed once, from its likelier origin: copies, old revisions, translations and
  mirrors stay out, and one repository lists at most 15. A crawled item joins a default set only with evidence about itself (installs,
  or downloads and stars); the rest are alternatives.
- **Stars are not enough.** Four research agents read what else there is about a repository: forum threads, star
  history against real installs, directories and curated lists. Of 90 repositories, 19 looked inflated; the 471
  skills of three of them wait for a human instead of entering the catalog.
- **Every skill classified by a decision model.** At catalog build time Jev (TypeSafe, via OpenRouter's Decisions API;
  any Jev-compatible model works) reads each `SKILL.md` and answers typed questions: off-topic gate, main job,
  language, framework or product, tied to one product, what it is for, lifecycle (pays off once, on every task, or
  now and then) and quality. Rules act only on confident answers and hand-curated items are never relabelled. Against
  49 hand labels with the taxonomy of 80 jobs: main job 88% (a jury's free-form labels 52%), language 98% (86%),
  off-topic 98% (88%), lifecycle 85%. Nothing calls a model on your machine.
- **The right agent.** A Claude Code hook is not offered when Cursor, Codex or Gemini CLI is the one asking.
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
- **Off-topic items are out.** Collections for digital forensics, malware analysis and marketing, math-contest
  skills, a Telegram bot setup and skills that only drive one product no project can show were removed.
- **Security, new in this release.** The launcher written into hook commands no longer accepts `$(…)`, backticks or
  `$VAR` inside a quoted path: a poisoned `repotify.lock.json` could have run a command at session start once the
  weekly check was enabled. Command scans read a script passed as one argument (`bash -c "…"`) as a script. The gate
  no longer counts `prepare` as an install script (npm does not run it for a package fetched from the registry).
- **Security.** Scanner 1.4.0: a file's level comes from its most severe findings, and so does a line's. Before, the
  first match on a line decided it, so a decoy put first hid the real command: an official installer before a second
  `curl … | bash` from anywhere, a negated example before a real instruction, an upload or a secret sent to a known API
  before one sent elsewhere, a dull blob before an encoded payload. Download-then-run looks at every command of the
  next five lines (twelve no-op commands or a long line before the run hid it), clone-then-run reads
  `git clone --depth 1 …`, `-b`, a named folder, `.` and SSH remotes, and a line with more matches than the scanner
  reads goes to human review. On 4,707 real skills this changes one verdict (a third-party clone run from `/opt`).
  Long lines of hidden characters no longer slow the scanner down. Since 2026-10-01 it also catches `xargs`/`parallel`
  pipes into a shell, `curl` redirects and more `rm` and `sudo` forms, and the package guard checks `npx -p`,
  `npm exec` and registry overrides in the environment. The jury no longer flags a skill for instructing its agent; only
  text aimed at the jury itself counts. `node pipeline/regate.mjs` re-scans the catalog at its pinned commits after a
  scanner change.
- **Codex.** Removing or updating an MCP server keeps everything else in `.codex/config.toml` (array tables and
  commented headers after the server were deleted before).
- **Hostile project files.** A cloned project can link a file to a device that never ends (`/dev/zero`). `audit`,
  `suggest`, the lock file, agent settings and MCP configs, and the package guard's `.npmrc` read now only regular files
  of a sane size; before, one such link made the command read forever and fill the memory. The capability graph check
  that runs on every `recommend` is linear (20,000 edges: 2.9 s before, 0.04 s now), so it keeps up as the catalog grows.
- **Telemetry stays on your machine.** Usage signals are logged locally after a first-run notice; `repotify sync` is
  the only way out, it asks first, and no collection server runs yet. Kill switches: `repotify telemetry off`,
  `REPOTIFY_TELEMETRY=0`, `DO_NOT_TRACK=1`, `NO_ANALYTICS=1` (the last one now stops both local logs).
- `recommend --arbitrate` (opt-in, needs a Jev key) asks only about the optional candidates; it used to ask which of
  four core skills fits best. Exploration is off unless `REPOTIFY_EXPLORE=1`, and it never doubles a job.

### Security hardening (external audit, 2026-10-03)

An outside audit ran its claims against the code; each confirmed finding is fixed with tests that cover the whole
class of inputs, not the one reported example (`test/audit-fixes.test.mjs`). What it means for you:

- **Hooks cannot be hijacked through the lock file.** The command a hook runs is the published package or
  `node "<absolute path>/repotify.mjs"`, taken from the copy you are running. It used to be read from
  `repotify.lock.json` and only checked for shell characters, so `sh -c "…"` or `node -e …` in a cloned repository's
  lock became a command at every session start.
- **Scanner 1.5.0.** A fetch tool is recognised however the shell would read it (`c'u'rl`, `c\url`, `\curl`,
  `/usr/bin/curl`, a word split over a `\` line break); warning words inside an HTML comment or a hidden element no
  longer turn a command into "documentation"; PowerShell `-EncodedCommand` and `FromBase64String | iex` are
  obfuscation; `git clone … && python setup` counts without a file extension; an encoded path is not an official
  installer. New: "ignore the previous instructions" in ten languages, and a rule for instructions that are unsafe to
  follow (wave a warning through, read `.env` into the conversation, load instructions from a URL).
- **`verified` is said for what it is:** scanned for known malicious patterns, not "safe to follow"
  ([docs/guides/security.md](docs/guides/security.md)).
- **The package guard reads dressed-up installs** (`sudo -E`, `env`, `nice`, absolute paths, `npm.cmd`, `pip3.11`,
  `python -u -m pip`, `-r requirements.txt`) and **asks when it could not check**: registry unreachable, install from
  a URL (including `name @ https://…`), a registry it does not know. Before, each of these passed in silence.
- **Raw usage events can no longer be sent.** `REPOTIFY_TELEMETRY_URL` used to switch on a second path that posted
  the local event queue (install id and timestamps) from six commands without asking. That code is gone; the variable
  only names the server for `repotify sync`, which sends aggregates after you confirm.
- **MCP servers: the environment is checked too.** An entry that sets `npm_config_registry`, `UV_INDEX_URL`,
  `NODE_OPTIONS`, `PATH` and the like is refused by the gate and by `enable`, never written, and flagged by `audit`.
  On an update, a value you set is kept over the catalog's.
- **A catalog check that could not run is not a pass.** If npm, PyPI or OSV does not answer, the item is not
  published (it used to go in as "caution"). Packages first published in the last 14 days are marked. Stored MCP gate
  results are per scanner and gate version.
- **Catalog loading.** A cache is used only for the source it came from (one run with `REPOTIFY_CATALOG_URL` could
  leave a catalog that outranked the real one forever); the same version with other content is refused; a changed
  source is announced; a catalog over 60 days old says so.
- **`audit`** scans Repotify's own skill like any other, says when a skill could not be scanned instead of calling it
  clean, and uses the same platform rule as `recommend`. `installSelf` scans the skill before copying it.
- **`update --check`** never offers a commit from a catalog older than the one an item was installed from, and
  compares an MCP server's whole setup.
- **The CLI exits when it is done** (open connections could hold it for minutes behind a proxy),
  `REPOTIFY_OFFLINE=1` refuses an install up front, `repotify scan` has the audit's size limits, and `--help` lists
  every environment variable.
- **Measurement.** A 400-project invariant sweep now runs against the engine the CLI serves
  (`test/served-invariants.test.mjs`), the eval can pin the machine, and coverage counts `lib/`.

Not done, and said so: the catalog is not signed, the plain-language rules are heuristics, and no model reads every
skill for instruction safety.

### Measured

- Recommendation quality on 49 scenarios, run against the engine the CLI serves and the 442-item catalog: 108/108
  must-include, 0 violations, 0 duplicate jobs; the default set averages 14.5 items and 4,233 of 6,000 characters.
- One setup costs the agent about 2,900 tokens (2,822–2,982 over seven fixture projects, `test/eval/flow-tokens.mjs`).
- The router, the classifier and the questions: [docs/BENCHMARKS.md](docs/BENCHMARKS.md).
- The scanner reads a long line of `git clone` commands 2.7 times faster (each later command was read once per
  clone); re-scanning the 4,484 stored skill folders gives the same verdict for every one.
- 943 tests: all pass on Node 22 and 24; on Node 18 and 20, six worker tests that need `node:sqlite` are skipped.
  Coverage 94.9% of lines, 85.4% of branches.

### Built, not live

The learning loop (LinUCB with off-policy evaluation, `lib/learn/`) and the fleet server (`lib/telemetry/server/`) are
built and tested in simulation. The learner is not wired into `recommend` and nothing is deployed, so rankings do not
learn from use yet (a policy file saved by `repotify sync` would move a score by at most 0.1; none exists without a
fleet server). An evaluation harness (`test/harness/`) compares routing strategies on pilot scale; its series 3 results
are on the website's leaderboard as mean [min–max] at n = 3 per cell.

### For maintainers

- The crawl pipeline: `pipeline/crawl.mjs` (fetch each skill folder once into a content store), `observe.mjs` (scan
  and decision model, kept per content and question set), `research.mjs` (four agents), `mcp.mjs` (registry,
  downloads, repository stars, setup gate) and `derive.mjs` (rules only). `node pipeline/derive.mjs --store DIR`
  rebuilds the catalog from the store in seconds; `--dry-run --report FILE` shows what each rule kept out.
- The pipeline at the scale of a full crawl (12,525 repositories, 419,581 skill folders): `observe` reads only
  repositories that changed and asks the decision model within a budget (`--max-asks`, best-known first, `--shard`
  for several processes); `crawl --restore` refills a store moved to another machine from its records; `derive`
  judges only skills the model answered about, with the copy rules of `pipeline/copies.mjs`. Two faults that ended
  crawl rounds are fixed (a git child that dies mid-input, a GitHub response cut off mid-body). Numbers and their
  limits: [docs/BENCHMARKS.md](docs/BENCHMARKS.md#the-pipeline-on-the-full-store).
- The router is measured, not assumed: `node test/eval/router.mjs`. Two request sets were written by another model
  (`pipeline/router-evalset.mjs`); the second is never tuned on, and floors in the test suite catch a regression.
- Pipeline scripts share one flag reader and one logger (`pipeline/lib/cli.mjs`).
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
