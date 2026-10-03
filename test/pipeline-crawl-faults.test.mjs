// The two faults a 12,000-repository crawl ran into: a git child that dies while its input is still being written, and
// a GitHub response whose body never finishes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../pipeline/store.mjs";
import { githubClient } from "../pipeline/github.mjs";
import { fetchRepo, runGit, remoteHead, parseLsTree } from "../pipeline/crawl.mjs";
import { withDeadline } from "../pipeline/lib/http.mjs";

const tempDirs = [];
const mkTemp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
};
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test("a git child that exits before reading its input fails the call instead of crashing the crawl", async () => {
  // More input than a pipe holds, to a git that exits at once: the write fails with EPIPE after the child is gone.
  const input = "0123456789abcdef0123456789abcdef01234567\n".repeat(400000);
  await assert.rejects(runGit(["-C", mkTemp("rp-norepo-"), "cat-file", "--batch"], { input }), /Command failed|not a git repository/);
  await assert.rejects(runGit(["--no-such-option"], { input }), /Command failed/);
  // The process is still here and git still works.
  assert.match((await runGit(["--version"])).toString(), /git version/);
  assert.match((await runGit(["hash-object", "--stdin"], { input: "hello\n" })).toString(), /^ce013625030ba8dba906f756967f9e9ca394464a/);
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a GitHub response whose body never finishes is abandoned at the deadline and asked for again", async () => {
  // What a cut connection looks like to fetch: headers and status arrive, the compressed body neither ends nor fails,
  // and the request's abort signal does not reach it. Nothing else keeps the process alive.
  const stalled = () => ({ ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}) });
  let calls = 0;
  const slept = [];
  const gh = githubClient({ fetchImpl: async () => (++calls === 1 ? stalled() : json({ tree: [{ path: "SKILL.md" }], truncated: false })), sleep: async (ms) => { slept.push(ms); }, timeoutMs: 30 });
  const doc = await gh.tree("acme/tools", "abc");
  assert.deepEqual(doc.tree, [{ path: "SKILL.md" }]);
  assert.equal(calls, 2);
  assert.equal(slept.length, 1);
  // A body that keeps stalling fails the call with a reason, after the usual number of attempts.
  calls = 0;
  const dead = githubClient({ fetchImpl: async () => (calls++, stalled()), sleep: async () => {}, timeoutMs: 5 });
  await assert.rejects(dead.tree("acme/tools", "abc"), /response body of .* did not finish/);
  assert.equal(calls, 6);
});

test("a GitHub response cut off mid-body is asked for again, not taken as the repository's answer", async () => {
  let calls = 0;
  const cut = () => new Response('{"tree":[{"path":"SKILL.m', { status: 200, headers: { "content-type": "application/json" } });
  const gh = githubClient({ fetchImpl: async () => (++calls <= 2 ? cut() : json({ tree: [], truncated: false })), sleep: async () => {} });
  assert.deepEqual(await gh.tree("acme/tools", "abc"), { tree: [], truncated: false });
  assert.equal(calls, 3);
});

test("withDeadline settles with the promise when it is in time and rejects when it is not", async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 1000, "x"), 7);
  await assert.rejects(withDeadline(Promise.reject(new Error("boom")), 1000, "x"), /boom/);
  await assert.rejects(withDeadline(new Promise(() => {}), 10, "the answer"), /the answer did not finish in 10 ms/);
  // A late failure of the abandoned promise is not an unhandled rejection.
  let fail;
  await assert.rejects(withDeadline(new Promise((_, reject) => { fail = reject; }), 5, "x"), /did not finish/);
  fail(new Error("late"));
  await new Promise((r) => setImmediate(r));
});

test("storing a large repository lets the other workers' network traffic through", async () => {
  // Storing thousands of files is synchronous disk work. Held in one stretch it starves the other workers' sockets for
  // seconds, which is what cuts their GitHub responses off; so the event loop gets a turn in between.
  const dir = mkTemp("rp-src-");
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "uploadpack.allowFilter", "true");
  git("config", "uploadpack.allowAnySHA1InWant", "true");
  for (let i = 0; i < 12; i++) {
    mkdirSync(join(dir, "skills", `s${i}`), { recursive: true });
    writeFileSync(join(dir, "skills", `s${i}`, "SKILL.md"), `---\nname: s${i}\ndescription: Skill ${i}.\n---\n`);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const url = `file://${dir}`;
  const commit = await remoteHead(url);
  const listing = parseLsTree(execFileSync("git", ["-C", dir, "ls-tree", "-r", "-l", "-z", "--full-tree", commit]));
  const store = createStore(mkTemp("rp-store-"));
  const events = [];
  const putBlob = store.putBlob.bind(store);
  store.putBlob = (content) => (events.push("blob"), putBlob(content));
  const putTree = store.putTree.bind(store);
  store.putTree = (entries) => (events.push("tree"), putTree(entries));
  let ticking = true;
  const tick = () => { if (ticking) { events.push("turn"); setImmediate(tick); } };
  setImmediate(tick);
  const r = await fetchRepo("acme/many", { store, workDir: mkTemp("rp-work-"), commit, listing, urlFor: () => url, licenseKnown: true, yieldEveryMs: 0 });
  ticking = false;
  assert.equal(r.skills.length, 12);
  const between = (kind) => events.slice(events.indexOf(kind), events.lastIndexOf(kind)).filter((e) => e === "turn").length;
  assert.ok(between("blob") >= 5, `event loop turns while storing files: ${between("blob")}`);
  assert.ok(between("tree") >= 5, `event loop turns while recording folders: ${between("tree")}`);
});
