# Changelog

## Unreleased

- Scanner: a long line with many downloads is scanned about four times faster. Each command is read once instead of
  once per earlier download, so the linear-time test passes on slower machines and on Node 18, where CI was failing.
- README (all three languages) and AGENTS.md: the npm package is the primary install path; cloning stays as the
  from-source option. The agent block is phrased as a request from the user, not an order, and says that nothing
  beyond the skill is installed without the user's approval.
- `.gitignore` covers `.env` files, `.npmrc` and `*.pem`, so local keys are not committed by `git add -A`.

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
