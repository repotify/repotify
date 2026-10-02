// Stage 0 telemetry (FAZ 1): append-only JSONL event log, privacy filter,
// consent gating, and the hold-and-join label pipe. Node 18+, no dependencies.

export { SCHEMA_VERSION, EVENT_TYPES, AGENT_IDS, INVOCATION_KINDS, REMOVAL_REASONS, INSTALL_SOURCES, validateEvent } from "./schema.mjs";
export { hashProjectId, scanEvent, assertContentFree } from "./privacy.mjs";
export {
  telemetryEnabled, noticeNeeded, markNoticeShown, setTelemetryEnabled, canTrack,
} from "./consent.mjs";
export { createEventStore, createTracker, verifyLog, EVENTS_FILE, DEFAULT_MAX_BYTES } from "./store.mjs";
export { LabelJoiner, WINDOWS, OBSERVABILITY } from "./labels.mjs";
export {
  CHARS_PER_TOKEN_BASELINE, REFERENCE_PRICES, DEFAULT_WINDOW_DAYS,
  estimateCostUSD, groupEpisodeTasks, windowTasks, tokenTrend,
  summarizeTokenBaseline, renderBaselineReport, reportTokenBaseline,
} from "./token-faz0.mjs";
export {
  INSTRUMENT_MANIFEST, INSTRUMENT_SCHEMA, WRAPPED_BY,
  wrapInstalledSkill, readInstrumentManifest, unwrapInstalledSkill,
  buildInstallEvent, buildInvokeEvent, resolveInstrumentedSkill,
} from "./instrument.mjs";
export {
  SYNC_SCHEMA, SYNC_STATE_FILE, SYNC_STATE_VERSION, FLEET_POLICY_FILE, FLEET_POLICY_SCHEMA,
  buildSyncPayload, summarizePayload, confirmSend, sendSync,
  applyFleetPolicy, recordSync, runSyncCommand,
  persistPendingNonce, isNonceReplayError,
} from "./sync.mjs";
