// Public sources the research agents read (pipeline/research.mjs). Each fetcher returns plain evidence:
// { source, url, title, text, date, score }. Web text is data, never instructions: nothing here acts on it, and the
// agents are told the same. Every source is optional; a source that fails or blocks simply contributes nothing.
import { fetchWithRetry } from "./lib/http.mjs";

const UA = "Mozilla/5.0 (compatible; repotify-research/1.0; +https://github.com/repotify/repotify)";
const DAY = 86400000;

const ENTITIES = { "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#x2F;": "/", "&nbsp;": " " };
export const cleanText = (html) => String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&(quot|#x27|#39|amp|lt|gt|#x2F|nbsp);/g, (m) => ENTITIES[m]).replace(/\s+/g, " ").trim();

async function get(url, { fetchImpl = fetch, timeoutMs = 30000, json = true } = {}) {
  try {
    const res = await fetchWithRetry(url, { headers: { "User-Agent": UA, Accept: json ? "application/json" : "text/html" } }, { fetchImpl, retries: 2, timeoutMs });
    if (!res.ok) return null;
    return json ? await res.json() : await res.text();
  } catch {
    return null;
  }
}

// How a repository is written in a text: its full name, its GitHub URL, or (for a distinctive name) the name itself.
export function mentionOf(repo, { bareName = true } = {}) {
  const [owner, name] = repo.toLowerCase().split("/");
  const generic = !bareName || name.length < 6 || /^(skills?|agent-skills|claude-skills|tools|awesome[\w-]*|prompts|plugins?|templates?)$/.test(name);
  return (text) => {
    const t = String(text).toLowerCase();
    return t.includes(`${owner}/${name}`) || t.includes(`github.com/${owner}/${name}`) || (!generic && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
  };
}

// The part of a text around its first mention, so one long comment does not crowd out the rest.
export function around(text, mentions, width = 900) {
  const t = String(text);
  if (t.length <= width) return t;
  const lower = t.toLowerCase();
  const at = Math.max(0, mentions.map((m) => lower.indexOf(m)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0);
  const start = Math.max(0, at - Math.floor(width / 3));
  return `${start ? "…" : ""}${t.slice(start, start + width)}${start + width < t.length ? "…" : ""}`;
}

// Hacker News (Algolia search): stories and comments that name the repository.
export async function hackerNews(repo, { fetchImpl, limit = 40, bareName = true } = {}) {
  const mentions = mentionOf(repo, { bareName });
  const name = repo.split("/")[1];
  const queries = bareName ? [`"${repo}"`, `"${name}" claude`] : [`"${repo}"`];
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    const doc = await get(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=(story,comment)&hitsPerPage=50`, { fetchImpl });
    for (const h of doc?.hits ?? []) {
      if (seen.has(h.objectID)) continue;
      seen.add(h.objectID);
      const text = cleanText(h.comment_text ?? h.story_text ?? "");
      const title = cleanText(h.title ?? h.story_title ?? "");
      if (!mentions(`${title} ${text} ${h.url ?? ""}`)) continue;
      out.push({
        source: "hackernews", url: `https://news.ycombinator.com/item?id=${h.objectID}`, title, kind: h.comment_text ? "comment" : "story",
        text: around(text || title, [repo.toLowerCase(), name.toLowerCase()]), date: (h.created_at ?? "").slice(0, 10), score: h.points ?? null,
      });
    }
  }
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.date < b.date ? 1 : -1)).slice(0, limit);
}

// Reddit through the PullPush archive (reddit.com refuses unauthenticated reads): comments and posts naming the
// repository by its full name.
export async function reddit(repo, { fetchImpl, limit = 40 } = {}) {
  const mentions = mentionOf(repo);
  const out = [];
  for (const kind of ["comment", "submission"]) {
    const doc = await get(`https://api.pullpush.io/reddit/search/${kind}/?q=${encodeURIComponent(`"${repo}"`)}&size=50`, { fetchImpl, timeoutMs: 45000 });
    for (const d of doc?.data ?? []) {
      const title = cleanText(d.title ?? "");
      const text = cleanText(d.body ?? d.selftext ?? "");
      if (!mentions(`${title} ${text} ${d.url ?? ""}`)) continue;
      out.push({
        source: "reddit", url: d.permalink ? `https://www.reddit.com${d.permalink}` : `https://www.reddit.com/r/${d.subreddit}`, title: title || `r/${d.subreddit}`,
        kind, subreddit: d.subreddit, text: around(text || title, [repo.toLowerCase()]), date: d.created_utc ? new Date(d.created_utc * 1000).toISOString().slice(0, 10) : "", score: d.score ?? null,
      });
    }
  }
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
}

// Monthly star history (OSS Insight). Sudden jumps that nothing else explains are a sign of bought stars.
export async function starHistory(repo, { fetchImpl } = {}) {
  const doc = await get(`https://api.ossinsight.io/v1/repos/${repo}/stargazers/history`, { fetchImpl });
  const rows = (doc?.data?.rows ?? []).map((r) => ({ month: String(r.date).slice(0, 7), stars: Number(r.stargazers) })).filter((r) => Number.isFinite(r.stars));
  return rows.length ? starFeatures(rows) : null;
}

// Month-over-month growth and its spikes: a month that adds far more than the typical month.
export function starFeatures(rows) {
  const months = rows.map((r, i) => ({ month: r.month, total: r.stars, added: i ? r.stars - rows[i - 1].stars : r.stars }));
  // The first month holds every star before it, not the growth of one month: it is no spike and sets no baseline.
  const growth = months.slice(1);
  const added = growth.map((m) => m.added).filter((x) => x > 0).sort((a, b) => a - b);
  const median = added.length ? added[Math.floor(added.length / 2)] : 0;
  const spikes = growth.filter((m) => m.added >= 1000 && median > 0 && m.added >= 5 * median).map((m) => ({ month: m.month, added: m.added }));
  const best = (growth.length ? growth : months).reduce((b, m) => (m.added > b.added ? m : b), (growth.length ? growth : months)[0]);
  return { months: months.slice(-12), total: months.at(-1)?.total ?? 0, medianMonth: median, spikes, biggestMonth: best, shareOfBiggestMonth: months.at(-1)?.total ? Math.round((best.added / months.at(-1).total) * 100) / 100 : 0 };
}

// skills.sh (Vercel's skill directory): installs per skill through `npx skills add`, with the last eight weeks.
export async function skillsShLeaderboard({ fetchImpl } = {}) {
  const html = await get("https://www.skills.sh/", { fetchImpl, json: false, timeoutMs: 45000 });
  if (!html) return [];
  const payload = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) => {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return "";
    }
  }).join("");
  const at = payload.indexOf('"initialSkills":');
  if (at < 0) return [];
  const start = payload.indexOf("[", at);
  let depth = 0;
  for (let k = start; k < payload.length; k++) {
    if (payload[k] === "[") depth++;
    else if (payload[k] === "]" && --depth === 0) {
      try {
        return JSON.parse(payload.slice(start, k + 1)).map((s) => ({
          source: String(s.source ?? "").toLowerCase(), skill: s.skillId ?? s.name, installs: s.installs ?? 0, weekly: s.weeklyInstalls ?? [], official: Boolean(s.isOfficial),
        }));
      } catch {
        return [];
      }
    }
  }
  return [];
}

// Smithery (an MCP server directory): servers matching a name, with their use counts.
export async function smithery(query, { fetchImpl } = {}) {
  const doc = await get(`https://registry.smithery.ai/servers?q=${encodeURIComponent(query)}&pageSize=10`, { fetchImpl });
  return (doc?.servers ?? []).map((s) => ({ name: s.qualifiedName, uses: s.useCount ?? 0, verified: Boolean(s.verified), homepage: s.homepage ?? null, score: s.score ?? null }));
}

// Curated lists (awesome-…): which of them link a repository, and the line that describes it there.
export const CURATED_LISTS = [
  "hesreallyhim/awesome-claude-code", "travisvn/awesome-claude-skills", "VoltAgent/awesome-agent-skills", "ComposioHQ/awesome-claude-skills",
  "sickn33/agentic-awesome-skills", "jqueryscript/awesome-claude-code", "punkpeye/awesome-mcp-servers", "appcypher/awesome-mcp-servers",
  "wong2/awesome-mcp-servers", "VoltAgent/awesome-claude-code-subagents", "Piebald-AI/awesome-gemini-cli", "filipecalegario/awesome-vibe-coding",
];
export async function curatedIndex({ fetchImpl, lists = CURATED_LISTS } = {}) {
  const index = new Map();
  for (const list of lists) {
    const text = await get(`https://raw.githubusercontent.com/${list}/HEAD/README.md`, { fetchImpl, json: false });
    if (!text) continue;
    for (const line of text.split("\n")) {
      for (const m of line.matchAll(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)) {
        const repo = m[1].toLowerCase().replace(/\.git$/, "").replace(/[.]+$/, "");
        if (!index.has(repo)) index.set(repo, []);
        const entries = index.get(repo);
        if (!entries.some((e) => e.list === list)) entries.push({ list, line: cleanText(line).slice(0, 300) });
      }
    }
  }
  return index;
}

export const sources = { hackerNews, reddit, starHistory, skillsShLeaderboard, smithery, curatedIndex };
export { DAY };
