// `repotify track`: what changed in the project since Repotify last looked, and what it would pick for it now.
// Run by a SessionStart hook the user enables (`repotify enable repotify-tracker`), or by hand. It reads the project and
// the catalog already on this computer; only the weekly update check uses the network. It speaks when there is
// something to do, once for each change, in a few lines the agent reads when a session starts.
//
// What it remembers is kept on this computer (REPOTIFY_HOME/projects/<hash of the folder path>.json), never in the
// project: the stacks, needs and platforms the files showed last time.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readJsonSafe, sha256 } from "./util.mjs";
import { homeDir } from "./config.mjs";
import { resolveNeeds } from "./needs.mjs";
import { demandFor, recommendLocal } from "../lib/pipeline/recommend/index.mjs";

export const MAX_NAMED = 6;

const stateFile = (env, cwd) => join(homeDir(env), "projects", `${sha256(resolve(cwd)).slice(0, 16)}.json`);

export function readProjectState(env, cwd) {
  const r = readJsonSafe(stateFile(env, cwd));
  return r.ok && r.value && typeof r.value === "object" && r.value.profile ? r.value : null;
}

// Best effort, like the config: a home folder that cannot be written only means the tracker starts over next time.
export function writeProjectState(env, cwd, state) {
  const file = stateFile(env, cwd);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

// What a project looks like to the engine: what the tracker compares between sessions.
export function projectProfile(fp) {
  const sorted = (list) => [...new Set(list ?? [])].sort();
  return { stacks: sorted(fp?.stacks), needs: sorted(fp?.inferredNeeds), platforms: sorted(fp?.platforms), hints: sorted(fp?.capabilityHints) };
}

function picks({ catalog, graph, fingerprint, installed, machine, agents }) {
  const needs = resolveNeeds({ fingerprint, answers: {}, taxonomy: catalog.taxonomy });
  const demand = { ...demandFor({ catalog, fingerprint, needs, agents }), ...(machine ? { machine } : {}) };
  return recommendLocal({ catalog, graph, demand, installed }).set;
}

const listed = (ids) => (ids.length > MAX_NAMED ? `${ids.slice(0, MAX_NAMED).join(", ")} and ${ids.length - MAX_NAMED} more` : ids.join(", "));

// What the project gained since the last look and what the engine picks for it only because of that. The first look
// only remembers. A change that brings no new pick is remembered and not mentioned.
export function driftOf({ catalog, graph, fingerprint, state, installed = [], machine = null, agents = [], now = new Date() }) {
  const profile = projectProfile(fingerprint);
  const next = { profile, at: now.toISOString() };
  const before = state?.profile;
  if (!before) return { first: true, added: null, fresh: [], lines: [], state: next };
  const gained = (key) => profile[key].filter((x) => !(before[key] ?? []).includes(x));
  const added = { stacks: gained("stacks"), needs: gained("needs"), platforms: gained("platforms"), hints: gained("hints") };
  if (!Object.values(added).some((list) => list.length)) return { first: false, added, fresh: [], lines: [], state: next };
  const earlier = { ...fingerprint, empty: false, stacks: before.stacks ?? [], inferredNeeds: before.needs ?? [], platforms: before.platforms ?? [], capabilityHints: before.hints ?? [] };
  const then = new Set(picks({ catalog, graph, fingerprint: earlier, installed, machine, agents }));
  const fresh = picks({ catalog, graph, fingerprint, installed, machine, agents }).filter((id) => !then.has(id));
  // A need and a platform can share a name ("mobile"): said once.
  const what = [...new Set([...added.stacks, ...added.needs, ...added.platforms])];
  const lines = fresh.length
    ? [`Repotify: this project changed since its setup was chosen (new: ${what.length ? listed(what) : "dependencies"}). It would now also pick: ${listed(fresh)}. Run \`repotify recommend\` and offer the user what is new.`]
    : [];
  return { first: false, added, fresh, lines, state: next };
}

// The audit in one line: installed skills that no longer earn their place.
export function staleLine(report) {
  const stale = (report?.skills ?? []).filter((s) => s.verdict === "remove").map((s) => s.id);
  return stale.length ? `Repotify: ${stale.length} installed skill${stale.length === 1 ? " no longer earns its" : "s no longer earn their"} place (${listed(stale)}). Run \`repotify audit\`, show the user why, and remove only with their OK.` : null;
}
