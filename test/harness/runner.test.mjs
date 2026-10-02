// Unit tests for test/harness/runner.mjs + report.mjs — mock driver, no network.
// Phase 2 content fetches are stubbed via a temp cache dir of dossier files.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { runOnce, loadScenario, listScenarios, buildRoutePrompt, buildTaskPrompt, parseArgs } from "./runner.mjs";
import { loadCatalog } from "./arms.mjs";
import { makeDriver } from "./drivers.mjs";
import { aggregate, bootstrapCI } from "./report.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const CATALOG_DIR = join(here, "..", "..", "catalog");
let CACHE;

before(() => {
  globalThis.__catalog = loadCatalog((f) => JSON.parse(readFileSync(join(CATALOG_DIR, f), "utf8")));
  // Pre-seed the content cache so no network is touched: dossier per catalog item.
  CACHE = mkdtempSync(join(tmpdir(), "harness-cache-"));
  for (const item of globalThis.__catalog.items) {
    const key = `${item.id}@${(item.commit ?? "nocmt").slice(0, 12)}.md`.replace(/[^a-zA-Z0-9@._-]/g, "_");
    writeFileSync(join(CACHE, key), `# ${item.id}\n${item.summary ?? ""}`);
  }
});

const OPTS = () => ({ driverName: "mock", model: "mock", maxTokens: 500, temperature: 0.2, maxRetries: 2, contentCache: CACHE });

// Mock agent: phase 1 (route prompt) -> SKILLS line; phase 2 -> deliverable.
function twoPhaseMock(routeReply, deliverable) {
  return ({ prompt }) => prompt.includes("AVAILABLE SKILLS") ? routeReply : `DELIVERABLE:\n${deliverable}`;
}

describe("runner", () => {
  it("lists the 7 scenarios (5 pilot + mcp-server + supply-chain)", () => {
    assert.deepEqual(listScenarios(), ["cli-tool", "docs", "js-frontend", "mcp-server", "python-api", "supply-chain", "testing"]);
  });

  it("scenario JSONs are valid: ids exist in catalog, rubrics non-empty", () => {
    const ids = new Set(globalThis.__catalog.items.map((i) => i.id));
    for (const sid of listScenarios()) {
      const s = loadScenario(sid);
      assert.equal(s.id, sid);
      assert.ok(s.task.length > 20);
      assert.ok((s.rubric ?? []).length >= 3, `${sid}: rubric too small`);
      for (const mid of [...(s.mustInclude ?? []), ...(s.mustNotInclude ?? [])]) {
        assert.ok(ids.has(mid), `${sid}: unknown catalog id ${mid}`);
      }
    }
  });

  it("runOnce two-phase: routing from phase 1, task from phase 2 content", async () => {
    const scenario = loadScenario("js-frontend");
    const deliverable = "export function useDebouncedValue(value: string, delay: number) {\n  const [v, setV] = useState<string>(value);\n  useEffect(() => { const t = setTimeout(() => setV(value), delay); return () => clearTimeout(t); }, [value, delay]);\n  return v;\n}";
    const driver = makeDriver("mock", { script: twoPhaseMock(`SKILLS: ${scenario.mustInclude.join(", ")}`, deliverable) });
    const rec = await runOnce({ scenario, arm: "repotify", repIndex: 0, driver, opts: OPTS() });
    assert.equal(rec.ok, true);
    assert.equal(rec.protocol, "two-phase");
    assert.equal(rec.routing_recall, 1);
    assert.equal(rec.routing_precision, 1);
    assert.equal(rec.routing_f1, 1);
    assert.equal(rec.task_score, 1);
    assert.equal(rec.retries, 0);
    assert.equal(rec.contract_fail_route, false);
    assert.equal(rec.contract_fail_task, false);
    assert.ok(typeof rec.pipeline_ms === "number");
    assert.ok(rec.phase1.tokens_est_in > 0 && rec.phase2.tokens_est_out > 0);
    assert.equal(rec.skill_set_source, "v2-recommendV1", "the repotify arm measures the served engine");
    assert.ok(rec.content_sources["react-best-practices"], "content source recorded");
    assert.match(rec.raw_route_reply, /SKILLS:/);
  });

  it("placebo arm substitutes dummy content in phase 2", async () => {
    const scenario = loadScenario("js-frontend");
    const driver = makeDriver("mock", {
      script: ({ prompt }) => {
        if (!prompt.includes("AVAILABLE SKILLS")) return "DELIVERABLE:\ncode";
        const m = /^- ([a-z0-9][a-z0-9-]*):/m.exec(prompt);
        return `SKILLS: ${m ? m[1] : "NONE"}`;
      },
    });
    const rec = await runOnce({ scenario, arm: "placebo", repIndex: 0, driver, opts: OPTS() });
    assert.equal(rec.ok, true);
    assert.ok(rec.chosen.length > 0, "mock chose an offered skill");
    assert.ok(Object.values(rec.content_sources).every((s) => s === "placebo"), "all content is placebo");
  });

  it("runOnce retries phase 1 on a malformed SKILLS line", async () => {
    const scenario = loadScenario("docs");
    let n = 0;
    const chat = async ({ prompt }) => {
      n++;
      if (prompt.includes("AVAILABLE SKILLS")) {
        return n === 1 ? { text: "I forgot the contract", rawMs: 1 } : { text: "SKILLS: NONE", rawMs: 1 };
      }
      return { text: "DELIVERABLE:\n# Quickstart\n```\nnpm install\n```\n1. install\n2. repodoc init\n3. run", rawMs: 1 };
    };
    const rec = await runOnce({ scenario, arm: "none", repIndex: 0, driver: { chat }, opts: OPTS() });
    assert.equal(rec.ok, true);
    assert.equal(rec.retries, 1);
    assert.equal(rec.phase1.retries, 1);
    assert.equal(rec.phase2.retries, 0);
  });

  it("runOnce completes (ok) even when the driver always throws", async () => {
    const scenario = loadScenario("testing");
    const driver = { chat: async () => { throw new Error("boom"); } };
    const rec = await runOnce({ scenario, arm: "none", repIndex: 0, driver, opts: { ...OPTS(), maxRetries: 1 } });
    assert.equal(rec.ok, true);
    assert.equal(rec.retries, 2); // 2 phases x maxRetries=1
    assert.equal(rec.phase1.retries, 1);
    assert.match(rec.phase1.last_error, /boom/);
  });

  it("buildRoutePrompt shows cards; buildTaskPrompt injects content", () => {
    const scenario = loadScenario("cli-tool");
    assert.match(buildRoutePrompt(scenario, { ids: [] }), /\(none/);
    assert.match(buildRoutePrompt(scenario, { ids: ["react-best-practices"] }), /react-best-practices:/);
    const tp = buildTaskPrompt(scenario, [{ id: "x", text: "SECRET-CONTENT", source: "cache" }]);
    assert.match(tp, /SECRET-CONTENT/);
    assert.match(tp, /DELIVERABLE:/);
  });

  it("parseArgs reads CLI flags", () => {
    const o = parseArgs(["--scenario", "js-frontend", "--arms", "repotify,none", "--runs", "3", "--dry-run"]);
    assert.equal(o.scenario, "js-frontend");
    assert.equal(o.arms, "repotify,none");
    assert.equal(o.runs, 3);
    assert.equal(o.dryRun, true);
  });
});

describe("report", () => {
  it("aggregate computes means per scenario x arm", () => {
    const rows = aggregate([
      { event: "harness_run", ok: true, scenario: "docs", arm: "repotify", routing_recall: 1, task_score: 0.8, routing_violations: 0, retries: 0, tokens_est_in: 400, tokens_est_out: 200, latency_ms: 10 },
      { event: "harness_run", ok: true, scenario: "docs", arm: "repotify", routing_recall: 0.5, task_score: 0.6, routing_violations: 1, retries: 1, tokens_est_in: 400, tokens_est_out: 200, latency_ms: 20 },
      { event: "harness_run", ok: false, scenario: "docs", arm: "repotify" },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].routing_recall, 0.75);
    assert.equal(rows[0].task_score, 0.7);
    assert.equal(rows[0].violations, 1);
    assert.equal(rows[0].n, 2);
    assert.ok(Array.isArray(rows[0].task_ci95) && rows[0].task_ci95.length === 2);
  });

  it("bootstrapCI brackets the mean", () => {
    const [lo, hi] = bootstrapCI([1, 1, 1, 0, 0.5], 200, 7);
    assert.ok(lo <= 0.7 && 0.7 <= hi, `mean 0.7 not in [${lo}, ${hi}]`);
    assert.ok(lo <= hi);
  });

  it("marks none arm routing recall as structural zero", () => {
    const rows = aggregate([
      { event: "harness_run", ok: true, scenario: "docs", arm: "none", routing_recall: 0, task_score: 0.3, routing_violations: 0, retries: 0, tokens_est_in: 100, tokens_est_out: 50, latency_ms: 5 },
    ]);
    assert.equal(rows[0].note, "structural zero (negative control: no skill cards shown)");
    const rep = aggregate([
      { event: "harness_run", ok: true, scenario: "docs", arm: "repotify", routing_recall: 1, task_score: 0.6, routing_violations: 0, retries: 0, tokens_est_in: 100, tokens_est_out: 50, latency_ms: 5 },
    ]);
    assert.equal(rep[0].note, null);
  });
});
