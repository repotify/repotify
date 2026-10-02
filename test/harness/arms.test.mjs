// Unit tests for test/harness/arms.mjs — no network (jev arm not exercised here).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, loadCatalog, resolveArmSet, recommendFor, seededRng, hashStr, skillCard } from "./arms.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const catalog = loadCatalog((f) => JSON.parse(readFileSync(join(here, "..", "..", "catalog", f), "utf8")));
const scenario = JSON.parse(readFileSync(join(here, "scenarios", "js-frontend.json"), "utf8"));

describe("arms", () => {
  it("registry has the required arms", () => {
    for (const a of ["repotify", "v1-baseline", "none", "naive", "oracle", "placebo"]) assert.ok(ARMS.includes(a), a);
  });

  it("none arm returns an empty set", async () => {
    const s = await resolveArmSet({ arm: "none", catalog, scenario });
    assert.deepEqual(s.ids, []);
  });

  it("repotify arm returns catalog ids from the real v2 pipeline", async () => {
    const s = await resolveArmSet({ arm: "repotify", catalog, scenario });
    assert.ok(s.ids.length > 0, "expected a non-empty default set");
    for (const id of s.ids) assert.ok(catalog.items.some((i) => i.id === id), `unknown id ${id}`);
    assert.ok(["v2-recommendV1", "v2-reject"].includes(s.source), `unexpected source ${s.source}`);
  });

  it("v1-baseline arm runs the frozen v1 engine", async () => {
    const s = await resolveArmSet({ arm: "v1-baseline", catalog, scenario });
    assert.ok(s.ids.length > 0, "expected a non-empty default set");
    for (const id of s.ids) assert.ok(catalog.items.some((i) => i.id === id), `unknown id ${id}`);
    assert.equal(s.source, "v1-recommend-defaultSet");
  });

  it("naive arm is seeded: same scenario+rep => same set; different rep => usually different", async () => {
    const a = await resolveArmSet({ arm: "naive", catalog, scenario, repIndex: 0 });
    const b = await resolveArmSet({ arm: "naive", catalog, scenario, repIndex: 0 });
    const c = await resolveArmSet({ arm: "naive", catalog, scenario, repIndex: 1 });
    assert.deepEqual(a.ids, b.ids);
    assert.notDeepEqual(a.ids, c.ids);
    assert.equal(a.source, "seeded-random");
    const rep = await resolveArmSet({ arm: "repotify", catalog, scenario });
    assert.equal(a.ids.length, Math.min(rep.ids.length, catalog.items.length));
  });

  it("naive set contains only catalog ids, no duplicates", async () => {
    const s = await resolveArmSet({ arm: "naive", catalog, scenario, repIndex: 3 });
    assert.equal(new Set(s.ids).size, s.ids.length);
    for (const id of s.ids) assert.ok(catalog.items.some((i) => i.id === id));
  });

  it("seededRng and hashStr are deterministic", () => {
    const r1 = seededRng(42), r2 = seededRng(42);
    assert.equal(r1(), r2());
    assert.equal(hashStr("abc"), hashStr("abc"));
    assert.notEqual(hashStr("abc"), hashStr("abd"));
  });

  it("skillCard renders id + truncated summary", () => {
    const card = skillCard(catalog, "react-best-practices");
    assert.match(card, /^react-best-practices: /);
    assert.ok(card.length < 220);
    assert.match(skillCard(catalog, "no-such-id"), /not in catalog/);
  });

  it("recommendFor is deterministic across calls", () => {
    const a = recommendFor(catalog, scenario).defaultSet;
    const b = recommendFor(catalog, scenario).defaultSet;
    assert.deepEqual(a, b);
  });

  it("oracle arm offers exactly the must-include set (ceiling)", async () => {
    const scenario = JSON.parse(readFileSync(join(here, "scenarios", "python-api.json"), "utf8"));
    const s = await resolveArmSet({ arm: "oracle", catalog, scenario });
    assert.deepEqual(new Set(s.ids), new Set(scenario.mustInclude));
    assert.equal(s.source, "oracle-mustInclude");
  });

  it("placebo arm draws a seeded set distinct from naive's stream", async () => {
    const s = await resolveArmSet({ arm: "placebo", catalog, scenario, repIndex: 0 });
    const n = await resolveArmSet({ arm: "naive", catalog, scenario, repIndex: 0 });
    assert.ok(s.ids.length > 0);
    assert.notDeepEqual(s.ids, n.ids);
  });

  it("unknown arm throws", async () => {
    await assert.rejects(() => resolveArmSet({ arm: "bogus", catalog, scenario }), /unknown arm/);
  });
});
