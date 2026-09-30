# Contributing to Repotify

Thanks for helping! Repotify decides what code AI agents install on people's machines, so correctness and security come
first, and every change carries a test.

## The fastest ways to help

- **Suggest a skill for the catalog** with the [submission form](https://github.com/repotify/repotify/issues/new?template=catalog_submission.yml).
  It goes through the same security gate and LLM jury as everything else.
- **Report a scanner false alarm or a miss.** Include the smallest file that shows it. Misses (something malicious that
  passed) belong in a [private advisory](SECURITY.md), not a public issue.
- **Add an evaluation scenario** in `test/eval/scenarios/` for a kind of project Repotify serves badly today.

## Development setup

Node.js 18 or newer. There are no dependencies to install.

```bash
git clone https://github.com/repotify/repotify
cd repotify
npm test          # unit, integration and end-to-end tests
npm run eval      # recommendation quality on the scenario set
node bin/repotify.mjs scan skill/repotify   # our own skill must stay "verified"
```

## Develop Repotify with Repotify

The repository recommends its own development setup. From a clone:

```bash
node bin/repotify.mjs                     # installs the repotify skill for your agent
node bin/repotify.mjs recommend --type library --needs security,github-workflow,dependencies,agent-skills,docs-writing
node bin/repotify.mjs install <picked ids> --yes
```

What it installs stays in your working copy (`.claude/skills/`, `repotify.lock.json` and third-party agents are
git-ignored). Claude Code users also get three project subagents from `.claude/agents/`: `repotify-scanner-guardian`
for `src/scan/`, `repotify-catalog-curator` for the catalog and the engine, and `repotify-release-docs` for docs and
releases.

## Where things live

| Folder | What it holds |
|---|---|
| `bin/`, `src/` | The CLI: fingerprint, questions, recommendations, audit, suggestions, installers, update flow, package guard |
| `src/scan/` | The security scanner (`rules.mjs`, `shell.mjs`, `files.mjs`) |
| `catalog/` | The published catalog and its hashes (`meta.json`) |
| `pipeline/` | Discovery, the security gate, the LLM jury and catalog publishing |
| `skill/repotify/` | The skill Repotify installs into the user's agent |
| `test/`, `test/eval/` | Tests, malicious and benign fixtures, evaluation scenarios |
| `docs/examples/` | Worked examples with real output |
| `site/` | The website in 24 languages (`node site/build.mjs`; strings in `site/src/i18n/`) |
| `docs/` | Maintainer guide, reports, translations of the README |
| `pipeline/worker/` | The anonymous analytics endpoint (not deployed yet) |

[ARCHITECTURE.md](../docs/ARCHITECTURE.md) explains how the pieces fit and where to add things.

## Rules for changes

- **Tests first.** A bug fix starts with a failing test; a feature comes with tests for its edge cases.
- **Documentation links are tested.** Keep relative links pointing at files that exist (`test/docs-links.test.mjs`).
- **Zero runtime dependencies.** Use Node built-ins only.
- **Scanner changes** need a malicious fixture for what they catch, a benign one for what they must not flag, and a
  corpus run (`node test/eval/scan-corpus.mjs <clones> --details`) that keeps the false-alarm rate at or below 5%. Regexes
  may not use an unbounded `[^\n]*` between two parts; there is a timing test.
- **The LLM jury may lower trust, never raise it.** No change may let model output make an item safer.
- **Never commit keys or tokens.** CI secrets live in GitHub Actions secrets.
- **Catalog files are generated.** Change `pipeline/seed-sources.json` or the pipeline, then rebuild; do not edit
  `catalog/*.json` by hand (their hashes are checked). The taxonomy is the exception: edit `catalog/taxonomy.json`,
  then run `node pipeline/rehash.mjs` and add an evaluation scenario for the change.

## Commits and pull requests

- One logical change per pull request, with a short description of the problem and how you tested it.
- Commit messages say what changed and why, in the imperative ("scanner: flag uploads with -d @file").
- If an AI assistant helped, say so in the commit message.

## Code of conduct

Be kind and assume good intent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
