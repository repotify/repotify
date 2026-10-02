// Tests for lib/signals/jev.mjs. All transport is faked via opts.cmd; no network.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { jevAsk, jevChoice, jevScore, jevNoul, jevLooksAvailable, localChoice, runJev, arbitrateWithJev } from "../lib/signals/jev.mjs";

const nodeEcho = (js) => ({ cmd: process.execPath, args: ["-e", js], timeoutMs: 5000 });

const answer = { questions: { pick: { option: "b", probability: 0.82 } } };
const echoAnswer = nodeEcho(`console.log(JSON.stringify(${JSON.stringify(answer)}))`);

test("jevChoice parses option and probability", async () => {
  const r = await jevChoice("pick one", { a: "first", b: "second" }, "choose", echoAnswer);
  assert.deepEqual(r, { option: "b", probability: 0.82 });
});

test("jevChoice returns null when option is unknown", async () => {
  const cmd = nodeEcho(`console.log(JSON.stringify({questions:{pick:{option:"zzz",probability:0.9}}}))`);
  assert.equal(await jevChoice("s", { a: "A" }, "i", cmd), null);
});

test("jevScore parses ordered criteria scores", async () => {
  const cmd = nodeEcho(`console.log(JSON.stringify({questions:{rank:{scores:{fast:0.9,cheap:0.3}}}}))`);
  const r = await jevScore("s", ["fast", "cheap"], "i", cmd);
  assert.deepEqual(r, { scores: { fast: 0.9, cheap: 0.3 } });
});

test("jevScore returns null when no criteria parse", async () => {
  const cmd = nodeEcho(`console.log(JSON.stringify({questions:{rank:{scores:{}}}}))`);
  assert.equal(await jevScore("s", ["fast"], "i", cmd), null);
});

test("jevNoul parses true/false criteria", async () => {
  const cmd = nodeEcho(
    `console.log(JSON.stringify({questions:{check:{needs_browser:{value:true,probability:0.95},needs_gpu:false}}}))`,
  );
  const r = await jevNoul("s", { needs_browser: "browser needed", needs_gpu: "gpu needed" }, "i", cmd);
  assert.deepEqual(r.truth, { needs_browser: true, needs_gpu: false });
  assert.equal(r.probability.needs_browser, 0.95);
});

test("jevNoul returns null when a criterion is missing", async () => {
  const cmd = nodeEcho(`console.log(JSON.stringify({questions:{check:{needs_browser:true}}}))`);
  assert.equal(await jevNoul("s", { needs_browser: "b", needs_gpu: "g" }, "i", cmd), null);
});

test("graceful degradation: missing binary returns null", async () => {
  assert.equal(await jevChoice("s", { a: "A" }, "i", { cmd: "/nonexistent/jev.py", timeoutMs: 1000 }), null);
});

test("graceful degradation: non-zero exit returns null", async () => {
  assert.equal(await runJev({}, { cmd: process.execPath, args: ["-e", "process.exit(1)"], timeoutMs: 1000 }), null);
});

test("graceful degradation: invalid JSON returns null", async () => {
  assert.equal(
    await runJev({}, { cmd: process.execPath, args: ["-e", "console.log('not json')"], timeoutMs: 1000 }),
    null,
  );
});

test("timeout kills a hanging process and returns null", async () => {
  const start = Date.now();
  const r = await runJev({}, { cmd: process.execPath, args: ["-e", "setTimeout(()=>{},30000)"], timeoutMs: 300 });
  assert.equal(r, null);
  assert.ok(Date.now() - start < 10000, "timeout respected");
});

test("REPOTIFY_JEV=off short-circuits without spawning", async () => {
  process.env.REPOTIFY_JEV = "off";
  try {
    assert.equal(await runJev({}, { cmd: "/nonexistent", timeoutMs: 1000 }), null);
    assert.equal(jevLooksAvailable({ cmd: "/nonexistent" }), false);
  } finally {
    delete process.env.REPOTIFY_JEV;
  }
});

test("jevAsk forwards state/questions/model", async () => {
  const cmd = nodeEcho(`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log(JSON.stringify({ok:true,questions:Object.keys(p.questions),model:p.model,state:p.state}))})`);
  const r = await jevAsk("the state", { q1: { type: "choice", instructions: "i", criteria: { a: "A" } } }, { model: "m1", ...cmd });
  assert.equal(r.state, "the state");
  assert.deepEqual(r.questions, ["q1"]);
  assert.equal(r.model, "m1");
});

test("localChoice picks best and reports ties", () => {
  assert.deepEqual(localChoice({ a: "A", b: "B" }, (k) => (k === "a" ? 2 : 1)), { option: "a", probability: 1, tied: false });
  const tie = localChoice({ a: "A", b: "B" }, () => 1);
  assert.equal(tie.tied, true);
  assert.equal(tie.probability, null);
  assert.equal(localChoice({}, () => 0), null);
});

test("arbitrateWithJev implements the recommendV1 arbitrate contract", async () => {
  const cmd = nodeEcho(`console.log(JSON.stringify({questions:{rank:{scores:{"skill-a":0.91,"skill-b":0.42}}}}))`);
  const r = await arbitrateWithJev(["skill-a", "skill-b"], {
    state: { need: "pdf" },
    describe: (id) => (id === "skill-a" ? "PDF toolkit" : "browser tool"),
    ...cmd,
  });
  assert.deepEqual(r, { "skill-a": 0.91, "skill-b": 0.42 });
});

test("arbitrateWithJev returns null on too few ids or failure", async () => {
  assert.equal(await arbitrateWithJev(["only-one"], {}), null);
  assert.equal(await arbitrateWithJev([], {}), null);
  const bad = { cmd: "/nonexistent/jev.py", timeoutMs: 1000 };
  assert.equal(await arbitrateWithJev(["a", "b"], bad), null);
});
