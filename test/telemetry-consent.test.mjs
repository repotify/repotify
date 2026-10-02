// Consent layer tests (T1/T2): the off triple, notice gating,
// and "the off command itself produces no telemetry" (CLI-level).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  telemetryEnabled, noticeNeeded, markNoticeShown, setTelemetryEnabled, canTrack,
} from "../lib/telemetry/consent.mjs";
import { main } from "../src/cli.mjs";

// Test temp dirs: track every mkdtempSync dir and remove them all in after(),
// or a day of test runs fills /tmp (512M tmpfs) and later runs fail with ENOSPC.
const tempDirs = [];
const mkTemp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
};
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const dir = () => mkTemp("rp-consent-");
const envFor = (d, extra = {}) => ({ REPOTIFY_HOME: d, REPOTIFY_OFFLINE: "1", ...extra });
const configOf = (d) => JSON.parse(readFileSync(join(d, "config.json"), "utf8"));
const ioFor = (d, extra = {}) => {
  const text = { out: "", err: "" };
  return {
    io: {
      cwd: d,
      env: envFor(d, extra),
      stdout: { write(s) { text.out += s; } },
      stderr: { write(s) { text.err += s; } },
    },
    text,
  };
};

test("T2: each leg of the off triple disables tracking", () => {
  for (const extra of [{ DO_NOT_TRACK: "1" }, { REPOTIFY_TELEMETRY: "0" }, { NO_ANALYTICS: "1" }]) {
    const d = dir();
    const env = envFor(d, extra);
    assert.equal(telemetryEnabled(env), false, JSON.stringify(extra));
    assert.equal(noticeNeeded(env), false);
    assert.equal(canTrack(env), false);
    assert.equal(existsSync(join(d, "config.json")), false, "disabled env writes nothing");
  }
  const d = dir();
  setTelemetryEnabled(envFor(d), false);
  assert.equal(telemetryEnabled(envFor(d)), false, "persisted opt-out sticks");
  assert.equal(configOf(d).telemetry, false);
  setTelemetryEnabled(envFor(d), true);
  assert.equal(telemetryEnabled(envFor(d)), true, "opt back in works");
});

test("T1: canTrack is false until the notice has been seen", () => {
  const d = dir();
  const env = envFor(d);
  assert.equal(telemetryEnabled(env), true, "default on (user directive)");
  assert.equal(noticeNeeded(env), true);
  assert.equal(canTrack(env), false, "no data before notice");
  markNoticeShown(env);
  assert.equal(noticeNeeded(env), false);
  assert.equal(canTrack(env), true);
});

test("markNoticeShown is a no-op while disabled (never flips a disabled user on)", () => {
  const d = dir();
  const env = envFor(d, { DO_NOT_TRACK: "1" });
  markNoticeShown(env);
  assert.equal(telemetryEnabled(env), false);
});

test("CLI: `telemetry off` works and produces no telemetry itself", async () => {
  const d = dir();
  const { io, text } = ioFor(d);
  const code = await main(["telemetry", "off"], io);
  assert.equal(code, 0);
  assert.match(text.out, /Telemetry off\./);
  assert.equal(configOf(d).telemetry, false);
  assert.equal(existsSync(join(d, "queue.jsonl")), false, "the off command queues nothing");
  assert.equal(existsSync(join(d, "stage0.jsonl")), false, "the off command writes no stage-0 events");
});

test("CLI: `telemetry on` re-enables, `status` reports without tracking", async () => {
  const d = dir();
  let h = ioFor(d);
  assert.equal(await main(["telemetry", "on"], h.io), 0);
  assert.match(h.text.out, /Telemetry on\./);
  assert.equal(configOf(d).telemetry, true);
  h = ioFor(d);
  assert.equal(await main(["telemetry", "status"], h.io), 0);
  assert.match(h.text.out, /Telemetry: on/);
  assert.match(h.text.out, /endpoint not configured/);
  assert.equal(existsSync(join(d, "queue.jsonl")), false, "status queues nothing");
  assert.equal(existsSync(join(d, "stage0.jsonl")), false, "status writes nothing");
});

test("CLI: env off-switches are reflected in `telemetry status`", async () => {
  for (const extra of [{ DO_NOT_TRACK: "1" }, { REPOTIFY_TELEMETRY: "0" }]) {
    const d = dir();
    const { io, text } = ioFor(d, extra);
    assert.equal(await main(["telemetry", "status"], io), 0);
    assert.match(text.out, /Telemetry: off/, JSON.stringify(extra));
  }
});

test("CLI: bad telemetry subcommand usage exits 2", async () => {
  const d = dir();
  const { io, text } = ioFor(d);
  assert.equal(await main(["telemetry", "explode"], io), 2);
  assert.match(text.err, /Usage: repotify telemetry/);
});
