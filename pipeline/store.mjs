// The content store: every file the lab has seen, kept once by its SHA-256, and the facts about repositories and skill
// versions that point at them. Fetching is the expensive part (network, rate limits); what the catalog does with the
// content (scanner rules, thresholds, categories, ranking) changes often and is recomputed from here without touching
// the network. Only content the store does not have yet is ever downloaded. Plain files, so the store can be copied or
// synced (rsync) as it is.
//
//   <dir>/blobs/ab/<sha256>             file contents
//   <dir>/git/ab/<git blob id>          the SHA-256 of a blob git knows by its id, so a known file is never fetched again
//   <dir>/trees/ab/<tree hash>.json     a skill folder at one commit: [{ path, sha256, size } | { path, link }]
//   <dir>/repos/<owner>__<name>.json    what the lab knows about a repository: metadata, commits seen, skill folders
//   <dir>/obs/<kind>/ab/<key>.json      observations (scans, classifier answers) keyed by content and observer version
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HEX = /^[0-9a-f]{40,64}$/;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// The id git gives a file's content: SHA-1 of "blob <size>\0<content>".
export function gitBlobId(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

// Canonical JSON (sorted keys), so the same tree always hashes the same.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

export const repoKey = (name) => String(name).toLowerCase().replace("/", "__");

export function createStore(dir) {
  let counter = 0;
  // Atomic write: a reader never sees half a file, and two writers of the same content cannot corrupt it.
  const write = (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${counter++}`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  };
  const shard = (kind, key, ext = "") => {
    if (!HEX.test(key)) throw new Error(`store: not a hash: ${key}`);
    return join(dir, kind, key.slice(0, 2), key + ext);
  };
  const readJson = (path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };

  return {
    dir,

    putBlob(content) {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const key = sha256(buf);
      const path = shard("blobs", key);
      if (!existsSync(path)) write(path, buf);
      this.mapGit(gitBlobId(buf), key);
      return key;
    },
    hasBlob: (key) => HEX.test(key) && existsSync(shard("blobs", key)),
    getBlob(key) {
      try {
        return readFileSync(shard("blobs", key));
      } catch {
        return null;
      }
    },

    mapGit(gitId, key) {
      const path = shard("git", gitId);
      if (!existsSync(path)) write(path, key);
    },
    // The SHA-256 of the content git calls `gitId`, when the store already holds it.
    shaForGit(gitId) {
      try {
        const key = readFileSync(shard("git", gitId), "utf8").trim();
        return this.hasBlob(key) ? key : null;
      } catch {
        return null;
      }
    },

    // entries: [{ path, sha256, size }] for files, [{ path, link }] for symbolic links. Returns the tree's hash.
    putTree(entries) {
      const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const text = canonical(sorted);
      const key = sha256(text);
      const path = shard("trees", key, ".json");
      if (!existsSync(path)) write(path, text);
      return key;
    },
    getTree: (key) => readJson(shard("trees", key, ".json")),
    // A tree as the scanner reads it: contents for files, link targets for links. Null when a blob is missing.
    treeFiles(key) {
      const tree = this.getTree(key);
      if (!tree) return null;
      const out = [];
      for (const e of tree) {
        if (e.link !== undefined) {
          out.push({ path: e.path, content: "", size: 0, isSymlink: true, linkTarget: e.link });
          continue;
        }
        const content = this.getBlob(e.sha256);
        if (!content) return null;
        out.push({ path: e.path, content, size: content.length });
      }
      return out;
    },

    getRepo: (name) => readJson(join(dir, "repos", `${repoKey(name)}.json`)),
    putRepo: (name, record) => write(join(dir, "repos", `${repoKey(name)}.json`), JSON.stringify(record, null, 1)),
    listRepos() {
      try {
        return readdirSync(join(dir, "repos")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5).replace("__", "/"));
      } catch {
        return [];
      }
    },

    // Observations: `kind` names the observer ("scan", "jev"), `key` is a hash of its inputs and version.
    getObs: (kind, key) => readJson(shard(`obs/${kind}`, key, ".json")),
    putObs: (kind, key, value) => write(shard(`obs/${kind}`, key, ".json"), JSON.stringify(value)),

    // Free-form state files (crawl progress, discovery results).
    getState: (name) => readJson(join(dir, `${name}.json`)),
    putState: (name, value) => write(join(dir, `${name}.json`), JSON.stringify(value, null, 1)),
  };
}

// A stable key for an observation: the hash of everything it depends on.
export const obsKey = (...parts) => sha256(canonical(parts));
