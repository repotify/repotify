// Discovery: collect candidate repositories from several public sources.
// A failing source is recorded in `errors` and never stops the run.
import { fetchWithRetry } from "./lib/http.mjs";

const DAY = 86400000;
const NON_REPO_OWNERS = new Set(["topics", "sponsors", "orgs", "marketplace", "features", "apps", "settings", "collections", "about", "pricing", "login", "site", "enterprise", "search", "trending", "explore", "notifications", "users"]);

export const DEFAULTS = {
  awesomeLists: [
    "https://raw.githubusercontent.com/travisvn/awesome-claude-skills/main/README.md",
    "https://raw.githubusercontent.com/hesreallyhim/awesome-claude-code/main/README.md",
    "https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md",
  ],
  hnQueries: ["claude skills", "agent skills", "claude code skill", "mcp server", "cursor rules", "codex skills"],
  subreddits: ["ClaudeAI", "cursor", "ChatGPTCoding", "LocalLLaMA"],
  // Claude Code and Codex first; each search returns the 100 most-starred repositories of its topic.
  topics: ["claude-code", "codex", "claude-skills", "claude-code-skills", "codex-skills", "codex-cli", "agent-skills", "mcp-server"],
};

export function reposFromText(text) {
  const out = [];
  for (const m of String(text).matchAll(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)) {
    const owner = m[1].toLowerCase();
    const name = m[2].toLowerCase().replace(/\.git$/, "").replace(/[.]+$/, "");
    if (NON_REPO_OWNERS.has(owner) || !name) continue;
    const repo = `${owner}/${name}`;
    if (!out.includes(repo)) out.push(repo);
  }
  return out;
}

export const parseAwesomeList = reposFromText;

async function getJson(url, { fetchImpl, headers = {} }) {
  const res = await fetchWithRetry(url, { headers: { "User-Agent": "repotify-pipeline", ...headers } }, { fetchImpl, retries: 1, timeoutMs: 30000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
  return res.json();
}

export async function discoverHn({ fetchImpl = fetch, now = new Date(), queries = DEFAULTS.hnQueries } = {}) {
  const since = Math.floor((now - 30 * DAY) / 1000);
  const mentions = new Map();
  for (const q of queries) {
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=story&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}&hitsPerPage=100`;
    const doc = await getJson(url, { fetchImpl });
    for (const hit of doc.hits ?? []) {
      for (const repo of reposFromText([hit.url, hit.title, hit.story_text].filter(Boolean).join(" "))) {
        mentions.set(repo, (mentions.get(repo) ?? 0) + 1);
      }
    }
  }
  return [...mentions].map(([repo, n]) => ({ repo, sources: ["hn"], mentions30d: n, meta: null }));
}

async function discoverReddit({ fetchImpl, subreddits = DEFAULTS.subreddits }) {
  const mentions = new Map();
  for (const sub of subreddits) {
    const doc = await getJson(`https://www.reddit.com/r/${sub}/search.json?q=github.com&restrict_sr=1&sort=new&t=month&limit=100`, { fetchImpl });
    for (const child of doc.data?.children ?? []) {
      const d = child.data ?? {};
      for (const repo of reposFromText([d.url, d.title, d.selftext].filter(Boolean).join(" "))) mentions.set(repo, (mentions.get(repo) ?? 0) + 1);
    }
  }
  return [...mentions].map(([repo, n]) => ({ repo, sources: ["reddit"], mentions30d: n, meta: null }));
}

async function discoverAwesome({ fetchImpl, awesomeLists = DEFAULTS.awesomeLists }) {
  const repos = [];
  for (const url of awesomeLists) {
    const res = await fetchWithRetry(url, {}, { fetchImpl, retries: 1, timeoutMs: 30000 });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    for (const r of parseAwesomeList(await res.text())) if (!repos.includes(r)) repos.push(r);
  }
  return repos.map((repo) => ({ repo, sources: ["awesome"], mentions30d: 0, meta: null }));
}

function githubHeaders(token) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function requireToken(token) {
  if (!token) throw new Error("GITHUB_TOKEN required for GitHub API sources");
  return githubHeaders(token);
}

const repoMeta = (r) => ({ stars: r.stargazers_count ?? null, license: r.license?.spdx_id ?? null, pushedAt: r.pushed_at ?? null, createdAt: r.created_at ?? null, topics: Array.isArray(r.topics) ? r.topics : [] });

// Repository search also works without a token, at a lower rate limit. The most-starred repositories come first, so a
// small budget goes to the collections people actually use.
async function discoverGithubTopics({ fetchImpl, githubToken, topics = DEFAULTS.topics }) {
  const headers = githubHeaders(githubToken);
  const out = [];
  for (const topic of topics) {
    const doc = await getJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(`topic:${topic}`)}&sort=stars&order=desc&per_page=100`, { fetchImpl, headers });
    for (const r of doc.items ?? []) out.push({ repo: r.full_name.toLowerCase(), sources: ["github-topics"], mentions30d: 0, meta: repoMeta(r) });
  }
  return out;
}

async function discoverGithubCode({ fetchImpl, githubToken }) {
  const headers = requireToken(githubToken);
  const doc = await getJson(`https://api.github.com/search/code?q=${encodeURIComponent("filename:SKILL.md")}&per_page=100`, { fetchImpl, headers });
  const repos = [...new Set((doc.items ?? []).map((i) => i.repository?.full_name?.toLowerCase()).filter(Boolean))];
  return repos.map((repo) => ({ repo, sources: ["github-code"], mentions30d: 0, meta: null }));
}

async function discoverSubmissions({ fetchImpl, githubToken, submissionsRepo }) {
  if (!submissionsRepo) return [];
  const headers = githubToken ? requireToken(githubToken) : {};
  const issues = await getJson(`https://api.github.com/repos/${submissionsRepo}/issues?labels=submission&state=open&per_page=100`, { fetchImpl, headers });
  const repos = [...new Set(issues.flatMap((i) => reposFromText(`${i.title ?? ""} ${i.body ?? ""}`)))];
  return repos.map((repo) => ({ repo, sources: ["submissions"], mentions30d: 0, meta: null }));
}

const SOURCES = {
  awesome: discoverAwesome,
  hn: (o) => discoverHn({ fetchImpl: o.fetchImpl, now: o.now, queries: o.hnQueries ?? DEFAULTS.hnQueries }),
  reddit: discoverReddit,
  "github-topics": discoverGithubTopics,
  "github-code": discoverGithubCode,
  submissions: discoverSubmissions,
};

export async function discover(opts = {}) {
  const { sources = Object.keys(SOURCES), fetchImpl = fetch, now = new Date() } = opts;
  const merged = new Map();
  const errors = [];
  for (const source of sources) {
    const fn = SOURCES[source];
    if (!fn) {
      errors.push({ source, message: "unknown source" });
      continue;
    }
    try {
      for (const c of await fn({ ...opts, fetchImpl, now })) {
        const prev = merged.get(c.repo);
        if (!prev) merged.set(c.repo, { ...c, sources: [...c.sources] });
        else {
          for (const s of c.sources) if (!prev.sources.includes(s)) prev.sources.push(s);
          prev.mentions30d += c.mentions30d;
          prev.meta = prev.meta ?? c.meta;
        }
      }
    } catch (error) {
      errors.push({ source, message: error.message });
    }
  }
  return { candidates: [...merged.values()], errors };
}
