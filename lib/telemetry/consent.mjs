// Consent layer for Stage 0 telemetry (T1/T2 hardening).
//
// T1 — "no data before notice": canTrack() is false until the user has SEEN
// the first-run notice. The tracker refuses to append anything before that,
// even when telemetry is otherwise enabled.
// T2 — the off triple: `repotify telemetry off` (persisted), REPOTIFY_TELEMETRY=0
// and DO_NOT_TRACK=1 all disable tracking. (NO_ANALYTICS=1 is honored too,
// as a standard convention.) Env beats the stored choice.

import { readConfig, writeConfig } from "../../src/config.mjs";

export const NOTICE_KEY = "telemetryNoticeShown";
export const ENABLED_KEY = "telemetry";

export function telemetryEnabled(env = process.env) {
  if (env.REPOTIFY_TELEMETRY === "0" || env.DO_NOT_TRACK === "1" || env.NO_ANALYTICS === "1") return false;
  return readConfig(env)[ENABLED_KEY] !== false;
}

export function noticeNeeded(env = process.env) {
  return telemetryEnabled(env) && !readConfig(env)[NOTICE_KEY];
}

export function markNoticeShown(env = process.env) {
  if (telemetryEnabled(env)) writeConfig(env, { [NOTICE_KEY]: true });
}

export function setTelemetryEnabled(env, on) {
  writeConfig(env, { [ENABLED_KEY]: Boolean(on) });
}

/** T1 gate: nothing is recorded before the notice has been seen. */
export function canTrack(env = process.env) {
  return telemetryEnabled(env) && !noticeNeeded(env);
}
