import assert from "node:assert/strict";
import test from "node:test";
import { parseAssistantIntent } from "../apps/windows/src/assistant.ts";

test("parses immediate performance commands", () => {
  assert.deepEqual(parseAssistantIntent("Scene C"), { kind: "scene", index: 2 });
  assert.deepEqual(parseAssistantIntent("bank down"), { kind: "bank", direction: -1 });
  assert.deepEqual(parseAssistantIntent("recall 6b"), { kind: "recall", location: "6B" });
  assert.deepEqual(parseAssistantIntent("open tuner"), { kind: "view", view: "tuner" });
  assert.deepEqual(parseAssistantIntent("set tempo to 121 BPM"), { kind: "tempo", bpm: 121 });
});

test("parses edits for preview instead of direct application", () => {
  assert.deepEqual(parseAssistantIntent("bypass selected block"), { kind: "bypass", desired: "bypassed" });
  assert.deepEqual(parseAssistantIntent("set Noise Reduction to 51%"), {
    kind: "parameter",
    parameter: "noise reduction",
    value: "51%"
  });
});
