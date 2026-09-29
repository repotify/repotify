const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with timeout, exponential backoff and Retry-After for 408/429/5xx and network errors.
export async function fetchWithRetry(url, init = {}, { retries = 3, timeoutMs = 60000, fetchImpl = fetch, sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    if (!retryable || attempt === retries) return res;
    const after = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt);
  }
  throw lastError;
}
