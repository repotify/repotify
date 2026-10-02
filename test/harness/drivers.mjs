// Model drivers: the runner never talks to a model API directly.
// Each driver implements: chat({ system, prompt, maxTokens, temperature }) -> Promise<{ text, rawMs }>.
// Adding a new model = adding an entry to DRIVERS. No runner changes needed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

const NVIDIA_BIN = `${process.env.HOME}/workspace/skills/nvidia/bin/chat.py`;
const JEV_BIN = `${process.env.HOME}/workspace/skills/openrouter/bin/jev.py`;

// --- chat completion via the nvidia skill (non-interactive) ------------------
export async function nvidiaChat({ system, prompt, maxTokens = 500, temperature = 0.2, model = "z-ai/glm-5.3" }) {
  const args = ["--model", model, "--max-tokens", String(maxTokens), "--temperature", String(temperature)];
  if (system) args.push("--system", system);
  args.push("--prompt", prompt);
  const t0 = Date.now();
  const { stdout } = await pExecFile("python3", [NVIDIA_BIN, ...args], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  return { text: stdout.trim(), rawMs: Date.now() - t0 };
}

// --- Jev decision API via the openrouter skill --------------------------------
// Jev is not a chat model: it answers typed questions (choice/noul/score) with
// calibrated probabilities. Used as a *routing signal* arm, not as the task agent.
export async function jevDecide({ state, questions, model = "typesafe/jev-1.13" }) {
  const t0 = Date.now();
  const { stdout } = await pExecFile(
    "python3",
    [JEV_BIN, JSON.stringify({ model, state, questions })],
    { timeout: 90000, maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  return { answers: parsed.answers, usage: parsed.usage ?? null, rawMs: Date.now() - t0 };
}

// --- mock driver: deterministic scripted replies for unit tests ---------------
export function mockDriverFactory(script = {}) {
  // script: { default: "reply text" } or a function ({system,prompt,temperature}) => text.
  // Records every call on .calls.
  const calls = [];
  const chat = async ({ system, prompt, temperature }) => {
    calls.push({ system, prompt, temperature });
    const text = typeof script === "function"
      ? script({ system, prompt, temperature })
      : (script.default ?? "SKILLS: NONE\nDELIVERABLE:\n" + (script.deliverable ?? "mock"));
    return { text, rawMs: 1 };
  };
  chat.calls = calls;
  return chat;
}

export const DRIVERS = {
  // Default agent model. Override with --model for cross-model runs.
  nvidia: (opts = {}) => ({ chat: (a) => nvidiaChat({ model: opts.model ?? "z-ai/glm-5.3", ...a }) }),
  mock: (opts = {}) => ({ chat: mockDriverFactory(opts.script ?? {}) }),
};

export function makeDriver(name, opts = {}) {
  const factory = DRIVERS[name];
  if (!factory) throw new Error(`unknown driver: ${name} (known: ${Object.keys(DRIVERS).join(", ")})`);
  return factory(opts);
}
