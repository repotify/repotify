// Unit tests for test/harness/drivers.mjs — mock driver only, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mockDriverFactory, makeDriver, DRIVERS } from "./drivers.mjs";

describe("drivers", () => {
  it("mock driver returns scripted reply and records calls", async () => {
    const chat = mockDriverFactory({ default: "SKILLS: react-best-practices\nDELIVERABLE:\nok" });
    const r = await chat({ system: "s", prompt: "p", temperature: 0.2 });
    assert.match(r.text, /SKILLS:/);
    assert.equal(chat.calls.length, 1);
    assert.equal(chat.calls[0].prompt, "p");
    assert.equal(typeof r.rawMs, "number");
  });

  it("mock driver default reply is well-formed", async () => {
    const chat = mockDriverFactory({});
    const r = await chat({ system: "", prompt: "" });
    assert.match(r.text, /^SKILLS:/m);
    assert.match(r.text, /DELIVERABLE:/);
  });

  it("makeDriver exposes the model-agnostic registry", () => {
    assert.ok(DRIVERS.nvidia, "nvidia driver registered");
    assert.ok(DRIVERS.mock, "mock driver registered");
    const d = makeDriver("mock");
    assert.equal(typeof d.chat, "function");
  });

  it("makeDriver throws on unknown driver", () => {
    assert.throws(() => makeDriver("nope"), /unknown driver/);
  });
});
