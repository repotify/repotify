// Content rules for the security scanner.
// Each rule inspects one line (or a small window of lines) of a text file and returns every match on it, so a harmless
// or official-looking match early on a line cannot hide a dangerous one later on the same line: the scanner reports the
// most severe. Regexes never use unbounded `[^\n]*` between two parts, and bounded gaps are lazy so one match never
// swallows the next; scanning stays linear on long lines. Shell structure comes from ./shell.mjs.
import { posix } from "node:path";
import { splitPipelines, statementSpan, fetchIndex, fetchToolOf, downloadTarget, stageRunPaths, runPath, fetchTargets, runsPipedInput, commandWords, baseName, INTERPRETERS } from "./shell.mjs";

export const SCRIPT_EXTENSIONS = new Set([
  ".sh", ".bash", ".zsh", ".fish", ".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx",
  ".ps1", ".psm1", ".rb", ".pl", ".php", ".bat", ".cmd", ".lua",
]);

export const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst"]);

// Pattern files for detection engines describe what to look for; they are never executed.
export const DETECTION_EXTENSIONS = new Set([".yar", ".yara", ".sigma", ".rules"]);
export const DETECTION_FENCES = new Set(["yara", "yar", "sigma", "semgrep", "regex", "codeql", "ql", "snort", "suricata"]);

export function extOf(path) {
  const base = path.split("/").pop();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

export function fileKind(path, text = "") {
  const ext = extOf(path);
  if (DETECTION_EXTENSIONS.has(ext)) return "detection";
  if (SCRIPT_EXTENSIONS.has(ext) || text.startsWith("#!")) return "script";
  if (DOC_EXTENSIONS.has(ext)) return "doc";
  return "other";
}

// Words that mark a line as describing a pattern rather than instructing the agent to run it.
export const DOC_CONTEXT_RE =
  /(\b(never|don'?t|do not|avoid|detect(s|ed|ion)?|flag(s|ged)?|block(s|ed)?|prevent(s|ed)?|scan(s|ning)? for|look(ing)? for|such as|for example|examples?|patterns?|attacks?|attacker|malicious|suspicious|vulnerab\w*|dangerous|exploit\w*|injection|payloads?|theft|steal\w*|stealers?|malware|keyloggers?|indicators?|iocs?|persistence|backdoors?)\b|\be\.g\.(?!\w))/i;

// A negation right before a command ("Never run `curl … | sh`"). Only this may lower a critical finding in
// documentation to caution; other descriptive words send it to human review instead.
export const NEGATION_BEFORE_RE =
  /\b(never|do not|don'?t|avoid|must not|mustn'?t|should not|shouldn'?t)\b(?!\s+(forget|hesitate|skip|fail|miss|wait|stop)\b)[^.!?\n]{0,40}$/i;

export const isTagChar = (cp) => cp >= 0xe0000 && cp <= 0xe007f;
export const isBidiChar = (cp) => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
export const isZeroWidth = (cp, offset) => (cp >= 0x200b && cp <= 0x200d) || cp === 0x2060 || (cp === 0xfeff && offset !== 0);

// Hidden characters: Unicode tags, zero-width, bidi controls. A BOM at offset 0 is allowed.
export function isHiddenChar(cp, offset) {
  if (cp >= 0xe0000 && cp <= 0xe007f) return true;
  if (cp >= 0x200b && cp <= 0x200d) return true;
  if (cp === 0x2060) return true;
  if (cp === 0xfeff) return offset !== 0;
  if (cp >= 0x202a && cp <= 0x202e) return true;
  if (cp >= 0x2066 && cp <= 0x2069) return true;
  return false;
}

// Official installers: running them is still remote code execution, but a known vendor lowers it to caution.
export const KNOWN_INSTALLER_HOSTS = [
  "astral.sh/uv/", "astral.sh/ruff/", "bun.sh/install", "sh.rustup.rs", "deno.land/install.sh", "deno.land/x/install/",
  "get.pnpm.io/install.sh", "install.python-poetry.org", "raw.githubusercontent.com/nvm-sh/nvm/", "get.docker.com",
  "raw.githubusercontent.com/Homebrew/install/", "claude.ai/install.sh", "fnm.vercel.app/install", "apt.llvm.org/llvm.sh",
];

// RFC 2606 / RFC 6761 names reserved for documentation: nothing real can be served from them.
export function isDocDomain(host) {
  return /(^|\.)example\.(com|net|org)$/.test(host) || /\.(example|test|invalid)$/.test(host) || host === "example";
}

// Hosts that routinely receive credentials as part of normal API use. Endpoints anyone can create for themselves
// (Slack incoming webhooks, request bins) are not on this list.
export const KNOWN_API_HOSTS = [
  "api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com", "api.github.com",
  "uploads.github.com", "integrate.api.nvidia.com", "api.mistral.ai", "api.groq.com", "openrouter.ai",
  "api.together.xyz", "api.cohere.com", "api.deepseek.com", "api.x.ai", "registry.npmjs.org",
  "pypi.org", "upload.pypi.org", "api.vercel.com", "api.stripe.com", "api.resend.com", "api.sendgrid.com",
  "slack.com/api/", "api.linear.app", "api.notion.com", "localhost", "127.0.0.1",
];

export const EXFIL_DOMAINS_RE =
  /\b(webhook\.site|pastebin\.com|ngrok\.io|ngrok-free\.app|ngrok\.app|requestbin\.\w+|pipedream\.net|burpcollaborator\.net|oast\.(pro|live|site|online|fun|me)|interact\.sh|transfer\.sh|requestcatcher\.com|hookbin\.com|canarytokens\.(com|org))\b/i;

const SECRET_RE =
  /(\$\{?[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)\b|process\.env\b|os\.environ\b|\bgetenv\(|\bprintenv\b|\benv\s*\||\.ssh\/|id_rsa|\.aws\/credentials)/;

const SEND_RES = [
  /\bcurl\b[^\n]{0,300}?\s(-d|--data(-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file)\b/g,
  /\bfetch\([\s\S]{0,300}?method\s*:\s*['"`](POST|PUT)['"`]/gi,
  /\brequests\.(post|put)\(/g,
  /\bhttpx\.(post|put)\(/g,
  /\baxios\.(post|put)\(/g,
  /\burlopen\([^)]{0,300}data\s*=/g,
  /\bnc\s+(-\w+\s+){0,8}[\w.-]+\s+\d{2,5}\b/g,
  /Invoke-(WebRequest|RestMethod)[^\n]{0,300}?-Method\s+(Post|Put)/gi,
  /\bwget\b[^\n]{0,300}?--post-(data|file)/g,
];

const URL_RE = /https?:\/\/[^\s'"`<>()]+/gi;

// Hosts of the URLs in `text`, parsed the way curl parses them: a user part (`https://api.github.com@evil.io/`)
// means the real host follows the `@`, and `..` segments collapse. URLs with a user part are never trusted.
export function urlHosts(text) {
  const out = [];
  for (const m of text.matchAll(URL_RE)) {
    let u;
    try {
      u = new URL(m[0].replace(/[.,;:!?\]}]+$/, ""));
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    // IPv6 literals (`http://[::1]/x`) are hosts too: dropping them made the URL invisible to every host check.
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(host) && !/^\[[0-9a-f:.]+\]$/.test(host)) continue;
    out.push({ host, url: m[0], hostPath: host + u.pathname, userinfo: Boolean(u.username || u.password) });
  }
  return out;
}

// An encoded slash, backslash or dot in the path can leave the allowed folder once the server decodes it
// (`astral.sh/uv/..%2f..%2fx.sh`): such a URL is never vouched for by a path entry.
const ENCODED_PATH_RE = /%(2f|5c|2e)|\\/i;

function hostAllowed(h, list) {
  if (h.userinfo) return false;
  return list.some((entry) => {
    if (entry.includes("/")) return !ENCODED_PATH_RE.test(h.hostPath) && h.hostPath.toLowerCase().startsWith(entry.toLowerCase());
    return h.host === entry || h.host.endsWith("." + entry);
  });
}

// Every destination of a curl/wget statement is a literal URL on an allowed host (no `$VAR` destinations).
function targetsAllowed(statement, list) {
  const targets = fetchTargets(statement);
  if (!targets.length) return false;
  return targets.every((t) => {
    if (!/^https?:\/\//i.test(t) || /[$`]/.test(t)) return false;
    const hosts = urlHosts(t);
    return hosts.length > 0 && hosts.every((h) => hostAllowed(h, list));
  });
}

// Two readings of a line: the shell's own (quotes respected) and a loose one that also looks inside quoted strings,
// because `os.system("curl … | sh")` and `subprocess.run("…", shell=True)` hand a string to a shell.
function readingsOf(ctx, line) {
  if (ctx?.readings) return ctx.readings;
  const opts = { comments: Boolean(ctx?.comments), prose: Boolean(ctx?.prose) };
  return [splitPipelines(line, opts), splitPipelines(line, { ...opts, quotes: false })];
}

// The scanner judges at most this many matches of one rule on one line; a line with more is sent to human review
// instead of being read further (see scanText). Collecting stops one past it, so the scanner can tell.
export const MAX_LINE_MATCHES = 32;

// Matches of one rule on one line, in order, one per position (both readings of a line often find the same command).
// A clean line allocates nothing: rules return the shared empty list. `overflow` marks a list the rule stopped filling
// because the line held more than the scanner reads. Lists stay short, so a linear check beats a Set.
const NO_MATCHES = Object.freeze([]);
function addMatch(list, m) {
  if (!list) return [m];
  if (!list.some((x) => x.index === m.index)) list.push(m);
  return list;
}
const isFull = (list) => list !== null && list.length > MAX_LINE_MATCHES;
function overflowing(list) {
  const out = list ?? [];
  out.overflow = true;
  return out;
}

function mergeMatches(...lists) {
  let out = null;
  let overflow = false;
  for (const l of lists) {
    if (l.overflow) overflow = true;
    for (const m of l) out = addMatch(out, m);
  }
  return overflow ? overflowing(out) : out ?? NO_MATCHES;
}

const RUN_LOOKAHEAD_LINES = 5;

// Every stage of the lines after line `ctx.i` that a download or clone on it may be run by. Whole lines and every stage
// count: a cap on either was a way around the rule (a dozen no-op commands, or a long line before the run). The scanner
// splits each line once (ctx.pipelinesOf), so looking ahead from every line stays linear.
function followingStages(ctx, opts) {
  const lines = ctx?.lines ?? [];
  const i = ctx?.i ?? 0;
  const out = [];
  for (let j = i + 1; j < Math.min(lines.length, i + 1 + RUN_LOOKAHEAD_LINES); j++) {
    out.push(...(ctx.pipelinesOf ? ctx.pipelinesOf(j, opts) : splitPipelines(lines[j], opts)).flat());
  }
  return out;
}

// A stage's run paths are worked out once, however many downloads look ahead to it.
const RUN_PATHS = new WeakMap();
function runPathsOf(stage) {
  let paths = RUN_PATHS.get(stage);
  if (!paths) RUN_PATHS.set(stage, (paths = stageRunPaths(stage.text)));
  return paths;
}

// Options that take the next word as their value: git's own (`git -C dir clone`) and those of `git clone`.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const CLONE_VALUE_OPTIONS = new Set([
  "-b", "--branch", "-o", "--origin", "-c", "--config", "-j", "--jobs", "-u", "--upload-pack", "--depth", "--reference",
  "--reference-if-able", "--separate-git-dir", "--shallow-since", "--shallow-exclude", "--template", "--server-option",
  "--bundle-uri", "--filter",
]);
// After these an interpreter runs the next word as code or as a module, not as a file.
const INLINE_CODE_FLAGS = new Set(["-c", "-e", "-m", "-p", "-r", "--eval", "--print", "-Command", "-command"]);
const CLONE_URL_RE = /^(?:(?:https?|ssh|git):\/\/\S+|[\w.-]+@[\w.-]+:\S+)$/i;

// A path as `cd` and the shell resolve it from `cwd` ("." is where the commands start); absolute paths stay absolute.
const resolvePath = (cwd, path) => posix.normalize(path.startsWith("/") ? path : `${cwd}/${path}`).replace(/(.)\/+$/, "$1");

// What `git clone` in this stage fetches and the folder it writes: the folder named after the URL, or "." and any other
// folder given after it. Options may come before or after the URL (`git clone --depth 1 -b v1 <url> [dir]`).
function cloneOf(stageText) {
  const words = commandWords(stageText);
  if (baseName(words[0] ?? "") !== "git") return null;
  let k = 1;
  while (k < words.length && words[k].startsWith("-")) k += GIT_VALUE_OPTIONS.has(words[k]) ? 2 : 1;
  if (words[k] !== "clone") return null;
  const args = [];
  let options = true;
  for (k += 1; k < words.length; k++) {
    const w = words[k];
    if (options && w === "--") options = false;
    else if (options && w.startsWith("-")) k += CLONE_VALUE_OPTIONS.has(w) ? 1 : 0;
    else args.push(w);
  }
  const url = args[0];
  if (!url || !CLONE_URL_RE.test(url)) return null;
  const named = args[1] ?? url.replace(/[?#].*$/, "").split(/[/:]/).filter(Boolean).pop()?.replace(/\.git$/, "");
  return named ? { url, dir: resolvePath(".", named) } : null;
}

// True when `path` (resolved) lies inside the clone written to `dir` (resolved; "." is the folder the commands start in).
function insideClone(path, dir) {
  if (dir === ".") return !path.startsWith("/") && path !== ".." && !path.startsWith("../");
  return path === dir || path.startsWith(dir + "/");
}

// `git clone` downloads a whole tree; running anything from it within the next few commands is the same shape as
// download-then-run. `cd <dir>` stages are tracked so `cd evil && ./setup.sh` resolves inside the clone. Like the
// curl/wget path, this is aggressive by design: a skill that clones a repo and executes its scripts is the attack,
// whatever the host.
function gitCloneThenRun(line, ctx) {
  const opts = { comments: Boolean(ctx?.comments), prose: Boolean(ctx?.prose) };
  const unq = (t) => t.replace(/^["']|["']$/g, "");
  // Every clone on the line reads the stages after it: each stage's words are worked out once, not once per clone.
  const read = new Map();
  const wordsOf = (st) => {
    let w = read.get(st);
    if (!w) read.set(st, (w = commandWords(st.text)));
    return w;
  };
  let found = null;
  for (const pipelines of readingsOf(ctx, line)) {
    const own = pipelines.flat();
    let following = null;
    let clones = 0;
    for (let k = 0; k < own.length; k++) {
      if (!/\bclone\b/.test(own[k].text)) continue;
      const clone = cloneOf(own[k].text);
      if (!clone) continue;
      if (++clones > MAX_LINE_MATCHES) return overflowing(found);
      following ??= followingStages(ctx, opts);
      let cwd = ".";
      for (const st of [...own.slice(k + 1), ...following]) {
        const words = wordsOf(st);
        if (!words.length) continue;
        if (words[0] === "cd" && words[1] && !words[1].startsWith("-")) {
          cwd = resolvePath(cwd, unq(words[1]));
          continue;
        }
        // Only flag file executions, not bare commands run inside the dir (`cd d && ls` is fine):
        // `./setup.sh`, `/abs/x.sh`, `sub/x.sh`, or a script via an interpreter (`bash install.sh`).
        const cmd = words[0];
        const looksFile = (w) => /[/\\]/.test(w) || w.startsWith(".") || /\.[a-z0-9]+$/i.test(w);
        let fileWord = null;
        if (looksFile(cmd)) fileWord = cmd;
        else if (INTERPRETERS.has(baseName(cmd))) {
          const dashC = words.indexOf("-c");
          fileWord = words.slice(1).find((w, idx) => !w.startsWith("-") && (dashC < 0 || idx + 1 < dashC) && looksFile(w)) ?? null;
          // An interpreter runs its first argument whatever it is called: `python setup`, `bash install`. In prose
          // only a path-like word counts ("… then python is ready").
          if (!fileWord && !opts.prose) {
            for (const w of words.slice(1)) {
              if (INLINE_CODE_FLAGS.has(w)) break;
              if (w.startsWith("-")) continue;
              fileWord = w;
              break;
            }
          }
        }
        if (!fileWord || !insideClone(resolvePath(cwd, unq(fileWord)), clone.dir)) continue;
        const at = own[k].text.search(/\S/);
        const text = own[k].text.slice(at).trimEnd();
        found = addMatch(found, { index: own[k].start + at, length: text.length, text });
        if (isFull(found)) return found;
        break;
      }
    }
  }
  return found ?? NO_MATCHES;
}

// `curl …/wget …/irm …` piped into an interpreter, possibly through other stages (`| tee x | sudo -E bash`).
function pipeToInterpreter(line, ctx) {
  let found = null;
  for (const pipelines of readingsOf(ctx, line)) {
    for (const stages of pipelines) {
      let first = null;
      for (const stage of stages) {
        if (first && runsPipedInput(stage.text, { prose: Boolean(ctx?.prose) })) {
          const index = first.stage.start + first.at;
          found = addMatch(found, { index, length: stage.start + stage.text.length - index, text: first.stage.text.slice(first.at) });
          if (isFull(found)) return found;
          first = null;
          continue;
        }
        if (!first) {
          const at = fetchIndex(stage.text);
          if (at >= 0) first = { stage, at };
        }
      }
    }
  }
  return found ?? NO_MATCHES;
}

// A download to a file that a later command runs, on the same line or within the next few lines.
function downloadThenRun(line, ctx) {
  const opts = { comments: Boolean(ctx?.comments), prose: Boolean(ctx?.prose) };
  let found = null;
  for (const pipelines of readingsOf(ctx, line)) {
    const own = pipelines.flat();
    const downloads = [];
    for (let k = 0; k < own.length; k++) {
      const at = fetchIndex(own[k].text);
      if (at < 0) continue;
      const fetch = own[k].text.slice(at);
      const file = downloadTarget(fetch);
      if (file) downloads.push({ k, at, fetch, want: runPath(file) });
    }
    if (!downloads.length) continue;
    // The last stage that runs each path and each base name; a download is run when a stage after it runs either.
    const lastRun = new Map();
    [...own, ...followingStages(ctx, opts)].forEach((st, n) => {
      for (const p of runPathsOf(st)) {
        lastRun.set(`path:${p.path}`, n);
        if (p.base) lastRun.set(`base:${p.base}`, n);
      }
    });
    for (const d of downloads) {
      const after = (key) => (lastRun.get(key) ?? -1) > d.k;
      if (after(`path:${d.want.path}`) || (d.want.base && after(`base:${d.want.base}`))) {
        found = addMatch(found, { index: own[d.k].start + d.at, length: d.fetch.trimEnd().length, text: d.fetch });
        if (isFull(found)) return found;
      }
    }
  }
  return found ?? NO_MATCHES;
}

const SUBSTITUTION_RES = [
  /\b(ba|z|da|k)?sh\s+<\(\s*(curl|wget)\b/i,
  /(?:^|[\s;&|(`])(source|\.)\s+<\(\s*(curl|wget)\b/i,
  /\b(eval|exec)\s+["']?(\$\(|`)\s*(curl|wget)\b/i,
  /\b((ba|z|da|k)?sh|python[23]?|perl|ruby|node|php)\s+(-\w+\s+){0,5}-c\s+["']?(\$\(|`)\s*(curl|wget)\b/i,
  /\b(python[23]?|node|ruby|perl|php)\s+<\(\s*(curl|wget)\b/i,
  /\b(iex|Invoke-Expression)\s*\(*\s*(iwr|irm|Invoke-WebRequest|Invoke-RestMethod|New-Object\s+(System\.)?Net\.WebClient|\[(System\.)?Net\.WebClient\])/i,
  /\bDownloadString\s*\([^)\n]{0,300}\)\s*\)?\s*\|\s*(iex|Invoke-Expression)\b/i,
  /\b(iex|Invoke-Expression)\b[^\n]{0,60}?\.DownloadString\s*\(/i,
];

// Uploads of local files: curl -F x=@f / -F x=<f / -d @f / --data-* @f / -T f, wget --post-file, PowerShell -InFile.
// `@-` reads stdin (a heredoc or a pipe), not a local file.
const UPLOAD_CURL_RE = /(?:^|\s)(?:-F|--form)\s*['"]?[\w.-]*=[@<](?!-(?:\s|$|['"]))|(?:^|\s)(?:-d|--data(?:-\w+)?|--json)\s*['"]?@(?!-(?:\s|$|['"]))|(?:^|\s)(?:-T|--upload-file)\s+(?!-(?:\s|$))/;
const UPLOAD_WGET_RE = /(?:^|\s)--post-file[=\s]/;
const UPLOAD_PS_RE = /(?:^|\s)-InFile\s/i;

function fileUpload(line, ctx) {
  let found = null;
  for (const stage of readingsOf(ctx, line).flat(2)) {
    const at = fetchIndex(stage.text);
    if (at < 0) continue;
    const fetch = stage.text.slice(at);
    const tool = fetchToolOf(fetch.split(/\s/, 1)[0]) ?? "";
    const re = tool === "curl" ? UPLOAD_CURL_RE : tool === "wget" ? UPLOAD_WGET_RE : UPLOAD_PS_RE;
    if (re.test(fetch)) found = addMatch(found, { index: stage.start + at, length: fetch.trimEnd().length, text: fetch });
    if (isFull(found)) break;
  }
  return found ?? NO_MATCHES;
}

// Line rules: {id, severity(kind) -> severity, matches(line, ctx) -> [match]}, matches in reading order.
// A match is {index, length, text} of the offending span so documentation context can ignore the span itself.
// Every regex runs as a global one, so all of its matches on a line come from one linear pass.
function reAll(res) {
  const all = res.map((re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`));
  return (line) => {
    let found = null;
    for (const re of all) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        found = addMatch(found, { index: m.index, length: m[0].length, text: m[0] });
        if (isFull(found)) {
          re.lastIndex = 0;
          return found;
        }
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    return found ?? NO_MATCHES;
  };
}

// `rm` is destructive only with a recursive flag AND a root-level target. Flags can arrive in any order
// (`rm / -rf`, `rm --recursive --force /`), so the flag is searched anywhere in the invocation while the
// target must be a standalone word: `rm -rf /var/lib/apt/lists/*` deletes one glob, not the system.
// The returned span still ends at the target, which the documentation-context logic relies on.
const RM_RECURSIVE_FLAG = /(?:^|\s)(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/;
const RM_DANGEROUS_TARGET = /(?:^|[\s"'])(\/|~|~\/|\$HOME\/?|\/\*|\$\{HOME\}\/?)(?=\s|$|;|&|\||"|')/;

function dangerousRm(line) {
  let found = null;
  const start = /\brm(?=\s|$)/g;
  let m;
  while ((m = start.exec(line))) {
    // One invocation, bounded so scanning stays linear; a separator ends the rm command.
    const rest = line.slice(m.index, m.index + 400).split(/[;&|`\n]/, 1)[0];
    // Words after `--` are file names, not flags: `rm -- -rf /` deletes nothing recursively.
    const opts = rest.split(/(?:^|\s)--(?:\s|$)/, 1)[0];
    if (!RM_RECURSIVE_FLAG.test(" " + opts)) continue;
    const t = RM_DANGEROUS_TARGET.exec(rest);
    if (!t) continue;
    const end = t.index + t[0].length;
    found = addMatch(found, { index: m.index, length: end, text: rest.slice(0, end) });
    if (isFull(found)) break;
  }
  return found ?? NO_MATCHES;
}

const substitutions = reAll(SUBSTITUTION_RES);
const IGNORE_PREVIOUS_RE =
  /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+)?((the|your|my)\s+)?(previous|prior|above|earlier|preceding|system|original)\s+(instructions|prompts?|rules|messages|directions|directives)/i;
const injections = reAll([
  IGNORE_PREVIOUS_RE,
  /\byou are now\s+(DAN|no longer|free from|unrestricted|jailbroken|in (developer|god|dan) mode|an? (unrestricted|unfiltered|uncensored))/i,
  /\b(do not|don't|never)\s+(tell|inform|notify|alert|show|reveal (this |it )?to|mention (this |it )?to)\s+(the\s+)?user\b/i,
  /\bwithout\s+(asking|telling|informing|notifying|alerting)\s+(the\s+)?user\b/i,
  /\b(note|message|instructions?)\s+(to|for)\s+(the\s+)?(ai|llm|evaluator|reviewer|grader|judge|scanner|model)\b/i,
  /\b(rate|score|grade|mark)\s+(this|the)\s+(skill|repo|repository|item|plugin|tool)\s+(as\s+)?(\d|high|safe|perfect|verified)/i,
  /\bgive\s+(this|it)\s+(a\s+)?(high|perfect|top|maximum|10|5)\b/i,
  /\b(this|the) (skill|content|file) is (verified|safe|trusted)[^.]*(do not|don't) (scan|flag|review)/i,
]);
const leetInjections = reAll([IGNORE_PREVIOUS_RE]);

// "Ignore the previous instructions" in the languages skills are most often written in. `\b` only knows ASCII
// letters, so word edges are spelled with \p{L}.
const foreignInjections = reAll([
  /(?<!\p{L})(önceki|yukarıdaki|eski|sistem)\s+(tüm\s+|bütün\s+)?(talimatlar\p{L}*|komutlar\p{L}*|kurallar\p{L}*|yönergeler\p{L}*)\s+(yok\s?say|görmezden\s+gel|unut|dikkate\s+alma|geçersiz\s+say)/iu,
  /(?<!\p{L})(ignora|ignore|olvida|omite|desestima)\s+(todas\s+)?(las\s+)?instrucciones\s+(anteriores|previas)(?!\p{L})/iu,
  /(?<!\p{L})(ignore[zr]?|oublie[zr]?)\s+(toutes\s+)?(les\s+)?instructions\s+(précédentes|antérieures|ci-dessus)(?!\p{L})/iu,
  /(?<!\p{L})(ignoriere|ignorieren\s+Sie|vergiss|vergessen\s+Sie|missachte)\s+(alle\s+)?(vorherigen|bisherigen|obigen|früheren)\s+(Anweisungen|Instruktionen|Befehle)(?!\p{L})/iu,
  /(?<!\p{L})(ignore|esqueça|desconsidere)\s+(todas\s+)?(as\s+)?instruções\s+(anteriores|prévias)(?!\p{L})/iu,
  /(?<!\p{L})(ignora|dimentica)\s+(tutte\s+)?(le\s+)?istruzioni\s+precedenti(?!\p{L})/iu,
  /(?<!\p{L})(игнорируй(те)?|забудь(те)?)\s+(все\s+)?(предыдущие|прежние)\s+(инструкции|указания)(?!\p{L})/iu,
  /(忽略|无视|忘记|忽視|無視)(之前|以上|先前|上述|前面)(的)?(所有)?(指令|指示|提示|说明|說明)/u,
  /(以前|これまで|上記)の(指示|命令)を(無視|忘れ)/u,
]);

// Instructions that are unsafe for the agent that follows them, written as plain language with no shell syntax: the
// rules above cannot see them. These are heuristics over wording, so they are narrow and say what they matched; a
// skill with none of them is not thereby safe to follow (see docs/guides/security.md).
const warningSuppression = reAll([
  /\b(?:it|this|that|these|those|the\s+(?:warning|alert|finding|error|block)s?)(?:\s+is|\s+are|'s)\s+(?:just\s+|only\s+|always\s+)?(?:a\s+)?false\s+positives?\b[^.\n]{0,80}?\b(?:proceed|continue|ignore|go\s+ahead|install|run|retry|override)\b/i,
  /\b(?:ignore|dismiss|disregard|bypass|suppress|override)\s+(?:any|all|the|these|those|such)?\s*(?:security|safety|guard|scanner|repotify)\s+(?:warnings?|alerts?|blocks?|findings?|prompts?)\b/i,
  /\b(?:disable|turn\s+off|remove|uninstall)\s+(?:the\s+)?(?:repotify\s+)?(?:package\s+)?guard\b/i,
]);
const secretsIntoContext = reAll([
  /\b(?:read|cat|open|load|print|include|paste|output|show|display|dump|copy)\b[^.\n]{0,60}?(?<![\w-])\.env\b(?!\.(?:example|sample|template))[^.\n]{0,80}?\b(?:into|in|to)\s+(?:the\s+|your\s+)?(?:context|conversation|chat|response|reply|output|prompt)\b/i,
]);
const remoteInstructions = reAll([
  /\b(?:fetch|download|read|load|open|retrieve|get|curl|visit|browse)\b[^.\n]{0,80}?https?:\/\/[^\s)>\]"'`]+[^\n]{0,80}?\b(?:and|then)\s+(?:follow|execute|obey|apply|carry\s+out|do|run)\s+(?:the\s+|its\s+|their\s+|those\s+|these\s+|all\s+|any\s+|whatever\s+)?(?:instructions?|steps|directions|commands|prompts?|it\s+says)\b/i,
]);
const authorityClaims = reAll([
  /\b(?:security|company|corporate|organi[sz]ation(?:al)?|compliance|admin(?:istrator)?|system)\s+polic(?:y|ies)\s+(?:requires?|mandates?|demands?|dictates?)\s+(?:that\s+)?(?:you|the\s+(?:agent|assistant|model|ai))\b/i,
  /\b(?:push|force[- ]push|commit|merge|deploy|publish|delete|drop|overwrite)\b[^.\n]{0,60}?\bwithout\s+(?:asking|requesting|waiting)(?:\s+for)?(?:\s+(?:any|a|the|user))?\s+(?:confirmation|permission|approval|review)\b/i,
]);
const agentSends = reAll([
  /\b(?:send|post|upload|submit|transmit|forward|report)\b[^.\n]{0,60}?\b(?:output|contents?|results?|files?|data|secrets?|keys?|tokens?|credentials?|conversation|history|source|code|logs?)\b[^.\n]{0,40}?\bto\s+https?:\/\/[^\s)>\]"'`]+/i,
]);
const destructive = reAll([
  // `chmod -R 777 /`, `chmod --recursive 777 /` and the symbolic equivalent `chmod -R a+rwx /`.
  /\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+|--recursive\s+)?(?:0?777|a\+rwx)\b/,
  // `dd of=/dev/sda …` in any argument order, including virtio (`vda`) and MMC (`mmcblk0`) disks.
  /\bdd\s+[^\n]{0,300}?of=\/dev\/(sd|nvme|hd|vd|mmcblk|disk)/,
  // `nc -e /bin/sh …` hands the network to a shell: the classic reverse shell.
  /\bnc\s+(?:-[a-zA-Z]*e|--exec\b)/,
  /\bmkfs(\.\w+)?\s/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  />\s*\/dev\/(sd[a-z]|nvme\d|disk\d)/,
  /\bformat\s+c:/i,
]);

// "Never ignore security warnings" is the opposite instruction, not a weaker one: a negation the reader can see right
// before the match drops it.
// The same holds for a row of a table whose heading says the rows are what not to do ("| Anti-pattern | Risk | Do
// instead |"): the heading is the visible context of every row under it.
const AVOID_HEADING_RE = /\b(anti-?patterns?|mistakes?|pitfalls?|avoid|don'?ts?|do not|never|bad|wrong|smells?)\b/i;
const MAX_TABLE_ROWS_BACK = 200;
function underAvoidHeading(ctx) {
  const lines = ctx?.lines;
  if (!lines || !/^\s*\|/.test(lines[ctx.i])) return false;
  let top = ctx.i;
  while (top > 0 && ctx.i - top < MAX_TABLE_ROWS_BACK && /^\s*\|/.test(lines[top - 1])) top--;
  return top < ctx.i && AVOID_HEADING_RE.test(lines[top]) && !/<!--|\bhidden\b|display\s*:\s*none/i.test(lines[top]);
}

function notNegated(matches, shown, ctx) {
  if (!matches.length) return matches;
  if (underAvoidHeading(ctx)) return NO_MATCHES;
  const kept = matches.filter((m) => !NEGATION_BEFORE_RE.test(shown.slice(0, m.index)));
  if (matches.overflow) kept.overflow = true;
  return kept;
}

// PowerShell accepts any unambiguous prefix of -EncodedCommand, and -ec.
const ENCODED_FLAG = ["ec", ...Array.from("encodedcommand", (_, n) => "encodedcommand".slice(0, n + 1))].sort((a, b) => b.length - a.length).join("|");
const PS_ENCODED_RE = new RegExp(`\\b(?:powershell|pwsh)(?:\\.exe)?\\b[^\\n|;&]{0,200}?\\s-(?:${ENCODED_FLAG})\\s+['"]?[A-Za-z0-9+/=]{16,}`, "i");

export const LINE_RULES = [
  {
    id: "remote-exec",
    severity: () => "critical",
    // Descriptive words next to a runnable command are written by the item's author: they can send it to human
    // review, but only a negation right before it lowers it to caution.
    strictDocContext: true,
    matches(line, ctx) {
      return mergeMatches(pipeToInterpreter(line, ctx), downloadThenRun(line, ctx), gitCloneThenRun(line, ctx), substitutions(line));
    },
    // `text` is the fetch command itself, so a URL in a comment or elsewhere on the line cannot vouch for it.
    adjust(text) {
      const hosts = urlHosts(statementSpan(text, 0));
      if (!hosts.length) return null;
      if (hosts.every((h) => !h.userinfo && isDocDomain(h.host))) return { severity: "medium", note: "documentation example domain" };
      if (hosts.every((h) => hostAllowed(h, KNOWN_INSTALLER_HOSTS))) {
        return { severity: "medium", note: "official installer: " + hosts.map((h) => h.host).join(", ") };
      }
      return null;
    },
  },
  {
    id: "credential-access",
    severity: () => "critical",
    matches: reAll([
      /~\/\.ssh\b|\$HOME\/\.ssh\b|\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b/,
      /\.aws\/credentials\b|\.netrc\b|\.docker\/config\.json\b|\.kube\/config\b|\.git-credentials\b|\.npmrc\b.{0,300}?_authToken/,
      /(Google\/Chrome|Chromium|BraveSoftware|Microsoft\/Edge|\.mozilla\/firefox|Firefox\/Profiles)[^\n]{0,300}?(Cookies|Login Data|Local State|key4\.db|logins\.json)/i,
      /\b(Login Data|logins\.json|key4\.db)\b/,
      /Library\/Keychains|\bsecurity\s+(find|dump)-(generic-password|internet-password|keychain)\b/,
      /\b(cat|type|less|more|head|tail|source|base64)\s+[^\s|;&]*\.env\b(?!\.example|\.sample|\.template)/,
      /\b(readFile\w*|open|read_text|Get-Content)\s*\(?\s*['"][^'"]*\.env['"]/,
    ]),
  },
  {
    id: "exfiltration",
    severity: () => "critical",
    matches: reAll([EXFIL_DOMAINS_RE]),
  },
  {
    id: "exfiltration",
    severity: () => "high",
    matches: fileUpload,
    adjust(text) {
      if (targetsAllowed(statementSpan(text, 0), KNOWN_API_HOSTS)) return { severity: "low", note: "upload to a known API" };
      return { severity: "high", note: "uploads a local file" };
    },
  },
  {
    id: "prompt-injection",
    severity: () => "high",
    matches(line) {
      // Leet-speak dodge (`ign0re previous instructions`): normalize the obvious substitutions and re-read only the
      // ignore/disregard pattern, keeping the false-positive surface small. The substitution is 1:1, so a span found
      // in the normalized line lines up with the original one.
      const deleet = line.replace(/[013457@]/g, (c) => ({ 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a" })[c]);
      const found = deleet === line ? injections(line) : mergeMatches(injections(line), leetInjections(deleet));
      // Only lines with letters outside ASCII, or with the word for "instructions", can match the other languages.
      return /[^\x00-\x7f]|instrucciones|istruzioni|instructions|anweisungen|instruktionen|befehle/i.test(line) ? mergeMatches(found, foreignInjections(line)) : found;
    },
  },
  {
    // Tells the agent to wave a warning through, or to load secrets into the conversation.
    id: "unsafe-instruction",
    severity: () => "high",
    matches(line, ctx) {
      return notNegated(mergeMatches(warningSuppression(line), secretsIntoContext(line)), ctx?.shown ?? line, ctx);
    },
  },
  {
    // Softer wording that is sometimes legitimate: instructions loaded from a URL nobody vetted, an appeal to
    // authority, an irreversible action without asking, a send of local content through the agent's own tools.
    id: "unsafe-instruction",
    severity: () => "medium",
    matches(line, ctx) {
      return notNegated(mergeMatches(remoteInstructions(line), authorityClaims(line), agentSends(line)), ctx?.shown ?? line, ctx);
    },
    adjust(text) {
      const hosts = urlHosts(text);
      if (hosts.length && hosts.every((h) => !h.userinfo && (isDocDomain(h.host) || hostAllowed(h, KNOWN_API_HOSTS)))) {
        return { severity: "low" };
      }
      return null;
    },
  },
  {
    id: "obfuscation",
    severity: () => "high",
    matches: reAll([
      /\beval\s*\(\s*(atob|Buffer\.from|unescape|decodeURIComponent)\s*\(/,
      /\bexec\s*\(\s*(base64\.b64decode|codecs\.decode|zlib\.decompress|marshal\.loads|bytes\.fromhex)/,
      /\b(new\s+)?Function\s*\(\s*(atob|Buffer\.from)\s*\(/,
      /\bbase64\s+(-d|--decode|-D)\b[^\n]{0,300}?\|\s*(sudo\s+)?(ba|z)?sh\b/,
      /\bString\.fromCharCode\((\s*\d+\s*,){20,}/,
      // PowerShell runs a Base64 string given to -EncodedCommand (any prefix of the name, or -ec).
      PS_ENCODED_RE,
      /\bFromBase64String\b[^\n]{0,300}?\|\s*(?:iex|Invoke-Expression)\b/i,
      /\b(?:iex|Invoke-Expression)\b[^\n]{0,300}?\bFromBase64String\b/i,
    ]),
  },
  {
    id: "dangerous-command",
    severity: (kind) => "high",
    matches(line) {
      return mergeMatches(dangerousRm(line), destructive(line));
    },
  },
  {
    id: "dangerous-command",
    severity: (kind) => (kind === "script" ? "high" : "medium"),
    // Flags between sudo and the command must not hide it: `sudo -n id`, `sudo -u root id`.
    matches: reAll([/(^|[\s;&|(`])sudo(\s+--?[a-zA-Z][\w-]*(=\S+)?)*\s+[a-z]/]),
  },
];

// How a send of data with a secret nearby is judged from its own statement: null when it goes to a known API.
function sendSeverity(statement) {
  if (/^(curl|wget)\b/.test(statement)) {
    if (targetsAllowed(statement, KNOWN_API_HOSTS)) return null;
    return fetchTargets(statement).some((t) => /^https?:\/\//i.test(t)) ? "critical" : "high";
  }
  const hosts = urlHosts(statement);
  if (hosts.length && hosts.every((h) => hostAllowed(h, KNOWN_API_HOSTS))) return null;
  return hosts.length ? "critical" : "high";
}

// Multi-line rule: a network send and a secret within a 3-line window. Only each send statement's own destinations
// count: a known-API URL in a comment or on a neighbouring line cannot vouch for `curl … "$U"`, and a send to a known
// API cannot vouch for another send in the same window. A window with more sends than the scanner reads is sent to
// human review.
export function exfilWindow(lines, i, { comments = false, prose = false } = {}) {
  const window = lines.slice(i, i + 3).join("\n");
  if (!SECRET_RE.test(lines[i]) && !SEND_RES.some((re) => lines[i].search(re) >= 0)) return null;
  if (!SECRET_RE.test(window)) return null;
  let worst = null;
  let sends = 0;
  for (const re of SEND_RES) {
    for (const send of window.matchAll(re)) {
      if (++sends > MAX_LINE_MATCHES) return { severity: worst ?? "high" };
      const severity = sendSeverity(statementSpan(window, send.index, { comments, quotes: !prose }));
      if (severity === "critical") return { severity };
      worst = severity ?? worst;
    }
  }
  return worst ? { severity: worst } : null;
}

// Long high-entropy blob combined with an execution primitive in the same file. Every blob counts: a dull one first
// (a run of padding) must not hide an encoded payload after it.
const BLOB_RE = /[A-Za-z0-9+/=]{200,}|(?:[0-9a-fA-F]{2}){100,}/g;
const EXEC_RE = /\b(eval|exec|Function\(|child_process|subprocess|os\.system|popen|spawn|execSync|Invoke-Expression|FromBase64String)\b/;

export function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function blobWithExec(text) {
  if (!EXEC_RE.test(text)) return null;
  for (const m of text.matchAll(BLOB_RE)) {
    const threshold = /^[0-9a-fA-F]+$/.test(m[0]) ? 3.5 : 4.0;
    if (entropy(m[0]) >= threshold) return { index: m.index };
  }
  return null;
}
