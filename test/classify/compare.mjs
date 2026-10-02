#!/usr/bin/env node
// Classifier benchmark: Jev's typed answers vs the jury's labels, both against
// hand labels (test/classify/labels.json). Needs JEV_API_KEY; costs a few cents.
//   node test/classify/compare.mjs [--cache DIR] [--verbose]
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { classifyItem, skillText, capabilityOptions, stackOptions, mapLimit, NEW_CAPABILITIES } from "../../pipeline/jev-classify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const labels = json(join(here, "labels.json"));
// Item text and pins come from the catalog (or the removed-items file); the jury's labels come from the
// snapshot taken before Jev relabelled the catalog, so the jury is scored on what it actually said.
const juryLabels = json(join(here, "jury-labels.json")).items;
const pool = [...json(join(root, "catalog", "items.json")), ...json(join(here, "removed-items.json")).items].map((i) => ({ ...i, ...(juryLabels[i.id] ?? {}) }));
const taxonomy = json(join(root, "catalog", "taxonomy.json"));
const capabilities = capabilityOptions(taxonomy, labels.extraCapabilities);
const stacks = stackOptions(taxonomy);
const argv = process.argv.slice(2);
const cacheDir = argv.includes("--cache") ? argv[argv.indexOf("--cache") + 1] : join(homedir(), ".cache", "repotify-classify");
const verbose = argv.includes("--verbose");

const rows = await mapLimit(labels.items, 4, async (l) => {
  const item = pool.find((i) => i.id === l.id);
  if (!item) return { l, missing: true };
  const text = await skillText(item, { cacheDir });
  const jev = await classifyItem(item, { capabilities, stacks, text, cacheDir });
  return { l, item, jev, hadText: Boolean(text) };
});

const tally = () => ({ right: 0, of: 0 });
const t = { jevCoding: tally(), juryCoding: tally(), jevJob: tally(), juryJob: tally(), jevJobOld: tally(), juryJobOld: tally(), jevLife: tally(), jevBound: tally(), jevStack: tally(), juryStack: tally() };
const oldCaps = new Set(Object.keys(taxonomy.capabilities).filter((c) => !(c in NEW_CAPABILITIES) && !(c in labels.extraCapabilities)));
const score = (k, ok) => { t[k].of++; if (ok) t[k].right++; };
let failed = 0;
const lines = [];
for (const { l, item, jev, missing, hadText } of rows) {
  if (missing) { lines.push(`  missing   ${l.id}`); continue; }
  if (!jev) { failed++; lines.push(`  no answer ${l.id}`); continue; }
  const juryJob = item.capabilities?.[0] ?? "none";
  if (l.coding !== null) { score("jevCoding", jev.coding.value === l.coding); score("juryCoding", l.coding === true); }
  if (l.job) {
    score("jevJob", l.job.includes(jev.job.option));
    score("juryJob", l.job.includes(juryJob));
    if (l.job.some((j) => oldCaps.has(j))) { score("jevJobOld", l.job.includes(jev.job.option)); score("juryJobOld", l.job.includes(juryJob)); }
  }
  if (l.lifecycle) score("jevLife", jev.lifecycle.option === l.lifecycle);
  if (l.stack) {
    score("jevStack", l.stack.includes(jev.stack.option));
    const juryStacks = (item.stacks ?? ["*"]).map((x) => (x === "*" ? "any" : x));
    // The jury is right when its list is exactly one acceptable answer (or "any" alone when any is right).
    score("juryStack", juryStacks.length === 1 ? l.stack.includes(juryStacks[0]) : juryStacks.every((x) => l.stack.includes(x)));
  }
  score("jevBound", jev.productBound.value === l.productBound);
  const mark = (ok) => (ok ? " " : "✗");
  lines.push(`${mark(!l.job || l.job.includes(jev.job.option))}${mark(l.coding === null || jev.coding.value === l.coding)}${mark(!l.lifecycle || jev.lifecycle.option === l.lifecycle)} ${l.id.padEnd(44)} job ${jev.job.option} (${(jev.job.probability ?? 0).toFixed(2)}) want ${l.job?.join("|") ?? "-"} · jury ${juryJob} · coding ${jev.coding.probability.toFixed(2)} · ${jev.lifecycle.option} (${(jev.lifecycle.probability ?? 0).toFixed(2)}) · stack ${jev.stack.option} (${(jev.stack.probability ?? 0).toFixed(2)}) want ${l.stack?.join("|") ?? "-"} jury ${(item.stacks ?? []).join(",")}${hadText ? "" : " · summary only"}`);
}
const pct = ({ right, of }) => `${right}/${of} (${of ? Math.round((100 * right) / of) : 0}%)`;
console.log(`items ${labels.items.length}, no answer ${failed}`);
console.log(`coding gate      Jev ${pct(t.jevCoding)}   jury ${pct(t.juryCoding)}`);
console.log(`main job         Jev ${pct(t.jevJob)}   jury ${pct(t.juryJob)}`);
console.log(`  old taxonomy   Jev ${pct(t.jevJobOld)}   jury ${pct(t.juryJobOld)}   (labels the jury could have given)`);
console.log(`lifecycle        Jev ${pct(t.jevLife)}   (the jury has no such label)`);
console.log(`product-bound    Jev ${pct(t.jevBound)}`);
console.log(`stack            Jev ${pct(t.jevStack)}   jury ${pct(t.juryStack)}`);
if (verbose) console.log(lines.join("\n"));
