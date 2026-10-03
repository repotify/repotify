#!/usr/bin/env node
// How well the skill router points requests at installed skills. Each set is a list of requests with the skills that
// should handle each (none for small commands and questions), run against 20 skills with their real descriptions and
// catalog jobs (a typical Repotify install). The router may name up to three skills for a request.
//   hit: one of the expected skills is named.   first: the first skill named is an expected one.
//   quiet: nothing is named for a request no skill should handle.   precision: named skills that were expected.
// Sets: router-prompts*.json were written while building the router and were tuned on (they guard against
// regressions). router-independent*.json were written by another model that saw only the skills' descriptions
// (pipeline/router-evalset.mjs); the second was measured once, after the last change to the router, and is the
// number the docs quote.
// Usage: node test/eval/router.mjs [--verbose] [file ...]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { route } from "../../src/router.mjs";

const read = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));

export function routerEval({ skills = read("./router-skills.json"), prompts = read("./router-prompts.json") } = {}) {
  const rows = prompts.map((p) => {
    const named = route(p.prompt, skills).map((m) => m.id);
    return { ...p, named, hit: named.some((id) => p.expect.includes(id)), first: p.expect.includes(named[0]), noise: named.filter((id) => !p.expect.includes(id)).length };
  });
  const work = rows.filter((r) => r.expect.length);
  const idle = rows.filter((r) => !r.expect.length);
  const share = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);
  const named = rows.reduce((n, r) => n + r.named.length, 0);
  return {
    requests: rows.length,
    work: work.length,
    idle: idle.length,
    hit: share(work.filter((r) => r.hit).length, work.length),
    first: share(work.filter((r) => r.first).length, work.length),
    quiet: share(idle.filter((r) => !r.named.length).length, idle.length),
    precision: share(named - rows.reduce((n, r) => n + r.noise, 0), named),
    namedPerRequest: share(named, rows.length),
    rows,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith("--"));
  const sets = files.length ? files : ["router-prompts.json", "router-prompts-2.json", "router-prompts-3.json", "router-independent.json", "router-independent-2.json"];
  const pct = (x) => (x == null ? "-" : `${(x * 100).toFixed(1)}%`);
  for (const file of sets) {
    const doc = read(file.includes("/") ? new URL(file, `file://${process.cwd()}/`) : `./${file}`);
    const r = routerEval({ prompts: Array.isArray(doc) ? doc : doc.requests });
    if (args.includes("--verbose")) {
      for (const row of r.rows) console.log(`${row.expect.length ? (row.hit ? "hit " : "MISS") : row.named.length ? "LOUD" : "quiet"}  ${row.prompt}\n      named: ${row.named.join(", ") || "-"}${row.expect.length ? `   expected: ${row.expect.join(" | ")}` : ""}`);
    }
    console.log(`${file}: ${r.requests} requests (${r.work} for a skill, ${r.idle} for none)  hit ${pct(r.hit)}  first named is right ${pct(r.first)}  quiet when none fits ${pct(r.quiet)}  named skills that were expected ${pct(r.precision)}  named per request ${r.namedPerRequest}`);
  }
}
