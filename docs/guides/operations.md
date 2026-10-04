# Operating Repotify

## Repository

Repotify lives at `repotify/repotify`. The catalog URL (`DEFAULT_CATALOG_URL` in `src/config.mjs`) and the clone
instructions in `README.md`, `docs/i18n/README.tr.md` and `AGENTS.md` point there; a fork must update them. `ci.yml` runs on every
push; the catalog is rebuilt only by hand (see [Building the catalog](#building-the-catalog)).

## Building the catalog

There is no schedule; a maintainer rebuilds the catalog when it is worth it.

The catalog has two parts. The hand-vetted items (the seed, the jury) are built by `pipeline/run.mjs`, on GitHub or
locally, as described below. Everything else is derived from a content store that lives outside the repository:

```bash
GITHUB_TOKEN=… node pipeline/crawl.mjs --store STORE --discover        # fetch skill folders, once each
JEV_API_KEY=… node pipeline/observe.mjs --store STORE --max-asks N     # scan what is new, classify within a budget
node pipeline/research.mjs --store STORE --env-file FILE               # what people say about each repository
JEV_API_KEY=… node pipeline/mcp.mjs --store STORE                      # MCP registry, downloads, stars, gate
node pipeline/derive.mjs --store STORE --dry-run --report report.json  # what the rules keep and why
node pipeline/derive.mjs --store STORE                                 # write catalog/
npm run eval && npm test                                               # 108/108 and no violation before committing
```

`derive` keeps the hand-vetted items it finds in `catalog/items.json`, adds Repotify's own hooks from the seed, and
replaces every derived item. **Running `pipeline/run.mjs` or the catalog-build workflow rewrites `catalog/` from the
seed alone: run `derive` again afterwards, or the crawled items are gone.** A taxonomy change (a new job or stack)
changes the questions, so `observe` and `mcp --from-state` ask again before `derive` sees answers.

### At the scale of the full store

The store of the 2026-10-03 crawl holds 12,567 repository records, 419,581 skill folders (317,666 distinct) and about
two million files in 21 GB. What that changes:

- **`observe` reads only what is new.** What a run finds about a repository is kept under `STORE/index/observe/`; an
  unchanged repository costs two small reads on the next run (12,525 repositories in under a minute). A new scanner
  version reads everything again, once: 78 minutes for the whole store with three processes
  (`--no-jev --shard 0/3`, `1/3`, `2/3`).
- **The decision model is asked within a budget.** `--max-asks N` asks the N skills most worth asking: most installed
  and best-known repositories first, at most 100 of one repository (`--per-repo`), same-named skills last, and never
  a skill that could not be listed whatever the answer. `--max-asks 0` only counts. A question costs about $0.00022;
  the store has 62,000 skills that could still be asked about. Measure the credit before a run
  (`GET https://openrouter.ai/api/v1/credits`); with none left the model returns nothing and twelve unanswered
  questions in a row end the run.
- **`derive` takes about twenty seconds** on that store, because it considers only the 25,015 skill folders the
  model has answered about. Derive into a copy first and read what arrives before touching `catalog/`:
  `cp -r catalog /tmp/staging && node pipeline/derive.mjs --store STORE --out /tmp/staging --report /tmp/report.json`.
  The report lists every skill kept out and why. The first catalog derived from the full store passed the scenarios
  and still held leaked vendor skills, translations of hand-vetted skills and benchmark output: the scenarios check
  default sets, not everything the table offers.
- **A crawl round survives its two known faults** (a git child that dies mid-input, a GitHub response cut off
  mid-body); a round that ends early is still safe to run again.

### Running the heavy steps on another machine

A laptop with a spinning disk needs hours for one pass over the store; a small server needs minutes. The store is
plain files, but two million of them: copying them took 63 files a second off the laptop disk. So move the records
and let the other machine fetch the content again:

```bash
# 1. records, observations and state files only (300,000 files, 80 minutes from a slow disk)
tar -C STORE -cf - --exclude=./blobs --exclude=./trees --exclude=./git . | zstd -3 | ssh HOST 'zstd -d | tar -C STORE -xf -'
# 2. on the server: the code, without the repository's history or agent folders
rsync -a --delete --exclude=/.git --exclude=/.claude --exclude=/node_modules ./ HOST:repo/
# 3. on the server: content back from GitHub at the commits the records name (77 minutes for 7,533 repositories)
GITHUB_TOKEN=… node pipeline/crawl.mjs --store STORE --restore --concurrency 8
```

Every repository comes back byte for byte as recorded, so the observations keyed by content still apply; a repository
whose commit is gone is marked and read again by the next crawl. Verify the copy by counts (repository records,
observation files per kind), not by reading the laptop's store again. Keep the keys in a file only the pipeline's
user can read, run long steps under `tmux` with `nice`, and bring back `obs/`, `repos/`, `index/` and the state files
as one compressed archive rather than as files.

- **On GitHub:** Actions → **catalog-build** → **Run workflow**. The `build` job discovers, gates and scores items with
  the jury keys; the `publish` job re-verifies the result, runs the tests and commits `catalog/` as `catalog: build <version>`.
  Without the jury keys the run stops instead of publishing a catalog without scores.
- **Locally:** `NVIDIA_API_KEY_1=… NVIDIA_API_KEY_2=… NVIDIA_API_KEY_3=… node pipeline/run.mjs` (or `node pipeline/seed.mjs`
  for the editorial items only, `--cache pipeline/jury-cache.seed.json` to reuse saved verdicts), then `npm test`,
  `node pipeline/verify.mjs catalog` and commit `catalog/`.

## Secrets and variables (Settings → Secrets and variables → Actions)

| Name | Kind | Used by | Purpose |
|---|---|---|---|
| `NVIDIA_API_KEY_1` … `NVIDIA_API_KEY_3` | secret | `catalog.yml` build | Key pool for the three-model LLM jury (NVIDIA NIM) |
| `NVIDIA_API_KEY_4` | secret | `catalog.yml` build | Given to OmniRoute only, when `USE_OMNIROUTE` is `true` |
| `USE_OMNIROUTE` | variable | `catalog.yml` | `true` enables OmniRoute as the jury's fallback route. Keep it off until a release fixes GHSA-hf57-cqmx-p4gr |
| `REPOTIFY_STATS_URL` | variable | `catalog.yml` | `<worker URL>/v1/stats`; leave empty until analytics is deployed |
| `NPM_TOKEN` | secret, environment `npm` | release | Only needed when npm trusted publishing is not configured |

The workflow's `GITHUB_TOKEN` is used read-only for discovery and issue submissions; `publish` gets `contents: write`.

## Turning analytics on (after the Cloudflare account is available)

The client has no code that sends raw events: its queue stays on the user's machine, and the only way out is
`repotify sync`, which sends aggregates to the fleet server (`lib/telemetry/server/`) after the user confirms. The
older Worker in `pipeline/worker/` stored raw events with an install id; no released client feeds it any more, and it
must not be given a client again without changing the privacy text in the README, the guide, the skill and the
first-run notice. `REPOTIFY_STATS_URL` (community counts for the pipeline) stays unset until the fleet server exists.

## Publishing to npm

Bump `version` in `package.json`, commit, and push a tag `v<version>`. `release.yml` verifies tests, eval and catalog
hashes, checks that the tag matches the version, and runs `npm publish --provenance --access public`.
The package is `@repotify/repotify`: npm rejects the unscoped `repotify` as too similar to `restify` and `reactify`.
The `@repotify` scope is an npm organization (or the npm user `repotify`), and `NPM_TOKEN` needs write access to it.

## Reviewing quarantined items

Each catalog build writes `catalog/review-queue.json` (quarantined) and `catalog/rejected.json` (rejected, declined or
unclassified). A reviewer can approve one exact commit of a quarantined item by adding it to `pipeline/reviewed.json`:

```json
[{ "repo": "owner/name", "path": "skills/x", "commit": "<40-hex>", "level": "caution", "reviewer": "<github user>", "note": "why it is acceptable" }]
```

Approvals are a maintainer's decision, recorded under their GitHub handle; an automated agent never approves its own
exceptions. Approval is tied to that commit: any upstream change sends the item back through the gate. Rejected items (a critical
finding) cannot be approved. Clients accept an approved item only when every high finding of their local re-scan is one
recorded in the catalog entry, that is, one the reviewer saw.

To pull an item the scanner passed (a confirmed report, a takedown), add it to `pipeline/denylist.json`:

```json
[{ "repo": "owner/name", "path": "skills/x", "commit": null, "reason": "GHSA-… / advisory link" }]
```

`path` and `commit` are optional; leaving them out quarantines every item of that repository or every commit. A denylist entry
wins over `reviewed.json`.

## Curating the seed

`pipeline/seed-sources.json` holds editorial items (core set, tiers, summaries, loadouts). Editorial fields win over
jury labels; the jury still scores them. Run `node pipeline/seed.mjs` for an offline-friendly rebuild from clones, or
`node pipeline/run.mjs` for the full pipeline.
