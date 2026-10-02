# Stage 0 telemetry (FAZ 1) — what is collected

Repotify's measurement layer. Append-only JSONL, Node 18+, zero dependencies.
This document is the published field list: everything below is the complete
set of fields that can ever appear in the local event log.

## Files

- `~/.repotify/stage0.jsonl` — the event log (append-only; rotated aside to
  `stage0.jsonl.1` at 5 MB, never edited in place)
- `~/.repotify/config.json` — `telemetry` (bool) and `telemetryNoticeShown`

## Consent (T1/T2)

- **No data before the notice.** Nothing is written until the first-run
  notice has been shown (`canTrack()` gate).
- **Off triple.** `repotify telemetry off`, `REPOTIFY_TELEMETRY=0`,
  `DO_NOT_TRACK=1` (plus `NO_ANALYTICS=1`) all disable tracking. Env beats
  the stored choice. The off command itself writes no events.
- **Fail-open.** A telemetry failure never breaks a user command.

## Privacy: content-free by construction

- Project names are SHA-256 hashed at emission (`project_hash`); the raw
  path is never persisted.
- Every event passes a PII scan (absolute paths, emails, private keys,
  credential assignments, URLs with credentials). Violations are refused —
  code and prompts never reach disk.
- Correlation uses opaque platform ids (`session_id`, `prompt_id`) only;
  transcript paths are never stored.

## Schema v1 — reward-formula-agnostic (D4)

Raw observations only. Computed rewards, weights and score formulas are
rejected by the validator — they cannot leak into the log.

Shared fields: `type`, `ts`, `schema_version`, `seq` (monotonic per file
generation, for gap detection), `install_id`, `episode_id`, `agent`,
`cli_version`, `catalog_version`, `policy_name`, `policy_version`,
`project_hash`, `session_id`, `prompt_id`, `skill_id`, `skill_ids`.

| Event | Extra fields |
|---|---|
| `recommendation` | `candidates[]` — one entry per considered candidate (shown or not): `skill_id`, `position`, `propensity` (**always 0 < p < 1**, B1), `shown`, `raw_score?`, `is_explore`; `budget_chars?`, `randomized?` (true only when the selection was actually randomized — counterfactual estimators must filter on this) |
| `install` | `from_recommendation?` |
| `select` | `target?` (hook/MCP enable target agent) |
| `invoke` | `invocation_kind`: `explicit` \| `implicit` \| `load` |
| `abandon` | `reason?`: `gave_up` \| `timeout` \| `switched_tool` |
| `fallback` | `from_skill`, `to_skill`, `trigger?`: `invoke_failed` \| `invoke_timeout` \| `removed` \| `manual` |
| `outcome` | `task_success` (bool), `quality?` (raw 1–5 rating, not a reward), `skill_free_baseline?` (per-project counterfactual baseline marker) |
| `kept_30d` | — |
| `removed_fast` / `removed` | `removal_reason`: `project_changed` \| `internalized` \| `unused` \| `broken` \| `other` |
| `replaced` | `replaced_by` (pairwise preference) |
| `question` | `question_id`, `answer?` (short enum token, never free text), `was_confirm?`, `skipped?`, `question_propensity?` (0 < p < 1) |
| `usage` | `tokens_in?`, `tokens_out?`, `latency_ms?` (platforms where measurable) |

## Hold-and-join labels (`labels.mjs`)

Slow signals (30-day survival) arrive long after the recommendation. Each
`(episode_id, skill_id)` pair is held open; when a window closes (`week1` at
7 days, `month1` at 30 days) the raw signals join into one label row:
counts, booleans and enums only — no reward math. Intermediate signals are
never training labels by themselves.

Debate-hardened details (GLM critic, 2026-10-01):
- `outcome_shared`: an outcome without `skill_id` attaches to every open hold
  of its episode and is flagged, so one shared outcome can never be mistaken
  for N independent ones.
- Clock-skew guard: events timestamped before their hold opened become
  (counted) orphans instead of silently corrupting window math.
- Episode-less events (e.g. hook-observed invokes on unobservable platforms)
  are kept as countable orphans, never silently dropped.

## Integrity (`verifyLog`, `droppedCount`)

- Every line carries a monotonic `seq` per file generation. `verifyLog(dir)`
  reports seq gaps and corrupt lines — the answer to "who watches the gaps".
- The tracker counts attempted-but-failed writes (`droppedCount()`).
  Consent refusals are not drops.

## Known limitations (v1)

- `install_id` resets on machine change: open holds do not survive it;
  long-window labels for multi-device users will be sparse (documented
  survivorship bias, not hidden).
- The PII scan is heuristic (regex); the schema's tight character classes are
  the primary barrier.
- Emission call-sites (`recommend`/`install`/`vote`/hook) are not yet wired —
  the tracker API is ready, wiring belongs to the owners of those files.
- `lib/` is not yet in `package.json`'s `files` list — add it before publish.

## Modules

- `schema.mjs` — event types + `validateEvent()`
- `privacy.mjs` — `hashProjectId()`, `scanEvent()`, `assertContentFree()`
- `consent.mjs` — `telemetryEnabled()`, `noticeNeeded()`, `markNoticeShown()`, `setTelemetryEnabled()`, `canTrack()`
- `store.mjs` — `createEventStore()` (append-only JSONL + rotation + `seq`), `createTracker()` (consent-gated, fail-open entry point)
- `labels.mjs` — `LabelJoiner` (hold-and-join, v1 skeleton). P4: holds pin an
  observability class from the install/select event's `install_source`
  (`repotify`→full, `third-party`→redacted, `external`→weak, absent→unknown);
  closed label rows carry `invoke_observed` (true/false/null) + `observability`.
- `instrument.mjs` — P4: installation is the instrumentation point.
  `wrapInstalledSkill()` writes `.repotify-instrument.json` into each installed
  skill dir (binds on-disk folder → catalog skill_id so host-agent invoke
  reports are attributable); `buildInstallEvent()` / `buildInvokeEvent()`
  build schema-valid Stage 0 events (`install_source: "repotify"`).
