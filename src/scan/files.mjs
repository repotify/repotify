import { posix } from "node:path";
import { extOf, fileKind, urlHosts } from "./rules.mjs";

// Binary formats that are allowed as skill assets when their magic bytes match the extension.
export const ASSET_MAGIC = {
  ".png": [[0x89, 0x50, 0x4e, 0x47]],
  ".jpg": [[0xff, 0xd8, 0xff]],
  ".jpeg": [[0xff, 0xd8, 0xff]],
  ".gif": [[0x47, 0x49, 0x46, 0x38]],
  ".webp": [[0x52, 0x49, 0x46, 0x46]],
  ".ico": [[0x00, 0x00, 0x01, 0x00]],
  ".pdf": [[0x25, 0x50, 0x44, 0x46]],
  ".ttf": [[0x00, 0x01, 0x00, 0x00], [0x74, 0x72, 0x75, 0x65]],
  ".otf": [[0x4f, 0x54, 0x54, 0x4f]],
  ".woff": [[0x77, 0x4f, 0x46, 0x46]],
  ".woff2": [[0x77, 0x4f, 0x46, 0x32]],
};

export const EXECUTABLE_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".pyc", ".pyo", ".class", ".jar", ".wasm", ".node", ".msi", ".app", ".deb", ".rpm",
]);

export const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".zst"]);
const ARCHIVE_MAGIC = [[0x50, 0x4b, 0x03, 0x04], [0x1f, 0x8b], [0x42, 0x5a, 0x68], [0xfd, 0x37, 0x7a, 0x58], [0x37, 0x7a, 0xbc, 0xaf], [0x52, 0x61, 0x72, 0x21]];

const EXEC_MAGIC = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // PE
  [0xcf, 0xfa, 0xed, 0xfe], [0xce, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe], // Mach-O
  [0x00, 0x61, 0x73, 0x6d], // wasm
];

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export const NETWORK_ALLOWLIST = [
  "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "api.github.com", "github.com",
  "raw.githubusercontent.com", "api.osv.dev", "osv.dev", "api.deps.dev", "deps.dev", "localhost", "127.0.0.1", "0.0.0.0",
];

const startsWith = (buf, sig) => sig.every((b, i) => buf[i] === b);

export function isBinaryFile(path, buf) {
  const ext = extOf(path);
  if (ASSET_MAGIC[ext] || EXECUTABLE_EXTENSIONS.has(ext) || ARCHIVE_EXTENSIONS.has(ext)) return true;
  return buf.subarray(0, 8192).includes(0);
}

function bufferOf(file) {
  return Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content ?? ""), "utf8");
}

const finding = (rule, severity, file, excerpt, note) => ({ rule, severity, file, line: 0, excerpt, ...(note ? { note } : {}) });

function binaryFindings(path, buf) {
  const ext = extOf(path);
  if (ASSET_MAGIC[ext]) {
    if (ASSET_MAGIC[ext].some((sig) => startsWith(buf, sig))) return [];
    return [finding("binary-file", "high", path, "content does not match extension " + ext)];
  }
  if (ARCHIVE_EXTENSIONS.has(ext) || ARCHIVE_MAGIC.some((sig) => startsWith(buf, sig))) {
    return [finding("binary-file", "high", path, "compressed archive", "archive cannot be scanned; needs manual review")];
  }
  if (EXECUTABLE_EXTENSIONS.has(ext) || EXEC_MAGIC.some((sig) => startsWith(buf, sig))) {
    return [finding("binary-file", "high", path, "executable or compiled binary")];
  }
  if (buf.subarray(0, 8192).includes(0)) return [finding("binary-file", "high", path, "unknown binary content")];
  return [];
}

function symlinkFindings(file) {
  const raw = file.linkTarget ?? "";
  // Windows writes link targets with backslashes, so they count as separators on every system.
  const target = raw.replace(/\\/g, "/");
  if (target.startsWith("/") || /^[A-Za-z]:/.test(target)) {
    return [finding("symlink", "high", file.path, "-> " + raw, "absolute link target")];
  }
  const resolved = posix.normalize(posix.join(posix.dirname(file.path), target));
  if (resolved === ".." || resolved.startsWith("../")) {
    return [finding("symlink", "high", file.path, "-> " + raw, "points outside the skill folder")];
  }
  return [];
}

const HOOK_PATHS = [
  /(^|\/)\.claude\/settings(\.local)?\.json$/,
  /(^|\/)hooks\/hooks\.json$/,
  /(^|\/)\.cursor\/hooks\.json$/,
  /(^|\/)\.mcp\.json$/,
  /(^|\/)\.gemini\/settings\.json$/,
  /(^|\/)\.codex\/config\.toml$/,
];

function configFindings(path, text) {
  const out = [];
  if (HOOK_PATHS.some((re) => re.test(path))) {
    out.push(finding("hook-autoexec", "high", path, path, "agent config that can run commands automatically"));
  } else if (path.endsWith(".json")) {
    if (/"hooks"\s*:/.test(text) && /"command"\s*:/.test(text)) {
      out.push(finding("hook-autoexec", "high", path, "hooks with commands", "hook definitions"));
    }
  }
  if (/"enableAllProjectMcpServers"\s*:\s*true/.test(text)) {
    out.push(finding("hook-autoexec", "high", path, "enableAllProjectMcpServers: true"));
  }
  if (/(^|\/)\.vscode\/tasks\.json$/.test(path) && /folderOpen/.test(text)) {
    out.push(finding("hook-autoexec", "high", path, "task runs on folder open"));
  }
  const base = path.split("/").pop();
  if (base === "package.json") {
    try {
      const scripts = JSON.parse(text.replace(/^\u{FEFF}/u, "")).scripts ?? {};
      const hooks = ["preinstall", "install", "postinstall", "prepare"].filter((k) => k in scripts);
      if (hooks.length) out.push(finding("install-script", "medium", path, hooks.map((k) => `${k}: ${scripts[k]}`).join("; ").slice(0, 80)));
    } catch {
      // Invalid package.json cannot run install scripts through npm either.
    }
  }
  if (base === "setup.py" && /\bcmdclass\b/.test(text)) {
    out.push(finding("install-script", "medium", path, "setup.py cmdclass"));
  }
  return out;
}

const NETWORK_PRIMITIVE =
  /\b(fetch|axios|got|requests\.\w+|httpx\.\w+|aiohttp|urlopen|urllib|http\.(get|request)|https\.(get|request)|XMLHttpRequest|WebSocket|curl|wget|irm|iwr|Invoke-WebRequest|Invoke-RestMethod|net\.connect|socket\.(create_connection|connect))\b/i;

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("#") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

export function hostsInScript(text) {
  // `git clone` fetches a whole tree over the network; its host counts like a curl/wget one.
  if (!NETWORK_PRIMITIVE.test(text) && !/\bgit\s+(clone|fetch|pull)\b/.test(text)) return [];
  const hosts = new Set();
  for (const line of text.split("\n")) {
    if (isCommentLine(line)) continue;
    for (const h of urlHosts(line)) hosts.add(h.host);
  }
  return [...hosts];
}

export function networkDomains(files) {
  const hosts = new Set();
  for (const file of files) {
    if (file.isSymlink) continue;
    const buf = bufferOf(file);
    if (isBinaryFile(file.path, buf)) continue;
    const text = buf.toString("utf8");
    if (fileKind(file.path, text) !== "script") continue;
    for (const h of hostsInScript(text)) hosts.add(h);
  }
  return [...hosts].sort();
}

function allowedHost(host) {
  return NETWORK_ALLOWLIST.some((a) => host === a || host.endsWith("." + a));
}

export function fileRules(file, allFiles = [file]) {
  const out = [];
  // The total-size check must run even when the first entry is a symlink:
  // otherwise a leading symlink skips the 20 MB cap for the whole skill.
  if (file === allFiles[0]) {
    const total = allFiles.reduce((sum, f) => sum + (f.size ?? bufferOf(f).length), 0);
    if (total > MAX_TOTAL_BYTES) out.push(finding("oversized", "high", "(total)", `${(total / 1048576).toFixed(1)} MB in ${allFiles.length} files`));
  }
  if (file.isSymlink) return out.concat(symlinkFindings(file));
  const buf = bufferOf(file);
  const size = file.size ?? buf.length;
  if (size > MAX_FILE_BYTES) out.push(finding("oversized", "high", file.path, `${(size / 1048576).toFixed(1)} MB`));
  if (isBinaryFile(file.path, buf)) return out.concat(binaryFindings(file.path, buf));
  const text = buf.toString("utf8");
  out.push(...configFindings(file.path, text));
  if (fileKind(file.path, text) === "script") {
    const hosts = hostsInScript(text);
    const unknown = hosts.filter((h) => !allowedHost(h));
    if (unknown.length) {
      out.push(finding("network-call", "medium", file.path, "network call", "domains: " + unknown.join(", ")));
    }
  }
  return out;
}
