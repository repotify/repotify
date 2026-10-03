#!/usr/bin/env node
// Repotify skill router. Standalone on purpose: this file is copied into projects as a Claude Code UserPromptSubmit
// hook, so it may only import Node built-ins.
// An agent with twenty skills installed often forgets the one that fits. Before each request this hook reads the
// installed skills (their names and descriptions, and for skills Repotify installed the job the catalog gave them),
// works out what kind of work the request is, finds the few skills made for it, and tells the agent to decide about
// exactly those. No match, no output: most requests pass untouched. Nothing leaves the computer, and only skill
// names (letters, digits, dashes) are ever written into the agent's context, never a skill's own text.

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
const SUFFIXES = ["ization", "ibility", "ability", "ation", "izing", "ating", "izer", "iser", "ment", "ized", "ated", "ance", "ence", "able", "ible", "ity", "ing", "ize", "ise", "ate", "ant", "ent", "ion", "ed", "er", "ly"].sort((a, b) => b.length - a.length);
// Turkish case and plural endings, for requests that put them on English terms ("testleri", "commitler").
const TR_SUFFIXES = ["lerini", "larını", "lerine", "larına", "lerde", "larda", "leri", "ları", "ler", "lar", "ini", "ını", "unu", "ünü", "ine", "ına", "nde", "nda", "den", "dan", "yi", "yı", "yu", "yü"].sort((a, b) => b.length - a.length);
const MIN_STEM = 3;

export function stem(word) {
  let w = word;
  // Plurals first, so "invariants" and "invariant" lose the same ending afterwards.
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.length > MIN_STEM + 1 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  for (const s of SUFFIXES) {
    if (w.length - s.length >= MIN_STEM && w.endsWith(s)) {
      w = w.slice(0, -s.length);
      break;
    }
  }
  if (w.length > MIN_STEM && /([bdfgklmnprt])\1$/.test(w)) w = w.slice(0, -1);
  if (w.length > MIN_STEM && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

// "don't" is "do not": left as "don" and "t" it would read as "done".
const tokens = (text) => String(text ?? "").toLowerCase().replace(/n['’]t\b/g, " not").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
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

// Kinds of work. `words`, `starts`, `ends`, `codes` and `phrases` are how a request sounds when it is that kind of
// work, symptoms included ("crash", "slow", "404"), in English and Turkish: a word matches in any of its forms, a
// start matches any word beginning with it (Turkish puts its endings there), an end any word ending with it
// ("TypeError"), a phrase matches as written (its last word may go on). `not` phrases are taken out first ("error
// message" is not a bug).
// `have` is how a skill made for the work names itself, and `jobs` are the catalog jobs made for it: a request about
// a failing login reaches a debugging skill this way, though they share no word.
const KINDS = {
  debugging: {
    words: "bug error exception crash crashed broken fail failing failed failure throws traceback regression flaky hang hangs debug troubleshoot wrong incorrect unexpected undefined nan weird strange stuck freeze frozen timeout killed oom suddenly intermittent sporadic corrupt corrupted deadlock glitch segfault reproduce repro",
    starts: "hata bozuk bozul çalışmıyor çalışmadı çökü çöktü patl sorun yanlış beklenme neden niye takıl donuyor dondu rastgele",
    ends: "error exception mıyor miyor muyor müyor",
    codes: true,
    phrases: ["not working", "does not work", "does not respond", "not responding", "nothing happens", "stopped working", "no longer", "used to work", "now it does not", "worked yesterday", "worked last", "since yesterday", "ever since", "something is off", "something s wrong", "what s wrong", "what s happening", "why is", "why does", "why did", "why are", "fix the bug", "fix this bug", "fix it", "fix that", "loops forever", "spins forever", "just spins", "infinite loop", "keeps growing", "keep timing", "keeps timing", "times out", "timing out", "ran twice", "blank page", "blank screen", "white screen", "build is red", "build fails", "build failed", "build is broken", "ci is red", "stack trace", "root cause", "figure out what", "find out why", "issue with", "problem with", "trouble with", "out of memory", "race condition", "memory leak", "pass locally", "passes locally", "works on my machine", "only in production", "is down", "went down", "beyaz ekran", "boş sayfa", "sonsuz döngü", "çalışıyordu", "zaman aşımı", "bellek sızıntısı", "geçiyor ama"],
    not: ["error message", "error handling", "error rate", "yazım hata", "difference between", "arasındaki fark"],
    have: "debug bug troubleshoot diagnos", jobs: "debugging-method",
  },
  testing: { words: "test tested tdd coverage unittest pytest jest vitest mocha assert mock fixture", starts: "test", phrases: ["edge case", "unit test", "regression test", "uç durum"], have: "test tdd", jobs: "tdd-discipline property-testing webapp-testing" },
  testfirst: { words: "tdd", starts: "", phrases: ["test first", "tests first", "failing test first", "red green", "start with a test", "önce test"], have: "tdd", jobs: "tdd-discipline" },
  fuzzing: { words: "fuzz fuzzing invariant quickcheck hypothesis", starts: "değişmez", phrases: ["property test", "property based", "random inputs", "all inputs", "any input", "for every", "round trip", "round trips", "are inverse", "encode and decode", "serialize and deserialize", "rastgele girdi"], not: ["properties of"], have: "property fuzz", jobs: "property-testing" },
  browser: { words: "e2e playwright browser selenium cypress puppeteer headless localhost", starts: "tarayıcı", phrases: ["end to end test", "take a screenshot", "grab a screenshot", "capture a screenshot", "screenshot of", "signup flow", "login flow", "checkout flow", "user flow", "click through", "console error", "console log", "open the app", "dev server", "fill the form", "submit the form", "form is submitted", "ui test", "ekran görüntüsü", "yerelde aç", "sayfayı aç"], have: "playwright browser e2e webapp", jobs: "webapp-testing browser-automation" },
  review: { words: "review reviewer critique diff", starts: "incele", phrases: ["pull request", "look over", "look through", "look at my", "look at this", "take a look", "have a look", "go through the changes", "my changes", "these changes", "the changes in", "second opinion", "someone else", "before it goes in", "before i open", "before merging", "safe to merge", "ready to merge", "what could go wrong", "anything risky", "sanity check", "feedback on", "gözden geçir", "göz at", "kod incelemesi", "inceleme iste", "güvenlik gözüyle"], have: "review", jobs: "code-review security-review" },
  security: { words: "security secure insecure vulnerability vulnerable exploit injection xss csrf ssrf secret leak leaked cve pentest threat malicious sanitize hardcoded crypto encryption sast owasp untrusted attacker", starts: "güvenli zafiyet saldır", phrases: ["static analysis", "user input", "shell command", "path traversal", "auth bypass", "high severity", "gömülü şifre", "gömülü anahtar", "gizli anahtar", "statik analiz", "açık var mı", "yüksek önem"], have: "secur vulnerab semgrep threat exploit", jobs: "security-review static-analysis supply-chain-audit smart-contract-security ci-security-audit" },
  planning: { words: "plan roadmap milestone breakdown spec specification outline estimate scope", starts: "plan adımlar adımla görev", phrases: ["break down", "step by step", "into steps", "into tasks", "small tasks", "split it into", "split this into", "implementation steps", "work needed", "what needs to happen", "order of work", "plan çıkar", "adımlara böl", "yol haritası", "adım adım"], have: "plan", jobs: "implementation-planning" },
  ideas: { words: "brainstorm idea design feature approach proposal requirements explore options alternatives tradeoff", starts: "fikir fikr tasarla özellik düşün seçenek karar", phrases: ["think it through", "think through", "best way to", "how would you", "how should we", "i want to add", "i d like", "we should support", "thinking about", "need to decide", "decide first", "pros and cons", "trade off", "nasıl yapalım", "eklemek istiyorum", "aktarma istiyorum"], have: "brainstorm ideat requirement", jobs: "design-brainstorming" },
  building: { words: "implement feature functionality", starts: "özellik geliştir uygula", phrases: ["add a feature", "new feature", "let s build", "build a", "build an", "build the", "add support for"], not: ["the build is", "build is", "build fails", "build failed"], have: "implement", jobs: "tdd-discipline design-brainstorming implementation-planning" },
  verifying: { words: "finished verify verified confirm ship shipped evidence proof", starts: "bitti doğrula düzeldi tamamlandı kanıtla", phrases: ["s done", "is done", "are done", "re done", "all done", "done with the", "double check", "is fixed", "s fixed", "fixed now", "before you commit", "before committing", "before you open", "full suite", "whole suite", "actual output", "what actually happened", "should be fixed", "works now", "should work", "safe to merge", "ready to merge", "all tests pass", "what should we check", "before i say", "call it done", "that s everything", "prove it", "the fix is in", "good to go", "ready to ship", "ready for release", "emin ol", "kontrol etmeliyiz", "bitti diyebilir", "hepsi bu"], have: "verif complet", jobs: "verification-gate" },
  finishing: { words: "merge squash", starts: "birleştir", phrases: ["what s next", "open a pr", "open a pull request", "wrap up", "wrapped up", "acceptance criteria", "meets the requirements", "all tests pass", "everything is implemented", "work is complete", "land it", "land this", "help me land", "her şey tamam", "ana dala", "iş tamamlandı"], have: "finish", jobs: "git-workflow code-review" },
  refactoring: { words: "refactor cleanup simplify restructure dedupe duplicated tidy", starts: "temizle sadeleştir", phrases: ["clean up", "technical debt", "tech debt", "dead code"], have: "refactor simplif cleanup", jobs: "refactoring" },
  performance: { words: "slow slower performance optimize latency profiling bottleneck lag laggy sluggish benchmark", starts: "yavaş hızlan performans optimiz kasıyor", phrases: ["takes too long", "speed it up", "speed up", "too slow", "make it faster", "run faster", "load faster", "loads faster", "be faster", "sequential scan", "table scan", "memory usage", "cpu usage", "uzun sürüyor", "geç açılıyor"], have: "perform optim profil", jobs: "performance-optimization react-performance database" },
  dependencies: { words: "dependency package library npm pip cargo lockfile outdated maintainer maintains abandoned typosquat", starts: "bağımlılık paket kütüphane", phrases: ["supply chain", "third party", "we rely on", "known cve", "terk edilmiş"], not: ["package json", "package lock"], have: "dependenc supply packag", jobs: "supply-chain-audit" },
  git: { words: "commit committed branch merge rebase squash", starts: "commitle", phrases: ["pull request", "commit message", "git history"], have: "git commit branch", jobs: "git-workflow" },
  docs: { words: "readme docs documentation document changelog tutorial article blog prose wording proofread paragraph grammar", starts: "doküman belge makale paragraf üslup", phrases: ["hard to read", "plain language", "rewrite it plainly", "reads awkwardly", "sade bir dil"], have: "doc document readme prose guidelin", jobs: "writing-quality" },
  frontend: { words: "ui ux css layout styling component responsive tailwind animation landing theme design redesign restyle font typography color palette polished polish visual aesthetic bland boring ugly sleek hero cluttered distinctive branding", starts: "arayüz tasarım tasarla görünüm renk tipografi boşluk yerleşim", phrases: ["dark mode", "look and feel", "looks generic", "looks dated", "look like every", "looks like every", " spacing", " padding", " whitespace", "yazı tipi", "karanlık mod", "koyu tema", "çok karışık"], have: "frontend design interfac css component", jobs: "frontend-design web-design-review component-architecture" },
  database: { words: "database db sql query schema postgres mysql sqlite mongodb orm prisma column", starts: "veritaban sorgu tablo şema indeks", phrases: ["a migration", "migration file", "schema migration", "database migration", "table scan", "sequential scan", "window function", "soft delete", "users table", "the table", "explain plan", "foreign key", "primary key", "an index", "pencere fonksiyon"], have: "databas sql schema postgres query", jobs: "database" },
  delivery: { words: "deploy deployment ci pipeline docker kubernetes k8s infra terraform hosting production staging rollout rollback helm nginx", starts: "yayınla dağıt sunucu canlıya", phrases: ["github actions", "ci cd", "cut a release", "release process", "release pipeline", "new release"], have: "deploy devop docker kubernet infra terraform", jobs: "deploy-vercel cloud-services" },
  observing: { words: "monitoring monitor alerting alert metrics logging logs tracing observability dashboard prometheus grafana uptime opentelemetry otel instrument instrumentation p95 p99 slo sentry datadog", starts: "izleme logla uyarı metrik alarm", phrases: ["error rate", "queue depth"], have: "monitor observab alert metric", jobs: "" },
  codebase: { words: "codebase architecture overview", starts: "mimari", phrases: ["how does", "how is", "where is", "where does", "walk me through", "explain how", "wired up", "trace where", "trace how", "ends up", "what depends on", "who depends on", "what uses", "where is it used", "how the request", "flows from", "which modules", "which files", "who calls", "what calls", "is used", "a map of", "dependency graph", "call graph", "depend on each other", "big picture", "new to this repo", "new to the codebase", "get oriented", "high level", "how the pieces", "pieces connect", "nasıl çalışıyor", "nasıl akıyor", "kod tabanı", "nasıl organize", "proje yapısı", "hangi modül", "genel resim", "repoda yeniyim", "nerede tanımlı", "nerede kullanılıyor"], have: "codebas graph architectur", jobs: "codebase-map" },
  skills: { words: "skill", starts: "beceri", phrases: ["skill md"], have: "skill", jobs: "skill-authoring" },
  llm: { words: "prompt llm rag embedding eval evals hallucination", starts: "", phrases: [], have: "prompt llm rag eval embedding", jobs: "prompt-engineering agent-evaluation" },
  accessibility: { words: "accessibility accessible a11y aria wcag", starts: "erişilebilir", phrases: ["screen reader"], have: "accessib a11y wcag", jobs: "accessibility web-design-review" },
  seo: { words: "seo sitemap", starts: "", phrases: ["search engine"], have: "seo", jobs: "seo-optimization" },
  translation: { words: "translation localization localize i18n locale multilingual", starts: "yerelleştir", phrases: [], have: "i18n international translat", jobs: "i18n-localization" },
  documents: { words: "pdf docx xlsx pptx excel spreadsheet slides powerpoint", starts: "sunum", phrases: [], have: "pdf docx xlsx pptx spreadsheet slid present", jobs: "pdf-processing docx-documents spreadsheets presentations" },
  mobile: { words: "mobile android ios iphone apk emulator simulator flutter expo", starts: "mobil telefon", phrases: [], have: "mobil android ios flutter nativ", jobs: "react-native mobile-testing flutter-expertise swift-expertise kotlin-expertise" },
  payments: { words: "payment checkout stripe billing subscription invoice", starts: "ödeme fatura", phrases: [], have: "payment strip billing", jobs: "payments-integration" },
  auth: { words: "login signin signup oauth auth authentication session password jwt sso", starts: "giriş şifre oturum", phrases: [], have: "auth oauth login", jobs: "auth-implementation" },
  // Languages and frameworks: a request that names one, or its tools, is work for its expert.
  typescript: { words: "typescript tsconfig generics generic infer inferred trpc zod", starts: "", phrases: ["return type", "union type", "type error", "type errors", "strict null", "as any", "type guard", "utility type", "mapped type", "type inference", "type safety", "shared types", "share types", "truth for types"], have: "typescript", jobs: "typescript-expertise" },
  python: { words: "python asyncio mypy ruff pytest pydantic dataclass venv poetry", starts: "", phrases: ["type hints", "type annotations"], have: "python", jobs: "python-expertise python-tooling fastapi-expertise django-expertise" },
  golang: { words: "golang goroutine gofmt", starts: "", phrases: ["go module", "go routine", "in go"], have: "golang", jobs: "go-expertise" },
  rust: { words: "rust cargo tokio lifetime", starts: "", phrases: ["borrow checker"], have: "rust", jobs: "rust-expertise" },
  jvm: { words: "java spring maven gradle jvm kotlin", starts: "", phrases: [], have: "java kotlin spring", jobs: "java-expertise kotlin-expertise" },
  react: { words: "react nextjs rerender jsx", starts: "", phrases: ["use effect", "re render", "server component", "next js"], have: "react", jobs: "react-performance component-architecture" },
};

const list = (text) => String(text ?? "").split(/\s+/).filter(Boolean);
const KIND_RULES = Object.entries(KINDS).map(([id, k]) => ({ id, words: new Set(list(k.words).map(stem)), starts: list(k.starts), ends: list(k.ends), codes: Boolean(k.codes), phrases: k.phrases, not: k.not ?? [], have: new Set(list(k.have)), jobs: new Set(list(k.jobs)) }));
const KIND_BY_ID = new Map(KIND_RULES.map((k) => [k.id, k]));

// An HTTP error status is a symptom when something returned it ("got a 404", "fails with a 500", "500 veriyor"),
// not when it is asked about ("the difference between 401 and 403").
const CODE_SYMPTOM = / (got|get|gets|getting|return|returns|returned|returning|throw|throws|give|gives|giving|with|respond|responds|shows)( an?| the| http)? [45]\d\d |[45]\d\d (error|hatası|veriyor|dönüyor|döndürüyor|alıyorum) /;

// The kinds of work a request sounds like.
export function kindsOf(prompt) {
  const all = ` ${tokens(prompt).join(" ")} `;
  const out = new Set();
  for (const k of KIND_RULES) {
    let text = all;
    for (const p of k.not) text = text.split(` ${p}`).join(" ");
    const raw = text.split(" ").filter(Boolean);
    const stems = new Set();
    for (const w of raw) for (const v of variants(w)) stems.add(v);
    if ([...k.words].some((s) => stems.has(s)) || k.starts.some((p) => p && raw.some((w) => w.startsWith(p))) || k.ends.some((p) => raw.some((w) => w.length > p.length && w.endsWith(p))) || (k.codes && CODE_SYMPTOM.test(text)) || k.phrases.some((p) => all.includes(` ${p}`))) out.add(k.id);
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

// The job the catalog gave each skill Repotify installed, by skill folder name, from repotify.lock.json.
export function lockedJobs(cwd) {
  const jobs = new Map();
  try {
    const file = join(cwd, "repotify.lock.json");
    if (statSync(file).size > 2_000_000) return jobs;
    const items = JSON.parse(readFileSync(file, "utf8"))?.items ?? {};
    for (const entry of Object.values(items)) {
      if (typeof entry?.job !== "string" || !/^[a-z0-9-]{1,64}$/.test(entry.job)) continue;
      for (const t of Array.isArray(entry.targets) ? entry.targets : []) jobs.set(String(t).split("/").pop(), entry.job);
    }
  } catch {
    // No lock, or one that cannot be read: skills are judged by their own words.
  }
  return jobs;
}

// Installed skills: every folder with a SKILL.md under the project's and the user's skills folders.
export function installedSkills({ cwd, home = homedir() } = {}) {
  const jobs = lockedJobs(cwd);
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
        out.set(e.name, { id: e.name, ...skillHead(readFileSync(file, "utf8").slice(0, MAX_HEAD_BYTES)), ...(jobs.has(e.name) ? { job: jobs.get(e.name) } : {}) });
      } catch {
        // Not a skill folder, or unreadable: skipped.
      }
    }
  }
  return [...out.values()];
}

// What a skill is about: its own words (2 in its name, 1 in its description) and the kinds of work it is made for:
// fully (3) when its catalog job or its name says so, in passing (1) when only its description does.
function profile(skill) {
  const weights = new Map();
  for (const w of words(skill.description)) weights.set(stem(w), 1);
  const nameWords = new Set(words(`${skill.id} ${skill.name ?? ""}`).map(stem));
  for (const w of nameWords) weights.set(w, 2);
  // A name says what a skill is for even inside a longer word: "graphify" maps the codebase.
  const named = tokens(`${skill.id} ${skill.name ?? ""}`);
  const inName = (s) => named.some((w) => (s.length >= 4 ? w.startsWith(s) : stem(w) === s));
  const described = new Set(tokens(skill.description).map(stem));
  const kinds = new Map();
  for (const k of KIND_RULES) {
    if ((skill.job && k.jobs.has(skill.job)) || [...k.have].some(inName)) kinds.set(k.id, 3);
    else if ([...k.have].some((s) => (s.length >= 4 ? [...described].some((d) => d.startsWith(s)) : described.has(s)))) kinds.set(k.id, 1);
  }
  return { weights, kinds, nameWords };
}

// A suggestion needs the request to be the kind of work the skill is made for, or to use two of the words in its
// name, or two separate pieces of evidence that are rare among the installed skills; one common word proves nothing.
export const MIN_SCORE = 1.5;
export const MIN_UNNAMED_SCORE = 1.9;

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
    let nameHits = 0;
    for (const t of asked) {
      const w = p.weights.get(t);
      if (!w || counted.has(t)) continue;
      score += w * rarity(wordCount.get(t));
      if (w === 2) nameHits++;
      why.push(t);
    }
    // One word of a longer name ("property" of property-based-testing) is a word; the whole name, or two of its
    // words, is the skill being asked for.
    named ||= nameHits >= Math.min(2, p.nameWords.size);
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
