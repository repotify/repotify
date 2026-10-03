// `repotify ui`: the decision drawn as a tree on this computer. The catalog is the tree (domains, then jobs, then
// items); each answer runs the same engine `recommend` runs and the page shows what it prunes, what is left for each
// job and what is picked. Read-only: the page can ask for the tree and for the engine's state, nothing else. It is
// served on 127.0.0.1 only, every request needs the random token in the printed link, and a Host header other than
// this server's is refused, so another site in the browser cannot read it or reach it through DNS rebinding.
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveNeeds } from "./needs.mjs";
import { adaptiveQuestions } from "./questions.mjs";
import { demandFor, recommendLocal } from "../lib/pipeline/recommend/index.mjs";

const PAGE = new URL("./ui.html", import.meta.url);
const MAX_ANSWER_BYTES = 4096;

// The catalog as a tree: domain -> job -> item, in a stable order. Only what the page shows about an item.
export function catalogTree(catalog) {
  const t = catalog.taxonomy;
  const domains = new Map();
  for (const item of catalog.items) {
    const job = item.cluster ?? item.capabilities?.[0];
    const domainId = t.capabilities?.[job]?.domain ?? "other";
    if (!domains.has(domainId)) domains.set(domainId, { id: domainId, label: t.domains?.[domainId]?.label ?? "Other", jobs: new Map() });
    const jobs = domains.get(domainId).jobs;
    if (!jobs.has(job)) jobs.set(job, { id: job, label: t.capabilities?.[job]?.label ?? job, items: [] });
    jobs.get(job).items.push({ id: item.id, name: item.name ?? item.id, type: item.type ?? "skill", summary: item.summary ?? "", tier: item.tier, origin: item.origin ?? null, stacks: item.stacks ?? [] });
  }
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    domains: [...domains.values()].sort(byId).map((d) => ({ ...d, jobs: [...d.jobs.values()].sort(byId).map((j) => ({ ...j, items: j.items.sort(byId) })) })),
    items: catalog.items.length,
  };
}

// The answers a request may carry, reduced to ids the taxonomy knows. An empty list stays: "none of these" is an
// answer, and it closes the question.
export function cleanAnswers(raw, taxonomy) {
  const a = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const known = { needs: taxonomy.needs ?? {}, priorities: taxonomy.priorities ?? {}, stacks: taxonomy.stacks ?? {}, platforms: { web: 1, mobile: 1, desktop: 1 } };
  const out = {};
  if (typeof a.projectType === "string" && taxonomy.projectTypes?.[a.projectType]) out.projectType = a.projectType;
  for (const [key, ids] of Object.entries(known)) {
    if (Array.isArray(a[key])) out[key] = [...new Set(a[key].filter((x) => typeof x === "string" && Object.hasOwn(ids, x)))].slice(0, 40);
  }
  return out;
}

// What the engine did with every item for these answers: how far it got (pruned, candidate, scored, table, default)
// and, when it stopped, why. `possible` items are those an answer to an open question would pick ("in play"); the
// funnel counts the catalog, what is still in play, and the picks.
export function explain({ catalog, graph, fingerprint, answers = {}, machine = null, installed = [], agents = [], possible = [] }) {
  const needs = resolveNeeds({ fingerprint, answers, taxonomy: catalog.taxonomy });
  const demand = { ...demandFor({ catalog, fingerprint, needs, answers, agents }), ...(machine ? { machine } : {}) };
  const rec = recommendLocal({ catalog, graph, demand, installed, answers });
  const stage = {};
  const why = {};
  for (const e of rec.narrowed.eliminated ?? []) {
    stage[e.id] = "pruned";
    why[e.id] = e.reasons?.[0] ?? "pruned";
  }
  for (const c of rec.narrowed.candidates) stage[c.item.id] = "candidate";
  for (const s of rec.scored) stage[s.item.id] = "scored";
  for (const r of rec.table ?? []) stage[r.id] = r.installed ? "installed" : "table";
  for (const id of rec.set) stage[id] = "default";
  for (const d of rec.dropped ?? []) if (d?.id && stage[d.id] !== "default") why[d.id] = d.reason ?? why[d.id];
  for (const c of rec.narrowed.candidates) if (stage[c.item.id] === "candidate") why[c.item.id] ??= "below the fit floor";
  for (const id of possible) if (stage[id] !== "default" && stage[id] !== "installed") stage[id] = "possible";
  const at = (...stages) => Object.values(stage).filter((s) => stages.includes(s)).length;
  return {
    stage,
    why,
    funnel: [
      { id: "catalog", label: "In the catalog", n: catalog.items.length },
      { id: "candidate", label: "Fit this project", n: at("candidate", "scored", "table", "default") },
      { id: "possible", label: "Still in play", n: at("possible", "default") },
      { id: "default", label: "Picked", n: rec.set.length },
    ],
    set: rec.set,
    decision: rec.decision,
    projectType: needs.projectType,
    needs: needs.needs,
  };
}

// What each answer is called, for the page to show: "needs:auth" -> "User accounts and auth".
export function answerLabels(answers, taxonomy) {
  const group = { projectType: "projectTypes", needs: "needs", priorities: "priorities", stacks: "stacks" };
  const platforms = { web: "Web", mobile: "Mobile", desktop: "Desktop" };
  const out = {};
  if (answers.projectType) out[`projectType:${answers.projectType}`] = taxonomy.projectTypes?.[answers.projectType]?.label ?? answers.projectType;
  for (const key of ["needs", "priorities", "stacks", "platforms"]) {
    for (const id of answers[key] ?? []) out[`${key}:${id}`] = key === "platforms" ? platforms[id] : taxonomy[group[key]]?.[id]?.label ?? id;
  }
  return out;
}

// The `recommend` command that gives the same picks.
export function commandFor(answers) {
  const flags = [];
  if (answers.projectType) flags.push(`--type ${answers.projectType}`);
  for (const key of ["needs", "priorities", "stacks", "platforms"]) if (answers[key]?.length) flags.push(`--${key} ${answers[key].join(",")}`);
  return ["repotify recommend", ...flags].join(" ");
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function startUi({ catalog, graph, fingerprint, project = "project", machine = null, installed = [], agents = [], port = 0, token = randomBytes(16).toString("hex") }) {
  const page = readFileSync(PAGE, "utf8");
  const tree = catalogTree(catalog);
  const itemById = new Map(catalog.items.map((i) => [i.id, i]));
  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Resource-Policy": "same-origin",
      ...extra,
    });
    res.end(body);
  };
  const json = (res, status, doc) => send(res, status, "application/json; charset=utf-8", JSON.stringify(doc));
  const server = createServer((req, res) => {
    const port = server.address()?.port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return send(res, 403, "text/plain", "wrong host\n");
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "read-only\n", { Allow: "GET, HEAD" });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (!sameToken(url.searchParams.get("t"), token)) return send(res, 403, "text/plain", "open the link `repotify ui` printed\n");
    try {
      if (url.pathname === "/") {
        const nonce = randomBytes(16).toString("base64");
        const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
        return send(res, 200, "text/html; charset=utf-8", page.replaceAll("__NONCE__", nonce), { "Content-Security-Policy": csp });
      }
      if (url.pathname === "/api/tree") {
        return json(res, 200, { ...tree, project, fingerprint: { stacks: fingerprint?.stacks ?? [], needs: fingerprint?.inferredNeeds ?? [], platforms: fingerprint?.platforms ?? [], empty: Boolean(fingerprint?.empty) }, machine });
      }
      if (url.pathname === "/api/state") {
        const raw = url.searchParams.get("a") ?? "{}";
        if (raw.length > MAX_ANSWER_BYTES) return json(res, 413, { error: "answers too long" });
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: "answers must be JSON" });
        }
        const answers = cleanAnswers(parsed, catalog.taxonomy);
        const asked = adaptiveQuestions({ catalog, graph, fingerprint, answers, machine, installed, agents });
        const state = explain({ catalog, graph, fingerprint, answers, machine, installed, agents, possible: asked.possible });
        const picked = state.set.map((id) => itemById.get(id)).filter(Boolean).map((i) => ({ id: i.id, name: i.name ?? i.id, type: i.type ?? "skill", summary: i.summary ?? "", job: catalog.taxonomy.capabilities?.[i.cluster]?.label ?? i.cluster }));
        return json(res, 200, { ...state, answers, answerLabels: answerLabels(answers, catalog.taxonomy), questions: asked.questions, picked, command: commandFor(answers) });
      }
      return send(res, 404, "text/plain", "not found\n");
    } catch (error) {
      return json(res, 500, { error: String(error?.message ?? error).slice(0, 200) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const p = server.address().port;
      const close = () => new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      });
      resolve({ url: `http://127.0.0.1:${p}/?t=${token}`, port: p, token, close });
    });
  });
}
