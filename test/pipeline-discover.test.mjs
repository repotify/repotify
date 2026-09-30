import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAwesomeList, reposFromText, discoverHn, discover } from "../pipeline/discover.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NOW = new Date("2026-09-28T00:00:00Z");

test("reposFromText normalizes GitHub links and ignores non-repo pages", () => {
  const text = [
    "https://github.com/Obra/Superpowers/tree/main/skills",
    "(https://github.com/anthropics/skills)",
    "https://github.com/topics/claude-skills",
    "https://github.com/sponsors/someone",
    "https://github.com/trailofbits/skills.git",
    "https://github.com/anthropics/skills#readme",
  ].join("\n");
  assert.deepEqual(reposFromText(text), ["obra/superpowers", "anthropics/skills", "trailofbits/skills"]);
});

test("parseAwesomeList returns unique repos from a markdown list", () => {
  const md = "# Awesome\n- [A](https://github.com/a/one) - x\n- [B](https://github.com/b/two/blob/main/SKILL.md)\n- [A again](https://github.com/a/one)\n";
  assert.deepEqual(parseAwesomeList(md), ["a/one", "b/two"]);
});

test("discoverHn counts recent GitHub mentions", async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /^https:\/\/hn\.algolia\.com\/api\/v1\/search_by_date\?/);
    assert.match(url, /numericFilters=created_at_i%3E\d+/);
    return json({ hits: [
      { url: "https://github.com/x/skill-pack", points: 40, title: "Skill pack" },
      { url: "https://github.com/x/skill-pack/tree/main", points: 5, title: "again" },
      { url: "https://example.com/blog", points: 100, story_text: "see https://github.com/y/mcp-thing" },
    ] });
  };
  const found = await discoverHn({ fetchImpl, now: NOW, queries: ["claude skills"] });
  const byRepo = Object.fromEntries(found.map((c) => [c.repo, c]));
  assert.equal(byRepo["x/skill-pack"].mentions30d, 2);
  assert.equal(byRepo["y/mcp-thing"].mentions30d, 1);
  assert.deepEqual(byRepo["x/skill-pack"].sources, ["hn"]);
});

test("discover merges sources, dedupes and never lets one failing source stop the run", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("raw.githubusercontent.com")) return new Response("- https://github.com/a/one\n- https://github.com/x/skill-pack", { status: 200 });
    if (url.includes("hn.algolia.com")) return json({ hits: [{ url: "https://github.com/x/skill-pack", points: 3 }] });
    if (url.includes("reddit.com")) return new Response("blocked", { status: 403 });
    throw new Error("unexpected " + url);
  };
  const r = await discover({
    sources: ["awesome", "hn", "reddit", "github-topics"],
    fetchImpl, now: NOW,
    awesomeLists: ["https://raw.githubusercontent.com/some/awesome-list/main/README.md"],
    hnQueries: ["claude skills"], subreddits: ["ClaudeAI"],
  });
  const repos = r.candidates.map((c) => c.repo).sort();
  assert.deepEqual(repos, ["a/one", "x/skill-pack"]);
  assert.deepEqual(r.candidates.find((c) => c.repo === "x/skill-pack").sources.sort(), ["awesome", "hn"]);
  assert.ok(r.errors.some((e) => e.source === "reddit" && /403/.test(e.message)));
  assert.ok(r.errors.some((e) => e.source === "github-topics"), "a failing topic search is reported, not fatal");
});

test("github topic search works without a token and asks for the most-starred repositories", async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Authorization, undefined);
    assert.match(url, /sort=stars&order=desc/);
    return json({ items: [{ full_name: "Big/Collection", stargazers_count: 11000, license: { spdx_id: "MIT" } }] });
  };
  const r = await discover({ sources: ["github-topics"], fetchImpl, now: NOW, topics: ["claude-skills"] });
  assert.deepEqual(r.candidates.map((c) => [c.repo, c.meta.stars]), [["big/collection", 11000]]);
  assert.deepEqual(r.errors, []);
});

test("github topic search uses the token and reads stars and dates", async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Authorization, "Bearer gh-token");
    assert.match(url, /^https:\/\/api\.github\.com\/search\/repositories\?q=topic%3A/);
    return json({ items: [{ full_name: "Org/Repo", stargazers_count: 120, pushed_at: "2026-09-20T00:00:00Z", created_at: "2026-01-01T00:00:00Z", license: { spdx_id: "MIT" } }] });
  };
  const r = await discover({ sources: ["github-topics"], fetchImpl, now: NOW, githubToken: "gh-token", topics: ["claude-skills"] });
  assert.deepEqual(r.candidates.map((c) => [c.repo, c.meta.stars, c.meta.license]), [["org/repo", 120, "MIT"]]);
});
