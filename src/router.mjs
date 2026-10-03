#!/usr/bin/env node
// Repotify skill router. Standalone on purpose: this file is copied into projects as a Claude Code UserPromptSubmit
// hook, so it may only import Node built-ins.
// An agent with twenty skills installed often forgets the one that fits. Before each request this hook reads the
// installed skills' names and descriptions, works out what kind of work the request is, finds the few skills made for
// it, and tells the agent to decide about exactly those. No match, no output: most requests pass untouched. Nothing
// leaves the computer, and only skill names (letters, digits, dashes) are ever written into the agent's context,
// never a skill's own text.

import { pathToFileURL } from "node:url";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const MAX_SKILLS = 200;
export const MAX_SUGGESTIONS = 3;
const MAX_HEAD_BYTES = 4096;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Words that say nothing about which skill fits: grammar, everyday verbs, and what nearly every skill description says.
const STOP = new Set(`a an and are as at be been but by can could did do does for from had has have how i if in into is it its
me my no not of on or our out so than that the their them then there these they this to too up us was we were what when
where which who why will with would you your also any all just more most other some such only own same very about after
again before being between both during each few further here once over under until while
use used uses using user users agent agents skill skills code project projects file files task tasks work working works
make makes making need needs want wants help helps please let lets get gets like new add adds create creates run runs
should must may might one two way thing things via etc claude repotify
write writes writing written fix fixes check checks find finds look looks show shows open start stop update updates
change changes changed remove delete move read set put take give tell try see go come think know sure good great thanks
thank now today first next last still already really maybe something anything everything nothing`.split(/\s+/));

// Suffixes dropped to bring word forms together (tests, testing, tested -> test), longest first.
const SUFFIXES = ["izations", "ization", "ibility", "ability", "ations", "ation", "ments", "izing", "ating", "ment", "ized", "izes", "ates", "ated", "ings", "ance", "ence", "able", "ible", "ions", "ity", "ies", "ing", "ize", "ise", "ate", "ant", "ent", "ion", "ers", "ed", "er", "es", "ly", "s"].sort((a, b) => b.length - a.length);
// Turkish case and plural endings, for requests that put them on English terms ("testleri", "commitler").
const TR_SUFFIXES = ["lerini", "larını", "lerine", "larına", "lerde", "larda", "leri", "ları", "ler", "lar", "ini", "ını", "unu", "ünü", "ine", "ına", "nde", "nda", "den", "dan", "yi", "yı", "yu", "yü"].sort((a, b) => b.length - a.length);
const MIN_STEM = 3;

export function stem(word) {
  let w = word;
  for (const s of SUFFIXES) {
    if (w.length - s.length >= MIN_STEM && w.endsWith(s)) {
      w = s === "ies" ? `${w.slice(0, -3)}y` : w.slice(0, -s.length);
      break;
    }
  }
  if (w.length > MIN_STEM && /([bdfgklmnprt])\1$/.test(w)) w = w.slice(0, -1);
  if (w.length > MIN_STEM && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

const tokens = (text) => String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export function words(text) {
  return tokens(text).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

// The stems a request word may stand for: its own, and the one under a Turkish ending.
export function variants(word) {
  const out = new Set([stem(word)]);
  for (const s of TR_SUFFIXES) {
    if (word.length - s.length >= 4 && word.endsWith(s)) {
      out.add(stem(word.slice(0, -s.length)));
      break;
    }
  }
  return out;
}

// Kinds of work. `words`, `starts` and `phrases` are how a request sounds when it is that kind of work, symptoms
// included ("crash", "slow"), in English and Turkish: a word matches in any of its forms, a start matches any word
// beginning with it (Turkish puts its endings there), a phrase matches as written. `have` is how a skill made for
// the work names itself. A request about a failing login reaches a debugging skill this way, though they share no word.
const KINDS = {
  debugging: { words: "bug error exception crash crashed broken fail failing failed failure throws traceback regression flaky hangs debug troubleshoot fix fixed", starts: "hata bozuk çalışmıyor çökü patl düzelt sorun", phrases: ["not working", "doesn t work", "does not work", "stack trace", "root cause"], have: "debug bug troubleshoot diagnos" },
  testing: { words: "test tested tdd coverage unittest pytest jest vitest", starts: "test", phrases: [], have: "test tdd" },
  browser: { words: "e2e playwright browser selenium cypress puppeteer screenshot", starts: "tarayıcı", phrases: ["end to end"], have: "playwright browser e2e webapp" },
  review: { words: "review reviewer critique", starts: "incele", phrases: ["pull request", "look over", "gözden geçir"], have: "review" },
  security: { words: "security secure insecure vulnerability vulnerable exploit injection xss csrf ssrf secret leak leaked cve pentest threat malicious sanitize", starts: "güvenli zafiyet", phrases: [], have: "secur vulnerab semgrep threat exploit" },
  planning: { words: "plan roadmap milestone breakdown", starts: "planla adımlar", phrases: ["break down", "step by step"], have: "plan" },
  ideas: { words: "brainstorm idea design feature approach proposal requirements", starts: "fikir tasarla özellik", phrases: [], have: "brainstorm ideat requirement" },
  verifying: { words: "done finished verify verified confirm ship shipped", starts: "bitti doğrula", phrases: ["make sure", "double check", "emin ol"], have: "verif complet" },
  refactoring: { words: "refactor cleanup simplify restructure dedupe duplicated tidy", starts: "temizle sadeleştir", phrases: ["clean up", "technical debt"], have: "refactor simplif cleanup" },
  performance: { words: "slow slower performance optimize latency profiling bottleneck faster speed", starts: "yavaş hızlan performans optimiz", phrases: [], have: "perform optim profil" },
  dependencies: { words: "dependency package library upgrade npm pip cargo lockfile outdated", starts: "bağımlılık paket kütüphane", phrases: ["supply chain"], have: "dependenc supply packag" },
  git: { words: "commit committed branch merge rebase squash git", starts: "commitle", phrases: ["pull request"], have: "git commit branch" },
  docs: { words: "readme docs documentation document changelog tutorial article blog prose wording", starts: "doküman belge makale", phrases: [], have: "doc document readme prose guidelin" },
  frontend: { words: "ui ux css layout styling component responsive tailwind animation landing theme design", starts: "arayüz tasarım", phrases: ["dark mode"], have: "frontend design interfac css component" },
  database: { words: "database db sql query schema migration postgres mysql sqlite mongodb orm prisma", starts: "veritaban sorgu", phrases: [], have: "databas sql schema postgres query" },
  delivery: { words: "deploy deployment ci cd pipeline docker kubernetes k8s release infra terraform hosting production", starts: "yayınla dağıt sunucu", phrases: [], have: "deploy devop docker kubernet infra terraform" },
  codebase: { words: "codebase architecture overview onboarding", starts: "mimari", phrases: ["how does", "where is", "walk me through", "nasıl çalışıyor"], have: "codebas graph architectur" },
  skills: { words: "skill", starts: "beceri", phrases: ["skill md"], have: "skill" },
  llm: { words: "prompt llm rag embedding eval evals hallucination", starts: "", phrases: [], have: "prompt llm rag eval embedding" },
  accessibility: { words: "accessibility accessible a11y aria wcag", starts: "erişilebilir", phrases: ["screen reader"], have: "accessib a11y wcag" },
  seo: { words: "seo sitemap", starts: "", phrases: ["search engine"], have: "seo" },
  translation: { words: "translate translation localization localize i18n locale multilingual", starts: "çevir yerelleştir", phrases: [], have: "i18n international translat" },
  documents: { words: "pdf docx xlsx pptx excel spreadsheet slides powerpoint", starts: "sunum", phrases: [], have: "pdf docx xlsx pptx spreadsheet slid present" },
  mobile: { words: "mobile android ios iphone apk emulator simulator flutter expo", starts: "mobil telefon", phrases: [], have: "mobil android ios flutter nativ" },
  payments: { words: "payment checkout stripe billing subscription invoice", starts: "ödeme fatura", phrases: [], have: "payment strip billing" },
  auth: { words: "login signin signup oauth auth authentication session password jwt sso", starts: "giriş şifre oturum", phrases: [], have: "auth oauth login" },
};

const list = (text) => text.split(/\s+/).filter(Boolean);
const KIND_RULES = Object.entries(KINDS).map(([id, k]) => ({ id, words: new Set(list(k.words).map(stem)), starts: list(k.starts), phrases: k.phrases, have: new Set(list(k.have)) }));
const KIND_BY_ID = new Map(KIND_RULES.map((k) => [k.id, k]));

// The kinds of work a request sounds like.
export function kindsOf(prompt) {
  const raw = tokens(prompt);
  const text = ` ${raw.join(" ")} `;
  const stems = new Set();
  for (const w of raw) for (const v of variants(w)) stems.add(v);
  const out = new Set();
  for (const k of KIND_RULES) {
    if ([...k.words].some((s) => stems.has(s)) || k.starts.some((p) => raw.some((w) => w.startsWith(p))) || k.phrases.some((p) => text.includes(` ${p} `))) out.add(k.id);
  }
  return out;
}

// name and description from a SKILL.md's frontmatter, without a YAML parser: the two plain `key: value` lines.
export function skillHead(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const field = (key) => {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(m[1]);
    if (!line) return "";
    let v = line[1].trim();
    if (/^[>|]/.test(v)) {
      // A folded or literal block: the indented lines that follow.
      const block = [];
      for (const l of m[1].slice(line.index + line[0].length).split(/\r?\n/).slice(1)) {
        if (/^\S/.test(l)) break;
        block.push(l.trim());
      }
      v = block.join(" ");
    }
    return v.replace(/^["']|["']$/g, "");
  };
  return { name: field("name"), description: field("description") };
}

// Installed skills: every folder with a SKILL.md under the project's and the user's skills folders.
export function installedSkills({ cwd, home = homedir() } = {}) {
  const out = new Map();
  for (const dir of [join(cwd, ".claude", "skills"), join(home, ".claude", "skills")]) {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.size >= MAX_SKILLS) break;
      if (!NAME_RE.test(e.name) || out.has(e.name)) continue;
      try {
        const file = join(dir, e.name, "SKILL.md");
        if (!statSync(file).isFile()) continue;
        out.set(e.name, { id: e.name, ...skillHead(readFileSync(file, "utf8").slice(0, MAX_HEAD_BYTES)) });
      } catch {
        // Not a skill folder, or unreadable: skipped.
      }
    }
  }
  return [...out.values()];
}

// What a skill is about: its own words (3 in its name, 1 in its description) and the kinds of work it is made for
// (3 when its name says so, 1.5 when only its description does).
function profile(skill) {
  const weights = new Map();
  for (const w of words(skill.description)) weights.set(stem(w), 1);
  for (const w of words(`${skill.id} ${skill.name ?? ""}`)) weights.set(stem(w), 3);
  // A name says what a skill is for even inside a longer word: "graphify" maps the codebase.
  const named = tokens(`${skill.id} ${skill.name ?? ""}`);
  const inName = (s) => named.some((w) => (s.length >= 4 ? w.startsWith(s) : stem(w) === s));
  const described = new Set(tokens(skill.description).map(stem));
  const kinds = new Map();
  for (const k of KIND_RULES) {
    if ([...k.have].some(inName)) kinds.set(k.id, 3);
    else if ([...k.have].some((s) => described.has(s))) kinds.set(k.id, 1.5);
  }
  return { weights, kinds };
}

// A suggestion needs the request to reach what the skill is named for, or two separate pieces of evidence from its
// description that weigh more together; one common word in a description proves nothing.
export const MIN_SCORE = 1.5;
export const MIN_UNNAMED_SCORE = 2.5;

// The installed skills that fit a request, best first: [{ id, score, why }]. A word or a kind of work that many
// installed skills share counts for less than one that few do.
export function route(prompt, skills, { max = MAX_SUGGESTIONS } = {}) {
  if (!skills.length) return [];
  const asked = new Set();
  for (const w of words(prompt)) for (const v of variants(w)) asked.add(v);
  const kinds = kindsOf(prompt);
  if (!asked.size && !kinds.size) return [];
  const profiles = skills.map((s) => ({ skill: s, ...profile(s) }));
  const rarity = (count) => Math.log(1 + skills.length / count) / Math.log(1 + skills.length);
  const wordCount = new Map();
  const kindCount = new Map();
  // A skill named for a kind of work holds it fully; one that only mentions it holds a quarter of it.
  for (const p of profiles) {
    for (const t of p.weights.keys()) wordCount.set(t, (wordCount.get(t) ?? 0) + 1);
    for (const [k, w] of p.kinds) kindCount.set(k, (kindCount.get(k) ?? 0) + (w === 3 ? 1 : 0.25));
  }
  const scored = [];
  for (const p of profiles) {
    let score = 0;
    let named = false;
    const why = [];
    // A word that already counted as a kind of work is not counted again as a word.
    const counted = new Set();
    for (const k of kinds) {
      const w = p.kinds.get(k);
      if (!w) continue;
      score += w * rarity(kindCount.get(k));
      named ||= w === 3;
      why.push(`kind:${k}`);
      const rule = KIND_BY_ID.get(k);
      for (const t of rule.words) counted.add(t);
      for (const t of rule.have) counted.add(t);
    }
    for (const t of asked) {
      const w = p.weights.get(t);
      if (!w || counted.has(t)) continue;
      score += w * rarity(wordCount.get(t));
      named ||= w === 3;
      why.push(t);
    }
    if (named ? score >= MIN_SCORE : why.length >= 2 && score >= MIN_UNNAMED_SCORE) scored.push({ id: p.skill.id, score: Math.round(score * 100) / 100, why: why.sort() });
  }
  return scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, max);
}

// What the agent is told: which skills to decide about, never to use one blindly.
export function advice(matches) {
  if (!matches.length) return "";
  const names = matches.map((m) => m.id).join(", ");
  return `Repotify router: this request may be work for ${matches.length === 1 ? "this installed skill" : "these installed skills"}: ${names}. Decide for each whether it applies; if one does, use it before you answer. If none applies, carry on without them.`;
}

export function runHook(input, { home = homedir() } = {}) {
  const prompt = String(input?.prompt ?? "");
  // Commands and one-word replies are not requests for work.
  if (!prompt.trim() || prompt.trimStart().startsWith("/") || tokens(prompt).length < 2) return null;
  const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const text = advice(route(prompt, installedSkills({ cwd, home })));
  return text ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } } : null;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    if (raw.length < 1_000_000) raw += d;
  });
  process.stdin.on("end", () => {
    try {
      const out = runHook(JSON.parse(raw || "{}"));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch {
      // A router that cannot read its input says nothing; it never blocks a request.
    }
  });
}
