# Real pipeline run — 2026-09-28

This file records one full run of the catalog pipeline against real sources and real LLM jurors, what it exposed, and a re-run on the same repositories after the fixes.

## Run 1 (before fixes)

```sh
NVIDIA_API_KEY_1=… NVIDIA_API_KEY_2=… NVIDIA_API_KEY_3=… \
node pipeline/run.mjs --out $RUN/out --work $RUN/work --cache $RUN/jury-cache.json \
  --sources awesome,hn,reddit,github-topics --limit 6 --concurrency 4
```

| Stage | Result |
|---|---|
| Discover | 4,377 candidate repositories from awesome lists and Hacker News. Reddit answered 403 and GitHub topic search 401 (no `GITHUB_TOKEN` on the local machine), and both errors were logged without stopping the run. `--limit 6` kept the top six. |
| Collect | 10 repositories: 4 editorial (`obra/superpowers` 6 skill folders, `trailofbits/skills` 7, `anthropics/skills` 8, `vercel-labs/agent-skills` 6) and 6 discovered (`nafeeur/maskshift` 50, `onsi/biloba` 21, `pizza-bot-app/pizza-bot` 2, `awss1i/assay` 1, `imshaikot/app-preview-craft-skill` 1, `drawcms/drawcms` 0). |
| Gate | 4 dropped: `modern-python` rejected (GitHub release script piped into `sh`), `deploy-to-vercel` and `app-preview-craft` quarantined (archive and 3D-model binaries cannot be scanned), `docker-kubernetes` unclassified. |
| Jury | 3 jurors from 3 vendor families on NVIDIA NIM: `nvidia/nemotron-3-ultra-550b-a55b`, `google/gemma-4-31b-it`, `openai/gpt-oss-20b`. 79 items judged, 0 juror failures, every verdict from a full panel. Median quality 0.9 (min 0.7), median agreement 0.85 (min 0.6), 3 suspicion flags. |
| Publish | Catalog `2026.09.28.1`: 84 items. |
| Time | 1,364 s |

### What the run exposed

1. **Repackaged copies.** `nafeeur/maskshift` ships 50 skill folders; nine of them are byte-identical to skills in
   `anthropics/skills` (`algorithmic-art`, `canvas-design`, `mcp-builder`, …). They were published under their own ids.
2. **Missing licenses.** Every discovered repository showed `license: unknown`. Without a GitHub token there is no
   repository metadata, and the pipeline did not read the LICENSE file itself.
3. **Generic ids.** Discovered skills took names like `api`, `setup`, `debugging` and `code-review`, which say nothing
   about their origin and collide easily.
4. **Duplicate names inside one repository.** `onsi/biloba` ships the same skill for Go and for Vitest
   (`plugins/biloba-go/skills/flake-hunt` and `plugins/biloba-vitest/skills/flake-hunt`).
5. **OmniRoute.** The same day, the supply-chain audit found GHSA-hf57-cqmx-p4gr (critical, unauthenticated RCE) in the
   `omniroute@3.8.50` package the catalog recommended. See `docs/reports/supply-chain-omniroute-3.8.50.md`.

### Fixes

| Problem | Fix |
|---|---|
| Copies | Every SKILL.md is hashed during collection. A discovered skill whose SKILL.md matches one already seen (the editorial repositories are hashed in full first) is declined as `duplicate of <repo>/<path>`. |
| Licenses | `detectLicense` reads LICENSE/COPYING files when the API has no answer. Discovered items with no recognizable license are declined. |
| Generic ids | Ids on a short list of generic names get the owner as a prefix (`nafeeur-debugging`). |
| Name collisions | The second skill with a taken id gets the owner prefix; a third is skipped. The two biloba variants carry different stacks (`go` versus `node`/`typescript`), and the recommender keeps one item per cluster. |
| OmniRoute | The gate queries OSV for pinned npm/PyPI versions (critical/high → quarantine). OmniRoute is opt-in in the catalog workflow (`vars.USE_OMNIROUTE`). No juror call in run 1 needed its fallback route, and run 2 ran with OmniRoute disabled. |
| Unsafe summaries | Jury summaries for discovered items are declined when they contain links, code or shell syntax, or when the scanner flags them (review finding I5). |

## Run 2 (after fixes, same repositories)

The same ten clones, the same jury cache and the current gate (scanner 1.1.0, gate version 2) were used. Discovered repositories
had no GitHub signals (placeholder `mentions30d: 1`).

| | Run 1 | Run 2 |
|---|---|---|
| Candidates | 88 | 76 |
| Published items | 84 | 71 |
| Declined as copies | 0 | 9 (all from `nafeeur/maskshift`) |
| Rejected / quarantined / unclassified | 1 / 2 / 1 | 1 / 2 / 1, plus `omniroute` quarantined by OSV |
| Discovered licenses recognized | 0 of 4 | 4 of 4 (GPL-3.0, MIT, MIT, Apache-2.0) |
| LLM calls | 237 verdicts (79 items × 3 jurors) plus probes | 3 (juror probes only; every verdict came from the cache) |

`nafeeur/maskshift` still publishes 20 skills. They are not byte-identical to any known skill, and they cleared the quality bar
(quality ≥ 0.7, agreement ≥ 0.6). Near-copy detection (similar but edited text) is not implemented; the review queue
is where a human would catch it.

## The bundled catalog

The catalog shipped in the package (`catalog/`) is built from the editorial seed only (`node pipeline/seed.mjs`), with the
same gate and jury as a full run. Discovered items need GitHub signals (stars, age, activity) to be ranked fairly, and
those are only available to the catalog workflow's `GITHUB_TOKEN`. Current bundled catalog: `2026.09.28.6`, 29 items (23
verified, 6 caution), all gated by scanner 1.2.0 and gate version 2. A test fails if a bundled item was gated by an older
scanner or gate.
