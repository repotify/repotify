import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeMachine, missingRuntime, formatMachine } from "../src/machine.mjs";
import { selectSet, GATE_REASONS } from "../lib/pipeline/recommend/present.mjs";

const tempDirs = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "rp-machine-"));
  tempDirs.push(d);
  return d;
};

test("the machine probe finds executables on PATH without running them", () => {
  const bin = tempDir();
  const other = tempDir();
  writeFileSync(join(bin, "uvx"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(bin, "docker"), "not executable\n", { mode: 0o644 });
  writeFileSync(join(other, "python"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(other, "git"));
  const m = probeMachine({ env: { PATH: `${bin}:${join(bin, "missing")}:${other}` }, platform: "linux", arch: "x64" });
  assert.equal(m.os, "linux");
  assert.equal(m.tools.uvx, true);
  assert.equal(m.tools.python, true, "python3 or python");
  assert.equal(m.tools.docker, false, "a file without the execute bit is not a program");
  assert.equal(m.tools.git, false, "a directory is not a program");
  assert.equal(m.tools.node, false);
  assert.equal(formatMachine(m), "linux/x64; tools: python, uvx");
  assert.equal(formatMachine(probeMachine({ env: {}, platform: "linux", arch: "arm64" })), "linux/arm64; tools: none found");
});

// Windows file names are case-insensitive; the probe asks for the lower-case extension, as the test's files have it.
test("on Windows the probe reads Path and PATHEXT, and needs no execute bit", () => {
  const bin = tempDir();
  writeFileSync(join(bin, "npx.cmd"), "@echo off\n", { mode: 0o644 });
  writeFileSync(join(bin, "docker.exe"), "", { mode: 0o644 });
  writeFileSync(join(bin, "uv.ps1"), "", { mode: 0o644 });
  const m = probeMachine({ env: { Path: `${bin};C:\\nowhere`, PATHEXT: ".EXE;.CMD" }, platform: "win32", arch: "x64" });
  assert.equal(m.os, "win32");
  assert.equal(m.tools.npx, true);
  assert.equal(m.tools.docker, true);
  assert.equal(m.tools.uv, false, "an extension PATHEXT does not list does not run");
});

test("what an item needs and this computer lacks: the MCP server's command, or the first word of a tool's steps", () => {
  const machine = { tools: { npx: true, node: true, uv: false, uvx: false, docker: false, pipx: true } };
  assert.deepEqual(missingRuntime({ type: "mcp", setup: { mcp: { command: "uvx", args: ["thing@1"] } } }, machine), ["uv"]);
  assert.deepEqual(missingRuntime({ type: "mcp", setup: { mcp: { command: "npx", args: ["-y", "x@1"] } } }, machine), []);
  assert.deepEqual(missingRuntime({ type: "mcp", setup: { mcp: { command: "uvx" } } }, { tools: { ...machine.tools, uv: true } }), [], "uv provides uvx");
  assert.deepEqual(missingRuntime({ type: "tool", setup: { steps: ["docker run --rm x", "pipx install y"] } }, machine), ["docker"]);
  assert.deepEqual(missingRuntime({ type: "mcp", setup: { mcp: { command: "./run-server.sh" } } }, machine), [], "an unknown command is not held against it");
  assert.deepEqual(missingRuntime({ type: "skill" }, machine), []);
  assert.deepEqual(missingRuntime({ type: "mcp", setup: { mcp: { command: "uvx" } } }, null), [], "unknown machine");
});

test("a server this computer cannot run is listed with what it needs, never put in the default set", () => {
  const row = (id, command) => ({
    item: { id, cluster: id, type: "mcp", origin: "curated", tier: "mission", capabilities: [id], needs: [], stacks: ["*"], descriptionChars: 100, setup: { mcp: { command } } },
    score: 0.8, parts: { classFit: 0.9 }, flags: [],
  });
  const scored = [row("py-server", "uvx"), row("js-server", "npx")];
  const demand = { capabilitiesWanted: ["py-server", "js-server"], machine: { tools: { npx: true, uv: false, uvx: false } } };
  const { selected, skipped } = selectSet(scored, { demand });
  assert.deepEqual(selected.map((s) => s.item.id), ["js-server"]);
  const s = skipped.find((x) => x.id === "py-server");
  assert.equal(s.reason, GATE_REASONS.MISSING_RUNTIME);
  assert.equal(s.blocker, "uv");
  assert.deepEqual(selectSet(scored, { demand: { capabilitiesWanted: demand.capabilitiesWanted } }).selected.map((x) => x.item.id).sort(), ["js-server", "py-server"], "unknown machine: both");
});
