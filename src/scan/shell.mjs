// Minimal, linear-time shell reading for the scanner: pipelines, the statement around a match, command words.
// It is deliberately forgiving: skill text mixes prose, Markdown and shell, and a wrong split must fail open to
// "another command starts here", never to "this is all one harmless string".

const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "time", "builtin", "nice", "xargs"]);
const WRAPPER_FLAGS_WITH_VALUE = new Set(["-u", "-g", "-C", "-h", "-p", "-U", "-n"]);

export const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "python", "python2", "python3", "perl", "ruby", "node",
  "php", "iex", "invoke-expression", "pwsh", "powershell",
]);
const SOURCE_WORDS = new Set(["source", "."]);

// Splits text into pipelines of stages. `|` separates stages; `;`, `&&`, `||`, `&` and newlines end a pipeline;
// `$(`, `<(`, `(`, `)` and backticks open or close a nested command, which also starts a new pipeline. Quotes are
// respected, except that `$(` and backticks inside double quotes still run (as in the shell). A `\` at the end of a
// line continues it. With `comments`, an unquoted `#` at the start of a word ends the line. With `prose`, quotes
// outside inline code are apostrophes and quotation marks, not shell quotes.
export function splitPipelines(text, { comments = false, prose = false, quotes: useQuotes = true } = {}) {
  // In a Markdown table row the top-level `|` separates cells, while `\|` is a pipe shown to the reader.
  const table = prose && /^\s*\|/.test(text);
  const pipelines = [];
  let stages = [];
  let stageStart = 0;
  const ctx = []; // "dq" double quotes, "(" nested command, "bt" backticks
  let inSingle = false;
  const endStage = (end) => {
    const t = text.slice(stageStart, end);
    if (t.trim()) stages.push({ text: t, start: stageStart });
  };
  const endPipeline = (end, next) => {
    endStage(end);
    if (stages.length) pipelines.push(stages);
    stages = [];
    stageStart = next;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const top = ctx[ctx.length - 1];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (top === "dq") {
      if (c === "\\") i++;
      else if (c === '"') ctx.pop();
      else if (c === "$" && text[i + 1] === "(") {
        ctx.push("(");
        endPipeline(i, i + 2);
        i++;
      } else if (c === "`") {
        ctx.push("bt");
        endPipeline(i, i + 1);
      }
      continue;
    }
    const quotes = useQuotes && (!prose || ctx.length > 0);
    if (c === "\\") {
      if (prose && ctx.length === 0 && text[i + 1] === "|") {
        endStage(i);
        stageStart = i + 2;
      }
      i++;
    } else if (c === "'" && quotes) {
      inSingle = true;
    } else if (c === '"' && quotes) {
      ctx.push("dq");
    } else if (c === "`") {
      if (top === "bt") ctx.pop();
      else ctx.push("bt");
      endPipeline(i, i + 1);
    } else if ((c === "$" || c === "<" || c === ">") && text[i + 1] === "(") {
      ctx.push("(");
      endPipeline(i, i + 2);
      i++;
    } else if (c === "(") {
      ctx.push("(");
      endPipeline(i, i + 1);
    } else if (c === ")") {
      if (top === "(") ctx.pop();
      endPipeline(i, i + 1);
    } else if (c === "|") {
      if (table && ctx.length === 0) {
        endPipeline(i, i + 1);
      } else if (text[i + 1] === "|") {
        endPipeline(i, i + 2);
        i++;
      } else {
        endStage(i);
        if (text[i + 1] === "&") i++;
        stageStart = i + 1;
      }
    } else if (c === "&") {
      // `2>&1`, `>&2` and `&>file` are redirections, not command separators.
      if (text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">") continue;
      endPipeline(i, text[i + 1] === "&" ? i + 2 : i + 1);
      if (text[i + 1] === "&") i++;
    } else if (c === ";" || c === "\n") {
      endPipeline(i, i + 1);
    } else if (comments && c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      const nl = text.indexOf("\n", i);
      const stop = nl < 0 ? text.length : nl;
      endPipeline(i, stop);
      i = stop - 1;
    }
  }
  endPipeline(text.length, text.length);
  return pipelines;
}

// The statement a match belongs to, from `index` to where it ends: an unquoted `;`, `|`, `&`, newline or backtick
// at bracket depth 0, a closing bracket that was opened before `index`, or (with `comments`) a comment. Brackets
// opened after `index` are followed, so `fetch("https://…", {…})` keeps its URL.
export function statementSpan(text, index, { comments = false, quotes = true } = {}) {
  let depth = 0;
  let quote = null;
  for (let i = index; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if ((c === "'" || c === '"') && quotes) quote = c;
    else if (c === "`") {
      if (depth === 0) return text.slice(index, i);
      quote = c;
    } else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      if (depth === 0) return text.slice(index, i);
      depth--;
    } else if (c === "\\" && text[i + 1] === "\n") i++;
    else if (depth === 0 && (c === ";" || c === "|" || c === "&" || c === "\n")) return text.slice(index, i);
    else if (comments && /\s/.test(text[i - 1] ?? " ") && (c === "#" || (c === "/" && text[i + 1] === "/"))) {
      return text.slice(index, i);
    }
  }
  return text.slice(index);
}

const unquote = (t) => t.replace(/^["']|["']$/g, "");

// Splits a command into words, keeping quoted text (with its spaces) as one word and dropping the quotes.
export function shellWords(text) {
  const words = [];
  let cur = "";
  let has = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) words.push(cur);
  return words;
}

// Words of a stage after wrappers such as `sudo -E`, `env X=1`, `/usr/bin/env` and leading assignments.
export function commandWords(stageText) {
  const words = shellWords(stageText.trim().replace(/^[({!]\s*/, ""));
  let i = 0;
  let wrapped = false;
  while (i < words.length) {
    const w = words[i];
    const base = baseName(w);
    if (/^[A-Za-z_]\w*=/.test(w)) {
      i++;
      continue;
    }
    if (WRAPPERS.has(base)) {
      wrapped = true;
      i++;
      continue;
    }
    if (wrapped && w.startsWith("-")) {
      i += WRAPPER_FLAGS_WITH_VALUE.has(w) ? 2 : 1;
      continue;
    }
    break;
  }
  return words.slice(i).map(unquote);
}

export function baseName(word) {
  const w = unquote(word);
  const parts = w.split(/[\\/]/);
  return parts[parts.length - 1].toLowerCase().replace(/\.exe$/, "").replace(/\.$/, "");
}

// The command word of a stage (`bash` for `| sudo -E /bin/bash -s`).
export function commandName(stageText) {
  const w = commandWords(stageText)[0];
  return w ? baseName(w) : "";
}

const FETCH_RE = /(?:^|[\s("'])(curl|wget|irm|iwr|Invoke-WebRequest|Invoke-RestMethod)(?=\s|$)/i;
const FETCH_TOOLS = new Set(["curl", "wget", "irm", "iwr", "invoke-webrequest", "invoke-restmethod"]);

// The names a command word can stand for. The shell drops quotes and escapes inside a word (`c'u'rl`, `c\url` and
// `\curl` all run curl) and a path runs its last segment (`/usr/bin/curl`, `C:\tools\curl.exe`). A backslash is an
// escape in a POSIX shell and a separator on Windows, so both readings are returned.
export function commandReadings(word) {
  const bare = word.replace(/['"]/g, "");
  const asPath = baseName(bare);
  if (!bare.includes("\\")) return [asPath];
  const asEscape = baseName(bare.replace(/\\/g, ""));
  return asEscape === asPath ? [asPath] : [asPath, asEscape];
}

// The fetch tool a command word runs (`curl` for `c'u'rl`, `\curl`, `/usr/bin/curl`), or null.
export function fetchToolOf(word) {
  return commandReadings(word ?? "").find((n) => FETCH_TOOLS.has(n)) ?? null;
}

// A word that may hide a fetch tool behind quotes, escapes or a path. One linear pass; only reached when the plain
// reading found nothing.
const FETCH_WORD_RE = /(?:^|[\s(])([\w.:~\\/'"-]{3,200})(?=\s|$)/g;

// Index of a fetch command inside a stage, or -1. Prose may precede it ("First run: curl …"). The plain spelling is
// tried first; the second pass reads each word the way the shell does, so `c'u'rl … | sh` is the same finding as
// `curl … | sh`.
export function fetchIndex(stageText) {
  const m = FETCH_RE.exec(stageText);
  if (m) return m.index + m[0].length - m[1].length;
  if (!/['"\\/]/.test(stageText)) return -1;
  FETCH_WORD_RE.lastIndex = 0;
  let w;
  while ((w = FETCH_WORD_RE.exec(stageText)) !== null) {
    if (fetchToolOf(w[1])) return w.index + w[0].length - w[1].length;
  }
  return -1;
}

// The file a fetch command writes, if any: curl -o/--output/-O, wget -O/--output-document or wget's default name.
export function downloadTarget(fetchText) {
  const words = shellWords(fetchText);
  const tool = fetchToolOf(words[0]) ?? words[0].toLowerCase();
  const urls = words.filter((w) => /^https?:\/\//i.test(w));
  const remoteName = () => {
    if (!urls.length) return null;
    try {
      const name = new URL(urls[0]).pathname.split("/").pop();
      return name || null;
    } catch {
      return null;
    }
  };
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (tool === "curl") {
      if (w === "--output" || w === "-o") return words[i + 1] ?? null;
      if (w.startsWith("--output=")) return w.slice(9);
      if (w === "-O" || w === "--remote-name") return remoteName();
      if (/^-[a-zA-Z]+$/.test(w) && !w.startsWith("--")) {
        if (w.endsWith("o")) return words[i + 1] ?? null;
        if (w.includes("O")) return remoteName();
      }
    } else if (tool === "wget") {
      if (w === "-O") return words[i + 1] === "-" ? null : words[i + 1] ?? null;
      if (/^-O./.test(w)) return w.slice(2) === "-" ? null : w.slice(2);
      if (w.startsWith("--output-document=")) return w.slice(18) === "-" ? null : w.slice(18);
      if (/^-[a-zA-Z]*O$/.test(w)) return words[i + 1] === "-" ? null : words[i + 1] ?? null;
    } else if (/^-outfile$/i.test(w)) {
      return words[i + 1] ?? null;
    }
  }
  if (tool === "wget" && !words.some((w) => /^-[a-zA-Z]*q?O/.test(w) && w !== "-q")) return remoteName();
  // `curl URL > file` writes the download to `file` just like `-o` does; without this,
  // `curl … > x.sh` followed by `bash x.sh` slips past the download-then-run check.
  if (tool === "curl" || tool === "wget") {
    for (let i = 1; i < words.length; i++) {
      if (/^(1?>|>>)$/.test(words[i]) && words[i + 1] && !words[i + 1].startsWith("-")) return words[i + 1];
    }
  }
  return null;
}

const normPath = (p) => unquote(p).replace(/^\.[\\/]/, "");

// A path as `runsFile` compares it: the normalized path and its base name.
export const runPath = (w) => {
  const path = normPath(w);
  return { path, base: baseName(path) };
};

// The paths a stage would run: its command word (`./file`) and, after an interpreter or `source`/`.`, the first
// non-option argument (`bash file`). Worked out once per stage, so one stage can be checked against many downloads.
export function stageRunPaths(stageText) {
  const words = commandWords(stageText);
  if (!words.length) return [];
  const paths = [runPath(words[0])];
  if (INTERPRETERS.has(baseName(words[0])) || SOURCE_WORDS.has(words[0])) {
    const arg = words.slice(1).find((w) => !w.startsWith("-"));
    if (arg) paths.push(runPath(arg));
  }
  return paths;
}

// A test of a stage's run paths (from `stageRunPaths`) for running `file`, built once per downloaded file.
export function runsFileTest(file) {
  if (!file) return () => false;
  const want = runPath(file);
  return (paths) => paths.some((p) => p.path === want.path || (p.base.length > 0 && p.base === want.base));
}

// True when the stage runs `file`: `bash file`, `source file`, `. file`, `python3 file` or `./file` itself.
export function runsFile(stageText, file) {
  return runsFileTest(file)(stageRunPaths(stageText));
}

const CURL_VALUE_FLAGS = new Set([
  "-H", "--header", "-d", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json", "-F", "--form",
  "--form-string", "-u", "--user", "-o", "--output", "-X", "--request", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie",
  "-c", "--cookie-jar", "-T", "--upload-file", "-w", "--write-out", "-m", "--max-time", "--connect-timeout", "--retry",
  "--retry-delay", "--retry-max-time", "-x", "--proxy", "-U", "--proxy-user", "-E", "--cert", "--key", "--cacert", "--capath",
  "-K", "--config", "--resolve", "--connect-to", "-r", "--range", "-z", "--time-cond", "--limit-rate", "-Y", "-y", "-C",
  "--continue-at", "--interface", "--dns-servers", "--max-filesize", "--max-redirs", "--oauth2-bearer", "--aws-sigv4", "-Q",
  "--quote", "--netrc-file", "--output-dir",
]);
const WGET_VALUE_FLAGS = new Set(["-O", "-o", "-a", "-e", "-P", "-t", "-T", "-U", "-i", "--header", "--post-data", "--post-file", "--user", "--password", "--user-agent"]);
const CLUSTER_VALUE = /[HdFuoXAebcTwmxUEKrzYyCQ]$/;

// The destinations a curl or wget command talks to: every argument that is not an option or an option's value.
export function fetchTargets(statement) {
  const words = shellWords(statement);
  const tool = fetchToolOf(words[0]) ?? baseName(words[0] ?? "");
  const values = tool === "wget" ? WGET_VALUE_FLAGS : CURL_VALUE_FLAGS;
  const out = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const redirect = /^(\d?[<>]{1,2}|&>|<<-?|<<<)(.*)$/.exec(w);
    if (redirect) {
      if (!redirect[2]) i++;
      continue;
    }
    if (w === "--url") {
      if (words[i + 1]) out.push(words[i + 1]);
      i++;
    } else if (w.startsWith("--")) {
      if (!w.includes("=") && values.has(w)) i++;
    } else if (w.startsWith("-") && w.length > 1) {
      if (values.has(w) || (tool === "curl" && CLUSTER_VALUE.test(w))) i++;
    } else if (w) {
      out.push(w);
    }
  }
  return out;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);
const CODE_FLAGS = new Set(["-c", "-e", "-E", "-m", "-p", "-r", "--eval", "--print", "-command", "-encodedcommand", "-file", "-f"]);
const RUNS_INPUT_RE = /\b(exec|eval|source|compile|Function|system|popen|spawn|execSync|Invoke-Expression|iex)\b|\/dev\/stdin|\$\(\s*cat\s*\)/i;

// True when an interpreter stage runs its piped input as code: `bash`, `bash -s`, `python3 -`, `iex`, `pwsh -Command -`.
// `python3 -c "…json.load(sys.stdin)…"` or `python3 tool.py` read the input as data, unless the inline code
// itself executes it (`exec(sys.stdin.read())`, `source /dev/stdin`).
// `xargs`/`parallel` hand each input line to a command: `curl … | xargs -I{} sh -c {}` is remote execution,
// and `>(sh)` feeds the stage's output to a shell as stdin.
// In prose (`prose: true`) only a path-like word counts as a script argument: "… | bash now." still runs the input.
export function runsPipedInput(stageText, { prose = false } = {}) {
  // `xargs`/`parallel` are in WRAPPERS so commandWords strips them: check the raw words first.
  // `curl … | xargs -I{} sh -c {}` runs each fetched line as a shell command.
  const raw = shellWords(stageText.trim());
  const rawName = baseName(raw[0] ?? "");
  if (rawName === "xargs" || rawName === "parallel") {
    return raw.slice(1).some((w) => INTERPRETERS.has(baseName(w.replace(/^[`'"]+|[`'"]+$/g, ""))));
  }
  const words = commandWords(stageText);
  // `pyth\on` and `b'a'sh` are interpreters too: take the reading that is one.
  const readings = commandReadings(words[0] ?? "");
  const name = readings.find((n) => INTERPRETERS.has(n)) ?? readings[0];
  // `curl … | tee >(sh)`: process substitution feeds the output to a shell's stdin.
  if (/>[ \t]*\(\s*(ba|z|da|k)?sh\b/i.test(stageText)) return true;
  if (!INTERPRETERS.has(name)) return false;
  if (name === "iex" || name === "invoke-expression") return true;
  const args = words.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    const lower = a.toLowerCase();
    if (SHELLS.has(name) && /^-[a-z]*s[a-z]*$/.test(a)) return true;
    const cluster = /^-[a-zA-Z]+$/.test(a) && !a.startsWith("--") && !(name === "pwsh" || name === "powershell");
    if (CODE_FLAGS.has(lower) || (cluster && /[ce]/.test(a.slice(1)) && !SHELLS.has(name)) || (cluster && SHELLS.has(name) && a.includes("c"))) {
      const code = args[i + 1] ?? "";
      if (code === "-") return true;
      return RUNS_INPUT_RE.test(code);
    }
    if (!a.startsWith("-")) {
      if (a === "-") return true;
      if (!prose || /[\\/]/.test(a) || /\.(py|js|mjs|cjs|ts|sh|bash|zsh|rb|pl|php|ps1)$/i.test(a)) return false;
    }
  }
  return true;
}
