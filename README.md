<p align="center"><img src=".github/assets/banner.png" alt="repotify: every skill your repo needs, nothing it doesn't" width="100%"></p>

<p align="center"><b>Every skill your repo needs. Nothing it doesn't.</b><br>Repotify reads your project, picks the agent skills, MCP servers and tools that fit it, scans every one of them and installs them safely into Claude Code, Cursor, Codex or Gemini CLI.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@repotify/repotify"><img alt="npm" src="https://img.shields.io/npm/v/@repotify/repotify?style=flat-square&labelColor=000000&color=3FE8B8&label=npm"></a>
  <a href="https://github.com/repotify/repotify/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/repotify/repotify/ci.yml?branch=main&style=flat-square&labelColor=000000&label=ci"></a>
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-3FE8B8?style=flat-square&labelColor=000000">
  <img alt="Runs on Linux, macOS and Windows" src="https://img.shields.io/badge/runs_on-linux_%7C_macos_%7C_windows-3FE8B8?style=flat-square&labelColor=000000">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-3FE8B8?style=flat-square&labelColor=000000"></a>
</p>

> [!NOTE]
> **🤖 For AI agents.** If the user asked you to set up Repotify for their project, run the published npm package (with provenance) in their project folder:
>
> ```
> npx -y @repotify/repotify@latest
> ```
>
> Then follow the `repotify` skill it installs into your skills folder (for example `.claude/skills/repotify/SKILL.md`, `.cursor/skills/repotify/SKILL.md` or `.agents/skills/repotify/SKILL.md`). Nothing beyond that skill is installed until the user approves it.

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a> &nbsp;·&nbsp;
  <a href="#see-it-in-action"><b>Demo</b></a> &nbsp;·&nbsp;
  <a href="#security-you-can-check"><b>Security</b></a> &nbsp;·&nbsp;
  <a href="#commands"><b>Commands</b></a> &nbsp;·&nbsp;
  <a href="#roadmap"><b>Roadmap</b></a> &nbsp;·&nbsp;
  <a href="https://repotify.github.io/repotify/"><b>Website</b></a> &nbsp;·&nbsp;
  <a href="docs/i18n/README.tr.md">Türkçe</a> &nbsp;·&nbsp;
  <a href="docs/i18n/README.zh-CN.md">简体中文</a>
</p>

## Why Repotify

There are thousands of agent-skill repositories out there. Setting up your agent by hand means guessing what fits,
trusting strangers' instructions and slowly filling its context with things it never uses. Repotify does it for you,
in one command.

<table>
<tr>
<td width="33%" valign="top">

**Made for your stack**

It reads manifests and file names, never your code. Excel in your dependencies brings the spreadsheet skill, not Word
and PowerPoint. Mobile apps never get web-only skills.

</td>
<td width="33%" valign="top">

**Nothing sketchy gets in**

A scanner reads every skill the way a shell and curl would. Every item is pinned to a commit, hash-checked and scanned
again on your machine before it lands.

</td>
<td width="33%" valign="top">

**No bloat, no duplicates**

One best item per job, inside a context budget. Your agent stays fast and focused instead of carrying instructions it
never uses.

</td>
</tr>
</table>

## Quick start

Run it in your project folder:

```bash
npx -y @repotify/repotify@latest                        # installs the repotify skill, prints what it found
npx -y @repotify/repotify@latest recommend              # the picks for this repo
npx -y @repotify/repotify@latest install <ids…> --yes   # installs the ones you choose
```

**Or just ask your agent.** In Claude Code, Cursor, Codex or Gemini CLI:

> Set up Repotify for this project: https://github.com/repotify/repotify

It reads your project, asks at most three questions, explains every pick in one sentence and installs the set you
approve. To run from source instead: `git clone --depth 1 https://github.com/repotify/repotify ~/repotify`, then
`node ~/repotify/bin/repotify.mjs`.

## See it in action

<p align="center"><img src=".github/assets/demo.svg" alt="A terminal: npx @repotify/repotify prints the project fingerprint, repotify recommend lists one pick per job and keeps react-native-skills out, repotify install installs the picks and leaves the guard hook for the user to switch on" width="100%"></p>

A Next.js app with Stripe, Supabase and Playwright, on a clean machine. Full walkthrough with every line of output:
[examples/nextjs-saas.md](docs/examples/nextjs-saas.md).

## Clean up what you already have

`repotify audit` judges the skills already in your project, including the ones Repotify never installed: keep,
consider removing, or remove, each with the reason and the context it frees.

<p align="center"><img src=".github/assets/audit.svg" alt="repotify audit: keeps the skills that serve the project, suggests removing ones for other stacks or duplicate jobs, and flags a skill that fails the security scan" width="100%"></p>

It never deletes anything; your agent asks you first. [The full example](docs/examples/audit-stray-skills.md).

## How it works

<p align="center"><img src=".github/assets/how-it-works.svg" alt="Four steps: read the project, ask at most three questions, pick one scanned item per job, install from a pinned commit" width="100%"></p>

1. **Knows your project without spending tokens.** A local script reads manifests and file names (never your code) and writes a ~400-token summary.
2. **Asks only what it cannot infer.** At most three multiple-choice questions, and only when the project does not already answer them.
3. **Picks from a vetted catalog, by evidence.** Every item passed a rule-based security gate (plus an OSV advisory check for pinned packages). Every skill is also scored by a three-model LLM jury from three vendor families; tools and MCP servers are editorial picks. Dependencies narrow broad needs, apps without a web target get no web-only skills, and an item joins the default set only if it covers something nothing else does.
4. **Lets your agent judge.** The agent reads a short candidate table (under 900 tokens), keeps the mandatory core, and writes one sentence per item: why it matters for *your* project.
5. **Installs safely.** Skill files come from a locked commit, are checked against catalog SHA-256 hashes, re-scanned on your machine, then written to your agent's folder and recorded in `repotify.lock.json`. Hooks and MCP servers change how your agent runs, so only you switch them on (`repotify enable`).

The whole flow costs your agent about 4,700 tokens.

## Security you can check

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
- Reports: [scanner results on real skills](docs/reports/scan-corpus-report.md), [code reviews](docs/reports/code-review-2026-09-28.md), [0.2.0 security review](docs/reports/security-review-2026-09-30.md), [security audit](docs/reports/security-audit.md). To report a problem, see [SECURITY.md](.github/SECURITY.md).

## Works with

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

<details>
<summary><b>What Repotify changes on your machine</b></summary>

| Command | Writes |
|---|---|
| `repotify` | Your agent's `skills/repotify/` folder and `repotify.lock.json`; nothing else |
| `install` | Skill folders in your agent's skills directory, and the lock file |
| `enable` | Only what it shows you first: a hook in `.claude/settings.json` or an entry in your agent's MCP config |
| `recommend`, `audit`, `suggest`, `scan`, `fingerprint` | Nothing |

It reads manifests and file names, never your code. It downloads the catalog, and skill files at pinned commits;
tools are never executed for you. Repotify's flow never has your agent switch hooks or MCP servers on: `enable` asks
in a terminal (without one it needs `--yes`), and the skill tells agents to hand you the command instead of running it.
This is a guard rail, not a sandbox: your agent's own permission settings still decide what it may run.

</details>

<details>
<summary><b>The mandatory core</b></summary>

Every project gets a small core that makes any agent more disciplined: a codebase knowledge graph (Graphify), the Superpowers discipline skills (brainstorming, writing plans, test-driven development, systematic debugging, verification before completion), a security review of every diff, and the **Repotify package guard**, which stops installs of packages that do not exist and asks before brand-new ones (a common attack on agents that invent package names). The guard is a hook, so you switch it on yourself with `repotify enable repotify-guard`.

</details>

<details>
<summary><b>How the catalog is built</b></summary>

```mermaid
flowchart LR
  D[Discover<br/>lists, HN, Reddit, GitHub] --> C[Collect<br/>pinned commits]
  C --> G[Security gate<br/>scanner, OSV, name squatting]
  G --> J[LLM jury<br/>3 models, 3 vendors]
  J --> K[Clusters and<br/>starter sets]
  K --> P[Publish<br/>hash-verified catalog]
```

The maintainers rebuild the catalog through this pipeline, and your client always reads the newest one (ETag-cached, with an offline copy in the package and rollback protection). Installed third-party items stay locked until you approve a scanned update. The package ships a hand-picked starter catalog; discovered items join when the catalog is rebuilt.

</details>

<details>
<summary><b>Privacy</b></summary>

Repotify is designed to learn from anonymous signals (which items were shown, picked, kept after 7 days or removed, and votes). It never collects code, file names, repository names or user names, and never stores IP addresses. The collection endpoint is **not configured yet**, so nothing is sent; events only stay in a local queue. Opt out at any time with `REPOTIFY_TELEMETRY=0` or `DO_NOT_TRACK=1`.

</details>

<details>
<summary><b>Official sources</b></summary>

The only official repository is [github.com/repotify/repotify](https://github.com/repotify/repotify), and the website is
[repotify.github.io/repotify](https://repotify.github.io/repotify/) (built from `site/`). The npm package is published
as `@repotify/repotify` from this repository, with provenance; npm does not allow an unscoped `repotify` package.
Packages, forks or catalogs under other names are not affiliated; the agent block at the top of this page is the only
install instruction.

</details>

## Roadmap

- [x] **0.2**: an audit of installed skills, picks by evidence, platform and coverage, hooks and MCP servers switched on only by you, Linux, macOS and Windows.
- [ ] **A catalog of 1,000+ vetted skills, MCP servers and tools**, discovered around the clock by a research lab, checked by the security gate and approved by a person.
- [ ] **Rankings that learn** from what developers keep and remove (anonymous, opt-out).
- [ ] **MCP mode**: your agent calls Repotify as a tool instead of a command.
- [ ] **Every major stack covered**: web, mobile, data, infrastructure, smart contracts and games.

How it is built: [ARCHITECTURE.md](docs/ARCHITECTURE.md). How it is measured: [BENCHMARKS.md](docs/BENCHMARKS.md). How it is
released: [RELEASING.md](docs/RELEASING.md).

## Contributing

- **Know a great skill, or wrote one?** Run `repotify suggest` in its repository, or [use the form](https://github.com/repotify/repotify/issues/new?template=catalog_submission.yml); it goes through the same security gate and jury.
- **Found a false alarm or a bug?** See [SUPPORT.md](.github/SUPPORT.md). Security problems go to a private advisory ([SECURITY.md](.github/SECURITY.md)).
- **Want to code?** Start with [CONTRIBUTING.md](.github/CONTRIBUTING.md). What changed in each release: [CHANGELOG.md](CHANGELOG.md).

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

---

<p align="center"><img src=".github/assets/logo-tile.svg" alt="" width="44"><br>Built by <b>Ahmet Bilal Deniz</b> · <a href="https://github.com/repotify">@repotify</a></p>
