import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../pipeline/lib/http.mjs";
import { createProvider } from "../pipeline/providers/openai-compatible.mjs";
import { providersFromEnv, NVIDIA_BASE_URL, OMNIROUTE_DEFAULT_URL } from "../pipeline/providers/index.mjs";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const noSleep = async () => {};

test("fetchWithRetry retries 5xx and honours Retry-After", async () => {
  const waits = [];
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "2" } }) : json({ ok: true }));
  const res = await fetchWithRetry("https://x.test", {}, { fetchImpl, sleep: async (ms) => waits.push(ms) });
  assert.equal(res.status, 200);
  assert.deepEqual(waits, [2000]);
});

test("fetchWithRetry returns client errors immediately and throws after repeated network failures", async () => {
  let n = 0;
  const res = await fetchWithRetry("https://x.test", {}, { fetchImpl: async () => { n++; return new Response("no", { status: 404 }); }, sleep: noSleep });
  assert.equal(res.status, 404);
  assert.equal(n, 1);
  let m = 0;
  await assert.rejects(fetchWithRetry("https://x.test", {}, { retries: 2, fetchImpl: async () => { m++; throw new TypeError("fetch failed"); }, sleep: noSleep }), /fetch failed/);
  assert.equal(m, 3);
});

test("a rate-limited key rotates to the next key", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.Authorization);
    if (init.headers.Authorization === "Bearer key-one") return json({ error: "rate" }, 429);
    return json({ choices: [{ message: { content: "hello" } }] });
  };
  const p = createProvider({ name: "nvidia", baseUrl: "https://api.test/v1", apiKeys: ["key-one", "key-two"], fetchImpl, sleep: noSleep });
  assert.equal(await p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }), "hello");
  assert.deepEqual(seen.slice(-2), ["Bearer key-one", "Bearer key-two"]);
  seen.length = 0;
  await p.chat({ model: "m", messages: [] });
  assert.deepEqual(seen, ["Bearer key-two"], "resting key is skipped for the rest of the run");
});

test("errors never include API keys", async () => {
  const fetchImpl = async (url, init) => json({ error: `invalid key ${init.headers.Authorization}` }, 401);
  const p = createProvider({ name: "nvidia", baseUrl: "https://api.test/v1", apiKeys: ["secret-aaa", "secret-bbb"], fetchImpl, sleep: noSleep });
  await assert.rejects(p.chat({ model: "m", messages: [] }), (e) => !String(e.message).includes("secret-") && !String(e.stack).includes("secret-"));
});

test("reasoning models without content fall back to reasoning text", async () => {
  const p = createProvider({ name: "x", baseUrl: "https://api.test/v1", apiKeys: [], fetchImpl: async () => json({ choices: [{ message: { content: null, reasoning_content: "{\"a\":1}" } }] }), sleep: noSleep });
  assert.equal(await p.chat({ model: "m", messages: [] }), "{\"a\":1}");
});

test("listModels returns model ids and keyless providers send no Authorization", async () => {
  let auth = "unset";
  const fetchImpl = async (url, init) => {
    auth = init.headers.Authorization;
    assert.equal(url, "http://localhost:20128/v1/models");
    return json({ data: [{ id: "auto" }, { id: "oc/free" }] });
  };
  const p = createProvider({ name: "omniroute", baseUrl: "http://localhost:20128/v1", apiKeys: [], fetchImpl, sleep: noSleep });
  assert.deepEqual(await p.listModels(), ["auto", "oc/free"]);
  assert.equal(auth, undefined);
});

test("providersFromEnv builds NVIDIA from numbered keys and OmniRoute from its URL", () => {
  assert.deepEqual(providersFromEnv({}).map((p) => [p.name, p.baseUrl]), [["omniroute", OMNIROUTE_DEFAULT_URL]]);
  const ps = providersFromEnv({ NVIDIA_API_KEY_1: "a", NVIDIA_API_KEY_3: "c", OMNIROUTE_BASE_URL: "http://127.0.0.1:9/v1" });
  assert.deepEqual(ps.map((p) => [p.name, p.baseUrl, p.keyCount]), [["nvidia", NVIDIA_BASE_URL, 2], ["omniroute", "http://127.0.0.1:9/v1", 0]]);
  assert.deepEqual(providersFromEnv({ NVIDIA_API_KEY_1: "a", REPOTIFY_USE_OMNIROUTE: "0" }).map((p) => p.name), ["nvidia"]);
});
