// Tests for lib/signals/jev.mjs. Transport is a fake fetch that answers in the
// shape the Decisions API documents (and a live call on 2026-10-02 returned):
//   { model, answers: { <id>: { type, noul | choice+probabilities | score+legend } }, usage }
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decide, ask, jevChoice, jevScore, jevNoul, jevLooksAvailable, jevConfig, localChoice, arbitrateWithJev, DEFAULT_ENDPOINT, DEFAULT_MODEL } from "../lib/signals/jev.mjs";

const env = { JEV_API_KEY: "test-key" };
const fakeFetch = (answers, { status = 200, capture } = {}) => async (url, init) => {
  if (capture) capture.push({ url, init, body: JSON.parse(init.body) });
  return { ok: status >= 200 && status < 300, status, json: async () => ({ model: "typesafe/jev-1.13-20260917", answers, usage: { input_tokens: 10, cost: 0 } }) };
};

test("decide posts model, state and questions with the bearer key to the configured endpoint", async () => {
  const calls = [];
  const r = await decide({ skill: "x" }, { q: { type: "noul", instructions: "i", criteria: { true: "y", false: "n" } } }, { env, fetchImpl: fakeFetch({ q: { type: "noul", noul: 0.9 } }, { capture: calls }) });
  assert.equal(calls[0].url, DEFAULT_ENDPOINT);
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
  assert.deepEqual(calls[0].body, { model: DEFAULT_MODEL, state: { skill: "x" }, questions: { q: { type: "noul", instructions: "i", criteria: { true: "y", false: "n" } } } });
  assert.equal(r.answers.q.noul, 0.9);
});

test("endpoint, model and key come from the environment, so a Jev-compatible model drops in", async () => {
  const calls = [];
  const clef = { JEV_API_KEY: "cf", JEV_ENDPOINT: "https://example.test/decisions", JEV_MODEL: "clef-flash" };
  await decide({}, {}, { env: clef, fetchImpl: fakeFetch({}, { capture: calls }) });
  assert.equal(calls[0].url, "https://example.test/decisions");
  assert.equal(calls[0].body.model, "clef-flash");
  assert.equal(jevConfig({ OPENROUTER_API_KEY: "or" }).key, "or");
});

test("jevChoice returns the option with its probability distribution", async () => {
  const r = await jevChoice({}, { a: "first", b: "second" }, "pick", { env, fetchImpl: fakeFetch({ pick: { type: "choice", choice: "b", confidence: 0.6, probabilities: { a: 0.2, b: 0.8 } } }) });
  assert.deepEqual(r, { option: "b", probability: 0.8, confidence: 0.6, probabilities: { a: 0.2, b: 0.8 } });
});

test("jevChoice rejects an option that was not offered", async () => {
  assert.equal(await jevChoice({}, { a: "A" }, "i", { env, fetchImpl: fakeFetch({ pick: { type: "choice", choice: "zzz", probabilities: { zzz: 1 } } }) }), null);
});

test("jevNoul asks one yes/no question per criterion in a single call", async () => {
  const calls = [];
  const r = await jevNoul({}, { coding: "helps build software", bound: "needs one product" }, null, {
    env, fetchImpl: fakeFetch({ coding: { type: "noul", noul: 0.95 }, bound: { type: "noul", noul: 0.1 } }, { capture: calls }),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].body.questions), ["coding", "bound"]);
  assert.deepEqual(r.truth, { coding: true, bound: false });
  assert.equal(r.probability.coding, 0.95);
});

test("jevNoul returns null when any criterion is missing from the answer", async () => {
  assert.equal(await jevNoul({}, { a: "A", b: "B" }, null, { env, fetchImpl: fakeFetch({ a: { type: "noul", noul: 0.7 } }) }), null);
});

test("jevScore returns the position on the ordered scale", async () => {
  const r = await jevScore({}, ["low", "mid", "high"], "how much", { env, fetchImpl: fakeFetch({ rank: { type: "score", score: 1.99, confidence: 0.99, probabilities: { 0: 0, 1: 0, 2: 1 }, legend: { 0: "low", 1: "mid", 2: "high" } } }) });
  assert.equal(r.score, 1.99);
  assert.equal(r.probabilities["2"], 1);
});

test("ask parses each answer by its question type and nulls malformed ones", async () => {
  const qs = { a: { type: "noul" }, b: { type: "choice", criteria: { x: "X" } }, c: { type: "score", criteria: ["l"] } };
  const r = await ask({}, qs, { env, fetchImpl: fakeFetch({ a: { noul: "bad" }, b: { choice: "x", probabilities: { x: 1 } } }) });
  assert.equal(r.a, null);
  assert.equal(r.b.option, "x");
  assert.equal(r.c, null);
});

test("graceful degradation: no key, switched off, HTTP error, network error, timeout all return null", async () => {
  const q = { q: { type: "noul" } };
  assert.equal(await decide({}, q, { env: {}, fetchImpl: fakeFetch({}) }), null);
  assert.equal(await decide({}, q, { env: { ...env, REPOTIFY_JEV: "off" }, fetchImpl: fakeFetch({}) }), null);
  assert.equal(await decide({}, q, { env, fetchImpl: fakeFetch({}, { status: 402 }) }), null);
  assert.equal(await decide({}, q, { env, fetchImpl: async () => { throw new Error("offline"); } }), null);
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const start = Date.now();
  assert.equal(await decide({}, q, { env, fetchImpl: hang, timeoutMs: 100 }), null);
  assert.ok(Date.now() - start < 5000);
});

test("jevLooksAvailable needs a key and Jev not switched off", () => {
  assert.equal(jevLooksAvailable({ env }), true);
  assert.equal(jevLooksAvailable({ env: {} }), false);
  assert.equal(jevLooksAvailable({ env: { ...env, REPOTIFY_JEV: "off" } }), false);
});

test("arbitrateWithJev implements the recommendV1 arbitrate contract with one choice question", async () => {
  const calls = [];
  const r = await arbitrateWithJev(["skill-a", "skill-b"], {
    state: { need: "pdf" }, describe: (id) => (id === "skill-a" ? "PDF toolkit" : "browser tool"),
    env, fetchImpl: fakeFetch({ pick: { type: "choice", choice: "skill-a", probabilities: { "skill-a": 0.91, "skill-b": 0.09 } } }, { capture: calls }),
  });
  assert.deepEqual(r, { "skill-a": 0.91, "skill-b": 0.09 });
  assert.deepEqual(calls[0].body.questions.pick.criteria, { "skill-a": "PDF toolkit", "skill-b": "browser tool" });
});

test("arbitrateWithJev returns null on too few ids or failure", async () => {
  assert.equal(await arbitrateWithJev(["only-one"], {}), null);
  assert.equal(await arbitrateWithJev([], {}), null);
  assert.equal(await arbitrateWithJev(["a", "b"], { env: {} }), null);
});

test("localChoice picks best and reports ties", () => {
  assert.deepEqual(localChoice({ a: "A", b: "B" }, (k) => (k === "a" ? 2 : 1)), { option: "a", probability: 1, tied: false });
  const tie = localChoice({ a: "A", b: "B" }, () => 1);
  assert.equal(tie.tied, true);
  assert.equal(tie.probability, null);
  assert.equal(localChoice({}, () => 0), null);
});
