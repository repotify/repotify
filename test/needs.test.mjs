import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { questionBank, resolveNeeds, formatQuestions, inferProjectType } from "../src/needs.mjs";
import { fingerprint } from "../src/fingerprint.mjs";

const taxonomy = JSON.parse(readFileSync(new URL("../catalog/taxonomy.json", import.meta.url), "utf8"));
const projects = fileURLToPath(new URL("./fixtures/projects/", import.meta.url));

test("an empty project gets all three questions", async () => {
  const fp = await fingerprint(join(projects, "empty"));
  const qs = questionBank(taxonomy, fp);
  assert.deepEqual(qs.map((q) => q.id), ["projectType", "priorities", "needs"]);
  assert.ok(qs.find((q) => q.id === "needs").options.length <= 8);
  assert.equal(qs.find((q) => q.id === "projectType").multi, false);
  assert.equal(qs.find((q) => q.id === "needs").multi, true);
});

test("a Next.js project is not asked what it is, and inferred needs are not offered again", async () => {
  const fp = await fingerprint(join(projects, "nextjs-saas"));
  assert.equal(inferProjectType(fp), "web-app");
  const qs = questionBank(taxonomy, fp);
  assert.ok(!qs.some((q) => q.id === "projectType"));
  const needOptions = qs.find((q) => q.id === "needs").options.map((o) => o.id);
  for (const n of fp.inferredNeeds) assert.ok(!needOptions.includes(n), n);
});

test("project types are inferred from stacks and needs", async () => {
  assert.equal(inferProjectType(await fingerprint(join(projects, "fastapi-llm"))), "api");
  assert.equal(inferProjectType(await fingerprint(join(projects, "flutter-app"))), "mobile");
  assert.equal(inferProjectType(await fingerprint(join(projects, "news-site"))), "content-site");
  assert.equal(inferProjectType(await fingerprint(join(projects, "go-cli"))), "cli");
  assert.equal(inferProjectType(await fingerprint(join(projects, "solidity-dapp"))), "smart-contracts");
  assert.equal(inferProjectType(await fingerprint(join(projects, "empty"))), null);
});

test("resolveNeeds merges fingerprint, answers and project-type defaults, dropping unknown codes", async () => {
  const fp = await fingerprint(join(projects, "empty"));
  const r = resolveNeeds({ fingerprint: fp, answers: { projectType: "content-site", needs: ["pdf", "foo"], priorities: ["security", "nope"] }, taxonomy });
  assert.equal(r.projectType, "content-site");
  for (const n of ["seo", "scraping", "llm-calls", "pdf", "security"]) assert.ok(r.needs.includes(n), n);
  assert.ok(!r.needs.includes("foo"));
  assert.deepEqual(r.priorities, ["security"]);
  assert.deepEqual(r.needs, [...r.needs].sort());
});

test("an unknown project type answer falls back to the inferred one", async () => {
  const fp = await fingerprint(join(projects, "nextjs-saas"));
  assert.equal(resolveNeeds({ fingerprint: fp, answers: { projectType: "spaceship" }, taxonomy }).projectType, "web-app");
});

test("formatQuestions renders numbered plain text", async () => {
  const text = formatQuestions(questionBank(taxonomy, await fingerprint(join(projects, "empty"))));
  assert.match(text, /^1\. /);
  assert.match(text, /\n2\. /);
  assert.match(text, /\(pick several\)/);
});
