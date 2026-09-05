import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { demoSnapshot, type BlockParameter } from "../packages/typescript/qc-client/src/index.ts";
import { demoBlockDetails } from "../packages/typescript/qc-core/src/demo-parameters.ts";
import { PARAMETER_ENCODER_ROLES, parameterControlKind, parameterDisplay, parameterEditorAccent, parameterEditorControlSlots, parameterEditorFamily, parameterEditorIsFullScreen, parameterEditorPageSize, parameterEditorPageSlots, parameterEditorTabs, parameterNormalizedValue, parameterRealValue, parameterStep } from "../packages/typescript/qc-ui/src/parameter-model.ts";
import { parameterContextMenuItems } from "../packages/typescript/qc-ui/src/parameter-menu.ts";

test("the ten QC encoders map to parameters in the official physical order", () => {
  assert.deepEqual(PARAMETER_ENCODER_ROLES, [
    "footswitch:A", "footswitch:B", "footswitch:C", "footswitch:D", "footswitch:E",
    "bank:down", "footswitch:F", "footswitch:G", "footswitch:H", "tempo"
  ]);
});

test("ModelRepo control types retain the CorOS interaction primitive", () => {
  const base = { options: [] as string[] };
  assert.equal(parameterControlKind({ ...base, type: "float" }), "knob");
  assert.equal(parameterControlKind({ ...base, type: "floatWithLed" }), "knob");
  assert.equal(parameterControlKind({ type: "rotarySwitch", options: ["1/8", "1/4", "1/2"] }), "knob");
  assert.equal(parameterControlKind({ type: "comboBox", options: ["A", "B", "C"] }), "select");
  assert.equal(parameterControlKind({ type: "string", options: ["Factory IR", "User IR"] }), "select");
  assert.equal(parameterControlKind({ type: "switch", options: ["Off", "On"] }), "switch");
  assert.equal(parameterControlKind({ type: "toggleButton", options: ["Off", "On"] }), "button");
  assert.equal(parameterControlKind({ ...base, type: "fader" }), "fader");
  assert.equal(parameterControlKind({ ...base, type: "grMeter" }), "meter");
});

test("all nine ModelRepo parameter types retain the measured Cortex Control geometry", () => {
  const editorSource = readFileSync(new URL("../packages/typescript/qc-ui/src/parameter-editor.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../packages/typescript/qc-ui/src/live-surface.css", import.meta.url), "utf8");

  assert.match(
    css,
    /\.coros-parameter \{[^}]*background: var\(--qc-device-control-surface\);/s,
    "parameter cells use the shared Cortex N40 theme token",
  );
  assert.match(css, /\.parameter-knob::before \{[^}]*background: var\(--qc-device-panel-raised\);/s, "float and floatWithLed knobs use the shared Cortex N30 token");
  assert.match(css, /\.coros-parameter select \{[^}]*bottom: 10%;[^}]*width: 87\.5%;[^}]*background-color: var\(--qc-device-panel\);[^}]*text-align: left;/s, "comboBox and string selectors match the 140x32 official control");
  assert.match(css, /\.parameter-switch \{[^}]*left: 6%;[^}]*top: 40%;[^}]*width: 13\.5%;[^}]*height: 48%;/s, "two-way switch uses the embedded parameterView bounds");
  assert.match(css, /\.is-3-way \.parameter-switch \{[^}]*top: 30%;[^}]*height: 58%;/s, "three-way switch uses the embedded parameterView bounds");
  assert.match(css, /\.parameter-toggle-button \{[^}]*width: 75%;[^}]*border: 0;[^}]*background: var\(--qc-device-panel\);/s, "toggleButton uses the dedicated text-button style");
  assert.match(css, /\.graphic-eq-faders \.parameter-name \{ top: 87\.5%;/);
  assert.match(css, /\.graphic-eq-faders \.parameter-value \{ top: 3%;/);
  assert.match(css, /\.parameter-gr-meter \{[^}]*right: 5%;[^}]*bottom: 8%;[^}]*left: 5%;[^}]*height: 1cqw;[^}]*background: var\(--qc-device-panel\);/s);
  assert.match(css, /\.parameter-gr-meter span \{[^}]*background: var\(--qc-category-overdrive\);/s, "gain reduction uses the shared Cortex pitch-yellow token");
  assert.match(editorSource, /\(parameter\.ledValue \?\? 0\) > \.02/, "floatWithLed does not mistake the knob setting for its live indicator");
});

test("rotary switches use discrete CorOS dots and dependency dimming leaves the cell background intact", () => {
  const editorSource = readFileSync(new URL("../packages/typescript/qc-ui/src/parameter-editor.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../packages/typescript/qc-ui/src/live-surface.css", import.meta.url), "utf8");
  assert.match(editorSource, /rotarySwitch \? " is-rotary-switch"/);
  assert.match(editorSource, /parameter-step-dots/);
  assert.match(editorSource, /Array\.from\(\{ length: rotaryStepCount \}/);
  assert.match(editorSource, /index === optionIndex \? " is-filled is-current"/);
  assert.doesNotMatch(editorSource, /index <= optionIndex/, "a rotary switch highlights only its selected dot, not a progress range");
  assert.match(css, /\.is-rotary-switch \.parameter-knob \{ background: var\(--qc-transparent\); \}/);
  assert.match(css, /\.parameter-step-dot \{[^}]*border-radius: 50%/);
  assert.match(css, /\.coros-parameter\.is-disabled > \* \{ opacity: \.55; \}/);
  assert.match(css, /\.parameter-knob:disabled \{ opacity: 1; \}/, "disabled dependency opacity is applied once at the cell-content level");
  assert.doesNotMatch(css, /\.coros-parameter\.is-disabled::after/);
});

test("ModelRepo displayPos is placed in the physical CorOS screen positions", () => {
  const protocol = ["GAIN", "BASS", "MID", "TREBLE", "MASTER", "PRESENCE", "OUTPUT"].map((name, index) => ({ name, displayPosition: [0, 1, 2, 3, 5, 4, 6][index] }));
  assert.deepEqual(parameterEditorPageSlots(protocol, 0, 10), [
    protocol[0], protocol[1], protocol[2], protocol[3], protocol[5],
    protocol[4], protocol[6], undefined, undefined, undefined
  ]);
  const flangerish = ["MIX", "RATE", "DEPTH", "FEEDBACK", "WIDTH", "DRIVE", "SYNC", "SYNC NOTE"]
    .map((name, index) => ({ name, displayPosition: [0, 1, 4, 5, 6, 7, 2, 3][index] }));
  assert.deepEqual(parameterEditorPageSlots(flangerish, 0, 10).map((parameter) => parameter?.name), [
    "MIX", "RATE", "SYNC", "SYNC NOTE", "DEPTH", "FEEDBACK", "WIDTH", "DRIVE", undefined, undefined
  ]);
});

test("demo mode supplies a parameter editor for every represented block category", () => {
  const blocks = demoSnapshot.blocks.filter((block) => block.column >= 0 && block.category);
  assert.equal(new Set(blocks.map((block) => block.category)).size, 19);
  for (const block of blocks) {
    const details = demoBlockDetails(block, 0);
    assert.equal(details.category, block.category);
    assert.ok(details.parameters.length > 0, `${block.category} has parameters`);
    assert.deepEqual(details.parameters.map((parameter) => parameter.index), details.parameters.map((_, index) => index));
  }
});

test("physical demo models preserve their captured switch primitives", () => {
  const topBoost = demoBlockDetails({ id: "amp", name: "UK C30 TopBoost", kind: "amp", category: "Amp", row: 0, column: 0 }, 0);
  assert.equal(topBoost.parameters.find((parameter) => parameter.name === "BOOST")?.type, "switch");
  const flanger = demoBlockDetails({ id: "mod", name: "Digital Flanger", kind: "mod", category: "Modulation", row: 0, column: 0 }, 0);
  assert.deepEqual(flanger.parameters.filter((parameter) => ["SYNC", "POLARITY", "DRIVE"].includes(parameter.name)).map((parameter) => parameter.type), ["switch", "switch", "enum"]);
  assert.deepEqual(flanger.parameters.filter((parameter) => ["RATE", "DELAY"].includes(parameter.name)).map((parameter) => parameter.displayPrecision), [2, 2]);
  const ambience = demoBlockDetails({ id: "reverb", name: "Ambience", kind: "reverb", category: "Reverb", row: 0, column: 0 }, 0);
  assert.equal(ambience.parameters.find((parameter) => parameter.name === "TRAILS")?.type, "switch");
  assert.equal(ambience.parameters.find((parameter) => parameter.name === "TRAILS")?.normalizedValue, 0);
});

test("Brit 2203 retains ModelRepo protocol order before physical screen placement", () => {
  const amp = demoSnapshot.blocks.find((block) => block.category === "Amp");
  assert.ok(amp);
  assert.deepEqual(demoBlockDetails(amp, 0).parameters.map((parameter) => parameter.name), [
    "GAIN", "BASS", "MID", "TREBLE", "MASTER", "PRESENCE", "OUTPUT"
  ]);
});

test("editor families reserve full-screen mode for dedicated device screens", () => {
  assert.equal(parameterEditorFamily("Compressor"), "compressor");
  assert.equal(parameterEditorFamily("EQ"), "eq");
  assert.equal(parameterEditorFamily("Neural Capture"), "standard");
  assert.equal(parameterEditorIsFullScreen("Cab"), true);
  assert.equal(parameterEditorIsFullScreen("IR Loader"), true);
  assert.equal(parameterEditorIsFullScreen("IRLoaders"), true);
  assert.equal(parameterEditorIsFullScreen("Looper"), true);
  assert.equal(parameterEditorIsFullScreen("EQ"), true);
  assert.equal(parameterEditorIsFullScreen("Synth"), false);
  assert.equal(parameterEditorPageSize("EQ"), 5);
  assert.equal(parameterEditorPageSize("Compressor"), 10);
  assert.equal(parameterEditorPageSize("Synth"), 10);
  assert.equal(parameterEditorPageSize("Delay"), 10);
  assert.equal(parameterEditorPageSize("Looper"), 5);
});

test("Cab blocks use the QC Cabsim CAB and EQ screens instead of an IR selector dropdown", () => {
  const editorSource = readFileSync(new URL("../packages/typescript/qc-ui/src/parameter-editor.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../packages/typescript/qc-ui/src/live-surface.css", import.meta.url), "utf8");
  assert.deepEqual(parameterEditorTabs("212 UK C30 65 (M)", "Guitar Cab", 2), ["CAB", "EQ"]);
  assert.match(editorSource, /const base = side \* 8/);
  assert.match(editorSource, /const controls = \[position, distance, level, pan\]/);
  assert.match(editorSource, /cab-microphone-selector/);
  assert.match(editorSource, /cab-channel-power/);
  assert.match(editorSource, /Invert microphone/);
  assert.match(editorSource, /\[16, 18, 17\]/, "EQ follows the QC HPF, output volume, LPF order");
  assert.match(editorSource, /onCommitBatch\(\[\{ parameter: position/, "speaker dragging commits both live QC coordinates in order");
  assert.match(css, /\.cab-speaker \{[^}]*touch-action: none;/s);
  assert.match(css, /\.cab-eq-curve/);
  assert.doesNotMatch(editorSource, /selectors\.slice\(0, 2\)/, "the old guessed IR dropdown renderer is gone");
  const parameters = Array.from({ length: 19 }, (_, index) => ({ index }));
  assert.deepEqual(parameterEditorControlSlots(parameters, "Guitar Cab", 0, 10).map((parameter) => parameter?.index), [5, 4, 2, 3, undefined, 13, 12, 10, 11, undefined]);
  assert.deepEqual(parameterEditorControlSlots(parameters, "Guitar Cab", 1, 10).map((parameter) => parameter?.index), [16, 18, 17, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
});

test("IR Loader uses the dedicated QC channel, impulse, and room screens", () => {
  const editorSource = readFileSync(new URL("../packages/typescript/qc-ui/src/parameter-editor.tsx", import.meta.url), "utf8");
  assert.deepEqual(parameterEditorTabs("Dual (ST)", "IR Loader", 2), ["1", "2"]);
  assert.match(editorSource, /function IrLoaderChannel/);
  assert.match(editorSource, /const mute = byIndex\(base\)/);
  assert.match(editorSource, /const phase = byIndex\(base \+ 1\)/);
  assert.match(editorSource, /const impulse = byIndex\(base \+ 2\)/);
  assert.match(editorSource, /\[3, 4, 5, 6, 7\]/);
  assert.match(editorSource, /parameter\.index >= 16 && parameter\.index <= 21/);
});

test("reverb pages follow the official mix-first ordering", () => {
  const reverb = demoSnapshot.blocks.find((block) => block.category === "Reverb");
  assert.ok(reverb);
  assert.equal(demoBlockDetails(reverb, 0).parameters[0]?.name, "MIX");
});

test("Looper X exposes the complete documented parameter set over three five-control pages", () => {
  const looper = demoSnapshot.blocks.find((block) => block.category === "Looper");
  assert.ok(looper);
  assert.deepEqual(demoBlockDetails(looper, 0).parameters.map((parameter) => parameter.name), [
    "PLAYBACK LEVEL", "OVERDUB LEVEL", "HIGH PASS", "LOW PASS", "THRESHOLD",
    "RECORD MODE", "OVERDUB MODE", "DUPLICATE MODE", "PUNCH MODE", "ROUTING MODE",
    "QUANTIZE", "MIDI CLOCK START", "PRE ROLL", "METRONOME PLAYBACK", "RECORDING LENGTH"
  ]);
  assert.deepEqual(parameterEditorTabs("Looper X", "Looper", 3), ["1", "2", "3"]);
});

test("Plugin Parametric-4 does not drop the second half of its QC controls", () => {
  const editorSource = readFileSync(new URL("../packages/typescript/qc-ui/src/parameter-editor.tsx", import.meta.url), "utf8");
  assert.match(editorSource, /eq-simple-controls">\{props\.parameters\.slice\(0, 10\)/);
});

test("Harmonic Tremolo follows the QC catalog parameter order", () => {
  const tremolo = demoSnapshot.blocks.find((block) => block.name === "Harmonic Tremolo");
  assert.ok(tremolo);
  assert.deepEqual(demoBlockDetails(tremolo, 0).parameters.map((parameter) => parameter.name), [
    "RATE", "DEPTH", "WAVEFORM", "DUTY CYCLE", "SMOOTHING", "LFO ACTIVE", "FADE IN",
    "FADE OUT", "BOOST", "LP XOVER", "HP XOVER", "SYNC", "SYNC NOTE", "SYNC ON"
  ]);
});

test("editor-only styling and assignments follow the hardware rules", () => {
  assert.equal(parameterEditorAccent("Adaptive Gate", "#ffd236"), "#f4f4f4");
  assert.equal(parameterEditorAccent("Harmonic Tremolo", "#3500f1"), "#3500f1");
  assert.deepEqual(parameterEditorTabs("Harmonic Tremolo", "Modulation", 2), ["MAIN", "PAGE 2"]);
  const wah = demoSnapshot.blocks.find((block) => block.category === "Wah");
  assert.ok(wah);
  assert.equal(demoBlockDetails(wah, 0).parameters[0]?.expression, 1);
});

test("parameter scene navigation uses the QC reference double chevrons", () => {
  const editorSource = readFileSync(new URL("../packages/typescript/qc-ui/src/parameter-editor.tsx", import.meta.url), "utf8");
  const iconSource = readFileSync(new URL("../packages/typescript/qc-ui/src/theme-icons.tsx", import.meta.url), "utf8");
  assert.match(editorSource, /QcEditorIcon kind="scene-previous"/);
  assert.match(editorSource, /QcEditorIcon kind="scene-next"/);
  assert.match(iconSource, /M11 4 3 12l8 8zM21 4l-8 8 8 8z/);
  assert.match(iconSource, /m13 4 8 8-8 8zM3 4l8 8-8 8z/);
  assert.doesNotMatch(iconSource, /M15\.8 3\.8 7\.6 12/);
  assert.doesNotMatch(iconSource, /m8\.2 3\.8 8\.2 8\.2/);
});

test("parameter header displays canonical QC device-type names verbatim", () => {
  const editorSource = readFileSync(new URL("../packages/typescript/qc-ui/src/parameter-editor.tsx", import.meta.url), "utf8");
  assert.match(editorSource, /function editorCategoryLabel\(category: string\) \{ return category\.toUpperCase\(\); \}/);
  assert.doesNotMatch(editorSource, /category\.trim\(\)\.toLowerCase\(\) === "amp"/);
});

test("parameter controls preserve catalog option and stepped behavior", () => {
  const option: BlockParameter = { index: 0, name: "MODE", normalizedValue: 0, displayValue: "A", units: "", type: "enum", minimum: 0, maximum: 1, steps: 3, sceneMode: false, options: ["A", "B", "C"], writable: true };
  const continuous: BlockParameter = { ...option, name: "GAIN", options: [], steps: 11, minimum: 0, maximum: 10, units: "dB" };
  assert.equal(parameterStep(option), .5);
  assert.equal(parameterDisplay(option, .51), "B");
  assert.equal(parameterStep(continuous), .1);
  assert.equal(parameterDisplay(continuous, .5), "5.0 dB");
  assert.equal(parameterDisplay({ ...continuous, displayPrecision: 0 }, .5), "5 dB");
  assert.equal(parameterDisplay({ ...continuous, minimum: -0.00001, maximum: -0.00001 }, .5), "0.0 dB");
});

test("Parametric EQ uses the dedicated graph and selected-band hardware layout", () => {
  const eq = demoSnapshot.blocks.find((block) => block.name === "Parametric-8");
  assert.ok(eq);
  const details = demoBlockDetails(eq, 0);
  assert.equal(details.parameters.length, 41);
  assert.deepEqual(details.parameters.slice(0, 5).map((parameter) => parameter.name), ["1 GAIN", "1 FREQ", "1 Q", "1 TYPE", "1 BYPASS"]);
  assert.equal(details.parameters.at(-1)?.name, "OUTPUT");
  const editorSource = readFileSync(new URL("../packages/typescript/qc-ui/src/parameter-editor.tsx", import.meta.url), "utf8");
  assert.match(editorSource, /EqResponseGraph/);
  assert.match(editorSource, /parameterWithName\(selected\.type, "TYPE"/);
  assert.match(editorSource, /parameterWithName\(selected\.frequency, "FREQ"/);
  assert.match(editorSource, /className="eq-band-tabs"/);
  assert.match(editorSource, /BYPASS \{band\.number\}/);
  assert.match(editorSource, /activePoints = points\.filter\(\(point\) => !point\.bypassed\)\.sort/, "bypassed bands keep their chart nodes but do not shape the response curve");
  assert.match(editorSource, /Band \$\{band\.number\}\$\{bypassed \? ", bypassed" : ""\}/, "bypassed tabs remain rendered and accessible");
  assert.match(editorSource, /family === "eq" \? \[\]/, "EQ bands are selected on the graph, not through invented paging tabs");
  const css = readFileSync(new URL("../packages/typescript/qc-ui/src/live-surface.css", import.meta.url), "utf8");
  assert.match(css, /\.eq-selected-controls \.coros-parameter select \{ top: 34%; bottom: auto; height: 4\.2cqw;/, "the Type selector has a fixed unclipped row in the full-screen editor");
});

test("parameter contextual menus follow the CorOS device order and special cases", () => {
  const amp = parameterContextMenuItems({ modelId: 10, name: "Brit 2203", category: "Amp" }, 10);
  assert.deepEqual(amp.map((item) => item.label), [
    "Save Current Parameters As…", "Change device", "Copy device", "Paste device",
    "Reset to defaults", "Set parameters as defaults", "Assign Expression Pedal",
    "Remove block from the grid"
  ]);
  assert.equal(amp.find((item) => item.action === "paste-device")?.disabled, false);
  assert.equal(parameterContextMenuItems({ modelId: 10, name: "Brit 2203", category: "Amp" }, 11).find((item) => item.action === "paste-device")?.disabled, true);
  assert.doesNotMatch(amp.map((item) => item.label).join("|"), /Footswitch|Advanced/, "footswitch assignment is a separate header control on the QC");

  const capture = parameterContextMenuItems({ modelId: 20, name: "OD Capture", category: "Neural Capture" });
  assert.notEqual(capture[0]?.action, "save-device-preset", "Neural Captures do not support Virtual Device Presets");
  assert.ok(parameterContextMenuItems({ modelId: 30, name: "Looper X", category: "Looper" }).some((item) => item.action === "assign-looper-actions"));
  assert.ok(parameterContextMenuItems({ modelId: 40, name: "FX Loop 1", category: "FX Loop" }).some((item) => item.action === "mute-bypass"));
});

test("footswitch assignment uses the hardware-switch workflow instead of a duplicate popup", () => {
  const editorSource = readFileSync(new URL("../packages/typescript/qc-ui/src/parameter-editor.tsx", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const surfaceActions = readFileSync(new URL("../packages/typescript/qc-ui/src/use-qc-surface-actions.ts", import.meta.url), "utf8");

  assert.match(editorSource, /Waiting for a footswitch assignment/);
  assert.match(editorSource, /is-assigning/);
  assert.doesNotMatch(editorSource, /parameter-assignment-menu|menuitemradio/);
  assert.match(appSource, /useQcSurfaceActions\(\{/);
  assert.match(surfaceActions, /grid\.footswitchAssignmentPending && action\.phase === "release"/);
});

test("Flangerish Rate round-trips the measured CorOS frequency scale", () => {
  const rate: BlockParameter = {
    index: 1, name: "RATE", normalizedValue: .5, displayValue: "4.14", units: "Hz",
    type: "float", minimum: .06, maximum: 13, valueScale: "power", scaleExponent: 5 / 3,
    displayPrecision: 2, scaleKnown: true, steps: null, sceneMode: false, options: [], writable: true
  };
  assert.equal(parameterDisplay(rate, 0), "0.06 Hz");
  assert.equal(parameterDisplay(rate, .5), "4.14 Hz");
  assert.equal(parameterDisplay(rate, 1), "13.00 Hz");
  for (const hz of [.06, 1, 4.14, 8, 13]) {
    assert.ok(Math.abs(parameterRealValue(rate, parameterNormalizedValue(rate, hz)) - hz) < 1e-9);
  }
});

test("ordinary Hertz controls render without decimals when metadata omits precision", () => {
  const cutoff: BlockParameter = {
    index: 2, name: "HIGH PASS", normalizedValue: .5, displayValue: "410", units: "Hz",
    type: "float", minimum: 20, maximum: 800, valueScale: "linear",
    scaleKnown: true, steps: 200, sceneMode: false, options: [], writable: true
  };
  assert.equal(parameterDisplay(cutoff, .5), "410 Hz");
});

test("ModelRepo logarithmic scales and endpoint labels round-trip exactly", () => {
  const filter: BlockParameter = {
    index: 0, name: "HIGH PASS", normalizedValue: 0, displayValue: "OFF", units: "Hz",
    type: "float", minimum: 20, maximum: 20000, valueScale: "logarithmic",
    displayPrecision: 0, scaleKnown: true, minimumLabel: "OFF", steps: 1001,
    sceneMode: false, options: [], writable: true
  };
  assert.equal(parameterDisplay(filter, 0), "OFF");
  assert.equal(parameterDisplay(filter, .5), "632 Hz");
  assert.ok(Math.abs(parameterNormalizedValue(filter, 2000) - (2 / 3)) < 1e-9);
  assert.ok(Math.abs(parameterRealValue(filter, parameterNormalizedValue(filter, 440)) - 440) < 1e-9);
});
