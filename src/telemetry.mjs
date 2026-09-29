import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir, readConfig, writeConfig, TELEMETRY_ENDPOINT } from "./config.mjs";
import { validateEvent, EVENT_TYPES } from "./telemetry-schema.mjs";

export { validateEvent, EVENT_TYPES };
export const MAX_QUEUE = 1000;
const BATCH = 100;

export const NOTICE = [
  "Repotify collects anonymous usage signals to rank items better: a random install id, agent type,",
  "stack/need categories, which catalog items were shown, picked, kept after 7 days or removed, and your votes.",
  "It never collects code, file names, repository names, user names, or stores IP addresses.",
  "Turn it off any time: REPOTIFY_TELEMETRY=0 (or DO_NOT_TRACK=1), or run `repotify telemetry off`.",
].join("\n");

export function createTelemetry({ env = process.env, fetchImpl = fetch, now = new Date(), endpoint = TELEMETRY_ENDPOINT, version = "0.0.0" } = {}) {
  const dir = homeDir(env);
  const queuePath = join(dir, "queue.jsonl");
  const config = readConfig(env);
  const enabled = !(env.REPOTIFY_TELEMETRY === "0" || env.DO_NOT_TRACK === "1" || config.telemetry === false);
  const target = endpoint ?? env.REPOTIFY_TELEMETRY_URL ?? null;

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
    async flush() {
      if (!enabled) return { sent: 0, queued: 0 };
      let lines = readQueue();
      if (!target || !lines.length) return { sent: 0, queued: lines.length };
      let sent = 0;
      while (lines.length) {
        const batch = lines.slice(0, BATCH);
        try {
          const res = await fetchImpl(`${target.replace(/\/$/, "")}/v1/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ events: batch.map((l) => JSON.parse(l)) }),
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) break;
        } catch {
          break;
        }
        sent += batch.length;
        lines = lines.slice(BATCH);
        writeQueue(lines);
      }
      return { sent, queued: lines.length };
    },
  };
}
