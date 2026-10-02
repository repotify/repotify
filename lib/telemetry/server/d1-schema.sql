-- Fleet aggregate — Cloudflare D1 production mapping (FAZ 9 / 9.3, reference).
--
-- This schema mirrors lib/telemetry/server/aggregate.mjs. The cardinal rule
-- holds in SQL too: NO per-sync / per-device / per-install rows are ever
-- persisted. Quarantine payloads live only in the Worker's memory (they are
-- dropped by admit()); D1 keeps sums per admitted window, nothing finer.
--
-- Vocabulary lock: the `counter` column accepts ONLY the counter names in
-- KNOWN_COUNTERS (server/aggregate.mjs). A new counter is a schema-version
-- bump, never an accident.
--
-- Privacy properties, enforced by construction:
--   1. No install_id, no nonce, no IP, no user agent, no free text — the
--      columns do not exist.
--   2. Delayed window: rows are written by admit() only after
--      FLEET_QUARANTINE_HOURS (24h) have passed since receipt.
--   3. k-anonymity: snapshot() publishes a skill bucket only with >=
--      FLEET_MIN_GROUP_INSTALLS (5) distinct contributing syncs; thin buckets
--      are suppressed, never published thin. `contributing_syncs` is a count,
--      not a list — the syncs behind it are unrecoverable.
--   4. The published fleet-policy.json (proof) is stored for audit; the
--      recipe (weighting, raw breakdowns) is code, not data, and is not here.

-- Admitted windows: one row per (window_start, window_end) the nightly job
-- folded. The window bounds are the min/max event timestamps across the
-- admitted syncs — coarse, per-window, never per-event.
CREATE TABLE IF NOT EXISTS fleet_windows (
  window_start      TEXT NOT NULL,
  window_end        TEXT NOT NULL,
  admitted_syncs    INTEGER NOT NULL CHECK (admitted_syncs >= 0),
  computed_at       TEXT NOT NULL,
  PRIMARY KEY (window_start, window_end)
);

-- The aggregate itself: one row per (window, skill, counter).
-- This is the ONLY counter table; there is no per-sync staging table.
CREATE TABLE IF NOT EXISTS fleet_counters (
  window_start       TEXT NOT NULL,
  window_end         TEXT NOT NULL,
  skill_id           TEXT NOT NULL CHECK (skill_id GLOB '[a-z0-9][a-z0-9-]*'),
  counter            TEXT NOT NULL CHECK (counter IN (
                         'shown','installed','selected','invoked','invoked_sessions',
                         'outcome_success','outcome_failure','kept_30d',
                         'removed_fast','removed','replaced','abandoned',
                         'fallback','questions_asked','questions_answered')),
  value              INTEGER NOT NULL CHECK (value >= 0),
  contributing_syncs INTEGER NOT NULL CHECK (contributing_syncs >= 0),
  PRIMARY KEY (window_start, window_end, skill_id, counter),
  FOREIGN KEY (window_start, window_end)
    REFERENCES fleet_windows (window_start, window_end)
);
CREATE INDEX IF NOT EXISTS fleet_counters_skill
  ON fleet_counters (skill_id, counter);

-- Published policies (audit trail): the exact fleet-policy.json the nightly
-- job distributed, keyed by version. Old versions are kept so any client can
-- verify what the fleet believed at the time it synced.
CREATE TABLE IF NOT EXISTS fleet_policies (
  version            TEXT PRIMARY KEY,
  computed_at        TEXT NOT NULL,
  window_start       TEXT,
  window_end         TEXT,
  contributing_syncs INTEGER NOT NULL CHECK (contributing_syncs >= 0),
  skills_published   INTEGER NOT NULL CHECK (skills_published >= 0),
  policy_json        TEXT NOT NULL
);

-- 8b gate history: when the fleet crossed FLEET_INSTALL_THRESHOLD (200).
-- One row per nightly run; the site build reads the latest.
CREATE TABLE IF NOT EXISTS fleet_gate (
  computed_at TEXT PRIMARY KEY,
  installs    INTEGER NOT NULL CHECK (installs >= 0),
  threshold   INTEGER NOT NULL,
  enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1))
);
