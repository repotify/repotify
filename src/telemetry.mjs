import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir, readConfig, writeConfig } from "./config.mjs";
import { validateEvent, EVENT_TYPES } from "./telemetry-schema.mjs";
import { telemetryEnabled } from "../lib/telemetry/consent.mjs";

export { validateEvent, EVENT_TYPES };
export const MAX_QUEUE = 1000;

// FAZ 0 / DL-009 — exact first-run notice text, FROZEN. Do not reword:
// the wording is a locked decision ("bildirimden önce veri yok" T1).
export const NOTICE =
  "Repotify measures which skills actually work and shares anonymous usage counts to improve recommendations. Turn off any time: `repotify telemetry off`.";

// Everything else the notice implies, shown on `repotify telemetry status`.
export const NOTICE_DETAILS = [
  "What is measured: a random install id, agent type, which catalog items were",
  "shown, installed, invoked, kept after 7/30 days or removed, and your votes.",
  "It never collects code, prompts, file names, repository names, user names,",
  "transcripts, or IP addresses; only aggregated summaries ever leave the",
  "machine, and only via an explicit `repotify sync` that you confirm.",
  "Kill switches: `repotify telemetry off`, REPOTIFY_TELEMETRY=0, DO_NOT_TRACK=1, NO_ANALYTICS=1.",
].join("\n");

// The local event queue. Nothing here talks to the network: raw events (they carry the install id and a timestamp)
// never leave the machine. The only way out is `repotify sync`, which sends aggregates after the user confirms.
export function createTelemetry({ env = process.env, now = new Date(), version = "0.0.0" } = {}) {
  const dir = homeDir(env);
  const queuePath = join(dir, "queue.jsonl");
  // One answer for both event logs (this queue and lib/telemetry's Stage 0 log): the same kill switches stop both.
  const enabled = telemetryEnabled(env);

  const readQueue = () => {
    try {
      return existsSync(queuePath) ? readFileSync(queuePath, "utf8").split("\n").filter(Boolean) : [];
    } catch {
      return [];
    }
  };
  const writeQueue = (lines) => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(queuePath, lines.length ? lines.join("\n") + "\n" : "");
      return true;
    } catch {
      return false;
    }
  };
  // Null when the id cannot be persisted (read-only home): then nothing is tracked at all.
  function installId() {
    const current = readConfig(env).installId;
    if (current) return current;
    writeConfig(env, { installId: randomUUID() });
    return readConfig(env).installId ?? null;
  }

  return {
    enabled,
    noticeNeeded: () => enabled && !readConfig(env).telemetryNoticeShown,
    markNoticeShown: () => enabled && writeConfig(env, { telemetryNoticeShown: true }),
    setEnabled: (on) => writeConfig(env, { telemetry: Boolean(on) }),
    track(event) {
      if (!enabled) return false;
      const id = installId();
      if (!id) return false;
      const full = { ts: now.toISOString(), version, ...event, installId: id };
      for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
      if (validateEvent(full).length) return false;
      const lines = readQueue();
      if (lines.length >= MAX_QUEUE) return writeQueue([...lines.slice(lines.length - MAX_QUEUE + 1), JSON.stringify(full)]);
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(queuePath, JSON.stringify(full) + "\n");
        return true;
      } catch {
        return false;
      }
    },
    // How many events wait in the local queue.
    queued: () => (enabled ? readQueue().length : 0),
  };
}
