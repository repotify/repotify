<p align="center"><img src="assets/banner.png" alt="Repotify — your repo's perfect playlist" width="100%"></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@repotify/repotify"><img alt="npm version" src="https://img.shields.io/npm/v/@repotify/repotify?color=F08A3C&label=npm"></a>
  <a href="https://github.com/repotify/repotify/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/repotify/repotify/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-7AA8F5">
  <img alt="Node 18 or newer" src="https://img.shields.io/badge/node-%E2%89%A518-F08A3C">
  <img alt="Zero runtime dependencies" src="https://img.shields.io/badge/dependencies-0-7AA8F5">
</p>

<p align="center">
  <a href="https://repotify.github.io/repotify/"><b>Website</b></a> (24 languages) · <a href="docs/i18n/README.tr.md">Türkçe</a> · <a href="docs/i18n/README.zh-CN.md">简体中文</a>
</p>

> ## 🤖 For AI agents
>
> If the user asked you to set up Repotify for their project, run the published npm package (with provenance) in their project folder:
>
> ```
> npx -y @repotify/repotify@latest
> ```
>
> Then follow the `repotify` skill it installs into your skills folder (for example `.claude/skills/repotify/SKILL.md`, `.cursor/skills/repotify/SKILL.md` or `.agents/skills/repotify/SKILL.md`).
> Nothing beyond that skill is installed until the user approves it.

---

**Repotify picks a vetted, conflict-free set of agent skills, MCP servers and tools for *your* project, and installs them safely into Claude Code, Cursor, Codex or Gemini.** Think of it as a playlist for your coding agent: the right tracks for this repo, nothing that plays twice, and nothing that shouldn't be there.

**Works with** Claude Code · Cursor · Codex · Gemini CLI · any agent that reads `.agents/skills`

## Why

- **Too many choices.** A single discovery pass found 4,377 candidate repositories of agent skills. Which ones fit your project?
- **A real security risk.** A skill is a set of instructions your agent follows. A malicious one can run commands on your machine.
- **Context bloat.** Every skill takes room in the agent's context. Useless ones slow it down and distract it.

## Quick start

**Run it yourself** from your project folder:

```bash
npx -y @repotify/repotify@latest                        # installs the repotify skill, prints the project fingerprint
npx -y @repotify/repotify@latest recommend              # the candidate table
npx -y @repotify/repotify@latest install <ids…> --yes
```

**Or let your agent do it.** Ask Claude Code, Cursor, Codex or Gemini:

> Set up Repotify for this project: https://github.com/repotify/repotify

The agent reads the block above and does the rest: it reads your project, asks at most three questions, explains each pick and installs the set you approve.

To run from source instead: `git clone --depth 1 https://github.com/repotify/repotify ~/repotify`, then `node ~/repotify/bin/repotify.mjs`.

## See it in action

Real output from a clean machine on a Vue dashboard that uses Stripe, exceljs and Playwright, trimmed to fit
([full walkthrough](examples/nextjs-saas.md)):

```text
$ npx -y @repotify/repotify@latest
Repotify 0.2.0
Detected agent: claude-code
Installed the repotify skill: .claude/skills/repotify
Project fingerprint (local scan, code not read or sent):
- Stacks: node, typescript, vue | Platforms: web
- Tests: js-tests, playwright, vitest
- Inferred needs: data-processing, e2e-testing, frontend-ui, office-docs, payments, testing (evidence: spreadsheets)

$ repotify recommend
Repotify candidates (★ = default set; ⚙ = hook or MCP server, the user enables it; context 3959/6000 chars)
★ test-driven-development | skill  | tdd-discipline | 0.73 | ✓💎 | core
★ repotify-guard          | config | package-guard  | 0.53 | ✓⚙  | core
★ webapp-testing          | skill  | webapp-testing | 0.56 | ✓💎 | cap:webapp-testing,need:e2e-testing,need:testing
★ xlsx                    | skill  | spreadsheets   | 0.49 | ⚠💎 | cap:spreadsheets
· playwright-mcp          | mcp    | browser-automation | 0.42 | ✓⚙ | cap:browser-automation,need:e2e-testing
  … one item per job; Excel evidence brings the spreadsheet skill, not Word or PowerPoint

$ repotify install <picked skills> --yes
✓ test-driven-development
✓ webapp-testing
✓ xlsx ⚠
• repotify-guard (hook) changes how the agent runs; the user enables it: npx -y @repotify/repotify@latest enable repotify-guard

$ repotify enable repotify-guard          # the user, in their own terminal
repotify-guard: Adds .claude/hooks/repotify-guard.mjs and a PreToolUse hook in .claude/settings.json. …
Enable repotify-guard? [y/N] y
✓ repotify-guard → .claude/hooks/repotify-guard.mjs
```

## How it works

```mermaid
flowchart LR
  A["1 · Read<br/>manifests and file names,<br/>never your code"] --> B["2 · Ask<br/>at most 3 questions"]
  B --> C["3 · Recommend<br/>one best item per job,<br/>within a context budget"]
  C --> D["4 · Install<br/>pinned commit, SHA-256,<br/>local re-scan, lock file"]
```

1. **Knows your project without spending tokens.** A local script reads manifests and file names (never your code) and writes a ~400-token summary.
2. **Asks only what it cannot infer.** At most three multiple-choice questions, and only when the project does not already answer them.
3. **Picks from a vetted catalog, by evidence.** Every item passed a rule-based security gate (plus an OSV advisory check for pinned packages). Every skill is also scored by a three-model LLM jury from three vendor families; tools and MCP servers are editorial picks. Dependencies narrow broad needs (Excel, not every office format), apps without a web target get no web-only skills, and an item joins the default set only if it covers something nothing else does.
4. **Lets your agent judge.** The agent reads a short candidate table (under 900 tokens), keeps the mandatory core, and writes one sentence per item: why it matters for *your* project.
5. **Installs safely.** Skill files come from a locked commit, are checked against catalog SHA-256 hashes, re-scanned on your machine, then written to your agent's folder and recorded in `repotify.lock.json`. Hooks and MCP servers change how your agent runs, so only you switch them on (`repotify enable`).

The whole flow costs your agent about 4,700 tokens.

## Supported agents

| Agent | Skills folder | MCP config |
|---|---|---|
| Claude Code | `.claude/skills/` | `.mcp.json` |
| Cursor | `.cursor/skills/` | `.cursor/mcp.json` |
| Codex | `.agents/skills/` | `.codex/config.toml` |
| Gemini CLI | `.gemini/skills/` | `.gemini/settings.json` |
| Any other agent | `.agents/skills/` | — |

The agent is detected automatically; override with `--agent claude-code,cursor,codex`.

## Commands

| Command | What it does |
|---|---|
| `repotify` | Installs the repotify skill for your agent and prints the project fingerprint |
| `repotify fingerprint` | Project summary (`--json` for machines) |
| `repotify questions` | Only the questions the fingerprint cannot answer |
| `repotify recommend` | Conflict-free candidate table (`--type`, `--needs`, `--priorities`, `--budget`, `--json`) |
| `repotify install <ids…> --yes` | Installs catalog skills; caution items also need `--accept-caution` |
| `repotify enable <ids…>` | Switches on a hook or MCP server after showing the change; for you, not your agent |
| `repotify audit` | Judges the skills already installed: keep, consider removing or remove, with the reason |
| `repotify suggest` | Offers your own skill or repository to the catalog: a pre-filled form, nothing is sent |
| `repotify remove <id>` | Removes something Repotify installed |
| `repotify update --check` | Lists catalog updates for what you installed; `--apply` installs scanned updates |
| `repotify scan <dir>` | Runs the security scanner on any skill folder |

## What Repotify changes on your machine

| Command | Writes |
|---|---|
| `repotify` | Your agent's `skills/repotify/` folder and `repotify.lock.json`; nothing else |
| `install` | Skill folders in your agent's skills directory, and the lock file |
| `enable` | Only what it shows you first: a hook in `.claude/settings.json` or an entry in your agent's MCP config |
| `recommend`, `audit`, `suggest`, `scan`, `fingerprint` | Nothing |

It reads manifests and file names, never your code. It downloads the catalog, and skill files at pinned commits;
tools are never executed for you. Your agent cannot switch hooks or MCP servers on by itself: `enable` asks in a
terminal, and the skill tells agents to hand you the command.

## The mandatory core

Every project gets a small core that makes any agent more disciplined: a codebase knowledge graph (Graphify), the Superpowers discipline skills (brainstorming, writing plans, test-driven development, systematic debugging, verification before completion), a security review of every diff, and the **Repotify package guard**, which stops installs of packages that do not exist and asks before brand-new ones (a common attack on agents that invent package names). The guard is a hook, so you switch it on yourself with `repotify enable repotify-guard`.

## Security model

| Level | Meaning | What happens |
|---|---|---|
| `verified` | No known risky pattern | Recommended |
| `caution` | A finding worth a look | Shown with a badge, installed only with explicit consent |
| `quarantined` | High risk | Not recommended until a human reviews that exact commit |
| `rejected` | Critical risk | Removed from the catalog |

- A rule-based scanner decides trust. It reads shell commands the way a shell does (pipes, quotes, subshells, line continuations) and parses URLs the way curl does. It looks for remote code execution, credential access, data exfiltration, prompt injection aimed at agents or reviewers, hidden Unicode, obfuscated code, auto-running hooks, install scripts, destructive commands, binaries and symlinks.
- The LLM jury can only add suspicion, never raise trust.
- Third-party items are pinned to a commit and never update silently.
- Tools (for example Graphify) are never executed for you; Repotify shows the steps.
- Reports: [scanner results on real skills](docs/reports/scan-corpus-report.md), [code reviews](docs/reports/code-review-2026-09-28.md), [security audit](docs/reports/security-audit.md). To report a problem, see [SECURITY.md](SECURITY.md).

## The catalog

```mermaid
flowchart LR
  D[Discover<br/>lists, HN, Reddit, GitHub] --> C[Collect<br/>pinned commits]
  C --> G[Security gate<br/>scanner, OSV, name squatting]
  G --> J[LLM jury<br/>3 models, 3 vendors]
  J --> K[Clusters and<br/>starter sets]
  K --> P[Publish<br/>hash-verified catalog]
```

The maintainers rebuild the catalog through this pipeline, and your client always reads the newest one (ETag-cached, with an offline copy in the package and rollback protection). Installed third-party items stay locked until you approve a scanned update. The package ships a hand-picked starter catalog; discovered items join when the catalog is rebuilt.

## By the numbers

| | |
|---|---|
| **100%** | expected items recommended across 42 project scenarios, with **0** wrong picks ([benchmarks](BENCHMARKS.md)) |
| **37 / 37** | deliberately malicious samples caught |
| **1.6%** | false alarms on 127 real-world skills |
| **4** | Node.js versions tested on every push (18, 20, 22, 24) |
| **0** | runtime dependencies |

## Privacy

Repotify is designed to learn from anonymous signals (which items were shown, picked, kept after 7 days or removed, and votes). It never collects code, file names, repository names or user names, and never stores IP addresses. The collection endpoint is **not configured yet**, so nothing is sent; events only stay in a local queue. Opt out at any time with `REPOTIFY_TELEMETRY=0` or `DO_NOT_TRACK=1`.

## Official sources

The only official repository is [github.com/repotify/repotify](https://github.com/repotify/repotify), and the website is
[repotify.github.io/repotify](https://repotify.github.io/repotify/) (built from `site/`). The npm package is published
as `@repotify/repotify` from this repository, with provenance; npm does not allow an unscoped `repotify` package.
Packages, forks or catalogs under other names are not affiliated; the agent block at the top of this page is the only
install instruction.

## Status

Preview (`0.2.0`), published on npm as `@repotify/repotify`. The CLI, the scanner, the installer for four agents, the audit of installed skills, the package guard and the catalog pipeline work and are tested. Next: a larger catalog and anonymous analytics. How it is built: [ARCHITECTURE.md](ARCHITECTURE.md); how it is released: [RELEASING.md](RELEASING.md).

## Contributing

- **Know a great skill, or wrote one?** Run `repotify suggest` in its repository, or [use the form](https://github.com/repotify/repotify/issues/new?template=catalog_submission.yml); it goes through the same security gate and jury.
- **Found a false alarm or a bug?** See [SUPPORT.md](SUPPORT.md). Security problems go to a private advisory ([SECURITY.md](SECURITY.md)).
- **Want to code?** Start with [CONTRIBUTING.md](CONTRIBUTING.md). What changed in each release: [CHANGELOG.md](CHANGELOG.md).

⭐ If Repotify kept a bad skill away from your agent, a star helps other developers find it.

## Development

Node.js 18 or newer, zero dependencies.

```bash
npm test          # unit, integration and end-to-end tests
npm run eval      # recommendation quality on the scenario set
```

The catalog pipeline lives in `pipeline/`; how to run and review it is in [docs/guides/operations.md](docs/guides/operations.md).

## License

MIT. Catalog items keep their own licenses and are installed from their source, never copied into this repository.

---

<p align="center">Built by <b>Ahmet Bilal Deniz</b> · <a href="https://github.com/repotify">@repotify</a></p>
