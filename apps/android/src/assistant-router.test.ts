import assert from "node:assert/strict";
import test from "node:test";
import { parseAssistantReply, validateAssistantActions } from "@ndsp-qc/core";

test("parses fenced JSON and validates a scene", () => {
  const reply = parseAssistantReply('```json\n{"reply":"Done","actions":[{"name":"select_scene","args":{"scene":2}},{"name":"set_tempo","args":{"bpm":96}}]}\n```');
  assert.ok(reply);
  assert.deepEqual(validateAssistantActions(reply), [{ name: "select_scene", scene: 2 }, { name: "set_tempo", bpm: 96 }]);
});

test("rejects unknown, malformed, and out-of-range actions", () => {
  const reply = { actions: [
    { name: "raw_usb_write", args: {} },
    { name: "select_scene", args: { scene: 9 } },
    { name: "set_selected_block_bypass", args: { bypassed: "yes" } }
  ] };
  assert.deepEqual(validateAssistantActions(reply as never), []);
});

test("deduplicates actions and limits the model to four proposals", () => {
  const reply = { actions: [
    { name: "next_preset" }, { name: "next_preset" },
    { name: "show_tuner" }, { name: "show_gig_view", args: { show: false } },
    { name: "previous_preset" }
  ] };
  assert.deepEqual(validateAssistantActions(reply), [
    { name: "next_preset" },
    { name: "show_tuner", show: true },
    { name: "show_gig_view", show: false }
  ]);
});
