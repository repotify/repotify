// Unit tests for test/harness/content.mjs — cache hit + dossier fallback, no network.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { fetchSkillContent, catalogDossier, MAX_CONTENT_CHARS } from "./content.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const catalog = { items: JSON.parse(readFileSync(join(here, "..", "..", "catalog", "items.json"), "utf8")) };
let CACHE;

before(() => {
  CACHE = mkdtempSync(join(tmpdir(), "harness-content-"));
});

describe("content", () => {
  it("serves a cached SKILL.md without network", async () => {
    const item = catalog.items.find((i) => i.id === "react-best-practices");
    const key = `react-best-practices@${(item.commit ?? "nocmt").slice(0, 12)}.md`.replace(/[^a-zA-Z0-9@._-]/g, "_");
    writeFileSync(join(CACHE, key), "# react-best-practices\ncached body");
    const c = await fetchSkillContent(catalog, "react-best-practices", CACHE);
    assert.equal(c.source, "cache");
    assert.match(c.text, /cached body/);
    assert.equal(c.truncated, false);
  });

  it("falls back to the catalog dossier when there is no repo/path", async () => {
    const c = await fetchSkillContent(catalog, "context7", CACHE);
    assert.equal(c.source, "catalog-dossier");
    assert.match(c.text, /context7/);
  });

  it("returns a missing marker for unknown ids", async () => {
    const c = await fetchSkillContent(catalog, "no-such-skill", CACHE);
    assert.equal(c.source, "missing");
  });

  it("catalogDossier includes summary, stacks, capabilities", () => {
    const item = catalog.items.find((i) => i.id === "fastapi-expert");
    const d = catalogDossier(item);
    assert.match(d, /fastapi-expert/);
    assert.ok(d.length > 20);
  });

  it("MAX_CONTENT_CHARS bounds github content", () => {
    assert.ok(MAX_CONTENT_CHARS >= 1000 && MAX_CONTENT_CHARS <= 8000);
  });
});
