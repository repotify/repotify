// Content rules for the security scanner.
// Each rule inspects one line (or a small window of lines) of a text file. Regexes never use unbounded `[^\n]*`
// between two parts, so scanning stays linear on long lines; shell structure comes from ./shell.mjs.
import { splitPipelines, statementSpan, fetchIndex, downloadTarget, stageRunPaths, runsFileTest, fetchTargets, runsPipedInput, commandWords, baseName, INTERPRETERS } from "./shell.mjs";

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
  /\bcurl\b[^\n]{0,300}\s(-d|--data(-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file)\b/,
  /\bfetch\([\s\S]{0,300}?method\s*:\s*['"`](POST|PUT)['"`]/i,
  /\brequests\.(post|put)\(/,
  /\bhttpx\.(post|put)\(/,
  /\baxios\.(post|put)\(/,
  /\burlopen\([^)]{0,300}data\s*=/,
  /\bnc\s+(-\w+\s+){0,8}[\w.-]+\s+\d{2,5}\b/,
  /Invoke-(WebRequest|RestMethod)[^\n]{0,300}-Method\s+(Post|Put)/i,
  /\bwget\b[^\n]{0,300}--post-(data|file)/,
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
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(host)) continue;
    out.push({ host, url: m[0], hostPath: host + u.pathname, userinfo: Boolean(u.username || u.password) });
  }
  return out;
}

function hostAllowed(h, list) {
  if (h.userinfo) return false;
  return list.some((entry) => {
    if (entry.includes("/")) return h.hostPath.toLowerCase().startsWith(entry.toLowerCase());
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

const GIT_CLONE_RE = /(?:^|[\s;&|(`])git\s+clone\s+(?:--[a-zA-Z-]+=?(?:\S+)?\s+)*(["']?)(https?:\/\/[^'"`\s]+)\1/;

// `git clone <url>` downloads a whole tree; running anything from it within the next few commands is the
// same shape as download-then-run. `cd <dir>` stages are tracked so `cd evil && ./setup.sh` resolves
// inside the clone. Like the curl/wget path, this is aggressive by design: a skill that clones a repo
// and executes its scripts is the attack, whatever the host.
function gitCloneThenRun(line, ctx) {
  const lines = ctx?.lines ?? [line];
  const i = ctx?.i ?? 0;
  const opts = { comments: Boolean(ctx?.comments), prose: Boolean(ctx?.prose) };
  const unq = (t) => t.replace(/^["']|["']$/g, "");
  for (const pipelines of readingsOf(ctx, line)) {
    const own = pipelines.flat();
    for (let k = 0; k < own.length; k++) {
      const g = GIT_CLONE_RE.exec(own[k].text);
      if (!g) continue;
      let dir = "";
      try {
        const seg = new URL(g[2]).pathname.split("/").filter(Boolean).pop() ?? "";
        dir = seg.replace(/\.git$/, "");
      } catch {
        continue;
      }
      if (!dir || dir === "." || dir === ".." || /[/\\]/.test(dir)) continue;
      const later = own.slice(k + 1, k + 1 + RUN_LOOKAHEAD_STAGES);
      for (let j = i + 1; j < Math.min(lines.length, i + 1 + RUN_LOOKAHEAD_LINES) && later.length < RUN_LOOKAHEAD_STAGES; j++) {
        later.push(...splitPipelines(lines[j].slice(0, 2000), opts).flat().slice(0, RUN_LOOKAHEAD_STAGES));
      }
      let cwd = "";
      for (const st of later.slice(0, RUN_LOOKAHEAD_STAGES)) {
        const words = commandWords(st.text);
        if (!words.length) continue;
        if (words[0] === "cd" && words[1] && !words[1].startsWith("-")) {
          const d = unq(words[1]);
          if (d === "/") cwd = "";
          else if (d === "..") cwd = cwd.split("/").slice(0, -1).join("/");
          else if (d.startsWith("/")) cwd = d.replace(/^\//, "");
          else if (!d.includes("..")) cwd = (cwd ? cwd + "/" : "") + d.replace(/^\.\//, "");
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
        }
        if (!fileWord) continue;
        const norm = unq(fileWord).replace(/^\.\//, "");
        const resolved = norm.startsWith("/") ? norm.slice(1) : (cwd ? cwd + "/" : "") + norm;
        if (resolved === dir || resolved.startsWith(dir + "/")) {
          return { index: own[k].start + g.index, length: g[0].trimEnd().length, text: g[0].trim() };
        }
      }
    }
  }
  return null;
}

// `curl …/wget …/irm …` piped into an interpreter, possibly through other stages (`| tee x | sudo -E bash`).
function pipeToInterpreter(line, ctx) {
  for (const pipelines of readingsOf(ctx, line)) {
    for (const stages of pipelines) {
      let first = null;
      for (const stage of stages) {
        if (first && runsPipedInput(stage.text, { prose: Boolean(ctx?.prose) })) {
          const index = first.stage.start + first.at;
          return { index, length: stage.start + stage.text.length - index, text: first.stage.text.slice(first.at) };
        }
        if (!first) {
          const at = fetchIndex(stage.text);
          if (at >= 0) first = { stage, at };
        }
      }
    }
  }
  return null;
}

const RUN_LOOKAHEAD_LINES = 5;
const RUN_LOOKAHEAD_STAGES = 12;

// A download to a file that a later command runs, on the same line or within the next few lines.
function downloadThenRun(line, ctx) {
  const lines = ctx?.lines ?? [line];
  const i = ctx?.i ?? 0;
  const opts = { comments: Boolean(ctx?.comments), prose: Boolean(ctx?.prose) };
  // A stage's run paths are worked out once, however many downloads before it look ahead to it.
  const runPaths = new Map();
  const pathsOf = (st) => {
    let paths = runPaths.get(st);
    if (!paths) runPaths.set(st, (paths = stageRunPaths(st.text)));
    return paths;
  };
  for (const pipelines of readingsOf(ctx, line)) {
    const own = pipelines.flat();
    for (let k = 0; k < own.length; k++) {
      const at = fetchIndex(own[k].text);
      if (at < 0) continue;
      const fetch = own[k].text.slice(at);
      const file = downloadTarget(fetch);
      if (!file) continue;
      const later = own.slice(k + 1, k + 1 + RUN_LOOKAHEAD_STAGES);
      for (let j = i + 1; j < Math.min(lines.length, i + 1 + RUN_LOOKAHEAD_LINES) && later.length < RUN_LOOKAHEAD_STAGES; j++) {
        later.push(...splitPipelines(lines[j].slice(0, 2000), opts).flat().slice(0, RUN_LOOKAHEAD_STAGES));
      }
      const runs = runsFileTest(file);
      if (later.slice(0, RUN_LOOKAHEAD_STAGES).some((st) => runs(pathsOf(st)))) {
        return { index: own[k].start + at, length: fetch.trimEnd().length, text: fetch };
      }
    }
  }
  return null;
}

const SUBSTITUTION_RES = [
  /\b(ba|z|da|k)?sh\s+<\(\s*(curl|wget)\b/i,
  /(?:^|[\s;&|(`])(source|\.)\s+<\(\s*(curl|wget)\b/i,
  /\b(eval|exec)\s+["']?(\$\(|`)\s*(curl|wget)\b/i,
  /\b((ba|z|da|k)?sh|python[23]?|perl|ruby|node|php)\s+(-\w+\s+){0,5}-c\s+["']?(\$\(|`)\s*(curl|wget)\b/i,
  /\b(python[23]?|node|ruby|perl|php)\s+<\(\s*(curl|wget)\b/i,
  /\b(iex|Invoke-Expression)\s*\(*\s*(iwr|irm|Invoke-WebRequest|Invoke-RestMethod|New-Object\s+(System\.)?Net\.WebClient|\[(System\.)?Net\.WebClient\])/i,
  /\bDownloadString\s*\([^)\n]{0,300}\)\s*\)?\s*\|\s*(iex|Invoke-Expression)\b/i,
  /\b(iex|Invoke-Expression)\b[^\n]{0,60}\.DownloadString\s*\(/i,
];

// Uploads of local files: curl -F x=@f / -F x=<f / -d @f / --data-* @f / -T f, wget --post-file, PowerShell -InFile.
// `@-` reads stdin (a heredoc or a pipe), not a local file.
const UPLOAD_CURL_RE = /(?:^|\s)(?:-F|--form)\s*['"]?[\w.-]*=[@<](?!-(?:\s|$|['"]))|(?:^|\s)(?:-d|--data(?:-\w+)?|--json)\s*['"]?@(?!-(?:\s|$|['"]))|(?:^|\s)(?:-T|--upload-file)\s+(?!-(?:\s|$))/;
const UPLOAD_WGET_RE = /(?:^|\s)--post-file[=\s]/;
const UPLOAD_PS_RE = /(?:^|\s)-InFile\s/i;

function fileUpload(line, ctx) {
  for (const stage of readingsOf(ctx, line).flat(2)) {
    const at = fetchIndex(stage.text);
    if (at < 0) continue;
    const fetch = stage.text.slice(at);
    const tool = fetch.split(/\s/, 1)[0].toLowerCase();
    const re = tool === "curl" ? UPLOAD_CURL_RE : tool === "wget" ? UPLOAD_WGET_RE : UPLOAD_PS_RE;
    if (re.test(fetch)) return { index: stage.start + at, length: fetch.trimEnd().length, text: fetch };
  }
  return null;
}

// Line rules: {id, severity(kind) -> severity, test(line) -> match|null}
// `match` is {index, length} of the offending span so documentation context can ignore the span itself.
function reRule(res) {
  return (line) => {
    for (const re of res) {
      const m = re.exec(line);
      if (m) return { index: m.index, length: m[0].length, text: m[0] };
    }
    return null;
  };
}

// `rm` is destructive only with a recursive flag AND a root-level target. Flags can arrive in any order
// (`rm / -rf`, `rm --recursive --force /`), so the flag is searched anywhere in the invocation while the
// target must be a standalone word: `rm -rf /var/lib/apt/lists/*` deletes one glob, not the system.
// The returned span still ends at the target, which the documentation-context logic relies on.
const RM_RECURSIVE_FLAG = /(?:^|\s)(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/;
const RM_DANGEROUS_TARGET = /(?:^|[\s"'])(\/|~|~\/|\$HOME\/?|\/\*|\$\{HOME\}\/?)(?=\s|$|;|&|\||"|')/;

function dangerousRm(line) {
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
    return { index: m.index, length: end, text: rest.slice(0, end) };
  }
  return null;
}

export const LINE_RULES = [
  {
    id: "remote-exec",
    severity: () => "critical",
    // Descriptive words next to a runnable command are written by the item's author: they can send it to human
    // review, but only a negation right before it lowers it to caution.
    strictDocContext: true,
    test(line, ctx) {
      return pipeToInterpreter(line, ctx) ?? downloadThenRun(line, ctx) ?? gitCloneThenRun(line, ctx) ?? reRule(SUBSTITUTION_RES)(line);
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
    test: reRule([
      /~\/\.ssh\b|\$HOME\/\.ssh\b|\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b/,
      /\.aws\/credentials\b|\.netrc\b|\.docker\/config\.json\b|\.kube\/config\b|\.git-credentials\b|\.npmrc\b.{0,300}_authToken/,
      /(Google\/Chrome|Chromium|BraveSoftware|Microsoft\/Edge|\.mozilla\/firefox|Firefox\/Profiles)[^\n]{0,300}(Cookies|Login Data|Local State|key4\.db|logins\.json)/i,
      /\b(Login Data|logins\.json|key4\.db)\b/,
      /Library\/Keychains|\bsecurity\s+(find|dump)-(generic-password|internet-password|keychain)\b/,
      /\b(cat|type|less|more|head|tail|source|base64)\s+[^\s|;&]*\.env\b(?!\.example|\.sample|\.template)/,
      /\b(readFile\w*|open|read_text|Get-Content)\s*\(?\s*['"][^'"]*\.env['"]/,
    ]),
  },
  {
    id: "exfiltration",
    severity: () => "critical",
    test: reRule([EXFIL_DOMAINS_RE]),
  },
  {
    id: "exfiltration",
    severity: () => "high",
    test: fileUpload,
    adjust(text) {
      if (targetsAllowed(statementSpan(text, 0), KNOWN_API_HOSTS)) return { severity: "low", note: "upload to a known API" };
      return { severity: "high", note: "uploads a local file" };
    },
  },
  {
    id: "prompt-injection",
    severity: () => "high",
    test(line, ctx) {
      const match = reRule([
        /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+)?((the|your|my)\s+)?(previous|prior|above|earlier|preceding|system|original)\s+(instructions|prompts?|rules|messages|directions|directives)/i,
        /\byou are now\s+(DAN|no longer|free from|unrestricted|jailbroken|in (developer|god|dan) mode|an? (unrestricted|unfiltered|uncensored))/i,
        /\b(do not|don't|never)\s+(tell|inform|notify|alert|show|reveal (this |it )?to|mention (this |it )?to)\s+(the\s+)?user\b/i,
        /\bwithout\s+(asking|telling|informing|notifying|alerting)\s+(the\s+)?user\b/i,
        /\b(note|message|instructions?)\s+(to|for)\s+(the\s+)?(ai|llm|evaluator|reviewer|grader|judge|scanner|model)\b/i,
        /\b(rate|score|grade|mark)\s+(this|the)\s+(skill|repo|repository|item|plugin|tool)\s+(as\s+)?(\d|high|safe|perfect|verified)/i,
        /\bgive\s+(this|it)\s+(a\s+)?(high|perfect|top|maximum|10|5)\b/i,
        /\b(this|the) (skill|content|file) is (verified|safe|trusted)[^.]*(do not|don't) (scan|flag|review)/i,
      ])(line);
      if (match) return match;
      // Leet-speak dodge (`ign0re previous instructions`): normalize the obvious substitutions and
      // re-test only the ignore/disregard pattern, keeping the false-positive surface small.
      // The substitution is 1:1, so the reported span still lines up with the original line.
      const deleet = line.replace(/[013457@]/g, (c) => ({ 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a" })[c]);
      if (deleet === line) return null;
      return reRule([
        /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+)?((the|your|my)\s+)?(previous|prior|above|earlier|preceding|system|original)\s+(instructions|prompts?|rules|messages|directions|directives)/i,
      ])(deleet);
    },
  },
  {
    id: "obfuscation",
    severity: () => "high",
    test: reRule([
      /\beval\s*\(\s*(atob|Buffer\.from|unescape|decodeURIComponent)\s*\(/,
      /\bexec\s*\(\s*(base64\.b64decode|codecs\.decode|zlib\.decompress|marshal\.loads|bytes\.fromhex)/,
      /\b(new\s+)?Function\s*\(\s*(atob|Buffer\.from)\s*\(/,
      /\bbase64\s+(-d|--decode|-D)\b[^\n]{0,300}\|\s*(sudo\s+)?(ba|z)?sh\b/,
      /\bString\.fromCharCode\((\s*\d+\s*,){20,}/,
    ]),
  },
  {
    id: "dangerous-command",
    severity: (kind) => "high",
    test(line) {
      return dangerousRm(line) ?? reRule([
        // `chmod -R 777 /`, `chmod --recursive 777 /` and the symbolic equivalent `chmod -R a+rwx /`.
        /\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+|--recursive\s+)?(?:0?777|a\+rwx)\b/,
        // `dd of=/dev/sda …` in any argument order, including virtio (`vda`) and MMC (`mmcblk0`) disks.
        /\bdd\s+[^\n]{0,300}of=\/dev\/(sd|nvme|hd|vd|mmcblk|disk)/,
        // `nc -e /bin/sh …` hands the network to a shell: the classic reverse shell.
        /\bnc\s+(?:-[a-zA-Z]*e|--exec\b)/,
        /\bmkfs(\.\w+)?\s/,
        /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
        />\s*\/dev\/(sd[a-z]|nvme\d|disk\d)/,
        /\bformat\s+c:/i,
      ])(line);
    },
  },
  {
    id: "dangerous-command",
    severity: (kind) => (kind === "script" ? "high" : "medium"),
    // Flags between sudo and the command must not hide it: `sudo -n id`, `sudo -u root id`.
    test: reRule([/(^|[\s;&|(`])sudo(\s+--?[a-zA-Z][\w-]*(=\S+)?)*\s+[a-z]/]),
  },
];

// Multi-line rule: a network send and a secret within a 3-line window. Only the send statement's own destinations
// count: a known-API URL in a comment or on a neighbouring line cannot vouch for `curl … "$U"`.
export function exfilWindow(lines, i, { comments = false, prose = false } = {}) {
  const window = lines.slice(i, i + 3).join("\n");
  if (!SECRET_RE.test(lines[i]) && !SEND_RES.some((re) => re.test(lines[i]))) return null;
  if (!SECRET_RE.test(window)) return null;
  const send = SEND_RES.map((re) => re.exec(window)).find(Boolean);
  if (!send) return null;
  const statement = statementSpan(window, send.index, { comments, quotes: !prose });
  if (/^(curl|wget)\b/.test(statement)) {
    if (targetsAllowed(statement, KNOWN_API_HOSTS)) return null;
    return { severity: fetchTargets(statement).some((t) => /^https?:\/\//i.test(t)) ? "critical" : "high" };
  }
  const hosts = urlHosts(statement);
  if (hosts.length && hosts.every((h) => hostAllowed(h, KNOWN_API_HOSTS))) return null;
  return { severity: hosts.length ? "critical" : "high" };
}

// Long high-entropy blob combined with an execution primitive in the same file.
const BLOB_RE = /[A-Za-z0-9+/=]{200,}|(?:[0-9a-fA-F]{2}){100,}/;
const EXEC_RE = /\b(eval|exec|Function\(|child_process|subprocess|os\.system|popen|spawn|execSync)\b/;

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
  const m = BLOB_RE.exec(text);
  if (!m) return null;
  const threshold = /^[0-9a-fA-F]+$/.test(m[0]) ? 3.5 : 4.0;
  if (entropy(m[0]) < threshold) return null;
  if (!EXEC_RE.test(text)) return null;
  return { index: m.index };
}
