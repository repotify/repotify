# Community comments — moderation design (FAZ 8.2)

Skill pages carry public experience reports ("what actually happened when you used
this skill"). Deliberately **no stars, no ratings, no scores** — the catalog's
measured jury scores already rank skills; community input is qualitative signal,
and a 5-star widget would reintroduce the popularity contest the leaderboard is
designed to avoid.

## v1: client-side prototype (shipped with the static site)

- Each skill page has a form: name (optional), project type (select), experience
  text (required, ≤2000 chars). **No rating input exists** — the form cannot
  express a score, so none can leak into the UI.
- Submit → stored in `localStorage` under `repotify-comments-v1:<skillId>:pending`.
  The comment is NOT shown publicly yet.
- The page has a "Moderation queue (local prototype)" block listing pending items.
  The Approve / Reject buttons render **only with `?demo=moderation` in the URL**
  (demo-only simulation — pragmatist tur2 b2). On public pages the queue is
  read-only and carries a pointer to the demo URL, so visitors never see
  moderation theater. Approve moves the item to
  `repotify-comments-v1:<skillId>:approved-local` and it renders publicly
  (each local card is labeled "saved in this browser only").
- Already-approved community comments shipped with the site build are embedded at
  build time from `assets/data/comments.json` (per-skill lists). v1 ships this
  file empty.

This is honest about what it is: a single-browser prototype. It proves the
interaction flow (submit → queue → approve → publish) with zero backend.

## Production pipeline (FAZ 9+, server required)

1. **Submit:** client POSTs `{skill, name?, projectType, text}` to the comments
   endpoint. Server validates (length, profanity/URL heuristics, per-IP rate
   limit), stores as `pending`, returns a receipt id. Never trust client timestamps.
2. **Moderate:** a moderator reviews the pending queue in an admin view.
   Approve/reject decisions are signed (moderator key) and appended to an
   append-only approvals log: `{commentId, skill, decision, moderator, ts, sig}`.
3. **Publish:** the site build fetches the approvals log, verifies signatures,
   and embeds approved comments into `assets/data/comments.json`. Rejected or
   signature-invalid entries never reach the build. Builds are reproducible from
   the log — the log is the source of truth, the JSON is a cache.
4. **Abuse:** rate limits + hash-blocklist for repeat spam; reporters can flag a
   published comment, which moves it back to pending and invalidates its approval
   signature at the next build.

## Schema (comments.json)

```json
{ "meta": { "note": "..." },
  "comments": [
    { "id": "…", "skill": "test-driven-development", "ts": "2026-10-…",
      "name": "…", "projectType": "cli", "text": "…", "approvedBy": "mod-key-id" }
  ] }
```

## Non-goals

- No voting, no "helpful" counts, no sorting by popularity. Newest first.
- No accounts in v1; production may add optional verified-installer badges later
  (only after the telemetry consent work in FAZ 9 — never silently).
