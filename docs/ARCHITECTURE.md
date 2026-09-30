# Architecture

Repotify is a zero-dependency Node.js CLI plus a catalog pipeline. The CLI runs on the user's machine and never reads
source code; the pipeline runs on GitHub Actions (or a maintainer's machine) and publishes a static, hash-verified
catalog that every client downloads.

```mermaid
flowchart LR
  subgraph Maintainers
    D[pipeline/discover] --> C[pipeline/collect<br/>pinned commits]
    C --> G[pipeline/gate<br/>scanner, OSV, name squatting]
    G --> J[pipeline/jury<br/>3 models, 3 vendors]
    J --> P[pipeline/publish<br/>catalog/*.json + SHA-256 in meta.json]
  end
  P -->|raw.githubusercontent.com, ETag| L[src/catalog<br/>remote → cache → bundled]
  subgraph "User's machine"
    F[src/fingerprint<br/>manifests and file names] --> N[src/needs<br/>≤ 3 questions, weights]
    N --> R[src/recommend<br/>demand · fit · coverage · budget]
    L --> R
    R --> I[src/install<br/>skills: hash + re-scan]
    R --> E[repotify enable<br/>hooks, MCP: the user]
    F --> A[src/audit<br/>installed skills]
  end
```

## Where things live

| Path | Responsibility |
|---|---|
| `bin/repotify.mjs` | Entry point: hands `process` streams to `src/cli.mjs` |
| `src/cli.mjs` | Argument parsing and every command's output (`start`, `fingerprint`, `questions`, `recommend`, `audit`, `suggest`, `install`, `enable`, `remove`, `scan`, `update`, `vote`, `telemetry`, `guard`) |
| `src/fingerprint.mjs`, `src/stackmap.mjs` | Local project scan: stacks, frameworks, needs, capability evidence, platforms, installed skills. `stackmap.mjs` is pure data |
| `src/needs.mjs` | The few questions an agent may ask, and needs with evidence weights |
| `src/recommend.mjs` | Recommendation engine (below) and the candidate table |
| `src/catalog.mjs` | Catalog schema, integrity checks, loading with ETag cache, offline copy and rollback protection |
| `src/install.mjs`, `src/mcpconfig.mjs`, `src/lock.mjs` | Installs (pinned commit, SHA-256, local re-scan), MCP config per agent, `repotify.lock.json` |
| `src/agents.mjs` | Supported agents: skills folder, MCP config file, detection |
| `src/audit.mjs` | Judges installed skills: keep, consider removing, remove, with reasons |
| `src/suggest.mjs` | Builds a pre-filled catalog submission link for the user's own repository |
| `src/update.mjs` | Vetted updates for installed items; the optional weekly SessionStart check |
| `src/guard.mjs` | Package guard, a Claude Code PreToolUse hook. Node built-ins only: it is copied into projects as one file |
| `src/scan/` | Security scanner: `rules.mjs` (line rules), `shell.mjs` (shell structure), `files.mjs` (file-level rules), `typosquat.mjs` |
| `src/telemetry*.mjs`, `src/feedback.mjs` | Anonymous usage signals (endpoint off until deployed), weekly votes |
| `src/config.mjs`, `src/util.mjs`, `src/frontmatter.mjs` | URLs and settings, helpers, SKILL.md frontmatter |
| `pipeline/` | Discovery, collection, security gate, LLM jury, clustering, publishing; `rehash.mjs` after a taxonomy edit |
| `catalog/` | The published catalog. Generated; `meta.json` holds the hashes clients verify |
| `skill/repotify/SKILL.md` | The skill Repotify installs into the user's agent |
| `test/eval/` | Recommendation scenarios (`test/eval/scenarios/`) and the scanner corpus run |
| `test/` | `node:test` suites, malicious and benign scanner fixtures, fixture projects |
| `pipeline/worker/` | Cloudflare Worker for anonymous analytics (not deployed yet) |
| `docs/` | Maintainer guide (`guides/`), reports (`reports/`), translations (`i18n/`) |
| `docs/examples/` | Worked examples with real output |
| `site/` | The website: `node site/build.mjs` builds one static page per language into `site/dist` (GitHub Pages) |

## The recommendation engine

1. **Demand.** Needs come with a weight for how sure we are: seen in the project or said by the user (1.0), a stated
   priority (0.85), a default of the project type (0.75). Each need wants the capabilities the taxonomy maps it to.
   Dependency evidence narrows a broad need to the facets it shows: `openpyxl` means spreadsheets, not every office
   format, unless the user named the need. Platforms (web, mobile, desktop) come from dependencies.
2. **Fit.** An item fits through the capabilities it provides (strong) and the needs it lists (weaker), scaled by the
   evidence behind them. Stack items need a stack the project uses. Web-only capabilities (taxonomy `platform: web`)
   do not fit an app with no web target. Core items always fit.
3. **Score.** Fit times a prior: quality (jury), trust (scan level), adoption, freshness and community signals, with
   Bayesian smoothing so new items are not punished.
4. **One item per job.** Candidates are deduplicated by cluster, exclusive group and declared conflicts.
5. **Coverage.** An optional item joins the default set only if it serves a wanted capability or need that nothing
   chosen so far serves; otherwise it stays in the table as an alternative with `covered-by:<id>`. Stack expertise
   and curated starter sets are exempt.
6. **Budget.** Installed items and the core go first; the rest fill the context budget by value per character.

`npm run eval` measures this on the scenario set; see [BENCHMARKS.md](BENCHMARKS.md).

## Trust boundaries

- **Reading is local.** The fingerprint reads manifests and file names, never file contents beyond manifests.
- **Skills are pinned and re-scanned.** Files come from the catalog's commit, must match its SHA-256 hashes and pass a
  local re-scan before they are written.
- **Hooks and MCP servers are the user's.** They change how the agent itself runs, so `install` only prints the
  `repotify enable <id>` command. `enable` shows the change and asks in a terminal; without one it needs `--yes`
  typed by the user. The skill tells agents never to run it. This is a guard rail, not a sandbox: an agent that ignores
  the skill could pass `--yes`, so the agent's own permission settings remain the real boundary.
- **Tools are never executed.** Repotify shows their steps.
- **The LLM jury can only lower trust.** Model output never makes an item safer.

## Design decisions

### Why JavaScript, not Python

Repotify serves people who use Claude Code, Cursor, Codex and Gemini CLI. Node.js is already on their machines (Claude
Code, Codex CLI and Gemini CLI install through npm), so `npx -y @repotify/repotify@latest` works with nothing to set up.
A Python tool needs `uv` or `pipx` first, which is the right trade for a tool like Graphify that needs heavy parsing
libraries (tree-sitter, graph algorithms). Repotify needs none of that: its work is file I/O, rules and scoring.

JavaScript also fits the artifacts Repotify writes: JSON settings, `.mcp.json` entries that launch npm packages with
`npx`, and a PreToolUse hook that must start fast and run with no dependencies. Node's standard library covers
everything else (`fetch`, `crypto`, `node:test`), which keeps the supply chain of a security tool at zero packages.

The costs are real but small: JavaScript regexes need care on long inputs (the scanner has a linear-time test) and the
code has no static types (tests and JSDoc cover it). A rewrite would cost weeks and give users nothing.

### Zero runtime dependencies

A tool that vets other people's code should not pull in a dependency tree of its own. Node built-ins only.

### A static catalog instead of a service

The catalog is plain JSON on GitHub with SHA-256 hashes in `meta.json`. Clients verify every file, cache by ETag, keep
an offline copy in the package and refuse a remote catalog older than the one they have. There is no server to trust or
to keep running.

## Changing things

| To add | Do this |
|---|---|
| A dependency or file signal | Add an entry to `src/stackmap.mjs` (`stacks`, `needs`, `caps`, `platforms`) and a fingerprint test |
| A capability, need or platform | Edit `catalog/taxonomy.json`, run `node pipeline/rehash.mjs`, add an eval scenario |
| A catalog item | Edit `pipeline/seed-sources.json` and rebuild (see [docs/guides/operations.md](guides/operations.md)) |
| A scanner rule | `src/scan/rules.mjs` plus a malicious and a benign fixture and a corpus run (see [CONTRIBUTING.md](../.github/CONTRIBUTING.md)) |
| A command | A module in `src/`, the command in `src/cli.mjs`, tests for its edge cases |
