// Capability graph loader: schema validation, R2 enforcement (an edge that was
// not exercised by a forcing test may not enter the graph), adjacency index.

import { readFileSync } from "node:fs";

export const EDGE_TYPES = ["provides", "requires", "conflicts_with", "supersedes", "depends_on", "fallback"];
export const NODE_RE = /^(item|cap):[a-z0-9][a-z0-9-]*$/;

export const SUPPORTED_SEED_VERSION = 1;

// Validate the raw seed object. Returns { ok, errors }. Pure: no catalog needed.
export function validateSeed(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["seed must be an object"] };
  if (raw.version !== SUPPORTED_SEED_VERSION) errors.push(`unsupported seed version ${raw.version} (want ${SUPPORTED_SEED_VERSION})`);
  if (!Array.isArray(raw.edges)) errors.push("seed.edges must be an array");
  else {
    const seen = new Set();
    // First position of each id, found once: the seed grows with the catalog and is checked on every `recommend`.
    const firstWithId = new Map();
    raw.edges.forEach((e, i) => {
      if (!firstWithId.has(e?.id)) firstWithId.set(e?.id, i);
    });
    raw.edges.forEach((e, i) => {
      const where = `edge[${i}]${e?.id ? "#" + e.id : ""}`;
      if (!e || typeof e !== "object") {
        errors.push(`${where}: not an object`);
        return;
      }
      if (!EDGE_TYPES.includes(e.type)) errors.push(`${where}: unknown type ${JSON.stringify(e.type)}`);
      if (typeof e.id !== "string" || !e.id) errors.push(`${where}: missing id`);
      if (typeof e.from !== "string" || !NODE_RE.test(e.from)) errors.push(`${where}: bad from ${JSON.stringify(e.from)}`);
      if (typeof e.to !== "string" || !NODE_RE.test(e.to)) errors.push(`${where}: bad to ${JSON.stringify(e.to)}`);
      if (e.from === e.to) errors.push(`${where}: self edge`);
      if (e.tested !== true) errors.push(`${where}: R2 violation — edge not forced by a test (tested !== true)`);
      if (typeof e.test !== "string" || !e.test) errors.push(`${where}: missing test reference`);
      const key = `${e.type}|${e.from}|${e.to}`;
      if (seen.has(key)) errors.push(`${where}: duplicate edge ${key}`);
      seen.add(key);
      if (firstWithId.get(e.id) !== i) errors.push(`${where}: duplicate edge id ${e.id}`);
    });
  }
  return { ok: errors.length === 0, errors };
}

// Build the adjacency index from a validated seed. Throws on invalid seed.
export function buildGraph(raw) {
  const { ok, errors } = validateSeed(raw);
  if (!ok) throw new Error(`invalid capability graph seed: ${errors.join("; ")}`);
  const out = new Map(); // node -> [edge]
  const byType = new Map();
  for (const type of EDGE_TYPES) byType.set(type, []);
  const nodeKind = (ref) => ref.split(":")[0];
  const nodes = new Set();
  for (const edge of raw.edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    if (!out.has(edge.from)) out.set(edge.from, []);
    out.get(edge.from).push(edge);
    byType.get(edge.type).push(edge);
  }
  return {
    version: raw.version,
    generatedAt: raw.generatedAt ?? null,
    edges: raw.edges,
    nodes,
    nodeKind,
    byType,
    outEdges(node) {
      return out.get(node) ?? [];
    },
    edgesOf(node, type = null) {
      const edges = out.get(node) ?? [];
      return type ? edges.filter((e) => e.type === type) : edges;
    },
  };
}

export function loadSeedGraph(filePath) {
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  return buildGraph(raw);
}

// Convenience: item/capability ref builders so call sites don't hand-roll strings.
export const item = (id) => `item:${id}`;
export const cap = (id) => `cap:${id}`;
