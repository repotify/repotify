// A small GitHub REST client for the crawler: search with paging, repository metadata, and the rate limits GitHub
// sets (5,000 core requests an hour with a token, 30 searches and 10 code searches a minute). It waits instead of
// failing when a limit is reached, so a long crawl keeps going.
import { withDeadline } from "./lib/http.mjs";

const API = "https://api.github.com";
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimum spacing between requests of each kind, below GitHub's per-minute limits.
const SPACING_MS = { search: 2100, code: 6500, core: 0 };

export function githubClient({ token = null, fetchImpl = fetch, sleep = defaultSleep, now = () => Date.now(), log = () => {}, timeoutMs = 60000 } = {}) {
  const last = { search: 0, code: 0, core: 0 };
  async function request(path, { kind = "core", attempts = 6, body = null } = {}) {
    const url = path.startsWith("http") ? path : `${API}${path}`;
    for (let attempt = 1; ; attempt++) {
      const wait = last[kind] + SPACING_MS[kind] - now();
      if (wait > 0) await sleep(wait);
      last[kind] = now();
      let res;
      let doc = null;
      try {
        res = await fetchImpl(url, {
          method: body ? "POST" : "GET",
          headers: {
            Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "repotify-crawler",
            ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Reading the body is part of the request and fails like one. A response left unread for seconds (the crawl
        // was busy storing a large repository) gets cut off. Read plain, the body is then half a document. Compressed,
        // as GitHub sends it, the read neither ends nor fails, the abort signal above no longer reaches it, and with
        // the socket gone nothing keeps the process alive: Node exits quietly with "unsettled top-level await".
        // Measured against the tree API (Node 24): on an idle loop 48 requests of 48 settle; with the loop blocked for
        // 2 to 18 s at a time, 13 of 75 never did.
        // Hence a deadline that holds the process, and another attempt.
        if (res.ok) doc = await withDeadline(res.json(), timeoutMs, `the response body of ${url.replace(API, "")}`);
      } catch (error) {
        if (attempt >= attempts) throw error;
        await sleep(2000 * attempt);
        continue;
      }
      if (res.ok) return doc;
      if (res.status === 404 || res.status === 451 || res.status === 422) return null;
      const remaining = Number(res.headers.get("x-ratelimit-remaining"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const retryAfter = Number(res.headers.get("retry-after"));
      if ((res.status === 403 || res.status === 429) && attempt < attempts) {
        // Primary limit: wait for the reset. Secondary limit: Retry-After, or a minute.
        const ms = remaining === 0 && reset > 0 ? Math.max(1000, reset * 1000 - now() + 1000) : (retryAfter > 0 ? retryAfter * 1000 : 60000);
        log(`github: ${res.status} on ${kind}, waiting ${Math.round(ms / 1000)} s`);
        await sleep(ms);
        continue;
      }
      if (res.status >= 500 && attempt < attempts) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new Error(`GitHub ${res.status} for ${url.replace(API, "")}`);
    }
  }

  return {
    request,
    // Every result of a search, page by page (GitHub returns at most 1,000 per query).
    async search(type, q, { sort, order = "desc", maxPages = 10 } = {}) {
      const items = [];
      let total = null;
      for (let page = 1; page <= maxPages; page++) {
        const params = new URLSearchParams({ q, per_page: "100", page: String(page), ...(sort ? { sort, order } : {}) });
        const doc = await request(`/search/${type}?${params}`, { kind: type === "code" ? "code" : "search" });
        if (!doc) break;
        total ??= doc.total_count;
        items.push(...(doc.items ?? []));
        if ((doc.items ?? []).length < 100 || items.length >= Math.min(total ?? Infinity, 1000)) break;
      }
      return { items, total: total ?? 0 };
    },
    repo: (fullName) => request(`/repos/${fullName}`),
    // Every entry of a commit's tree with git ids and sizes; `truncated` past 100,000 entries.
    tree: (fullName, sha) => request(`/repos/${fullName}/git/trees/${sha}?recursive=1`),
    // GraphQL needs a token; a failed query returns its errors, which callers treat as missing data.
    graphql: (query) => request("/graphql", { body: { query } }),
  };
}

// The metadata the lab keeps for a repository, from a search result or GET /repos.
export function repoMeta(r) {
  return {
    repo: String(r.full_name).toLowerCase(),
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null,
    topics: Array.isArray(r.topics) ? r.topics : [],
    description: typeof r.description === "string" ? r.description.slice(0, 300) : "",
    defaultBranch: r.default_branch ?? null,
    pushedAt: r.pushed_at ?? null,
    createdAt: r.created_at ?? null,
    archived: Boolean(r.archived),
    fork: Boolean(r.fork),
    size: r.size ?? null,
  };
}
