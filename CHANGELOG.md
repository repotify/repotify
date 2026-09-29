# Changelog

## 0.1.1 (2026-09-30)

- The npm package is `@repotify/repotify`. npm does not accept the unscoped name `repotify` (too similar to
  `restify` and `reactify`), so 0.1.0 was never published there. The command is still `repotify`.

## 0.1.0 (2026-09-29)

First public preview.

- `repotify` reads a project without reading its code, asks at most three questions and recommends a conflict-free set
  of skills, MCP servers and tools within a context budget.
- Installs for Claude Code, Cursor, Codex, Gemini CLI and any agent that reads `.agents/skills`, from pinned commits,
  checked against SHA-256 hashes, re-scanned locally and recorded in `repotify.lock.json`.
- Security scanner 1.2.0: reads shell structure and URLs the way the shell and curl do; four trust levels.
- Package guard for Claude Code that blocks installs of packages that do not exist and asks before brand-new ones.
- Catalog pipeline with discovery, a security gate with OSV advisories and a three-model LLM jury. The starter catalog
  has 29 hand-picked items.
- 300 tests, a 37-scenario evaluation set, documentation in English, Turkish and Simplified Chinese.
