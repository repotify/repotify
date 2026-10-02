// Production chat adapter for the draft jury: shells out to the nvidia skill's
// non-interactive bin/chat.py. Used only by guarded runner scripts, never by
// unit tests (they inject a fake chat into runJuryDraft instead).
//
// NOTE: bin/chat.py has no --seed flag. Varied-seed repetition is part of the
// draft protocol and is passed through where the provider supports it; the CLI
// adapter logs that the seed was dropped. A future chat.py --seed flag would
// make the repetition meaningful at temperature 0.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BIN = join(homedir(), "workspace", "skills", "nvidia", "bin", "chat.py");
let seedWarned = false;

function messagesToArgs(messages) {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n");
  return { system, user };
}

export function nvidiaCliChat({ bin = DEFAULT_BIN, timeoutMs = 120000, log = () => {} } = {}) {
  return async ({ model, messages, temperature = 0, seed = null, maxTokens = 4000 }) => {
    if (seed != null && !seedWarned) {
      seedWarned = true;
      log("nvidia-cli: bin/chat.py has no --seed flag; varied-seed repetition degrades to identical temperature-0 calls");
    }
    const { system, user } = messagesToArgs(messages);
    const args = ["--model", model, "--temperature", String(temperature), "--max-tokens", String(maxTokens)];
    if (system) args.push("--system", system);
    args.push("--prompt", user);
    return new Promise((resolve, reject) => {
      execFile("python3", [bin, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(`nvidia chat.py failed: ${String(stderr || error.message).slice(0, 200)}`));
        resolve(String(stdout));
      });
    });
  };
}
