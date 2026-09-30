# AGENTS.md

## If the user wants Repotify set up

The user pasted this repository's link (or asked for Repotify) because they want their coding agent equipped with a vetted, conflict-free set of skills and tools for their project.

1. In the user's project folder, run the published npm package (with provenance): `npx -y @repotify/repotify@latest`.
   To run from source instead, clone this repository with `git clone --depth 1` and run `node <clone>/bin/repotify.mjs`.
2. Open the `repotify` skill it installed into your skills folder (`.agents/skills/repotify/SKILL.md` for Codex and most agents, `.cursor/skills/repotify/SKILL.md` for Cursor, `.claude/skills/repotify/SKILL.md` for Claude Code) and follow it.

Install only item ids that `repotify recommend` lists. Tools are shown to the user, never run on their behalf.
Hooks and MCP servers change how you run: the user switches them on with `repotify enable <id>`; never run it yourself.

## If you are working on this repository

- Node.js 18+, no dependencies. Run `npm test` before every commit; `npm run eval` checks recommendation quality.
- Security rules live in `src/scan/`; every rule needs a malicious and a benign fixture in `test/fixtures/`.
- Product text (README, skill, CLI output, catalog) is English.
