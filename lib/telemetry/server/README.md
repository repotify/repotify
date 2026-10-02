# Fleet server — production mapping (FAZ 9)

The reference implementation in this directory is the whole server, in
dependency-free Node: intake (`aggregate.mjs`), nightly policy
(`nightly.mjs` → `policy.mjs`), the 8b gate (`leaderboard.mjs`), and
distribution (`distribute.mjs`). Production is the same logic on
Cloudflare (Workers + D1); this file maps one to the other.

## Endpoints (Worker)

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/sync` | `ingest(payload)`: schema allowlist → PII scan → nonce replay check → quarantine. Returns 202 + the current `fleet-policy.json` and `leaderboard-status.json` from the last nightly run. |
| GET | `/v1/fleet-policy` | Latest published policy (public proof). |
| GET | `/v1/leaderboard-status` | `{ enabled, installs, threshold }` for the 8b flag. |

No auth, no accounts, no cookies. Rate-limit by IP at the edge (abuse
control only — the IP is never stored; see the D1 schema notes).

## Cron

One Workers cron trigger, nightly: `runNightly({ aggregator, outDir })`.
The "outDir" in production is the catalog bundle build that ships
`fleet-policy.json` + `leaderboard-status.json` with the catalog data —
every install picks up the fleet's wisdom on update, no extra round-trip.

## D1

`d1-schema.sql` is the schema. Correspondence with the reference:

- `aggregate.mjs` quarantine → Worker memory only (dropped by `admit()`).
  D1 has no per-sync table, by design.
- `folded` sums → `fleet_counters` (one row per window/skill/counter),
  written by `admit()` after the 24h quarantine.
- `computeFleetPolicy()` output → `fleet_policies` (audit trail) and the
  distributed `fleet-policy.json`.
- `computeLeaderboardStatus()` → `fleet_gate` history + the distributed
  `leaderboard-status.json`.

## What never leaves the server

Raw counter breakdowns per skill, per-sync rows, nonces, the effectiveness
weighting (`policy.mjs`), quarantine contents. The published bundle is
proof (per-skill effectiveness + evidence weight + CI); the recipe stays
code on the server. ("Kanıtı yayınla, tarifi sakla.")

## Thresholds

All frozen in `thresholds.mjs` (DL-045): 200 installs (8b gate), 5 syncs
(k-anonymity), 24h quarantine. The site build imports them — never literals.

Rationale (FAZ 9 debate d5/d6):

- **k=5**: the published unit is per-skill *counters* — no quasi-identifiers,
  no install ids, no per-device timestamps. `snapshot()` suppresses buckets
  with <5 syncs before policy computation, and the 24h quarantine batches
  user-initiated syncs so no single sync maps to a publish window. k=5 is the
  standard floor for non-sensitive aggregate publication; the differencing
  attack it guards against needs group-membership knowledge the server never
  collects. Layered with fold-and-delete (`admit()` keeps no per-sync rows),
  this is defense-in-depth, not k-anonymity alone.
- **200 installs (8b leaderboard gate)**: a launch guardrail, not a derived
  constant — below it the public leaderboard would rank noise. Tunable as
  the fleet grows; the value lives in one named constant so a retune is a
  one-line change.
- **24h quarantine**: absorbs late/duplicate syncs and bursts before a
  window is folded into the policy; also the batching layer that makes
  per-sync timing analysis impractical.

## Reference limitations (not for production as-is)

- **Nonce store is in-memory.** The reference `createAggregator()` keeps seen
  nonces in process memory, so a restart (or a second node behind a load
  balancer) forgets them and a replayed payload would be admitted twice.
  Production needs a durable, shared nonce set with a TTL ≥ the quarantine
  window (a small D1/KV table holding only nonce hashes, no per-sync rows).
- **No client authentication.** `POST /v1/sync` accepts any well-formed
  aggregate, so a third party can submit forged counters and steer
  effectiveness (data poisoning). The TTY "y" confirmation is a UX consent
  control on the legitimate client, not a server-side trust boundary.
  Acceptable for the opt-in prototype; production needs per-install
  attestation or API keys before the policy feeds real rankings.
