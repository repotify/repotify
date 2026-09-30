# Security review of 0.2.0 (differential)

Date: 2026-09-30 · Scope: `4e405f4..HEAD` before the 0.2.0 release (13 commits, 22 source files, about 1,500 lines).
Method: differential review (risk triage, diff reading, test coverage, blast radius, attacker view), done by the
maintainer's AI assistant; not an independent audit.

## Triage

| Risk | Files |
|---|---|
| High | `src/cli.mjs` (install and enable consent), `src/audit.mjs` (reads installed skills, suggests removals), `src/suggest.mjs` (reads `.git/config` and project files, builds a URL), `src/scan/rules.mjs`, `src/scan/shell.mjs` (scanner) |
| Medium | `src/recommend.mjs`, `src/fingerprint.mjs`, `src/catalog.mjs`, `pipeline/run.mjs`, `pipeline/rehash.mjs`, `site/build.mjs`, `skill/repotify/SKILL.md`, `AGENTS.md`, workflows |
| Low | `src/needs.mjs`, `src/stackmap.mjs`, `site/src/app.js`, documentation |

Attacker model: a repository the user clones and runs Repotify in (it controls folder names, `repotify.lock.json`,
`package.json`, `.git/config` and installed skill files), and an agent that does not follow the Repotify skill.

## Findings (all fixed before release)

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | Medium | `repotify update --apply` rewrote an enabled MCP server's command or the guard hook without the consent that `enable` requires. | Updating a hook or MCP server asks in a terminal and needs `--yes` without one. | `test/cli-update.test.mjs` |
| 2 | Medium | `repotify audit` printed folder names and lock-file keys as they were: terminal control codes could spoof verdicts, and a crafted lock key became part of a suggested `repotify remove` command. | Names are printed plainly only when plain, else escaped and single-quoted for a shell (`src/display.mjs`); a remove command is suggested only for a real catalog id. | `test/audit.test.mjs`, `test/display.test.mjs` |
| 3 | Low | `repotify suggest` echoed the project's `license` field and finding paths. | The license must look like a license expression; paths are shown safely. | `test/suggest.test.mjs` |
| 4 | Low | `audit` parsed a `SKILL.md` of any size. | Over 1 MiB it is not parsed and is questioned. | `test/audit.test.mjs` |
| 5 | Info | README and website said an agent *cannot* enable hooks or MCP servers. | Reworded: it is a guard rail, not a sandbox; the agent's own permission settings are the real boundary. | n/a |

## Checked and accepted

- **Scanner refactor** (`downloadThenRun`): same verdicts on every fixture and on the 127-skill corpus; four times faster.
- **Site** (`site/build.mjs`, `app.js`): all strings are escaped for their context, JSON-LD escapes `<`, the page writes
  only `textContent`; the one outside request is GitHub's public API for the star count.
- **Workflows**: `pages.yml` builds with read-only contents and deploys with `pages: write` and `id-token: write` only;
  no untrusted event text reaches a shell; every action is pinned to a commit.
- **Symlinked skill folders** are audited through the link (read-only, bounded by the scanner's file and size limits).
- **Consent gate**: an agent that ignores the skill can pass `--yes`. Repotify documents this; it does not claim more.

## Limits

No fuzzing or independent reviewer; the private research lab (outside this repository) was out of scope.
