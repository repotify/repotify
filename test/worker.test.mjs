import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { DAILY_LIMIT } from "../pipeline/worker/src/index.mjs";

let sqlite = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  // node:sqlite ships with Node 22+; on older runtimes these tests are skipped.
}
const schema = readFileSync(new URL("../pipeline/worker/schema.sql", import.meta.url), "utf8");

// Minimal Cloudflare D1 binding backed by node:sqlite, so the Worker's real SQL is exercised.
function d1() {
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(schema);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
  });
  return { prepare: (sql) => stmt(sql), _db: db };
}

const ID = "123e4567-e89b-42d3-a456-426614174000";
const ev = (o = {}) => ({ type: "shown", ts: "2026-09-28T10:00:00.000Z", installId: ID, agent: "claude-code", version: "0.1.0", items: ["pdf", "graphify"], ...o });
const post = (env, events, headers = {}) => worker.fetch(new Request("https://w.test/v1/events", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers }, body: JSON.stringify({ events }) }), env);
const opts = { skip: !sqlite && "node:sqlite not available" };

test("valid batches are accepted and aggregated per item", opts, async () => {
  const env = { DB: d1() };
  let res = await post(env, [ev(), ev({ type: "selected", ts: "2026-09-28T10:01:00.000Z", items: ["pdf"] }), ev({ type: "vote", ts: "2026-09-28T10:02:00.000Z", items: undefined, item: "pdf", vote: "up" })]);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { accepted: 3 });
  res = await worker.fetch(new Request("https://w.test/v1/stats"), env);
  const stats = await res.json();
  assert.deepEqual(stats.items.pdf, { shown: 1, selected: 1, installed: 0, kept7d: 0, removed: 0, up: 1, down: 0 });
  assert.equal(stats.items.graphify.shown, 1);
});

test("invalid events reject the batch", opts, async () => {
  const env = { DB: d1() };
  const res = await post(env, [ev({ repoName: "secret" })]);
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /repoName/);
  assert.equal((await post(env, "nope")).status, 400);
  assert.equal((await post(env, Array.from({ length: 101 }, (_, i) => ev({ ts: new Date(Date.UTC(2026, 8, 28, 0, 0, i)).toISOString() })))).status, 400);
});

test("the same event sent twice is stored once", opts, async () => {
  const env = { DB: d1() };
  await post(env, [ev()]);
  const again = await post(env, [ev()]);
  assert.deepEqual(await again.json(), { accepted: 0 });
  const stats = await (await worker.fetch(new Request("https://w.test/v1/stats"), env)).json();
  assert.equal(stats.items.pdf.shown, 1);
});

test("each install id is rate limited per day", opts, async () => {
  const env = { DB: d1() };
  for (let b = 0; b < DAILY_LIMIT / 100; b++) {
    const batch = Array.from({ length: 100 }, (_, i) => ev({ ts: new Date(Date.UTC(2026, 8, 28, 1, b, i % 60, Math.floor(i / 60))).toISOString() }));
    assert.equal((await post(env, batch)).status, 202);
  }
  const over = await post(env, [ev({ ts: "2026-09-28T23:59:59.000Z" })]);
  assert.equal(over.status, 429);
});

test("no IP address or request metadata is stored", opts, async () => {
  const env = { DB: d1() };
  await post(env, [ev()], { "user-agent": "secret-agent" });
  const dump = JSON.stringify(env.DB._db.prepare("SELECT * FROM events").all());
  assert.ok(!dump.includes("203.0.113.9"));
  assert.ok(!dump.includes("secret-agent"));
});

test("unknown routes are 404", async () => {
  const res = await worker.fetch(new Request("https://w.test/admin"), { DB: null });
  assert.equal(res.status, 404);
});

test("M6: one vote per install and item; a later vote replaces the earlier one", opts, async () => {
  const env = { DB: d1() };
  await post(env, [ev({ type: "vote", items: undefined, item: "pdf", vote: "up", ts: "2026-09-28T10:00:00.000Z" })]);
  await post(env, [ev({ type: "vote", items: undefined, item: "pdf", vote: "up", ts: "2026-09-28T11:00:00.000Z" })]);
  await post(env, [ev({ type: "vote", items: undefined, item: "pdf", vote: "down", ts: "2026-09-28T12:00:00.000Z" })]);
  const stats = await (await worker.fetch(new Request("https://w.test/v1/stats"), env)).json();
  assert.deepEqual([stats.items.pdf.up, stats.items.pdf.down], [0, 1]);
});
