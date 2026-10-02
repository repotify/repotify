// Existing-install audit: read installed skills/repos, find conflicts, suggest
// removals. PROJECT-SCOPED removals only — global installs (~/.claude/skills
// and friends) are scanned read-only and NEVER touched: another project may
// need them. The audit reports; it never deletes anything itself.

import { readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const PROJECT_SKILL_DIRS = [".claude/skills", ".cursor/skills", ".agents/skills", ".codex/skills", ".gemini/skills"];
const GLOBAL_SKILL_DIRS = [".claude/skills", ".cursor/skills", ".agents/skills", ".codex/skills", ".gemini/skills"];

function listSkillDirs(root) {
  const found = [];
  for (const rel of PROJECT_SKILL_DIRS) {
    const dir = join(root, rel);
    if (!existsSync(dir)) continue;
    let entries = [];
    try {
      entries = readdirSync(dir).filter((e) => {
        try {
          return statSync(join(dir, e)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }
    for (const e of entries) found.push({ name: e, path: join(dir, e), host: rel.split("/")[0] });
  }
  return found;
}

// Map an installed directory name to a catalog item id when recognizable.
function matchCatalog(name, itemById, itemByName) {
  const norm = name.toLowerCase().replace(/_/g, "-");
  if (itemById.has(norm)) return norm;
  if (itemByName.has(norm)) return itemByName.get(norm);
  return null;
}

export function scanInstalls({ projectDir = process.cwd() } = {}) {
  const project = listSkillDirs(projectDir).map((d) => ({ ...d, scope: "project" }));
  const home = homedir();
  const global = [];
  if (home && home !== projectDir) {
    for (const d of listSkillDirs(home)) global.push({ ...d, scope: "global" });
  }
  return { project, global };
}

export function auditInstalls({ catalog, graph, projectDir } = {}) {
  const { project, global } = scanInstalls({ projectDir });
  const itemById = new Map(catalog.items.map((i) => [i.id, i]));
  const itemByName = new Map(catalog.items.map((i) => [i.name.toLowerCase().replace(/_/g, "-"), i.id]));

  const annotate = (entries) =>
    entries.map((e) => ({ ...e, catalogId: matchCatalog(basename(e.path), itemById, itemByName) }));
  const projectItems = annotate(project);
  const globalItems = annotate(global);
  const all = [...projectItems, ...globalItems].filter((e) => e.catalogId);

  const graphConflicts = new Set();
  for (const e of graph?.byType.get("conflicts_with") ?? []) {
    graphConflicts.add(`${e.from.slice(5)}|${e.to.slice(5)}`);
    graphConflicts.add(`${e.to.slice(5)}|${e.from.slice(5)}`);
  }

  const conflicts = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      const ia = itemById.get(a.catalogId);
      const ib = itemById.get(b.catalogId);
      const catalogConflict = (ia.conflicts ?? []).includes(b.catalogId) || (ib.conflicts ?? []).includes(a.catalogId);
      const graphConflict = graphConflicts.has(`${a.catalogId}|${b.catalogId}`);
      if (!catalogConflict && !graphConflict) continue;
      const involvesGlobal = a.scope === "global" || b.scope === "global";
      conflicts.push({
        a: { id: a.catalogId, scope: a.scope, path: a.path },
        b: { id: b.catalogId, scope: b.scope, path: b.path },
        source: catalogConflict && graphConflict ? "catalog+graph" : catalogConflict ? "catalog" : "graph",
        // Project-scoped pairs get a removal suggestion; anything touching a
        // global install is report-only. The tool never deletes.
        action: involvesGlobal ? "report-only" : "suggest-removal",
        note: involvesGlobal
          ? "one side is a global install — left alone; resolve per project if it hurts"
          : "both are project-scoped — removing one is safe to suggest",
      });
    }
  }

  const unknown = [...projectItems, ...globalItems].filter((e) => !e.catalogId);

  return {
    project: projectItems,
    global: globalItems,
    conflicts,
    unknown,
    summary: {
      projectCount: projectItems.length,
      globalCount: globalItems.length,
      conflictCount: conflicts.length,
      removable: conflicts.filter((c) => c.action === "suggest-removal").length,
    },
  };
}
