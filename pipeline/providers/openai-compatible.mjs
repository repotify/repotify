import { fetchWithRetry } from "../lib/http.mjs";

export class ProviderError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

// OpenAI-compatible chat provider with a key pool. Keys that get 401/403/429 rest for the rest of the run.
export function createProvider({ name, baseUrl, apiKeys = [], fetchImpl = fetch, sleep, timeoutMs = 120000 }) {
  const keys = apiKeys.filter(Boolean);
  const resting = new Set();
  let next = 0;
  const redact = (text) => keys.reduce((t, k) => t.split(k).join("***"), String(text));
  const headers = (key) => ({ "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) });

  function order() {
    if (!keys.length) return [null];
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      const idx = (next + i) % keys.length;
      if (!resting.has(idx)) out.push(idx);
    }
    return out;
  }

  async function request(path, body) {
    const candidates = order();
    if (!candidates.length) throw new ProviderError(`${name}: all API keys are rate-limited or rejected`);
    let lastStatus = null;
    for (const idx of candidates) {
      const key = idx === null ? null : keys[idx];
      let res;
      try {
        res = await fetchWithRetry(`${baseUrl}${path}`, { method: body ? "POST" : "GET", headers: headers(key), ...(body ? { body: JSON.stringify(body) } : {}) }, { fetchImpl, sleep, retries: 1, timeoutMs });
      } catch (error) {
        throw new ProviderError(redact(`${name}: ${error.message}`));
      }
      if (res.ok) {
        if (idx !== null) next = idx;
        return res.json();
      }
      lastStatus = res.status;
      if (idx !== null && (res.status === 401 || res.status === 403 || res.status === 429)) {
        resting.add(idx);
        continue;
      }
      const text = await res.text().catch(() => "");
      throw new ProviderError(redact(`${name}: HTTP ${res.status} ${text.slice(0, 200)}`), res.status);
    }
    throw new ProviderError(`${name}: all API keys failed (last HTTP ${lastStatus})`, lastStatus);
  }

  return {
    name,
    baseUrl,
    keyCount: keys.length,
    async listModels() {
      const doc = await request("/models");
      return (doc.data ?? []).map((m) => m.id).filter(Boolean);
    },
    async chat({ model, messages, maxTokens = 900, temperature = 0 }) {
      const doc = await request("/chat/completions", { model, messages, max_tokens: maxTokens, temperature });
      const msg = doc.choices?.[0]?.message ?? {};
      return msg.content ?? msg.reasoning_content ?? msg.reasoning ?? "";
    },
  };
}
