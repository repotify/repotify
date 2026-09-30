# Changelog

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
- Repository layout: `ARCHITECTURE.md` (including why JavaScript), `BENCHMARKS.md`, `RELEASING.md`, worked examples in
  `examples/`, translations in `docs/i18n/`, reports in `docs/reports/`; a test keeps documentation links working.
- Taxonomy: capabilities can be marked `platform: web`; building an MCP server also wants docs lookup.
  `pipeline/rehash.mjs` rewrites the hashes after a taxonomy edit.
- CI also runs on Node 24; `.gitignore` covers `.env` files, `.npmrc` and `*.pem`.
- Security review before release ([report](docs/reports/security-review-2026-09-30.md)): `update --apply` of a hook or
  MCP server now needs the same consent as `enable`; `audit` and `suggest` print names from the project safely and only
  suggest `repotify remove` for real catalog ids; oversized SKILL.md files are not parsed; the docs no longer claim the
  consent gate is a sandbox.
- A website at repotify.github.io/repotify in 24 languages (right-to-left for Arabic, Persian and Hebrew): one static
  page per language with hreflang, Open Graph, Twitter cards and JSON-LD, a sitemap, no trackers and no framework
  (`site/`, deployed by `.github/workflows/pages.yml`).
- A new logo, an R with a play symbol, and a new banner in violet and mint; the website uses the same colours.
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
