import { test, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint } from "../src/fingerprint.mjs";
import { catalogTree, cleanAnswers, explain, commandFor, answerLabels, startUi } from "../src/ui.mjs";
import { adaptiveQuestions } from "../src/questions.mjs";
import { loadSeedGraph } from "../lib/pipeline/graph/loader.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(root, "catalog", f), "utf8"));
const catalog = { items: read("items.json"), taxonomy: read("taxonomy.json"), loadouts: read("loadouts.json"), core: read("core.json") };
const graph = loadSeedGraph(join(root, "data", "graph-seed.json"));
const project = (name) => fingerprint(join(root, "test", "fixtures", "projects", name));

const servers = [];
after(async () => {
  for (const s of servers) await s.close();
});

test("the tree holds every catalog item once, under its job and domain", () => {
  const tree = catalogTree(catalog);
  const ids = tree.domains.flatMap((d) => d.jobs.flatMap((j) => j.items.map((i) => i.id)));
  assert.equal(ids.length, catalog.items.length);
  assert.equal(new Set(ids).size, ids.length);
  for (const d of tree.domains) {
    assert.ok(d.label && d.jobs.length, d.id);
    for (const j of d.jobs) for (const i of j.items) assert.equal(catalog.items.find((x) => x.id === i.id).cluster, j.id);
  }
});

test("answers are cut down to ids the taxonomy knows; an empty list stays, it closes its question", () => {
  const a = cleanAnswers({ projectType: "web-app", needs: ["auth", "auth", "nope", 3], priorities: [], stacks: "supabase", platforms: ["web", "tv"], extra: 1 }, catalog.taxonomy);
  assert.deepEqual(a, { projectType: "web-app", needs: ["auth"], priorities: [], platforms: ["web"] });
  assert.deepEqual(cleanAnswers({ projectType: "spaceship" }, catalog.taxonomy), {});
  assert.deepEqual(cleanAnswers(["needs"], catalog.taxonomy), {});
  assert.deepEqual(cleanAnswers(null, catalog.taxonomy), {});
});

test("every item gets a stage; the funnel counts them; what an open answer would pick is in play", async () => {
  const fp = await project("empty");
  const asked = adaptiveQuestions({ catalog, graph, fingerprint: fp });
  const s = explain({ catalog, graph, fingerprint: fp, possible: asked.possible });
  assert.equal(Object.keys(s.stage).length, catalog.items.length);
  const n = (id) => s.funnel.find((f) => f.id === id).n;
  assert.equal(n("catalog"), catalog.items.length);
  assert.equal(n("default"), s.set.length);
  assert.equal(n("possible"), s.set.length + asked.possible.length);
  for (const id of asked.possible) assert.equal(s.stage[id], "possible");
  for (const id of s.set) assert.equal(s.stage[id], "default");
  for (const [id, st] of Object.entries(s.stage)) if (st === "pruned") assert.ok(s.why[id], `${id} says why it is out`);
  // Answering every open question leaves nothing in play: the picks are settled.
  let answers = {};
  for (let i = 0; i < 6; i++) {
    const q = adaptiveQuestions({ catalog, graph, fingerprint: fp, answers }).questions[0];
    if (!q) break;
    answers = q.id === "projectType" ? { ...answers, projectType: q.options[0].id } : { ...answers, [q.id]: [q.options[0].id] };
  }
  const settled = adaptiveQuestions({ catalog, graph, fingerprint: fp, answers });
  assert.deepEqual(settled.questions, []);
  assert.deepEqual(settled.possible, []);
});

test("the command and the names shown for answers", () => {
  const answers = { projectType: "web-app", needs: ["auth", "payments"], platforms: ["web"] };
  assert.equal(commandFor(answers), "repotify recommend --type web-app --needs auth,payments --platforms web");
  assert.equal(commandFor({}), "repotify recommend");
  const labels = answerLabels(answers, catalog.taxonomy);
  assert.equal(labels["projectType:web-app"], catalog.taxonomy.projectTypes["web-app"].label);
  assert.equal(labels["needs:auth"], catalog.taxonomy.needs.auth.label);
  assert.equal(labels["platforms:web"], "Web");
});

const get = (port, path, { host = `127.0.0.1:${port}`, method = "GET" } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: host } }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on("error", reject);
  req.end();
});

test("the local server: 127.0.0.1 only, the token on every request, its own Host only, read-only", async () => {
  const ui = await startUi({ catalog, graph, fingerprint: await project("nextjs-saas"), project: "nextjs-saas", machine: { os: "linux", arch: "x64", tools: { node: true } } });
  servers.push(ui);
  assert.match(ui.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/);
  const t = ui.token;
  assert.equal((await get(ui.port, "/")).status, 403, "no token");
  assert.equal((await get(ui.port, `/?t=${"0".repeat(32)}`)).status, 403, "wrong token");
  assert.equal((await get(ui.port, `/?t=${t}`, { host: `evil.example:${ui.port}` })).status, 403, "DNS rebinding: another host name");
  assert.equal((await get(ui.port, `/?t=${t}`, { method: "POST" })).status, 405);
  assert.equal((await get(ui.port, `/?t=${t}`, { host: `localhost:${ui.port}` })).status, 200, "localhost is this server too");
  const page = await get(ui.port, `/?t=${t}`);
  assert.equal(page.status, 200);
  const nonce = /script-src 'nonce-([^']+)'/.exec(page.headers["content-security-policy"])?.[1];
  assert.ok(nonce && page.body.includes(`<script nonce="${nonce}">`) && !page.body.includes("__NONCE__"));
  assert.match(page.headers["content-security-policy"], /default-src 'none'.*connect-src 'self'.*frame-ancestors 'none'/);
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  const tree = JSON.parse((await get(ui.port, `/api/tree?t=${t}`)).body);
  assert.equal(tree.project, "nextjs-saas");
  assert.ok(tree.fingerprint.stacks.includes("nextjs"));
  const state = JSON.parse((await get(ui.port, `/api/state?t=${t}&a=${encodeURIComponent(JSON.stringify({ needs: ["security"], bogus: 1 }))}`)).body);
  assert.deepEqual(state.answers, { needs: ["security"] });
  assert.ok(state.set.length && state.picked.length === state.set.length);
  assert.equal(state.command, "repotify recommend --needs security");
  assert.ok(Array.isArray(state.questions) && !state.questions.some((q) => q.id === "needs"), "an answered question is closed");
  assert.equal((await get(ui.port, `/api/state?t=${t}&a=%7Bnot-json`)).status, 400);
  assert.equal((await get(ui.port, `/api/state?t=${t}&a=${"x".repeat(5000)}`)).status, 413);
  assert.equal((await get(ui.port, `/nope?t=${t}`)).status, 404);
});

test("the page never turns catalog text into markup and runs no inline handlers", () => {
  const page = readFileSync(join(root, "src", "ui.html"), "utf8");
  assert.doesNotMatch(page, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(page, /<[^>]+\son[a-z]+\s*=/i, "no inline event handlers");
  assert.doesNotMatch(page, /<(script|link|img)[^>]+(src|href)\s*=\s*["']https?:/i, "nothing loaded from another host");
});

test("a bare catalog still draws: items without a name, summary or domain, and an engine error is a 500, not a crash", async () => {
  const bare = {
    items: [{ id: "x", capabilities: ["mystery"], cluster: "mystery", needs: [], stacks: ["*"], tier: "core", security: { level: "verified" }, descriptionChars: 10 }],
    taxonomy: { capabilities: { mystery: {} }, needs: {}, stacks: {}, priorities: {}, projectTypes: {} },
    loadouts: [], core: [],
  };
  const tree = catalogTree(bare);
  assert.deepEqual(tree.domains.map((d) => [d.id, d.label]), [["other", "Other"]]);
  assert.deepEqual(tree.domains[0].jobs[0].items[0], { id: "x", name: "x", type: "skill", summary: "", tier: "core", origin: null, stacks: ["*"] });
  assert.deepEqual(answerLabels({ projectType: "ghost", needs: ["gone"], platforms: ["web"] }, bare.taxonomy), { "projectType:ghost": "ghost", "needs:gone": "gone", "platforms:web": "Web" });
  const ui = await startUi({ catalog: bare, graph, fingerprint: null });
  servers.push(ui);
  const tr = JSON.parse((await get(ui.port, `/api/tree?t=${ui.token}`)).body);
  assert.deepEqual(tr.fingerprint, { stacks: [], needs: [], platforms: [], empty: false });
  assert.equal(tr.machine, null);
  const state = await get(ui.port, `/api/state?t=${ui.token}`);
  assert.equal(state.status, 200);
  assert.deepEqual(JSON.parse(state.body).set, ["x"]);
  const broken = await startUi({ catalog: { ...bare, items: [{ id: "y" }] }, graph, fingerprint: null });
  servers.push(broken);
  const failed = await get(broken.port, `/api/state?t=${broken.token}`);
  assert.equal(failed.status, 500);
  assert.ok(JSON.parse(failed.body).error.length <= 200);
});
