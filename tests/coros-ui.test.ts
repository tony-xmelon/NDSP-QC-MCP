import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { demoSnapshot } from "../packages/typescript/qc-client/src/index.ts";
import { DIRECTORY_PRESET_CONTEXT_MENU, GRID_CONTEXT_MENU, PRESET_TITLE_RIGHT_EDGE, gridBlocksByRow, mixAnchorX, openSplitPath, presetTitleLayout, presetTitlePresentation, rejoinSplitPath, routedPortIsPlugged, rowHasVisibleSignalRail, splitAnchorX } from "../packages/typescript/qc-ui/src/coros-ui.ts";
import { consumeQcNativeStateFrame } from "../packages/typescript/qc-ui/src/qc-native-state-frame.ts";
import { corosFixtureConfiguration } from "../packages/typescript/qc-ui/src/coros-screen-fixture-data.ts";

test("visual fixture query state is identical for every host", () => {
  const fixture = corosFixtureConfiguration("?fixture=coros410&screen=tempo&mode=SCENE&tempo=91", demoSnapshot);
  assert.equal(fixture.enabled, true);
  assert.equal(fixture.screenView, "tempo");
  assert.equal(fixture.initialSnapshot.mode, "SCENE");
  assert.equal(fixture.initialSnapshot.tempo, 91);
  const ordinary = corosFixtureConfiguration("?screen=grid", demoSnapshot);
  assert.equal(ordinary.enabled, false);
  assert.equal(ordinary.initialSnapshot, demoSnapshot);
});

test("native frame ordering, timestamps, and tempo clocks are host-independent", () => {
  const sequence = { current: 0 };
  let snapshot = { ...demoSnapshot };
  const observations: Array<{ count: number; observedAt?: number }> = [];
  const consumer = {
    sequence,
    consume: (states: readonly unknown[], observedAt?: number) => observations.push({ count: states.length, observedAt }),
    setSnapshot: (update: typeof snapshot | ((current: typeof snapshot) => typeof snapshot)) => {
      snapshot = typeof update === "function" ? update(snapshot) : update;
    }
  };
  const frame = {
    sequence: 4,
    observedAt: 120_000,
    states: [{ kind: "tempo", tempo: 120 }],
    tempoClock: { currentTick: 0 }
  };

  assert.equal(consumeQcNativeStateFrame(frame, consumer), true);
  assert.deepEqual(observations, [{ count: 1, observedAt: 120_000 }]);
  assert.equal(sequence.current, 4);
  assert.equal(typeof snapshot.tempoPulseEpochMs, "number");
  assert.equal(consumeQcNativeStateFrame(frame, consumer), false);
  assert.equal(observations.length, 1, "a duplicate native frame must not be reduced twice");
});

test("empty preset titles match the QC clean and dirty Unsaved states", () => {
  assert.deepEqual(presetTitlePresentation("", false), { text: "Unsaved", dimmed: true, italic: false });
  assert.deepEqual(presetTitlePresentation("Unsaved", false), { text: "Unsaved", dimmed: true, italic: false });
  assert.deepEqual(presetTitlePresentation("", true), { text: "Unsaved*", dimmed: false, italic: true });
  assert.deepEqual(presetTitlePresentation("Brit 2203", false), { text: "Brit 2203", dimmed: false, italic: false });
});

test("neutral Grid colors match the native QC capture", () => {
  const surfaceSource = readFileSync(new URL("../packages/typescript/qc-ui/src/quad-cortex-surface.tsx", import.meta.url), "utf8");
  const themeSource = readFileSync(new URL("../packages/typescript/qc-theme/src/colors.json", import.meta.url), "utf8");
  assert.match(surfaceSource, /QC_COLORS/);
  assert.match(themeSource, /"unsaved": "#313031"/);
  assert.match(themeSource, /"routePill": "#101010"/);
  assert.match(themeSource, /"routeText": "#dedfde"/);
  assert.match(themeSource, /"routeRail": "#c6c3c6"/);
  assert.match(themeSource, /"utilityMark": "#949694"/);
  assert.match(surfaceSource, /fill=\{QC_COLORS\.captured\.routePill\}/);
  assert.match(surfaceSource, /stroke=\{QC_COLORS\.captured\.utilityMark\}/);
  assert.doesNotMatch(surfaceSource, /titlePresentation\.dimmed \? "#29292b"/);
});

test("Grid contextual menu starts with the device Create New command", () => {
  assert.equal(GRID_CONTEXT_MENU[0].label, "Create New");
  assert.deepEqual(GRID_CONTEXT_MENU.map((item) => item.label), [
    "Create New", "Save as…", "Edit Details", "Copy Scene A", "Swap Scene A",
    "Preset MIDI Out", "Add to favorites", "Delete Preset", "New Neural Capture",
    "Modes Configuration", "Tempo", "CPU Monitor", "Settings"
  ]);
});

test("Edit menu separates preset and device clipboards", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const presetWorkflow = readFileSync(new URL("../packages/typescript/qc-ui/src/use-preset-workflow.ts", import.meta.url), "utf8");
  assert.match(appSource, /label: "Copy Preset"/);
  assert.match(appSource, /label: "Paste Preset"/);
  assert.match(appSource, /label: "Copy Device"/);
  assert.match(appSource, /label: "Paste Device"/);
  assert.doesNotMatch(appSource, /label: "(?:Copy|Paste) (?:Settings|Parameters)"/);
  assert.match(presetWorkflow, /gateway\.copyPreset\(/);
});

test("Preset menu owns Grid editing commands without a standalone Grid menu", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const presetMenu = appSource.slice(appSource.indexOf('{ name: "Preset"'), appSource.indexOf('{ name: "Edit"'));
  assert.match(presetMenu, /id: "add-block"/);
  assert.match(presetMenu, /id: "edit-routing"/);
  assert.match(presetMenu, /id: "discard-changes"/);
  assert.doesNotMatch(appSource, /\{ name: "Grid", items:/);
});

test("QC READY panel owns connection controls without a standalone Connection menu", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8") + readFileSync(new URL("../apps/windows/src/menu-bar.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(appSource, /\{ name: "Connection", items:/);
  assert.match(appSource, />Reconnect<|\? "Reconnect" : "Connect"/);
  assert.match(appSource, />Refresh state</);
  assert.match(appSource, />Reset session</);
  assert.match(appSource, />Disconnect</);
  assert.match(appSource, />Device info…</);
  assert.match(appSource, /onOpenDeviceInfo=\{\(\) => setDialog\("device-info"\)\}/);
});

test("an unassigned empty row does not connect its two plus endpoints", () => {
  assert.equal(rowHasVisibleSignalRail(0, { input: "Internal", output: "Internal" }), false);
  assert.equal(rowHasVisibleSignalRail(0), false);
  assert.equal(rowHasVisibleSignalRail(1, { input: "Internal", output: "Internal" }), true);
  assert.equal(rowHasVisibleSignalRail(0, { input: "In 1", output: "Multi Out" }), true);
  assert.equal(rowHasVisibleSignalRail(0, { input: "Internal", output: "Internal", splitColumn: 0 }), true);
});

test("Grid endpoint connection marks derive from native physical port state", () => {
  const ports = [
    { kind: "input", id: 1, plugged: true },
    { kind: "input", id: 2, plugged: false },
    { kind: "output", id: 4, plugged: true },
    { kind: "usb", id: 0, plugged: false }
  ];
  assert.equal(routedPortIsPlugged("input", 1, ports), true);
  assert.equal(routedPortIsPlugged("input", 2, ports), false);
  assert.equal(routedPortIsPlugged("input", 3, ports), true, "combined In 1/2 reflects either physical jack");
  assert.equal(routedPortIsPlugged("output", 1, ports), true, "Out 1/2 reflects either physical jack");
  assert.equal(routedPortIsPlugged("input", 0, ports), undefined, "Internal is not a physical jack");
});

test("Directory, Scene, and Mode menus follow their CorOS order and live device data", () => {
  assert.deepEqual(DIRECTORY_PRESET_CONTEXT_MENU.map((item) => item.label), [
    "Edit", "Copy", "Cut", "Paste", "Delete"
  ]);
  const surfaceSource = readFileSync(new URL("../packages/typescript/qc-ui/src/quad-cortex-surface.tsx", import.meta.url), "utf8");
  assert.match(surfaceSource, /sceneMenuOpen[^]*snapshot\.scenes\.map/);
  assert.match(surfaceSource, /modeMenuOpen[^]*snapshot\.modeSlots/);
  assert.match(surfaceSource, /DIRECTORY_PRESET_CONTEXT_MENU\.map/);
  assert.match(surfaceSource, /entry\.name === "Unsaved"/);
});

test("preset Directory requests and renders all 256 slots including Unsaved entries", () => {
  const runtimeSource = readFileSync(new URL("../packages/rust/qc-device-runtime/src/lib.rs", import.meta.url), "utf8");
  assert.match(runtimeSource, /pub fn list\(&self, setlist_key:/);
  assert.match(runtimeSource, /\(0\.\.256\)/);
  assert.match(runtimeSource, /unwrap_or_else\(\|\| "Unsaved"\.into\(\)\)/);
});

test("an open row-three split curves into the beginning of row four", () => {
  const path = openSplitPath(659.5, 338, 430);
  assert.equal(path, "M659.5 338V375Q659.5 384 650.5 384H61Q52 384 52 393V421Q52 430 61 430");
  assert.doesNotMatch(path, /[CL]/, "the device splitter must not contain diagonal or cubic segments");
});

test("a QC mixer return curves around the output side instead of drawing a vertical shortcut", () => {
  const path = rejoinSplitPath(488, 151, 243);
  assert.equal(path, "M488 151V188Q488 197 497 197H739Q748 197 748 206V234Q748 243 739 243");
  assert.doesNotMatch(path, /[CL]/, "the device mixer return must use the rounded orthogonal Grid path");
});

test("a mixer on the final boundary descends cleanly without a pulse loop", () => {
  const path = rejoinSplitPath(748, 151, 243);
  assert.equal(path, "M748 151V234Q748 243 739 243");
  assert.doesNotMatch(path, /H|757|197/, "the final-boundary return must not double back over itself");
});

test("a mixer anchor sits after its reported cell while the splitter stays before its cell", () => {
  assert.equal(splitAnchorX(5), 488);
  assert.equal(mixAnchorX(5), 572);
  assert.equal(mixAnchorX(7), 748);
});

test("Grid blocks tab left-to-right within each signal line", () => {
  const rows = gridBlocksByRow([
    { id: "r3c6", row: 2, column: 6 },
    { id: "r1c4", row: 0, column: 4 },
    { id: "r3c1", row: 2, column: 1 },
    { id: "r1c2", row: 0, column: 2 }
  ]);
  assert.deepEqual(rows.map((row) => row.map((block) => block.id)), [
    ["r1c2", "r1c4"], [], ["r3c1", "r3c6"], []
  ]);
});

test("long preset names retain a hard gutter before Undo for every bank width", () => {
  for (const locationWidth of [75, 125, 165]) {
    const layout = presetTitleLayout(locationWidth, 900);
    assert.equal(layout.start + layout.maxWidth, PRESET_TITLE_RIGHT_EDGE);
    assert.ok(layout.fontSize >= 22 && layout.fontSize <= 68);
  }
  const ordinary = presetTitleLayout(75, 260);
  assert.equal(ordinary.fontSize, 68, "short reference-style names remain at the native QC size");
  assert.equal(ordinary.squeeze, false);
});

test("splitter and mixer circles are selectable parameter targets", () => {
  const surfaceSource = readFileSync(new URL("../packages/typescript/qc-ui/src/quad-cortex-surface.tsx", import.meta.url), "utf8");
  const gridWorkflow = readFileSync(new URL("../packages/typescript/qc-ui/src/use-grid-workflow.ts", import.meta.url), "utf8");
  assert.match(surfaceSource, /kind: "select-routing-node"/);
  assert.match(surfaceSource, /Open row \$\{row \+ 1\} Splitter parameters/);
  assert.match(surfaceSource, /Open row \$\{row \+ 1\} Mixer parameters/);
  assert.match(surfaceSource, /stops\.sort\(\(left, right\) => left\.x - right\.x\)/, "routing nodes must participate in left-to-right row tab order");
  assert.match(gridWorkflow, /gateway\.blockDetails\(row, column, snapshot\.presetName\)/);
  assert.match(gridWorkflow, /column = node === "splitter" \? 8 : 9/);
});

test("IN and OUT taps use the in-screen CorOS route picker instead of a modal", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const surfaceSource = readFileSync(new URL("../packages/typescript/qc-ui/src/quad-cortex-surface.tsx", import.meta.url), "utf8");
  const routingSource = readFileSync(new URL("../packages/typescript/qc-core/src/routing.ts", import.meta.url), "utf8");
  const routingWorkflow = readFileSync(new URL("../packages/typescript/qc-ui/src/use-routing-workflow.ts", import.meta.url), "utf8");
  const iconSource = readFileSync(new URL("../packages/typescript/qc-ui/src/theme-icons.tsx", import.meta.url), "utf8");
  const domain = JSON.parse(readFileSync(new URL("../contracts/qc-domain.v1.json", import.meta.url), "utf8"));
  const styles = readFileSync(new URL("../packages/typescript/qc-ui/src/surface-shell.css", import.meta.url), "utf8");
  assert.match(appSource, /onOpenRouting=\{openRoutePicker\}/);
  assert.match(appSource, /routingPicker=\{routingWorkflow\.pickerProps\}/);
  assert.doesNotMatch(appSource, /window\.confirm\(`Set row \$\{row \+ 1\} \$\{kind\}/);
  assert.match(surfaceSource, /className=\{`coros-route-picker is-\$\{routingPicker\.side\}`\}/);
  assert.match(surfaceSource, /role="listbox"/);
  assert.match(surfaceSource, /aria-selected=\{value === routingPicker\.value\}/);
  assert.match(surfaceSource, /routePickerLabel\(routingPicker\.side, selectedRoute/);
  assert.match(surfaceSource, /routePickerGroups\.map/);
  assert.match(surfaceSource, /className="coros-route-focus-layer"/);
  assert.match(surfaceSource, /fill=\{QC_COLORS\.device\.focusOverlay\} fillOpacity="\.27"/);
  assert.match(surfaceSource, /QcRouteGlyph/, "the surface must use the shared route glyph renderer");
  assert.match(iconSource, /label\.startsWith\("Return "\)/, "Return routes need their dedicated curved-return glyph");
  assert.match(iconSource, /label\.startsWith\("Send "\)/, "Send routes need their dedicated outward loop glyph");
  assert.match(iconSource, /label\.startsWith\("Out "\)/, "physical outputs need their dedicated output-jack glyph");
  assert.match(iconSource, /label === "Multi Out"/, "multiple outputs need their dedicated fan-out glyph");
  assert.match(surfaceSource, /\["MONO", "STEREO", ""\] : \["STEREO", "MONO", "OTHER"\]/);
  assert.deepEqual(domain.inputRoutes.slice(0, 4).map(({ id, label }: { id: number; label: string }) => [id, label]), [[1, "In 1"], [2, "In 2"], [4, "Return 1"], [5, "Return 2"]], "input ports must follow the CorOS mono-first order");
  assert.deepEqual(domain.outputRoutes.slice(0, 4).map(({ id, label }: { id: number; label: string }) => [id, label]), [[19, "Multi Out"], [1, "Out 1/2"], [2, "Out 3/4"], [3, "Send 1/2"]], "output ports must follow the CorOS stereo-first order");
  assert.doesNotMatch(routingSource.slice(routingSource.indexOf("inputRouteOptions"), routingSource.indexOf("outputRouteOptions")), /Sidechain/, "the internal sidechain buffer is not a selectable input port");
  assert.match(routingWorkflow, /routeOptionsForRow\(picker\.side, picker\.row, value, snapshot\.routes\)/, "row routes must be filtered for the selected row");
  assert.match(styles, /\.coros-route-picker\.is-input \{ left: 7\.2%; \}/);
  assert.match(styles, /\.coros-route-focus-layer \{ position: absolute; z-index: 23;/);
  assert.match(styles, /scrollbar-color: var\(--qc-palette-96999b\) var\(--qc-transparent\)/);
  assert.doesNotMatch(styles.slice(styles.indexOf(".coros-route-picker-dismiss"), styles.indexOf(".context-menu-section")), /#45f862/, "the CorOS route list is neutral gray, not a green selection menu");
});

test("the Grid starts without an implicitly selected effect", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  assert.match(appSource, /const \[selectedBlockId, setSelectedBlockId\] = useState\(""\)/);
  assert.doesNotMatch(appSource, /setSelectedBlockId\([^\n]*blocks\[0\]/, "snapshot changes must not silently select the first block");
});

test("both visual benchmark drivers isolate the raw 800x480 framebuffer", () => {
  const windowsCapture = readFileSync(new URL("../tools/capture_windows_ui.mjs", import.meta.url), "utf8");
  const androidCapture = readFileSync(new URL("../tools/capture_android_ui.mjs", import.meta.url), "utf8");
  for (const source of [windowsCapture, androidCapture]) {
    assert.match(source, /width: 800px !important; height: 480px !important/);
    assert.match(source, /\.qc-screen-bezel::after[^}]*display: none !important/s);
    assert.match(source, /page\.mouse\.move\(viewport\.width - 1, viewport\.height - 1\)/);
    assert.match(source, /const shouldCapture = \(id\) => !requestedIds\.size \|\| requestedIds\.has\(id\)/);
    assert.match(source, /async function gridState\(id, action\) \{\s+if \(!shouldCapture\(id\)\) return;/);
    assert.match(source, /for \(const \[id,[^\n]+\) \{\s+if \(!shouldCapture\(id\)\) continue;/);
  }
  assert.match(androidCapture, /\.mobile-screen \.qc-screen \{ border-radius: 0 !important; box-shadow: none !important; \}/);
});

test("master volume has an independent two-way live synchronization path", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const controlsSource = readFileSync(new URL("../packages/typescript/qc-ui/src/use-continuous-control-workflow.ts", import.meta.url), "utf8");
  const frameSource = readFileSync(new URL("../apps/windows/src/use-windows-device-frames.ts", import.meta.url), "utf8");
  const transportSource = readFileSync(new URL("../apps/windows/src/tauri-transport.ts", import.meta.url), "utf8");
  const gatewayBindings = readFileSync(new URL("../packages/typescript/qc-client/src/generated-gateway-methods.ts", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../apps/windows/src-tauri/src/lib.rs", import.meta.url), "utf8");
  const runtimeSource = readFileSync(new URL("../packages/rust/qc-device-runtime/src/request.rs", import.meta.url), "utf8");
  assert.match(appSource, /useWindowsDeviceFrames\(/, "the desktop shell must delegate native event ownership");
  assert.match(frameSource, /type NativeFrame = NativeStateFrames<QcStateUpdate>/);
  assert.match(frameSource, /listen<NativeFrame>\("qc-state-frame"/, "hardware changes must arrive through the native event stream");
  assert.doesNotMatch(appSource, /const synchronizeVolume/, "master volume must not be polled continuously");
  assert.match(appSource, /const current = await tauriTransport\.currentSnapshot\(\)[\s\S]*?tauriTransport\.currentMasterVolume\(\)[\s\S]*?masterVolume: synchronizedVolume/, "startup must merge the authoritative Master Volume report before enabling the knob");
  assert.match(appSource, /useContinuousControlWorkflow\(\{/);
  assert.match(controlsSource, /gateway\.setMasterVolume\(target, expected\)/, "app knob changes must still write to the hardware");
  assert.match(appSource, /masterVolume: recovered \? current\.masterVolume : snapshotRef\.current\.masterVolume/, "ordinary whole-preset synchronization must preserve the latest faster volume sample while recovery accepts the newly reattached device state");
  assert.match(transportSource, /createGatewayClientTransport<GatewayTransport>/, "native gateway calls must use the generated contract adapter");
  assert.match(gatewayBindings, /"currentMasterVolume": \{ rpc: "device\.masterVolume", tauri: "current_master_volume"/);
  assert.match(rustSource, /async fn gateway_invoke[\s\S]*?rpc::CURRENT_MASTER_VOLUME[\s\S]*?spawn_blocking[\s\S]*?try_with_gateway/, "volume polling must stay off the desktop UI thread and yield to device commands");
  assert.match(rustSource, /async fn gateway_invoke[\s\S]*?spawn_blocking[\s\S]*?with_gateway_params/, "volume writes must not block the desktop UI thread");
  assert.match(runtimeSource, /GatewayVerification::MasterVolume \{ value \}/, "master-volume readback must use the shared authoritative predicate");
  assert.match(runtimeSource, /"device\.setMasterVolume"[\s\S]*DeviceCommand::SetMasterVolume/, "the native hosts must share the same master-volume plan");
});

test("tapping the selected Grid effect closes its parameter editor", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const coreSource = readFileSync(new URL("../packages/typescript/qc-core/src/editor.ts", import.meta.url), "utf8");
  const gridWorkflow = readFileSync(new URL("../packages/typescript/qc-ui/src/use-grid-workflow.ts", import.meta.url), "utf8");
  const surfaceActions = readFileSync(new URL("../packages/typescript/qc-ui/src/use-qc-surface-actions.ts", import.meta.url), "utf8");
  assert.match(appSource, /useQcSurfaceActions\(\{/);
  assert.match(surfaceActions, /toggleBlockEditor: \(blockId\)[\s\S]*blockSelectionIntent\(selectedBlockId, blockId\) === "close"/);
  assert.match(coreSource, /selectedBlockId !== "" && selectedBlockId === requestedBlockId \? "close" : "open"/);
  assert.match(gridWorkflow, /const close = useCallback\(\(\) => \{[\s\S]*?setSelectedBlockId\(""\);[\s\S]*?editor\.close\(\)/);
});

test("switching Grid devices replaces the parameter screen atomically", () => {
  const appSource = readFileSync(new URL("../packages/typescript/qc-ui/src/use-grid-workflow.ts", import.meta.url), "utf8");
  const blockFlow = appSource.slice(appSource.indexOf("const openBlock"), appSource.indexOf("const openRoutingNode"));
  const routingFlow = appSource.slice(appSource.indexOf("const openRoutingNode"), appSource.indexOf("useEffect", appSource.indexOf("const openRoutingNode")));
  assert.doesNotMatch(blockFlow, /editor\.close\(\)/, "the current parameter screen remains mounted while the replacement is read");
  assert.doesNotMatch(routingFlow, /editor\.close\(\)/, "routing-node transitions use the same no-flicker replacement");
  assert.match(blockFlow, /setSelectedBlockId\(block\.id\);[\s\S]*?editor\.load\(next, true\)/, "selection and reset-page details commit together after readback");
  assert.match(routingFlow, /setSelectedBlockId\(`routing-\$\{row\}-\$\{node\}`\);[\s\S]*?editor\.load\(next, true\)/);
});

test("startup synchronization is visible in the connection indicator", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8") + readFileSync(new URL("../apps/windows/src/menu-bar.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../apps/windows/src/styles.css", import.meta.url), "utf8");
  assert.match(appSource, /SYNCING \$\{syncProgress\}%/);
  assert.match(appSource, /phase: "syncing"/);
  assert.match(appSource, /className="connection-progress"/);
  assert.match(styles, /\.connection-progress/);
});

test("connection status owns one non-modal details and recovery panel", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8") + readFileSync(new URL("../apps/windows/src/menu-bar.tsx", import.meta.url), "utf8");
  assert.match(appSource, /className="connection-panel" role="dialog" aria-modal="false"/);
  assert.match(appSource, /Connection steps/);
  assert.match(appSource, /onReset=\{\(\) => void connect\("reset"\)\}/);
  assert.match(appSource, /onDisconnect=\{\(\) => void disconnectDevice\(\)\}/);
  assert.match(appSource, /onRefresh=\{\(\) => void refreshSnapshot\(\)\}/);
  assert.doesNotMatch(appSource, /className="menubar-more"/);
  assert.doesNotMatch(appSource, /className="menubar-reconnect"/);
  assert.doesNotMatch(appSource, /dialog === "connection"/);
  assert.match(appSource, /connection\.phase === "ready" \? "QC READY"/);
});

test("device and chat own fixed-size status buttons and mutually exclusive detail panes", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8") + readFileSync(new URL("../apps/windows/src/menu-bar.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../apps/windows/src/styles.css", import.meta.url), "utf8");
  assert.match(appSource, /useState<"device" \| "chat" \| null>/);
  assert.match(appSource, /className="menubar-device-side"/);
  assert.match(appSource, /className="menubar-chat-side"/);
  assert.match(appSource, /statusPanelOpen === "device"/);
  assert.match(appSource, /statusPanelOpen === "chat"/);
  assert.match(appSource, /aria-label="Chat model details"/);
  assert.match(appSource, /Conversational model/);
  assert.doesNotMatch(appSource, /className="chat-provider-status"/);
  assert.match(styles, /\.connection-badge, \.chat-status-badge \{[^}]*flex: 0 0 176px;[^}]*width: 176px;[^}]*min-width: 176px;[^}]*max-width: 176px;/s);
  assert.match(styles, /\.menu-bar \{[^}]*grid-template-columns: minmax\(0, 1fr\) clamp\(320px, 27vw, 420px\)/s);
});

test("startup synchronization advances continuously and exposes completion", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  assert.match(appSource, /animateSyncProgress\(65, 10000\)/, "the handshake must advance instead of sitting at its initial percentage");
  assert.match(appSource, /window\.setInterval\(tick, 80\)/, "progress must receive regular linear updates");
  assert.match(appSource, /animateSyncProgress\(100, duration\)/);
  assert.match(appSource, /await finishSyncProgress\(\)/, "100% must be rendered before the ready state replaces the progress bar");
  assert.doesNotMatch(appSource, /setSyncProgress\(5\)/);
  assert.doesNotMatch(appSource, /setSyncProgress\(25\)/);
});

test("startup sync gates only on the active preset and defers library catalogs", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const presetWorkflow = readFileSync(new URL("../packages/typescript/qc-ui/src/use-preset-workflow.ts", import.meta.url), "utf8");
  const connectFlow = appSource.slice(appSource.indexOf("const connect = async"), appSource.indexOf("const disconnectDevice = async"));
  assert.match(connectFlow, /const current = await tauriTransport\.currentSnapshot\(\)/, "startup must fetch the active preset");
  assert.doesNotMatch(connectFlow, /listModels|loadPresetDirectory|loadPresetFolders/, "catalogs must not block device readiness");
  assert.match(presetWorkflow, /await loadDirectory\(refresh, snapshotRef\.current\.setlistKey\)/, "the active setlist should load when its browser opens");
  assert.match(presetWorkflow, /void loadFolders\(refresh\)/, "folder discovery should be queued from the browser instead of startup");
});

test("USB detach keeps a recovery poll and automatically restores live mode after reattach", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const liveSync = appSource.slice(appSource.indexOf("const recovering = connection.phase"), appSource.indexOf("const refreshSnapshot = async"));
  assert.match(liveSync, /connection\.phase === "needs-attention"/);
  assert.match(liveSync, /if \(!recovering && nativeStateAvailable\.current\) return/, "healthy native state must disable full-snapshot polling entirely");
  assert.match(liveSync, /schedule\(liveSyncFailures\.current >= 2 \? 500 : 250\)/, "recovery must continue quickly while the event stream is unavailable");
  assert.doesNotMatch(liveSync, /30000/, "healthy sessions must not retain a periodic snapshot poll");
  assert.match(liveSync, /phase: "ready", demo: false/, "first successful snapshot must restore the live UI");
  assert.match(liveSync, /event: "live-sync-recovered"/);
  assert.doesNotMatch(liveSync, /Live synchronization stopped/);
});

test("UP and DOWN navigate adjacent presets instead of banks", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const coreSource = readFileSync(new URL("../packages/typescript/qc-core/src/surface-actions.ts", import.meta.url), "utf8");
  const controllerSource = readFileSync(new URL("../packages/typescript/qc-ui/src/use-qc-controller.ts", import.meta.url), "utf8");
  const workflowSource = readFileSync(new URL("../packages/typescript/qc-ui/src/use-performance-workflow.ts", import.meta.url), "utf8");
  const surfaceActions = readFileSync(new URL("../packages/typescript/qc-ui/src/use-qc-surface-actions.ts", import.meta.url), "utf8");
  const sharedTransport = readFileSync(new URL("../packages/typescript/qc-core/src/gateway-transport.ts", import.meta.url), "utf8");
  const navigationFlow = workflowSource.slice(workflowSource.indexOf("const movePreset = useCallback"), workflowSource.indexOf("const navigateBank"));
  assert.match(coreSource, /action\.role === "bank:up"\) return \{ kind: "move-preset", delta: -1 \}/, "UP must resolve to the previous preset");
  assert.match(coreSource, /action\.role === "bank:down"\) return \{ kind: "move-preset", delta: 1 \}/, "DOWN must resolve to the next preset");
  assert.match(appSource, /useQcSurfaceActions\(\{/);
  assert.match(surfaceActions, /movePreset: \(delta\) => void performance\.movePreset\(delta\)/);
  assert.doesNotMatch(appSource, /action\.role === "bank:up"\) \{\s*void navigateBank/);
  assert.doesNotMatch(appSource, /action\.role === "bank:down"\) \{\s*void navigateBank/);
  assert.match(navigationFlow, /const target = current\.presetPosition \+ direction/);
  assert.match(controllerSource, /presetMoveQueueRef\.current\.push\(\{ transport, delta, expected, token, resolve, reject \}\)/, "consecutive UP\/DOWN presses must preview immediately and queue their device writes");
  assert.match(controllerSource, /presetMoveQueueRef\.current\.shift\(\)/, "queued navigation must advance after each verified device write");
  assert.match(navigationFlow, /controller\.runPresetMove\(transport, direction\)/, "adjacent navigation must use the shared guarded transport path");
  assert.match(sharedTransport, /gateway\.recallPreset\(state\.setlistKey, position, "", state\.presetPosition\)/, "both hosts must use the same position-guarded recall");
  assert.match(controllerSource, /while \(presetMoveQueueRef\.current\.length\)/, "queued navigation must be serialized against fresh device state");
  assert.doesNotMatch(navigationFlow, /listPresets/, "first navigation must not wait for the 256-slot directory download");
});

test("background catalogs never monopolize the device command channel", () => {
  const broker = readFileSync(new URL("../services/device-broker/src/rpc.rs", import.meta.url), "utf8");
  const folders = broker.slice(broker.indexOf("fn gateway_list_preset_folders"), broker.indexOf("fn gateway_list_presets"));
  const presets = broker.slice(broker.indexOf("fn gateway_list_presets"), broker.indexOf("fn gateway_list_preset_slots"));
  assert.doesNotMatch(folders, /wait_for_preset_folders/);
  assert.doesNotMatch(presets, /wait_for_preset_list/);
  assert.match(folders, /"loading": loading/);
  assert.match(presets, /"loading": true/);
});

test("realtime device state is pushed instead of polled", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const frameSource = readFileSync(new URL("../apps/windows/src/use-windows-device-frames.ts", import.meta.url), "utf8");
  const broker = readFileSync(new URL("../services/device-broker/src/rpc.rs", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../apps/windows/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(broker, /"method": "device\.stateFrame"/);
  assert.match(rustSource, /emit\("qc-state-frame", frame\)/);
  assert.match(appSource, /useWindowsDeviceFrames\(/);
  assert.match(frameSource, /listen<NativeFrame>\("qc-state-frame"/);
  assert.doesNotMatch(appSource, /const synchronizeNativeState/);
  assert.doesNotMatch(appSource, /const synchronizeTempoClock/);
  assert.doesNotMatch(appSource, /const synchronizeVolume/);
});

test("QC results collapse after two rendered lines with a side chevron and no header", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/chat-dock.tsx", import.meta.url), "utf8");
  const primitiveSource = readFileSync(new URL("../packages/typescript/qc-ui/src/assistant-chat-primitives.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../apps/windows/src/styles.css", import.meta.url), "utf8");
  assert.match(primitiveSource, /function CollapsibleAssistantResult/);
  assert.match(primitiveSource, /element\.scrollHeight > element\.clientHeight \+ 1/, "the chevron must only appear when rendered content exceeds the clamp");
  assert.match(primitiveSource, /aria-expanded=\{expanded\}/);
  assert.match(appSource, /item\.role === "tool" \? <CollapsibleAssistantResult text=\{item\.text\} \/>/, "only QC results should use the compact result treatment");
  assert.match(appSource, /item\.role !== "tool" && <span>\{item\.role\.toUpperCase\(\)\}<\/span>/, "QC results must not render a redundant role header");
  assert.doesNotMatch(appSource, />QC RESULT</);
  assert.match(styles, /\.qc-result-text\.is-collapsed[^}]*-webkit-line-clamp: 2;/s);
  assert.match(styles, /\.qc-result-toggle \{[^}]*position: absolute;[^}]*right: -9px;/s, "the chevron must overlay the right edge instead of adding a footer row");
  assert.match(styles, /\.qc-result\.is-expanded \.qc-result-toggle i/);
});

test("the packaged Windows app launches without allocating a console window", () => {
  const mainSource = readFileSync(new URL("../apps/windows/src-tauri/src/main.rs", import.meta.url), "utf8");
  assert.match(mainSource, /#!\[cfg_attr\(not\(debug_assertions\), windows_subsystem = "windows"\)\]/);
});

test("Windows installer, Rust, About, and diagnostics share one app version source", () => {
  const appPackage = JSON.parse(readFileSync(new URL("../apps/windows/package.json", import.meta.url), "utf8"));
  const tauriConfig = JSON.parse(readFileSync(new URL("../apps/windows/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const cargoManifest = readFileSync(new URL("../apps/windows/src-tauri/Cargo.toml", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  assert.equal(tauriConfig.version, appPackage.version);
  assert.match(cargoManifest, new RegExp(`^version = "${appPackage.version.replaceAll(".", "\\.")}"$`, "m"));
  assert.match(appSource, /import appPackage from "\.\.\/package\.json"/);
  assert.match(appSource, /const appVersion = appPackage\.version/);
  assert.doesNotMatch(appSource, /QC Control <span>0\.1\.0<\/span>/);
});

test("Settings prioritizes Google subscription sign-in and retains OAuth fallback support", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const transportSource = readFileSync(new URL("../apps/windows/src/tauri-transport.ts", import.meta.url), "utf8");
  assert.match(appSource, /Google AI subscription/);
  assert.match(appSource, /Open Google sign-in/);
  assert.match(transportSource, /configure_google_oauth_app/);
});

test("Settings exposes one device-model choice without a redundant skin selector", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  assert.match(appSource, />Device model</);
  assert.doesNotMatch(appSource, />Skin</);
  assert.doesNotMatch(appSource, /\[skinId, setSkinId\]/);
  assert.match(appSource, /item\.id === formFactor\.defaultSkinId/);
});

test("remote conversational sharing is a persistent Settings preference without a first-message popup", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  assert.match(appSource, /Allow online conversational models/);
  assert.match(appSource, /localStorage\.setItem\(remoteChatDisclosureKey, allowed \? "accepted" : "declined"\)/);
  assert.match(appSource, /!remoteChatAllowed/);
  assert.doesNotMatch(appSource, /window\.confirm\(`Conversational chat will send/);
});

test("slow model requests remain cancellable without blocking hardware controls", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8") + readFileSync(new URL("../apps/windows/src/menu-bar.tsx", import.meta.url), "utf8");
  const dockSource = readFileSync(new URL("../apps/windows/src/chat-dock.tsx", import.meta.url), "utf8");
  const chatSource = readFileSync(new URL("../apps/windows/src-tauri/src/chat.rs", import.meta.url), "utf8");
  assert.match(appSource, /pending: assistantPending/);
  assert.match(appSource, /MODEL THINKING/);
  assert.match(dockSource, /props\.assistantPending && props\.canCancel \? props\.onCancel : props\.onSend/);
  assert.match(appSource, /conversation\.begin\(text, submittedAttachments\)/);
  assert.match(appSource, /conversation\.cancel\(\)/);
  assert.doesNotMatch(appSource, /const submitAssistantText[\s\S]*?setCommandPending\(true\)[\s\S]*?const cancelAssistantRequest/);
  assert.match(chatSource, /ANTIGRAVITY_MIN_TIMEOUT_MS: u64 = 180_000/);
  assert.match(chatSource, /\.arg\("--print-timeout"\)/);
});

test("chat continues multi-step device work across bounded tool rounds", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const chatSource = readFileSync(new URL("../apps/windows/src/model-chat.ts", import.meta.url), "utf8");
  const controllerSource = readFileSync(new URL("../packages/typescript/qc-core/src/chat-session.ts", import.meta.url), "utf8");
  assert.match(controllerSource, /const maxToolCalls = options\.maxToolCalls \?\? 1_000/);
  assert.match(controllerSource, /const maxToolRounds = maxToolCalls \+ 1/);
  assert.match(controllerSource, /for \(let round = 0; round < maxToolRounds; round \+= 1\)/);
  assert.match(controllerSource, /totalToolCalls > maxToolCalls/);
  assert.match(controllerSource, /QC tool output \(untrusted data\):\\n\$\{details\.join\("\\n"\)\}/);
  assert.match(controllerSource, /Continue the requested device work now\. Issue the required tool calls/);
  assert.match(appSource, /runToolConversation/);
  assert.doesNotMatch(appSource, /const followUp = await modelChat\.complete/);
  const policySource = readFileSync(new URL("../packages/typescript/qc-core/src/assistant-tools.ts", import.meta.url), "utf8");
  assert.match(policySource, /continue issuing tool calls until every requested step is complete/);
});

test("each chat tool validates against the latest device snapshot", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const executorSource = readFileSync(new URL("../packages/typescript/qc-ui/src/qc-action-executor.ts", import.meta.url), "utf8");
  const controllerSource = readFileSync(new URL("../packages/typescript/qc-ui/src/use-qc-controller.ts", import.meta.url), "utf8");
  assert.match(appSource, /snapshot, snapshotRef, setSnapshot/);
  assert.match(controllerSource, /snapshotRef\.current = next/);
  assert.match(appSource, /const liveSnapshot = snapshotRef\.current/);
  assert.match(appSource, /const commitToolSnapshot = \(next: PresetSnapshot\)/);
  assert.match(appSource, /snapshot: liveSnapshot/);
  assert.match(appSource, /executeAndReconcileQcAction\(call,/);
  assert.match(appSource, /commitSnapshot: commitToolSnapshot/);
  assert.match(executorSource, /assertExpectedString\(call, "expected_preset_name", snapshot\.presetName\)/);
});

test("the chat plus button opens general file attachments without a manual QC-context toggle", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/chat-dock.tsx", import.meta.url), "utf8");
  assert.match(appSource, /aria-label="Attach files"/);
  assert.match(appSource, /props\.attachmentInputRef\.current\?\.click\(\)/);
  assert.doesNotMatch(appSource, /qcContextAttached|Attach current QC preset|Upload images/);
  assert.doesNotMatch(appSource, /Your QC conversation and command results will appear here/);
});

test("chat accepts pasted and uploaded images, audio, video, PDFs, text, data, and source files", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const dockSource = readFileSync(new URL("../apps/windows/src/chat-dock.tsx", import.meta.url), "utf8");
  const chatSource = readFileSync(new URL("../apps/windows/src-tauri/src/chat.rs", import.meta.url), "utf8");
  assert.match(dockSource, /onPaste=\{props\.onPaste\}/);
  assert.match(dockSource, /image\/jpeg,image\/png,image\/webp,image\/gif,audio\/mpeg,[^"]*video\/mp4,[^"]*application\/pdf,/);
  assert.match(appSource, /const limitMb = media \? 32 : 4/);
  assert.match(appSource, /attachments: submittedAttachments/);
  assert.match(dockSource, /className="composer-attachments"/);
  assert.match(chatSource, /"type": "input_image"/);
  assert.match(chatSource, /"type": "input_file"/);
  assert.match(chatSource, /"inlineData": \{"mimeType": attachment\.media_type/);
  assert.match(chatSource, /"source": \{"type": "base64"/);
  assert.match(chatSource, /"fileAttachments": file_attachments/);
  assert.match(chatSource, /MAX_CHAT_MEDIA_ATTACHMENT_BYTES: usize = 32 \* 1024 \* 1024/);
  assert.match(chatSource, /"audio\/mpeg" \| "audio\/mp3"/);
  assert.match(chatSource, /"video\/mp4" => "mp4"/);
});

test("authorized YouTube reference audio is attached to the next Antigravity round", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const modelSource = readFileSync(new URL("../apps/windows/src/model-chat.ts", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../apps/windows/src-tauri/src/lib.rs", import.meta.url), "utf8");
  const tauriConfig = readFileSync(new URL("../apps/windows/src-tauri/tauri.conf.json", import.meta.url), "utf8");
  assert.match(modelSource, /name: "fetch_youtube_reference_audio"/);
  assert.match(modelSource, /user_confirmed_rights/);
  assert.match(appSource, /modelChat\.fetchYoutubeReferenceAudio/);
  assert.match(appSource, /result\.attachment \? \[result\.attachment as ChatAttachment\]/);
  assert.match(rustSource, /bestaudio\[acodec=opus\]\[ext=webm\]/);
  assert.match(rustSource, /--download-sections/);
  assert.doesNotMatch(rustSource, /--extract-audio|--audio-format/);
  assert.match(tauriConfig, /binaries\/qc-media-fetch/);
  assert.match(tauriConfig, /binaries\/qc-media-ffmpeg/);
  assert.match(tauriConfig, /binaries\/qc-media-deno/);
});

test("Antigravity browsing is read-only and does not grant command or page-interaction permission", () => {
  const chatSource = readFileSync(new URL("../apps/windows/src-tauri/src/chat.rs", import.meta.url), "utf8");
  assert.match(chatSource, /fn enable_antigravity_browsing\(\)/);
  assert.match(chatSource, /allow\.push\(json!\("read_url\(\*\)"\)\)/);
  assert.match(chatSource, /You may browse public URLs read-only/);
  assert.doesNotMatch(chatSource, /dangerously-skip-permissions/);
  const permissionFlow = chatSource.slice(chatSource.indexOf("fn enable_antigravity_browsing"), chatSource.indexOf("pub async fn open_google_subscription_setup"));
  assert.doesNotMatch(permissionFlow, /command\(\*\)|execute_url\(\*\)|write_file\(\*\)/);
});

test("open parameter editor consumes device knob events and chat write readback", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const frameSource = readFileSync(new URL("../apps/windows/src/use-windows-device-frames.ts", import.meta.url), "utf8");
  const liveStateSource = readFileSync(new URL("../packages/typescript/qc-ui/src/use-qc-live-state.ts", import.meta.url), "utf8");
  const parameterWorkflow = readFileSync(new URL("../packages/typescript/qc-ui/src/use-parameter-workflow.ts", import.meta.url), "utf8");
  const runtimeSource = readFileSync(new URL("../packages/rust/qc-device-runtime/src/request.rs", import.meta.url), "utf8");
  const brokerSource = readFileSync(new URL("../services/device-broker/src/rpc.rs", import.meta.url), "utf8");
  const nativeFrameSource = readFileSync(new URL("../packages/typescript/qc-ui/src/qc-native-state-frame.ts", import.meta.url), "utf8");
  assert.match(frameSource, /type NativeFrame = NativeStateFrames<QcStateUpdate>/);
  assert.match(frameSource, /listen<NativeFrame>\("qc-state-frame"/);
  assert.match(frameSource, /consumeQcNativeStateFrame/);
  assert.match(nativeFrameSource, /consumer\.consume\(frame\.states, frame\.observedAt\)/);
  assert.match(liveStateSource, /state\.kind === "parameter"/);
  assert.match(liveStateSource, /editor\.updateParameters\(changes\)/);
  assert.match(parameterWorkflow, /detailsRef\.current = result\.block/);
  assert.match(appSource, /updateBlock: parameterWorkflow\.updateDetails/);
  assert.match(runtimeSource, /GatewayVerification::Parameter/);
  assert.match(runtimeSource, /assert_expected_parameter/);
  assert.match(brokerSource, /runtime_request::assert_expected_parameter/);
});

test("interactive synchronization avoids human-visible debounce and full snapshot readback", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const frameSource = readFileSync(new URL("../apps/windows/src/use-windows-device-frames.ts", import.meta.url), "utf8");
  const editorSource = readFileSync(new URL("../packages/typescript/qc-ui/src/parameter-editor.tsx", import.meta.url), "utf8");
  const parameterWorkflow = readFileSync(new URL("../packages/typescript/qc-ui/src/use-parameter-workflow.ts", import.meta.url), "utf8");
  const runtimeSource = readFileSync(new URL("../packages/rust/qc-device-runtime/src/request.rs", import.meta.url), "utf8");
  const parameterStart = runtimeSource.indexOf('"device.previewParameter"');
  const parameterFlow = runtimeSource.slice(parameterStart, runtimeSource.indexOf('"device.setTempo"', parameterStart));
  assert.match(parameterWorkflow, /timers\.current\.set[\s\S]*?}, 8\)\)/);
  assert.match(parameterWorkflow, /previewQueue\.current = \{/);
  assert.match(parameterWorkflow, /await gateway\.previewParameter/);
  assert.match(parameterWorkflow, /revisions\.current\.get\(parameter\.index\) === revision/);
  assert.match(parameterFlow, /"device\.previewParameter" \| "device\.setParameter"/);
  assert.match(parameterFlow, /GatewayVerification::None/);
  assert.match(editorSource, /window\.setTimeout\(finish, 55\)/);
  assert.match(frameSource, /"qc-state-frame"/);
  assert.doesNotMatch(appSource, /window\.setTimeout\(\(\) => void reconcile\(\), 120\)/);
  assert.doesNotMatch(parameterFlow, /sleep|snapshot\(\)/);
});

test("preset navigation waits on QC state events and reads only as recovery", () => {
  const brokerSource = readFileSync(new URL("../services/device-broker/src/rpc.rs", import.meta.url), "utf8");
  const recallFlow = brokerSource.slice(brokerSource.indexOf("fn execute_preset_recall"), brokerSource.indexOf("fn gateway_recall_preset"));
  assert.match(recallFlow, /subscribe_state_events\(\)/);
  assert.match(brokerSource, /fn wait_for_transaction_event[\s\S]*events\.recv_timeout\(Duration::from_millis\(remaining\)\)/);
  assert.match(recallFlow, /wait_for_transaction_event/);
  assert.match(recallFlow, /read_setlist_position\(request_id\)/);
  assert.doesNotMatch(recallFlow, /wait_for_gateway_snapshot/);
  assert.doesNotMatch(recallFlow, /thread::sleep/);
});

test("tempo writes preserve the original guard and the lamp follows the QC clock", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const controlsSource = readFileSync(new URL("../packages/typescript/qc-ui/src/use-continuous-control-workflow.ts", import.meta.url), "utf8");
  const frameSource = readFileSync(new URL("../apps/windows/src/use-windows-device-frames.ts", import.meta.url), "utf8");
  const nativeFrameSource = readFileSync(new URL("../packages/typescript/qc-ui/src/qc-native-state-frame.ts", import.meta.url), "utf8");
  const uiSource = readFileSync(new URL("../packages/typescript/qc-ui/src/quad-cortex-surface.tsx", import.meta.url), "utf8");
  const cssSource = readFileSync(new URL("../packages/typescript/qc-ui/src/live-surface.css", import.meta.url), "utf8");
  const runtimeSource = readFileSync(new URL("../packages/rust/qc-device-runtime/src/request.rs", import.meta.url), "utf8");
  assert.match(appSource, /useContinuousControlWorkflow\(\{/);
  assert.match(controlsSource, /gateway\.setTempo\(target, expected, controller\.snapshotRef\.current\.presetName\)/);
  assert.match(controlsSource, /while \(queue\.target !== undefined\)/, "rapid encoder changes must coalesce without dropping the latest value");
  assert.match(frameSource, /consumeQcNativeStateFrame/);
  assert.match(nativeFrameSource, /frame\.tempoClock/);
  assert.match(nativeFrameSource, /synchronizeTempoPulseEpoch\([\s\S]*?current\.tempoPulseEpochMs,\s*frame\.observedAt, tick, current\.tempo/);
  assert.match(uiSource, /pulseEpochMs=\{!parameterLeds \? snapshot\.tempoPulseEpochMs/);
  assert.match(uiSource, /useMemo\(\(\) => tempoPeriodMs[\s\S]*\[tempoPeriodMs, pulseEpochMs\]\)/);
  assert.match(cssSource, /15\.9%[\s\S]*16%/);
  assert.match(runtimeSource, /"device\.setTempo" \| "device\.command\.tempo"[\s\S]*GatewayVerification::Tempo/);
});

test("Antigravity warms at startup and model writes execute directly", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8") + readFileSync(new URL("../apps/windows/src/menu-bar.tsx", import.meta.url), "utf8");
  const chatSource = readFileSync(new URL("../apps/windows/src-tauri/src/chat.rs", import.meta.url), "utf8");
  const transportSource = readFileSync(new URL("../apps/windows/src/tauri-transport.ts", import.meta.url), "utf8");
  const executorSource = readFileSync(new URL("../packages/typescript/qc-ui/src/qc-action-executor.ts", import.meta.url), "utf8");
  assert.match(appSource, /settings\.provider === "antigravity-cli"/);
  assert.match(appSource, /modelChat\.warm\(\)/);
  assert.match(transportSource, /warm_chat_provider/);
  assert.match(appSource, /MODEL WARMING/);
  assert.match(appSource, /await modelWarmupPromise\.current/);
  assert.match(chatSource, /antigravity_worker: AsyncMutex<Option<AntigravityWorker>>/);
  assert.match(chatSource, /pub async fn warm\(bridge: &ChatBridge\)/);
  assert.match(chatSource, /worker\.stdin\.flush\(\)\.await/);
  assert.match(chatSource, /worker\.lines\.next_line\(\)/);
  assert.match(appSource, /executeAndReconcileQcAction\(call,/);
  assert.match(executorSource, /gateway\.toggleBypass\(row, column/);
  assert.match(executorSource, /gateway\.setParameter\(row, column, parameterIndex/);
  assert.doesNotMatch(appSource, /The model requested more than one QC action/);
});

test("chat shows measured token use and provider-reported remaining quota", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const dockSource = readFileSync(new URL("../apps/windows/src/chat-dock.tsx", import.meta.url), "utf8");
  const transportSource = readFileSync(new URL("../apps/windows/src/tauri-transport.ts", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../apps/windows/src-tauri/src/chat.rs", import.meta.url), "utf8");
  assert.match(dockSource, /className="safety-copy chat-quota-footer"/);
  assert.match(appSource, /onUsage: recordChatUsage/);
  assert.match(appSource, /Math\.round\(chatQuota\.remainingFraction \* 100\)/);
  assert.match(appSource, /quotaGroupForModel/);
  assert.match(appSource, /modelQuotaLabel\(model\.id, chatQuota\)/);
  assert.match(appSource, /% remaining/);
  assert.match(transportSource, /chat_quota/);
  assert.match(rustSource, /"\/usage"/);
  assert.match(rustSource, /pub groups: Vec<ChatQuotaGroup>/);
  assert.match(rustSource, /third_party_model/);
  assert.match(rustSource, /remaining_fraction/);
  assert.match(rustSource, /thinking_tokens/);
});

test("switching the Google subscription account invalidates the authenticated worker", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../apps/windows/src-tauri/src/chat.rs", import.meta.url), "utf8");
  assert.match(appSource, /Open Google sign-in \/ switch account/);
  assert.match(rustSource, /open_google_subscription_setup\(bridge: &ChatBridge\)/);
  assert.match(rustSource, /bridge\.antigravity_worker\.lock\(\)\.await/);
  assert.match(rustSource, /worker_guard\.take\(\)/);
  assert.match(rustSource, /worker\.child\.kill\(\)\.await/);
});

test("preset rename is available from UI and chat with verified device readback", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const executorSource = readFileSync(new URL("../packages/typescript/qc-ui/src/qc-action-executor.ts", import.meta.url), "utf8");
  const transportSource = readFileSync(new URL("../apps/windows/src/tauri-transport.ts", import.meta.url), "utf8");
  const gatewayBindings = readFileSync(new URL("../packages/typescript/qc-client/src/generated-gateway-methods.ts", import.meta.url), "utf8");
  const runtimeSource = readFileSync(new URL("../packages/rust/qc-device-runtime/src/request.rs", import.meta.url), "utf8");
  const brokerSource = readFileSync(new URL("../services/device-broker/src/rpc.rs", import.meta.url), "utf8");
  assert.match(appSource, /Rename Current Preset/);
  assert.match(appSource, /executeAndReconcileQcAction\(call,/);
  assert.match(executorSource, /call\.name === "rename_current_preset"/);
  assert.match(transportSource, /createGatewayClientTransport<GatewayTransport>/);
  assert.match(gatewayBindings, /"renameCurrentPreset": \{ rpc: "device\.renameCurrentPreset", tauri: "rename_current_preset"/);
  assert.match(runtimeSource, /"device\.renameCurrentPreset"/);
  assert.match(runtimeSource, /Renamed and verified/);
  assert.match(brokerSource, /plan_preset_mutation\("device\.renameCurrentPreset"/);
});

test("chat saves an Unsaved preset to its trusted current device slot", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const chatSource = readFileSync(new URL("../apps/windows/src/model-chat.ts", import.meta.url), "utf8");
  const presetWorkflow = readFileSync(new URL("../packages/typescript/qc-ui/src/use-preset-workflow.ts", import.meta.url), "utf8");
  assert.match(chatSource, /name: "save_current_unsaved_preset"/);
  assert.match(chatSource, /active preset is named Unsaved[\s\S]*use save_current_unsaved_preset/);
  assert.match(appSource, /call\.name === "save_current_unsaved_preset"/);
  assert.match(appSource, /snapshot\.presetName !== "Unsaved"/);
  assert.match(appSource, /savePresetAs\(liveSnapshot\.setlistKey, liveSnapshot\.presetPosition, name, liveSnapshot\.presetName, liveSnapshot\.presetPosition, false\)/);
  assert.match(presetWorkflow, /const commitSavedPreset = useCallback\(\(result: SavePresetResult\)/);
  assert.match(presetWorkflow, /presetName: result\.savedName/);
  assert.match(presetWorkflow, /result\.snapshot \?\? snapshotRef\.current[\s\S]*dirty: false/, "a successful save must synchronously replace the stale Unsaved snapshot");
});

test("the device Save button uses the CorOS screen instead of desktop dialogs", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const surfaceSource = readFileSync(new URL("../packages/typescript/qc-ui/src/quad-cortex-surface.tsx", import.meta.url), "utf8");
  const saveFlow = readFileSync(new URL("../packages/typescript/qc-ui/src/use-preset-workflow.ts", import.meta.url), "utf8");
  assert.match(appSource, /savePreset=\{presetWorkflow\.saveProps\}/);
  assert.match(surfaceSource, /className="coros-save-preset"/);
  assert.match(surfaceSource, /\["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"\]/);
  assert.doesNotMatch(saveFlow, /setDialog\("save-device"\)|window\.confirm|listPresetSlots/);
  assert.doesNotMatch(appSource, /dialog === "save-device"/);
  assert.match(saveFlow, /current\.setlistKey,[\s\S]*current\.presetPosition,[\s\S]*current\.presetName !== "Unsaved"/);
  assert.match(saveFlow, /commitSavedPreset\(result\)/, "the Save button must display the verified device name immediately");
});

test("slow device saves and navigation stay off the window event thread", () => {
  const rustSource = readFileSync(new URL("../apps/windows/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(rustSource, /async fn gateway_invoke\([\s\S]{0,100}app: AppHandle/);
  assert.match(rustSource, /gateway_invoke[\s\S]*spawn_blocking\(move \|\|/);
  assert.doesNotMatch(rustSource, /async fn (navigate_bank|recall_preset|press_footswitch|list_preset_slots|save_preset_as|rename_current_preset)\(/);
});

test("chat follows new messages without stealing a user-controlled scroll position", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const dockSource = readFileSync(new URL("../apps/windows/src/chat-dock.tsx", import.meta.url), "utf8");
  const scrollSource = readFileSync(new URL("../packages/typescript/qc-ui/src/use-assistant-auto-scroll.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../apps/windows/src/styles.css", import.meta.url), "utf8");
  assert.match(appSource, /useAssistantAutoScroll\(chatOpen, messages\)/);
  assert.match(scrollSource, /stickToBottom/);
  assert.match(scrollSource, /userScrolling/);
  assert.match(scrollSource, /programmaticScroll/);
  assert.match(scrollSource, /element\.scrollTo\(\{ top: element\.scrollHeight/);
  assert.match(scrollSource, /behavior: "auto"/, "new model responses must land at the bottom without a smooth-scroll event disabling follow mode");
  assert.match(scrollSource, /if \(!element \|\| programmaticScroll\.current\) return;/, "programmatic scroll events must not be interpreted as user scrolling");
  assert.match(dockSource, /onWheel=\{props\.onUserScroll\}/);
  assert.match(styles, /\.conversation-preview::\-webkit-scrollbar \{ width: 5px; \}/);
  assert.match(styles, /scrollbar-color: var\(--qc-transparent\) var\(--qc-transparent\)/);
});

test("the chat composer receives keyboard focus when the app starts", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  assert.match(appSource, /requestAnimationFrame\(\(\) => chatInput\.current\?\.focus\(\{ preventScroll: true \}\)\)/);
});

test("device and chat footers share one readable font size", () => {
  const styles = readFileSync(new URL("../apps/windows/src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /--ui-font-footer: 13px/);
  assert.match(styles, /\.status-strip \{[^}]*font-size: var\(--ui-font-footer\)/);
  assert.match(styles, /\.status-context \{[^}]*font: var\(--ui-font-footer\)/);
  assert.match(styles, /\.chat-quota-footer \{[^}]*font-size: var\(--ui-font-footer\)/);
});

test("the Save action is one normal floppy without a status-dot overlay", () => {
  const surfaceSource = readFileSync(new URL("../packages/typescript/qc-ui/src/quad-cortex-surface.tsx", import.meta.url), "utf8");
  const iconSource = readFileSync(new URL("../packages/typescript/qc-ui/src/theme-icons.tsx", import.meta.url), "utf8");
  const saveIcon = iconSource.slice(iconSource.indexOf('kind === "save"'), iconSource.indexOf('return <g fill={QC_COLORS.hardware.whiteLed}>'));
  assert.match(surfaceSource, /<QcScreenHeaderGlyph kind="save" \/>/);
  assert.match(saveIcon, /fill=\{QC_COLORS\.hardware\.whiteLed\}/);
  assert.doesNotMatch(saveIcon, /#45f862|snapshot\.dirty|<circle/);
});

test("preset bank, slot, and name use natural inline text flow", () => {
  const surfaceSource = readFileSync(new URL("../packages/typescript/qc-ui/src/quad-cortex-surface.tsx", import.meta.url), "utf8");
  assert.match(surfaceSource, /<text x="14" y="75"><tspan[^>]*>\{presetBank\}<\/tspan><tspan[^>]*>\{presetSlot\}<\/tspan><tspan[^>]*dx="16"/);
  assert.doesNotMatch(surfaceSource, /presetLocationExtraWidth|x=\{56 \+|x=\{114 \+/);
});
