// Repotify analytics endpoint (Cloudflare Worker + D1). Deployed only once the owner configures it;
// the client ships with the endpoint disabled.
import { validateEvent } from "../../../src/telemetry-schema.mjs";

export const DAILY_LIMIT = 500;
const MAX_BATCH = 100;
const COUNTED = ["shown", "selected", "installed", "kept7d", "removed"];

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function eventId(e) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(e)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ingest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const events = body?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_BATCH) return json({ error: `events must be an array of 1-${MAX_BATCH}` }, 400);
  const problems = events.map((e, i) => validateEvent(e).map((m) => `#${i}: ${m}`)).flat();
  if (problems.length) return json({ error: "invalid events", details: problems.slice(0, 20) }, 400);

  // Only the day of receipt is recorded; the request's IP and headers are never read.
  const day = new Date().toISOString().slice(0, 10);
  const perInstall = new Map();
  for (const e of events) perInstall.set(e.installId, (perInstall.get(e.installId) ?? 0) + 1);
  for (const [installId, n] of perInstall) {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE install_id = ? AND day = ?").bind(installId, day).first();
    if (Number(row?.n ?? 0) + n > DAILY_LIMIT) return json({ error: "rate limited" }, 429);
  }

  let accepted = 0;
  for (const e of events) {
    const id = await eventId(e);
    const r = await env.DB.prepare(
      "INSERT OR IGNORE INTO events (event_id, install_id, day, type, agent, version, catalog_version, project_type, stacks, needs, items, item, vote, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      id, e.installId, day, e.type, e.agent ?? null, e.version ?? null, e.catalogVersion ?? null, e.projectType ?? null,
      JSON.stringify(e.stacks ?? []), JSON.stringify(e.needs ?? []), JSON.stringify(e.items ?? []), e.item ?? null, e.vote ?? null, e.ts,
    ).run();
    if (!r.meta?.changes) continue;
    accepted++;
    if (e.type === "vote") {
      await env.DB.prepare("INSERT INTO votes (install_id, item, vote, ts) VALUES (?, ?, ?, ?) ON CONFLICT (install_id, item) DO UPDATE SET vote = excluded.vote, ts = excluded.ts WHERE excluded.ts >= votes.ts")
        .bind(e.installId, e.item, e.vote, e.ts).run();
    }
    const items = COUNTED.includes(e.type) ? [...new Set([...(e.items ?? []), ...(e.item ? [e.item] : [])])] : [];
    for (const item of items) {
      await env.DB.prepare("INSERT OR IGNORE INTO event_items (event_id, item, type) VALUES (?, ?, ?)").bind(id, item, e.type).run();
    }
  }
  return json({ accepted }, 202);
}

async function stats(env) {
  const items = {};
  const entry = (id) => (items[id] ??= { shown: 0, selected: 0, installed: 0, kept7d: 0, removed: 0, up: 0, down: 0 });
  const counts = await env.DB.prepare("SELECT item, type, COUNT(*) AS n FROM event_items GROUP BY item, type").all();
  for (const r of counts.results ?? []) entry(r.item)[r.type] = Number(r.n);
  const votes = await env.DB.prepare("SELECT item, vote, COUNT(*) AS n FROM votes GROUP BY item, vote").all();
  for (const r of votes.results ?? []) entry(r.item)[r.vote] = Number(r.n);
  return json({ generatedAt: new Date().toISOString(), items }, 200, { "cache-control": "public, max-age=3600" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/events") return ingest(request, env);
    if (request.method === "GET" && url.pathname === "/v1/stats") return stats(env);
    return json({ error: "not found" }, 404);
  },
};
