# Security audit — 2026-09-28

Scope: Repotify's own supply chain, the three GitHub Actions workflows under `.github/workflows/`, and the
third-party code the catalog pipeline runs. Tools: the `agentic-actions-auditor` and `supply-chain-risk-auditor`
skills (both pinned in `.claude/skills.lock.json`), plus Repotify's own scanner.

## 1. Agentic Actions audit (`agentic-actions-auditor`)

**Analyzed 3 workflows containing 0 AI action instances. Found 0 findings: 0 High, 0 Medium, 0 Low, 0 Info.**

| Workflow file | AI action instances |
|---|---|
| `.github/workflows/catalog.yml` | 0 |
| `.github/workflows/ci.yml` | 0 |
| `.github/workflows/release.yml` | 0 |

No step uses `anthropics/claude-code-action`, `google-github-actions/run-gemini-cli`, `openai/codex-action` or
`actions/ai-inference`. No security findings identified under vectors A–I.

Additional review of the LLM usage that the methodology does not cover (the jury is called from pipeline code,
not from an agent action):

- Triggers are `schedule`, `workflow_dispatch`, `push`, `pull_request` and version tags; no trigger exposes
  issue or comment bodies to a privileged job. Issue submissions are read only as repository names.
- Untrusted skill text reaches the jury prompt by design. The jury has no tools, its reply is parsed as strict
  JSON and never executed, and its verdict can only lower a security level (see SECURITY.md).
- No `${{ }}` expression is interpolated into a `run:` script; values pass through `env:`.
- `build` holds the LLM keys with `contents: read`; `publish` holds `contents: write` and no LLM key.
  `persist-credentials: false` is set wherever the token is not needed.
- Every `uses:` reference is pinned to a commit SHA (checkout v7.0.1, setup-node v7.0.0, cache v6.1.0,
  upload-artifact v7.0.1, download-artifact v8.0.1).
- OmniRoute, when enabled, runs as a separate unprivileged user bound to 127.0.0.1, so it cannot read the
  pipeline process environment through `/proc`.

## 2. Supply chain (`supply-chain-risk-auditor`)

### Repotify package

The collector refused to report on `repotify/`: "no direct dependencies found under .. A run that assesses
nothing must not report that nothing is wrong." The package declares no `dependencies` or `devDependencies`;
`npm pack --dry-run` lists 36 files (bin, src, skill, catalog, docs) and no install scripts.

### OmniRoute 3.8.50 (catalog pipeline, optional jury fallback)

Full report: `docs/audits/supply-chain-omniroute-3.8.50.md` (1,241 registry-verified packages in the lockfile).

- `omniroute` 3.8.50 is affected by **GHSA-hf57-cqmx-p4gr** ("OmniRoute ACP Custom-Agent Remote Code
  Execution (RCE)", CVSS 4.0 vector `AV:N/AC:L/AT:P/PR:N/UI:N`, severity CRITICAL). OSV lists
  `last_affected: 3.8.50`; no fixed release exists at the time of the audit.
- Three transitive packages carry advisories at the locked versions: `adm-zip` 0.5.18 (3), `dompurify` 3.4.8 (4),
  `next` 16.3.1 (2).
- The package publishes with build provenance; 53,702 downloads per week.
- The package manifest declares `postinstall` and `prepare` scripts. The collector's install-script criterion
  reported clean for this dependency; Repotify's gate reads the `scripts` field directly and flags both.
- Repository criteria (archived, maintenance, Scorecard) were not assessable: the GitHub API did not answer during
  the audit.

Actions taken:

1. The catalog workflow runs OmniRoute only when the repository variable `USE_OMNIROUTE` is `true` (default off).
2. The pipeline gate now queries OSV for every pinned npm and PyPI package. CRITICAL and HIGH advisories
   quarantine the item; MODERATE adds a caution. With this rule `omniroute` leaves the published catalog until a
   fixed version is pinned, and the jury runs on the NVIDIA key pool alone.
3. The local OmniRoute instance used during development was stopped after the advisory was found. It had been
   bound to 127.0.0.1 for the jury run (an earlier start listened on 0.0.0.0 inside the ephemeral container for a
   few minutes before it was restarted on loopback).

Upgrade path: pin `omniroute` to the first release that OSV no longer lists as affected, re-run the pipeline,
and re-enable `USE_OMNIROUTE`.

### GitHub Actions

All actions come from the `actions/` organization and are pinned to the commit of their latest release tag at the
time of writing. Dependabot or a periodic re-pin keeps them current.

## 3. Repotify's own scanner on its agent-facing files

`repotify scan skill/repotify` reports `verified`; README.md and AGENTS.md are verified by `test/token-budget.test.mjs`.
