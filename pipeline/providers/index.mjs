import { createProvider } from "./openai-compatible.mjs";

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const OMNIROUTE_DEFAULT_URL = "http://localhost:20128/v1";

// NVIDIA NIM from NVIDIA_API_KEY_1..4 (a pool), plus a self-hosted OmniRoute gateway as fallback.
export function providersFromEnv(env = process.env, { fetchImpl = fetch } = {}) {
  const providers = [];
  const nvidiaKeys = [1, 2, 3, 4].map((i) => env[`NVIDIA_API_KEY_${i}`]).filter(Boolean);
  if (nvidiaKeys.length) providers.push(createProvider({ name: "nvidia", baseUrl: NVIDIA_BASE_URL, apiKeys: nvidiaKeys, fetchImpl }));
  if (env.REPOTIFY_USE_OMNIROUTE !== "0") {
    providers.push(createProvider({
      name: "omniroute",
      baseUrl: env.OMNIROUTE_BASE_URL || OMNIROUTE_DEFAULT_URL,
      apiKeys: env.OMNIROUTE_API_KEY ? [env.OMNIROUTE_API_KEY] : [],
      fetchImpl,
    }));
  }
  return providers;
}
