# Changelog

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
