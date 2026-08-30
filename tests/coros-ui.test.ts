import assert from "node:assert/strict";
import test from "node:test";
import { GRID_CONTEXT_MENU, openSplitPath } from "../packages/typescript/qc-ui/src/coros-ui.ts";

test("Grid contextual menu starts with the device Create New command", () => {
  assert.equal(GRID_CONTEXT_MENU[0].label, "Create New");
  assert.deepEqual(GRID_CONTEXT_MENU.map((item) => item.label), [
    "Create New", "Save as…", "Edit details", "Preset MIDI Out", "Add to favorites",
    "Delete preset", "New Neural Capture", "Tempo", "CPU monitor", "Settings"
  ]);
});

test("an open row-three split curves into the beginning of row four", () => {
  assert.equal(openSplitPath(659.5, 338, 430), "M659.5 338 C659.5 375,52 393,52 430");
});
