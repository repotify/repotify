# Operating Repotify

## Repository

Repotify lives at `repotify/repotify`. The catalog URL (`DEFAULT_CATALOG_URL` in `src/config.mjs`) and the clone
instructions in `README.md`, `docs/i18n/README.tr.md` and `AGENTS.md` point there; a fork must update them. `ci.yml` runs on every
push; the catalog is rebuilt only by hand (see [Building the catalog](#building-the-catalog)).

## Building the catalog

There is no schedule; a maintainer rebuilds the catalog when it is worth it.

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

Follow `pipeline/worker/README.md`, then set `TELEMETRY_ENDPOINT` in `src/config.mjs` to the Worker URL, release a new version,
and set `REPOTIFY_STATS_URL`. Until then the client only keeps a local queue and sends nothing.

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
