// Frozen fleet constants — one home for every threshold the server, the
// client and the site build share (DL-045: the 8b flag test imports these,
// not literals).

// 8b effectiveness leaderboard stays behind the feature flag until this many
// cumulative installs (DL-045, DL-021).
export const FLEET_INSTALL_THRESHOLD = 200;

// k-anonymity: a skill's aggregate is published only when at least this many
// distinct syncs contributed to it. Below the bar the bucket is suppressed,
// never published thin.
export const FLEET_MIN_GROUP_INSTALLS = 5;

// Delayed window: a sync payload sits in quarantine this long before its
// counts may influence the public aggregates. Recency + re-identification
// resistance in one mechanism.
export const FLEET_QUARANTINE_HOURS = 24;

// Envelope versions.
export const FLEET_POLICY_SCHEMA = "fleet-policy/1";
export const SYNC_SCHEMA = "telemetry-sync/v1";
