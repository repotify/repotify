# Repotify analytics Worker

> **Retired.** Since 2.0.0 the CLI has no code that sends raw events (they carry an install id and a timestamp, which
> the privacy promise rules out). Nothing feeds this Worker; `repotify sync` and `lib/telemetry/server/` replace it.
> The text below is kept for the record.

Receives anonymous events from the Repotify CLI and serves aggregate stats to the catalog pipeline.
The CLI ships with the endpoint **disabled** (`TELEMETRY_ENDPOINT = null` in `src/config.mjs`); until this Worker is
deployed, events only stay in each user's local queue.

## Deploy (Cloudflare free tier)

1. `npx wrangler login`
2. `npx wrangler d1 create repotify` and copy the printed `database_id` into `wrangler.toml`.
3. `npx wrangler d1 execute repotify --remote --file schema.sql`
4. `npx wrangler deploy` and note the Worker URL (for example `https://repotify-analytics.<account>.workers.dev`).
5. Enable it:
   - CLI: set `TELEMETRY_ENDPOINT` in `src/config.mjs` to the Worker URL and release a new version.
   - Pipeline: add the repository variable `REPOTIFY_STATS_URL` = `<Worker URL>/v1/stats`.

## API

- `POST /v1/events` — `{ "events": [...] }`, 1–100 events, validated against `src/telemetry-schema.mjs`.
  Duplicates are ignored, each install id is limited to 500 events per day, IP addresses are never stored.
- `GET /v1/stats` — `{ generatedAt, items: { <id>: { shown, selected, installed, kept7d, removed, up, down } } }`.
