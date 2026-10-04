import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  LINE_RULES, DOC_CONTEXT_RE, NEGATION_BEFORE_RE, DETECTION_FENCES, MAX_LINE_MATCHES, fileKind, isHiddenChar, isTagChar,
  isBidiChar, isZeroWidth, exfilWindow, blobWithExec,
} from "./rules.mjs";
import { splitPipelines } from "./shell.mjs";
import { fileRules, isBinaryFile, hostsInScript, NETWORK_ALLOWLIST } from "./files.mjs";

export const SCANNER_VERSION = "1.5.1";

const RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const MAX_FINDINGS_PER_RULE_PER_FILE = 10;

export function levelFromFindings(findings) {
  let top = -1;
  for (const f of findings) top = Math.max(top, RANK[f.severity] ?? -1);
  if (top === 3) return "rejected";
  if (top === 2) return "quarantined";
  if (top === 1) return "caution";
  return "verified";
}

export function escapeInvisible(text) {
  let out = "";
  let offset = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (isHiddenChar(cp, offset === 0 ? -1 : offset) || cp < 0x20 && ch !== "\t") {
      out += `\\u{${cp.toString(16).toUpperCase()}}`;
    } else {
      out += ch;
    }
    offset += ch.length;
  }
  return out;
}

// Only a short window is escaped: a finding on a long line must not cost the whole line (one finding per hidden
// character on a 100 KB line was quadratic and hung the scan).
function excerptOf(line, index = 0) {
  const start = Math.max(0, Math.min(index, line.length) - 20);
  const clean = escapeInvisible(line.slice(start, start + 160).trimStart());
  return clean.length > 80 ? clean.slice(0, 79) + "…" : clean;
}

// True when the match sits between a pair of quotes, e.g. `x = "; rm -rf /"`.
function inQuotes(line, match) {
  const end = match.index + match.length;
  for (const q of ['"', "'"]) {
    const open = line.lastIndexOf(q, match.index - 1);
    if (open < 0 || /\w/.test(line[open - 1] ?? "")) continue;
    const close = line.indexOf(q, end - 1 >= open + 1 ? end - 1 : end);
    if (close >= end - 1 && close > open && !/\w/.test(line[close + 1] ?? "")) return true;
  }
  return false;
}

// A documentation word must come before the match ("Never run …", "e.g. …"). A quoted example also
// counts when a documentation word appears anywhere on the line. Inline code alone does not demote:
// it is the normal way a skill tells the agent which command to run.
function docContext(line, match) {
  if (DOC_CONTEXT_RE.test(line.slice(0, match.index))) return true;
  const outside = line.slice(0, match.index) + " " + line.slice(match.index + match.length);
  return inQuotes(line, match) && DOC_CONTEXT_RE.test(outside);
}

const SHELL_FENCES = new Set(["bash", "sh", "shell", "zsh", "console", "powershell", "ps1", "pwsh", "cmd", "bat", "fish", "terminal", "shell-session"]);

// Per-line fence info for Markdown: language, whether the fence is properly closed, fence marker lines.
function fenceMap(lines) {
  const info = lines.map(() => ({ lang: null, closed: false, marker: false }));
  let open = -1;
  let lang = null;
  for (let i = 0; i < lines.length; i++) {
    if (open < 0) {
      const m = /^\s*(```|~~~)\s*([\w+-]*)/.exec(lines[i]);
      if (m) {
        open = i;
        lang = m[2].toLowerCase();
        info[i].marker = true;
      }
    } else if (/^\s*(```|~~~)\s*$/.test(lines[i])) {
      for (let k = open + 1; k < i; k++) info[k] = { lang, closed: true, marker: false };
      info[i].marker = true;
      open = -1;
    }
  }
  if (open >= 0) for (let k = open + 1; k < lines.length; k++) info[k] = { lang, closed: false, marker: false };
  return info;
}

const PICTOGRAPHIC_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}]/u;
const NON_LATIN_LETTER_RE = /[^\P{L}a-zA-Z]/u;

// Classifies hidden characters. Returns findings and the text with hidden characters removed,
// so the line rules below cannot be dodged by splitting a keyword with a zero-width character.
function hiddenCharFindings(text) {
  const cps = Array.from(text);
  const findings = [];
  const keep = [];
  let line = 1;
  let offset = 0;
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    const cp = ch.codePointAt(0);
    if (ch === "\n") line++;
    if (cp === 0x1f3f4) {
      // Subdivision flags: black flag + tag letters + cancel tag.
      let j = i + 1;
      while (j < cps.length && j - i <= 8 && isTagChar(cps[j].codePointAt(0)) && cps[j].codePointAt(0) !== 0xe007f) j++;
      if (j < cps.length && cps[j].codePointAt(0) === 0xe007f && j > i + 1) {
        for (let k = i; k <= j; k++) keep.push(cps[k]);
        offset += cps.slice(i, j + 1).join("").length;
        i = j;
        continue;
      }
    }
    if (isTagChar(cp)) {
      findings.push({ rule: "hidden-unicode", severity: "critical", line, note: "invisible Unicode tag character" });
    } else if (isBidiChar(cp)) {
      findings.push({ rule: "hidden-unicode", severity: "critical", line, note: "bidirectional override" });
    } else if (isZeroWidth(cp, offset)) {
      let j = i;
      let o = offset;
      while (j < cps.length && isZeroWidth(cps[j].codePointAt(0), o)) {
        o += cps[j].length;
        j++;
      }
      const run = j - i;
      const prev = cps[i - 1] ?? "";
      const next = cps[j] ?? "";
      const joinsEmoji = run <= 2 && PICTOGRAPHIC_RE.test(prev) && PICTOGRAPHIC_RE.test(next);
      const joinsScript = run === 1 && (cp === 0x200c || cp === 0x200d) && NON_LATIN_LETTER_RE.test(prev) && NON_LATIN_LETTER_RE.test(next);
      if (run >= 3) {
        findings.push({ rule: "hidden-unicode", severity: "critical", line, note: `run of ${run} zero-width characters` });
      } else if (!joinsEmoji && !joinsScript) {
        findings.push({ rule: "hidden-unicode", severity: "medium", line, note: "zero-width character" });
      }
      if (joinsEmoji || joinsScript) for (let k = i; k < j; k++) keep.push(cps[k]);
      offset = o;
      i = j - 1;
      continue;
    }
    if (!isTagChar(cp) && !isBidiChar(cp)) keep.push(ch);
    offset += ch.length;
  }
  return { findings, clean: keep.join("") };
}

const COMMENT_RE = /^\s*(#(?!!)|\/\/|--\s|;|REM\s|\*|\/\*)/i;
const PRINT_RE = /^\s*(echo|printf|print\s*\(|console\.(log|error|warn)\s*\(|Write-(Host|Output)|puts|say)\b/;

// A print statement is documentation only when nothing else runs on the line. `$(…)` and backticks run even
// inside double quotes, so only single-quoted text is ignored for those.
function isPurePrint(line) {
  if (!PRINT_RE.test(line)) return false;
  const unsingle = line.replace(/'[^']*'/g, "");
  if (/`|\$\(/.test(unsingle)) return false;
  const bare = unsingle.replace(/"(\\.|[^"\\])*"/g, "");
  return !/[;&|>]/.test(bare);
}

// Joins lines ending in a `\` continuation, keeping the number of the first physical line. The shell joins them with
// nothing in between, so a command split inside a word (`cu\` + `rl … | sh`) is read as the command it runs; joining
// with a space hid it. `shadow` is a second copy of the lines (same lengths) that is joined the same way.
// In Markdown a trailing `\` is also a hard line break: when the join glues two words together, the lines after the
// break are read on their own as well, so neither reading hides a command.
function logicalLines(lines, shadow = lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let text = lines[i];
    let shadowText = shadow[i];
    let glued = false;
    while (/(^|[^\\])(\\\\)*\\$/.test(text) && i + 1 < lines.length) {
      if (/\S\\$/.test(text) && /^\S/.test(lines[i + 1])) glued = true;
      shadowText = shadowText.slice(0, text.length - 1) + shadow[i + 1];
      text = text.slice(0, -1) + lines[++i];
    }
    out.push({ text, line: start, shadow: shadowText });
    if (glued) for (let k = start + 1; k <= i; k++) out.push({ text: lines[k], line: k, shadow: shadow[k] });
  }
  return out;
}

// Markdown the reader never sees but the agent reads: HTML comments, link-reference "comments" (`[//]: # (…)`) and
// elements hidden with `hidden` or `display:none`. Returns the lines with those spans blanked (same lengths) and, per
// line, the hidden spans. Words inside them cannot vouch for a command ("<!-- Never run --> curl … | sh" showed the
// reader a bare command and the scanner a warning), and a command inside them is never documentation.
const LINK_COMMENT_RE = /^\s{0,3}\[[^\]\n]{0,200}\]:\s*(?:#|<>)(?:\s|$)/;
const HIDDEN_ELEMENT_RE = /<([a-z][a-z0-9]*)\b[^>\n]{0,300}?(?:\shidden(?=[\s=>/])|display\s*:\s*none)[^>\n]{0,300}?>/gi;
function hideInvisible(lines, fences) {
  const shown = [];
  const spans = [];
  let open = false;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const own = [];
    if (fences[n].lang !== null || fences[n].marker) {
      // Inside a code fence everything is shown literally.
      open = false;
    } else if (!open && LINK_COMMENT_RE.test(line)) {
      own.push([0, line.length]);
    } else {
      let at = 0;
      while (at < line.length) {
        if (open) {
          const end = line.indexOf("-->", at);
          own.push([at, end < 0 ? line.length : end + 3]);
          if (end < 0) break;
          open = false;
          at = end + 3;
        } else {
          const start = line.indexOf("<!--", at);
          if (start < 0) break;
          open = true;
          own.push([start, start + 4]);
          at = start + 4;
        }
      }
      HIDDEN_ELEMENT_RE.lastIndex = 0;
      let m;
      while ((m = HIDDEN_ELEMENT_RE.exec(line)) !== null) {
        const close = line.toLowerCase().indexOf(`</${m[1].toLowerCase()}`, m.index + m[0].length);
        const end = close < 0 ? line.length : close;
        own.push([m.index, end]);
        HIDDEN_ELEMENT_RE.lastIndex = Math.max(end, m.index + m[0].length);
      }
    }
    spans.push(own);
    if (!own.length) {
      shown.push(line);
      continue;
    }
    let out = "";
    let last = 0;
    for (const [a, b] of own.slice().sort((x, y) => x[0] - y[0])) {
      if (b <= last) continue;
      out += line.slice(last, Math.max(a, last)) + " ".repeat(b - Math.max(a, last));
      last = b;
    }
    shown.push(out + line.slice(last));
  }
  return shown;
}

// Effective kind of one line: comments and pure print statements in scripts read like documentation.
function lineKind(fileKindValue, line) {
  if (fileKindValue === "script" && (COMMENT_RE.test(line) || isPurePrint(line))) return "doc";
  if (fileKindValue === "detection") return "doc";
  return fileKindValue;
}

function scanText(path, text) {
  const findings = [];
  const kind = fileKind(path, text);
  // Excerpts are built only for the findings that are kept (see capPerRule).
  const push = (f) => findings.push(f);

  const originalLines = text.split("\n");
  const hidden = hiddenCharFindings(text);
  for (const f of hidden.findings) push({ ...f, excerpt: () => excerptOf(originalLines[f.line - 1] ?? "") });

  const physical = hidden.clean.split("\n");
  const fences = kind === "doc" ? fenceMap(physical) : null;
  const logical = logicalLines(physical, fences ? hideInvisible(physical, fences) : physical);
  const lines = logical.map((l) => l.text);
  const shellLines = [];
  const shellOpts = (f) => {
    const inShellFence = Boolean(f && f.lang !== null && SHELL_FENCES.has(f.lang));
    return { inShellFence, comments: kind === "script" || inShellFence, prose: kind === "doc" && !(f && f.lang !== null) };
  };
  // Each line is split into pipelines once per reading, however many lines before it look ahead to it.
  const split = [];
  const pipelinesOf = (j, opts) => {
    const cache = (split[(opts.comments ? 1 : 0) | (opts.prose ? 2 : 0) | (opts.quotes === false ? 4 : 0)] ??= []);
    return (cache[j] ??= splitPipelines(lines[j], opts));
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = logical[i].line + 1;
    const f = fences?.[logical[i].line];
    if (f?.marker) continue;
    const { inShellFence, comments, prose } = shellOpts(f);
    if (inShellFence) shellLines.push(line);
    const effective = lineKind(kind, line);
    const forcedDoc = kind === "detection" || Boolean(f && f.closed && DETECTION_FENCES.has(f.lang));
    const mayDemote = effective === "doc" && !inShellFence;
    // What the reader sees of this line: documentation words count only there.
    const shown = logical[i].shadow;
    const ctx = { lines, i, comments, prose, shown, pipelinesOf, readings: [pipelinesOf(i, { comments, prose }), pipelinesOf(i, { comments, prose, quotes: false })] };
    for (const rule of LINE_RULES) {
      const matches = rule.matches(line, ctx);
      if (!matches.length && !matches.overflow) continue;
      const full = rule.severity(effective);
      // Every match on the line is judged and the most severe is reported: an official installer, an allowed API or a
      // documented example early on a line must not vouch for a different command later on it.
      let worst = null;
      for (const m of matches.slice(0, MAX_LINE_MATCHES)) {
        let severity = full;
        let note;
        const adjusted = rule.adjust?.(m.text, line);
        if (adjusted) ({ severity, note } = adjusted);
        // A match the reader cannot see (inside an HTML comment or a hidden element) is an instruction to the agent
        // alone: nothing around it makes it documentation.
        const unseen = shown !== line && shown.slice(m.index, m.index + Math.max(m.length ?? 1, 1)).trim() === "";
        if (mayDemote && !unseen && RANK[severity] > RANK.medium && (forcedDoc || docContext(shown, m))) {
          const strict = rule.strictDocContext && severity === "critical" && !forcedDoc;
          severity = strict && !NEGATION_BEFORE_RE.test(shown.slice(0, m.index)) ? "high" : "medium";
          note = severity === "high" ? "documentation context; needs human review" : "documentation context";
        }
        if (!worst || RANK[severity] > RANK[worst.severity]) worst = { m, severity, note };
        if (RANK[severity] >= RANK[full]) break;
      }
      // More matches than the scanner reads on one line: the unread ones are not assumed harmless.
      const capped = RANK[full] > RANK.high ? "high" : full;
      if ((matches.overflow || matches.length > MAX_LINE_MATCHES) && (!worst || RANK[worst.severity] < RANK[capped])) {
        const at = worst?.m ?? matches[0] ?? { index: 0 };
        worst = { m: at, severity: capped, note: "more matches on one line than the scanner reads; needs human review" };
      }
      if (!worst || (worst.severity === "low" && !worst.note)) continue;
      const { m, severity, note } = worst;
      push({ rule: rule.id, severity, line: lineNo, excerpt: () => excerptOf(line, m.index), ...(note ? { note } : {}) });
    }
  }

  // Shell snippets in Markdown are run by agents as-is: list the hosts they contact, like scripts.
  if (shellLines.length) {
    const unknown = hostsInScript(shellLines.join("\n")).filter((h) => !NETWORK_ALLOWLIST.some((a) => h === a || h.endsWith("." + a)));
    if (unknown.length) push({ rule: "network-call", severity: "medium", line: 0, excerpt: "network call in a shell snippet", note: "domains: " + unknown.join(", ") });
  }

  for (let i = 0; i < lines.length; i++) {
    const { comments, prose } = shellOpts(fences?.[logical[i].line]);
    const hit = exfilWindow(lines, i, { comments, prose });
    if (hit) {
      const at = lines[i];
      push({ rule: "exfiltration", severity: hit.severity, line: logical[i].line + 1, excerpt: () => excerptOf(at), note: "network send with secret" });
      i += 2;
    }
  }

  const blob = blobWithExec(hidden.clean);
  if (blob) {
    const blobLine = hidden.clean.slice(0, blob.index).split("\n").length;
    push({ rule: "obfuscation", severity: "high", line: blobLine, excerpt: "high-entropy blob with code execution", note: "encoded payload" });
  }
  return capPerRule(findings).map((f) => ({ file: path, ...f, excerpt: typeof f.excerpt === "function" ? f.excerpt() : f.excerpt }));
}

// At most MAX_FINDINGS_PER_RULE_PER_FILE findings per rule, and always the most severe ones: keeping the first ones
// let ten harmless mentions of a pattern hide a critical one further down, and the file's level is computed from
// what is kept.
function capPerRule(findings) {
  const groups = new Map();
  findings.forEach((f, order) => {
    if (!groups.has(f.rule)) groups.set(f.rule, []);
    groups.get(f.rule).push({ f, order });
  });
  const kept = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (RANK[b.f.severity] ?? -1) - (RANK[a.f.severity] ?? -1) || a.order - b.order);
    kept.push(...group.slice(0, MAX_FINDINGS_PER_RULE_PER_FILE));
  }
  return kept.sort((a, b) => a.order - b.order).map(({ f }) => f);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Detection-rule files count as documentation, so running one (`bash setup.rules`) is a finding of its own.
function detectionRunFindings(texts) {
  const names = texts.filter((t) => fileKind(t.path) === "detection").map((t) => t.path.split("/").pop());
  if (!names.length) return [];
  const re = new RegExp(`(?:^|[\\s;&|(\`])(?:(?:ba|z|da|k)?sh|source|\\.|python[23]?|perl|ruby|node|pwsh|powershell)\\s+(?:-\\S+\\s+){0,3}(?:\\S*\\/)?(${names.map(escapeRe).join("|")})(?![\\w.-])|(?:^|[\\s;&|(\`])\\.\\/(${names.map(escapeRe).join("|")})(?![\\w.-])`);
  const out = [];
  for (const t of texts) {
    const lines = t.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // The whole line: the pattern is linear, and a cut-off let padding hide the run.
      const m = re.exec(lines[i]);
      if (m) out.push({ file: t.path, rule: "remote-exec", severity: "high", line: i + 1, excerpt: excerptOf(lines[i], m.index), note: "runs a detection-rule file" });
    }
  }
  return out;
}

// files: [{path, content: string|Buffer, size?, isSymlink?, linkTarget?}]
export function scanFiles(files) {
  const findings = [];
  const texts = [];
  for (const file of files) {
    findings.push(...fileRules(file, files));
    if (file.isSymlink) continue;
    const buf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content ?? ""), "utf8");
    if (isBinaryFile(file.path, buf)) continue;
    const text = buf.toString("utf8");
    texts.push({ path: file.path, text });
    findings.push(...scanText(file.path, text));
  }
  findings.push(...detectionRunFindings(texts));
  return { level: levelFromFindings(findings), findings };
}

const SKIP_DIRS = new Set([".git", "node_modules"]);

export async function readTree(dir, { maxFiles = Infinity, maxBytes = Infinity } = {}) {
  const out = [];
  let bytes = 0;
  async function walk(abs) {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const full = join(abs, entry.name);
      const rel = relative(dir, full).split(sep).join("/");
      const st = await lstat(full);
      if (st.isSymbolicLink()) {
        out.push({ path: rel, content: "", size: 0, isSymlink: true, linkTarget: await readlink(full) });
      } else if (st.isDirectory()) {
        await walk(full);
      } else if (st.isFile()) {
        bytes += st.size;
        if (out.length + 1 > maxFiles || bytes > maxBytes) throw new Error(`too large to vet: more than ${maxFiles} files or ${maxBytes} bytes`);
        out.push({ path: rel, content: await readFile(full), size: st.size });
      }
    }
  }
  await walk(dir);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export async function scanDir(dir, limits = {}) {
  return scanFiles(await readTree(dir, limits));
}
