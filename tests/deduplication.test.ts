import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("Windows and Android compose the same QC behavior and screen packages", () => {
  const surfaceActions = source("packages/typescript/qc-ui/src/use-qc-surface-actions.ts");
  for (const app of [source("apps/windows/src/App.tsx"), source("apps/android/src/App.tsx")]) {
    assert.match(app, /from "@ndsp-qc\/core"/);
    assert.match(app, /QuadCortexSurface[\s\S]*from "@ndsp-qc\/ui"/);
    assert.match(app, /useQcSurfaceActions\(\{/);
    assert.doesNotMatch(app, /surfaceCommand\(action\)|dispatchSurfaceCommand\(/);
    assert.match(app, /useBlockEditorSession\(\)/);
    assert.match(app, /useQcController\(demoSnapshot\)/);
    assert.match(app, /useQcWorkflows\(/, "the complete shared workflow suite must be composed by both native shells");
    assert.doesNotMatch(app, /use(?:PresetWorkflow|RoutingWorkflow|GridWorkflow|ParameterWorkflow|PerformanceWorkflow|SceneWorkflow|DeviceHistory)\(/);
    assert.match(app, /reconcileFrame/);
    assert.match(app, /parseAssistantIntent\(/);
    assert.doesNotMatch(app, /function (?:surfaceCommand|recordTempoTap|parseAssistantIntent|applyQcStateUpdate)\b/);
    assert.doesNotMatch(app, /String\.fromCharCode\(65 \+/);
  }
  assert.match(surfaceActions, /surfaceCommand\(action\)/);
  assert.match(surfaceActions, /blockSelectionIntent\(selectedBlockId,/);
  assert.match(surfaceActions, /grid\.footswitchAssignmentPending/);
});

test("the installed Windows runtime has no Python gateway or backup sidecar", () => {
  const tauri = source("apps/windows/src-tauri/src/lib.rs");
  const bundle = source("apps/windows/src-tauri/tauri.conf.json");
  const installer = source("scripts/build-windows-installer.ps1");
  const worker = source("services/device-broker/src/worker.rs");
  const usb = source("services/device-broker/src/usb.rs");
  assert.doesNotMatch(tauri, /QC_GATEWAY_RUNTIME|qc-device-gateway|\.venv|python\.exe/i);
  assert.doesNotMatch(`${bundle}\n${installer}`, /qc-backup-helper|PyInstaller|backup_helper\.py/i);
  assert.match(worker, /connected\.usb\.create_backup/);
  assert.match(usb, /BackupAssembler/);
});

test("realtime surface commands have one shared cross-platform workflow", () => {
  const workflow = source("packages/typescript/qc-ui/src/use-performance-workflow.ts");
  assert.match(workflow, /controller\.runBypass\(transport/);
  assert.match(workflow, /controller\.runFootswitch\(transport/);
  assert.match(workflow, /controller\.runPresetMove\(transport/);
  assert.match(workflow, /recordTempoTap\(/);
  assert.doesNotMatch(workflow, /commandPending|setPending/, "realtime input must not be dropped behind a global busy flag");
  for (const app of [source("apps/windows/src/App.tsx"), source("apps/android/src/App.tsx")]) {
    assert.doesNotMatch(app, /recordTempoTap\(/);
    assert.doesNotMatch(app, /runBypass\(qcTransport/);
    assert.doesNotMatch(app, /runFootswitch\(qcTransport/);
  }
});

test("shared UI exclusively owns dirty-title and parameter-screen rendering", () => {
  const surface = source("packages/typescript/qc-ui/src/quad-cortex-surface.tsx");
  const corosUi = source("packages/typescript/qc-ui/src/coros-ui.ts");
  const windows = source("apps/windows/src/App.tsx");
  const android = source("apps/android/src/App.tsx");
  const desktopStyles = source("apps/windows/src/styles.css");
  assert.match(surface, /presetTitlePresentation\(snapshot\.presetName, snapshot\.dirty\)/);
  assert.match(corosUi, /text: `\$\{normalizedName\}\$\{dirty \? "\*" : ""\}`/);
  assert.match(corosUi, /dimmed: unsaved && !dirty/);
  assert.match(surface, /<CorOsParameterEditor \{\.\.\.parameterEditor\} \/>/);
  assert.match(surface, /import "\.\/surface-shell\.css"/);
  assert.doesNotMatch(desktopStyles, /^\.qc-chassis \{/m);
  assert.doesNotMatch(windows, /function CorOsGrid|function CorOsParameterEditor/);
  assert.doesNotMatch(android, /function CorOsGrid|function CorOsParameterEditor/);
});

test("one shared controller owns parameter editor details, drafts, and paging", () => {
  const controller = source("packages/typescript/qc-ui/src/use-block-editor-session.ts");
  assert.match(controller, /reduceBlockEditorSession/);
  for (const app of [source("apps/windows/src/App.tsx"), source("apps/android/src/App.tsx")]) {
    assert.doesNotMatch(app, /\[blockDetails, setBlockDetails\].*useState/);
    assert.doesNotMatch(app, /\[parameterDrafts, setParameterDrafts\].*useState/);
    assert.doesNotMatch(app, /\[parameterPage, setParameterPage\].*useState/);
  }
});

test("both platform adapters implement the shared port without exposing the native broker", () => {
  const android = source("apps/android/src/native-services.ts");
  const windows = source("apps/windows/src/qc-transport.ts");
  assert.match(android, /createAndroidQcTransport[\s\S]*createQcGatewayTransport/);
  assert.match(windows, /createWindowsQcTransport[\s\S]*: QcDeviceTransport/);
  assert.match(windows, /createQcGatewayTransport\(gateway, currentSnapshot\)/);
  assert.doesNotMatch(android, /QcUsbNative\.(?:selectScene|setBypass|setParameter|movePreset|tapTempo)/);
  assert.doesNotMatch(`${android}\n${windows}`, /device\.raw\.|payloadBase64|qc-device-broker/);
});

test("platform composition roots do not import one another", () => {
  const windows = source("apps/windows/src/main.tsx") + source("apps/windows/src/App.tsx");
  const android = source("apps/android/src/main.tsx") + source("apps/android/src/App.tsx");
  assert.doesNotMatch(windows, /apps\/android|\.\.\/\.\.\/android/);
  assert.doesNotMatch(android, /apps\/windows|\.\.\/\.\.\/windows/);
});

test("clients and shared UI import canonical behavior without compatibility wrappers", () => {
  const windows = source("apps/windows/src/App.tsx");
  const android = source("apps/android/src/App.tsx");
  const ui = source("packages/typescript/qc-ui/src/quad-cortex-surface.tsx");
  assert.match(windows, /assistantHelp[\s\S]*from "@ndsp-qc\/core"/);
  assert.match(android, /parseAssistantReply[\s\S]*from "@ndsp-qc\/core"/);
  assert.match(ui, /footswitchLeds[\s\S]*from "@ndsp-qc\/core"/);
});

test("one generated profile owns USB and performance MIDI policy across native hosts", () => {
  const contract = JSON.parse(source("contracts/qc-usb-profile.v1.json"));
  const java = source("apps/android/android/app/src/main/java/com/qccontrol/mobile/QcUsbProfile.java");
  const rust = source("packages/rust/qc-protocol/src/profile.rs");
  assert.equal(contract.version, 1);
  for (const value of [contract.vendorId, contract.productId, contract.maxFrameBytes, contract.maxInflatedBytes, contract.performanceMidiGapMs]) {
    assert.match(java, new RegExp(`= ${value}(?:L)?;`));
    assert.match(rust, new RegExp(`= ${value};`));
  }
  assert.equal(contract.liveSubscriptions.includes(4), false, "directory traffic must not starve realtime startup");
  assert.match(source("packages/rust/qc-protocol/src/commands.rs"), /profile::LIVE_SUBSCRIPTIONS/);
  assert.match(source("services/device-gateway/src/qc_device_gateway/usb_profile.py"), new RegExp(`MAX_INFLATED_BYTES = ${contract.maxInflatedBytes}`));
});

test("one generated domain contract owns Grid, scene, tempo, route, and IPC constants", () => {
  const contract = JSON.parse(source("contracts/qc-domain.v1.json"));
  const outputs = [
    source("packages/typescript/qc-client/src/generated-domain.ts"),
    source("packages/rust/qc-protocol/src/domain.rs"),
    source("services/device-gateway/src/qc_device_gateway/domain.py"),
    source("services/mcp-server/src/qc_mcp_server/generated_domain.py"),
    source("apps/android/android/app/src/main/java/com/qccontrol/mobile/QcDomain.java")
  ];
  for (const output of outputs) {
    assert.match(output, new RegExp(String(contract.limits.gridRows)));
    assert.match(output, new RegExp(String(contract.limits.gridColumns)));
    assert.match(output, new RegExp(String(contract.limits.maximumTempoBpm)));
  }
  assert.match(source("packages/typescript/qc-core/src/routing.ts"), /QC_INPUT_ROUTES/);
  assert.match(source("services/device-gateway/src/qc_device_gateway/device.py"), /GRID_COLUMNS/);
});

test("one generated gateway manifest owns dispatch and both native bindings", () => {
  const contract = JSON.parse(source("contracts/gateway-methods.v1.json"));
  const generated = source("packages/typescript/qc-client/src/generated-gateway-methods.ts");
  const dispatch = source("services/device-gateway/src/qc_device_gateway/generated_gateway_dispatch.py");
  const pythonClient = source("packages/python/qc-gateway-client/src/qc_gateway_client/generated_gateway_methods.py");
  const rust = source("apps/windows/src-tauri/src/generated_gateway.rs");
  const tauriHost = source("apps/windows/src-tauri/src/lib.rs");
  const java = source("apps/android/android/app/src/main/java/com/qccontrol/mobile/GeneratedGatewayMethods.java");
  const transport = source("apps/windows/src/tauri-transport.ts");
  assert.ok(contract.methods.length >= 37, "the generated gateway must retain the complete baseline API");
  for (const method of contract.methods) {
    assert.match(generated, new RegExp(method.rpc.replace(".", "\\.")));
    if (method.python !== false) assert.match(dispatch, new RegExp(method.target));
    assert.match(pythonClient, new RegExp(method.rpc.replace(".", "\\.")));
    assert.match(rust, new RegExp(method.rpc.replace(".", "\\.")));
    assert.match(java, new RegExp(method.rpc.replace(".", "\\.")));
    assert.match(tauriHost, new RegExp(`async fn ${method.tauri}\\b`), `${method.rpc} must have a thin Windows adapter`);
    assert.match(tauriHost, new RegExp(`\\b${method.tauri},`), `${method.rpc} must be registered with Tauri`);
  }
  assert.match(transport, /createGatewayClientTransport<GatewayTransport>/);
  assert.match(source("packages/python/qc-gateway-client/src/qc_gateway_client/client.py"), /method not in GATEWAY_METHODS/);
  assert.doesNotMatch(transport, /callTauri<[^>]+>\("(?:select_scene|toggle_bypass|current_snapshot)"/);
});

test("one shared action registry drives model tools and MCP safety classes", () => {
  const actions = JSON.parse(source("contracts/qc-actions.v1.json")).actions;
  const chat = source("apps/windows/src/model-chat.ts");
  const assistantTools = source("packages/typescript/qc-core/src/assistant-tools.ts");
  const mcp = source("services/mcp-server/src/qc_mcp_server/server.py");
  assert.equal(new Set(actions.map((action: { name: string }) => action.name)).size, actions.length);
  for (const name of ["move_block", "add_block", "remove_block", "set_block_footswitch", "set_chain_input", "set_chain_output", "set_chain_split"]) {
    assert.ok(actions.some((action: { name: string }) => action.name === name), name);
  }
  assert.match(chat, /SHARED_QC_ASSISTANT_TOOLS/);
  assert.match(assistantTools, /SHARED_QC_ACTIONS\.map/);
  assert.match(assistantTools, /action\.classification === "read"/);
  assert.match(mcp, /for name, action in SHARED_QC_ACTIONS\.items\(\)/);
  assert.match(mcp, /annotations\[action\["classification"\]\]/);
});

test("both USB readers defer ModelRepo work away from realtime I/O", () => {
  const rust = source("services/device-broker/src/usb.rs");
  const python = source("services/device-gateway/src/qc_device_gateway/native_transport.py");
  const android = source("apps/android/android/app/src/main/java/com/qccontrol/mobile/QcUsbPlugin.java");
  assert.match(rust, /message_type != 51 && payload\.starts_with/);
  assert.match(rust, /if is_preset \{[\s\S]*?synchronized = true;[\s\S]*?break;/, "Windows must release startup to the live reader as soon as the preset arrives");
  assert.match(python, /payload\.startswith\(b"\\x1f\\x8b"\)[\s\S]*_gunzip_bounded/);
  assert.match(android, /type == 51[\s\S]*scheduleModelCatalogDecode/);
  assert.match(android, /metadataIo\.execute/);
  assert.match(source("services/device-broker/src/worker.rs"), /qc-native-metadata/);
});

test("one Rust state engine normalizes Windows and Android device frames", () => {
  const engine = source("packages/rust/qc-protocol/src/state.rs");
  const broker = source("services/device-broker/src/worker.rs");
  const androidJni = source("packages/rust/qc-android/src/lib.rs");
  const androidPlugin = source("apps/android/android/app/src/main/java/com/qccontrol/mobile/QcUsbPlugin.java");
  const windows = source("apps/windows/src/App.tsx");
  const windowsFrames = source("apps/windows/src/use-windows-device-frames.ts");
  const liveState = source("packages/typescript/qc-ui/src/use-qc-live-state.ts");
  assert.match(engine, /pub struct StateDecoder/);
  assert.match(engine, /fn decode_grid/);
  assert.match(broker, /StateDecoder::new\(\)/);
  assert.match(androidJni, /qc_protocol::state::\{parse_model_repo, StateDecoder\}/);
  assert.match(androidPlugin, /stateDecoder\.decode\(type, payload\)/);
  assert.doesNotMatch(androidPlugin, /decodeGridUpdates|decodeQcState|decodeModelRepo/);
  assert.match(windows, /useWindowsDeviceFrames\(/);
  assert.match(windowsFrames, /"qc-state-frame"/);
  assert.match(windowsFrames, /consume\(frame\.states, frame\.observedAt\)/);
  assert.match(liveState, /reconcileFrame\(states, observedAt\)/);
});

test("Android owns one pending-operation lifecycle and has no confirmation polling loops", () => {
  const android = source("apps/android/android/app/src/main/java/com/qccontrol/mobile/QcUsbPlugin.java");
  const pending = source("apps/android/android/app/src/main/java/com/qccontrol/mobile/QcPendingOperations.java");
  const broker = source("services/device-broker/src/worker.rs");
  assert.match(android, /QcPendingOperations pendingOperations/);
  assert.doesNotMatch(android, /pollRelayReady|pollRelayVerification|pollPresetLibrary/);
  assert.match(pending, /class QcPendingOperations/);
  assert.match(pending, /void failAll/);
  assert.doesNotMatch(broker, /pending_scene|next_scene_poll|CONFIRMATION_POLL_INTERVAL_MS/);
  assert.match(broker, /subscribe_state_events\(\)/);
  assert.match(broker, /recv_timeout/);
  const rpc = source("services/device-broker/src/rpc.rs");
  const readFlow = rpc.slice(rpc.indexOf("fn execute_gateway_read"), rpc.indexOf("fn gateway_identity"));
  assert.match(readFlow, /subscribe_raw_events\(\)/);
  assert.match(readFlow, /recv_timeout\(remaining\)/);
  assert.doesNotMatch(readFlow, /events_since|thread::sleep/);
});

test("one shared command coordinator owns optimistic state and stale-echo policy", () => {
  const coordinator = source("packages/typescript/qc-core/src/command-coordinator.ts");
  const windows = source("apps/windows/src/App.tsx");
  const android = source("apps/android/src/App.tsx");
  const reactController = source("packages/typescript/qc-ui/src/use-qc-controller.ts");
  const performanceWorkflow = source("packages/typescript/qc-ui/src/use-performance-workflow.ts");
  const liveState = source("packages/typescript/qc-ui/src/use-qc-live-state.ts");
  assert.match(coordinator, /class QcCommandCoordinator/);
  assert.match(coordinator, /beginFootswitch/);
  assert.match(coordinator, /reconcileSnapshot/);
  assert.match(coordinator, /older failure to undo a newer command/);
  assert.match(reactController, /new QcCommandCoordinator\(\)/);
  assert.match(reactController, /snapshotRef\.current = next/);
  assert.match(reactController, /const runCommand/);
  assert.match(reactController, /transport\.pressFootswitch/);
  assert.match(liveState, /reconcileFrame\(states, observedAt\)/);
  assert.match(liveState, /editor\.updateParameters\(changes\)/);
  for (const app of [windows, android]) {
    assert.match(app, /useQcController\(demoSnapshot\)/);
    assert.match(app, /useQcWorkflows\(\{/);
    assert.match(app, /useQcLiveState/);
    assert.doesNotMatch(app, /QcCommandCoordinator|recordPendingBypassChanges|clearPendingBypassChanges|pendingBypass/);
  }
  assert.match(performanceWorkflow, /controller\.beginFootswitch/);
  assert.match(performanceWorkflow, /controller\.failCommand/);
});

test("assistant actions use one shared provider-neutral executor", () => {
  const resolver = source("packages/typescript/qc-core/src/assistant-execution.ts");
  const executor = source("packages/typescript/qc-ui/src/qc-action-executor.ts");
  const controller = source("packages/typescript/qc-ui/src/use-qc-controller.ts");
  const windows = source("apps/windows/src/App.tsx");
  const android = source("apps/android/src/App.tsx");
  assert.match(resolver, /assistantIntentCommand/);
  assert.match(controller, /const runAssistantCommand/);
  assert.match(windows, /assistantIntentCommand\(intent, selected\)/);
  assert.match(windows, /runAssistantCommand\(qcTransport, deviceCommand\)/);
  assert.match(android, /runAssistantCommand\(qcTransport,/);
  assert.match(android, /assistantToolActionPrompt\(snapshotRef\.current,/);
  assert.match(android, /validateAssistantToolCalls\(parsed, controlAccessMode\)/);
  assert.match(windows, /executeQcAction\(call,/);
  assert.match(android, /executeQcAction\(action,/);
  assert.match(executor, /export async function executeQcAction/);
  assert.match(source("packages/typescript/qc-ui/src/assistant-parameter-edit.ts"), /resolveAssistantParameterEdit/);
  for (const app of [windows, android]) assert.match(app, /resolveAssistantParameterEdit/);
  assert.doesNotMatch(android, /Allowed reversible hardware actions:/);
});

test("all generated QC actions are owned by the shared UI executor", () => {
  const executor = source("packages/typescript/qc-ui/src/qc-action-executor.ts");
  const contract = JSON.parse(source("contracts/qc-actions.v1.json")) as { actions: Array<{ name: string }> };
  for (const action of contract.actions) assert.match(executor, new RegExp(`\\b${action.name}\\b`), `${action.name} must be handled centrally`);
  assert.match(executor, /confirm_persistent_write/);
  assert.match(executor, /confirm_risky_operation/);
  assert.match(executor, /parameterNormalizedValue/);
});

test("routing labels, grouping, and row constraints live in shared core", () => {
  const routing = source("packages/typescript/qc-core/src/routing.ts");
  const windows = source("apps/windows/src/App.tsx");
  const surface = source("packages/typescript/qc-ui/src/quad-cortex-surface.tsx");
  const workflow = source("packages/typescript/qc-ui/src/use-routing-workflow.ts");
  assert.match(routing, /inputRouteOptions/);
  assert.match(routing, /routeOptionsForRow/);
  assert.match(workflow, /routeOptionsForRow[\s\S]*from "@ndsp-qc\/core"/);
  assert.match(surface, /routePickerGroup[\s\S]*from "@ndsp-qc\/core"/);
  assert.doesNotMatch(windows, /const inputRoutes|const routeOptionsForRow/);
  assert.doesNotMatch(surface, /function routePickerLabel|function routePickerGroup/);
});

test("one Rust command and framing engine owns both native USB hosts", () => {
  const commands = source("packages/rust/qc-protocol/src/commands.rs");
  const windowsUsb = source("services/device-broker/src/usb.rs");
  const windowsWorker = source("services/device-broker/src/worker.rs");
  const androidJni = source("packages/rust/qc-android/src/lib.rs");
  const androidPlugin = source("apps/android/android/app/src/main/java/com/qccontrol/mobile/QcUsbPlugin.java");
  const androidBuild = source("apps/android/android/app/build.gradle");
  const windowsAdapter = source("services/device-gateway/src/qc_device_gateway/native_transport.py");
  assert.match(commands, /pub fn initialization/);
  assert.match(commands, /pub fn set_parameter_numeric/);
  assert.match(commands, /pub enum DeviceCommand/);
  assert.match(windowsUsb, /commands::initialization/);
  assert.match(windowsUsb, /FrameAssembler/);
  assert.match(windowsWorker, /DeviceCommand::SelectScene/);
  assert.match(source("services/device-broker/src/rpc.rs"), /runtime_request::plan_gateway_write/);
  assert.match(source("packages/rust/qc-device-runtime/src/request.rs"), /DeviceCommand::SetBypass/);
  assert.match(source("packages/rust/qc-device-runtime/src/request.rs"), /DeviceCommand::SetParameterNumeric/);
  assert.match(windowsAdapter, /device\.command\.parameter/);
  assert.match(androidJni, /PlannedWrite::HidCommand/);
  assert.match(androidJni, /PlannedWrite::MidiControlChange/);
  assert.match(androidJni, /FrameAssembler/);
  assert.match(androidJni, /framing::encode/);
  assert.match(androidPlugin, /stateDecoder\.initializationCommands/);
  assert.match(androidPlugin, /stateDecoder\.encodeFrame/);
  assert.match(androidPlugin, /stateDecoder\.pushReport/);
  assert.match(androidBuild, /packages\/rust\/qc-device-runtime/, "shared runtime changes must invalidate Android's native library");
  assert.doesNotMatch(androidPlugin, /frameReports|FLAG_FIRST|FLAG_LAST/);
  assert.doesNotMatch(androidPlugin, /fieldVarint|fieldMessage|QcUsbFraming|QcProtobufWire/);
});

test("shared routing drafts and command journal keep the Windows composition root thin", () => {
  const routing = source("packages/typescript/qc-core/src/routing.ts");
  const journal = source("packages/typescript/qc-ui/src/use-command-journal.ts");
  const windows = source("apps/windows/src/App.tsx");
  const editor = source("packages/typescript/qc-ui/src/routing-editor.tsx");
  const workflow = source("packages/typescript/qc-ui/src/use-routing-workflow.ts");
  const composition = source("packages/typescript/qc-ui/src/use-qc-workflows.ts");
  assert.match(routing, /routeDraftsFromSnapshot/);
  assert.match(routing, /updateRouteDraft/);
  assert.match(journal, /useCommandJournal/);
  assert.match(windows, /useQcWorkflows\(/);
  assert.match(composition, /useDeviceHistory\(/);
  assert.match(workflow, /recordHistory/);
  assert.match(windows, /<RoutingEditor/);
  assert.match(editor, /QC_GRID_COLUMNS/);
  assert.doesNotMatch(windows, /<div className="routing-editor">/);
});

test("Windows and Android request block details from the same native ModelRepo projection", () => {
  const engine = source("packages/rust/qc-protocol/src/state.rs");
  const payloads = source("packages/rust/qc-protocol/src/generated_payloads.rs");
  const broker = source("services/device-broker/src/worker.rs");
  const python = source("services/device-gateway/src/qc_device_gateway/device.py");
  const android = source("apps/android/android/app/src/main/java/com/qccontrol/mobile/QcNativeStateDecoder.java");
  assert.match(engine, /pub use crate::generated_payloads/);
  assert.match(payloads, /pub struct BlockDetails/);
  assert.match(payloads, /scale_points: Vec<ScalePoint>/);
  assert.match(engine, /fn parameter_enabled/);
  assert.match(broker, /StateDecoderCommand::BlockDetails/);
  assert.match(python, /native_reader\(row, column, expected_preset_name\)/);
  assert.match(android, /nativeBlockDetails/);
});

test("one shared Rust session machine owns reconnect, handshake, keepalive, and read-error policy", () => {
  const session = source("packages/rust/qc-protocol/src/session.rs");
  const brokerUsb = source("services/device-broker/src/usb.rs");
  const brokerWorker = source("services/device-broker/src/worker.rs");
  const androidJni = source("packages/rust/qc-android/src/lib.rs");
  const androidPlugin = source("apps/android/android/app/src/main/java/com/qccontrol/mobile/QcUsbPlugin.java");
  for (const policy of ["reconnect_due", "next_handshake_attempt", "keepalive_due", "read_failed", "outbound"]) assert.match(session, new RegExp(policy));
  assert.match(brokerUsb, /SessionMachine/);
  assert.match(brokerUsb, /awaiting_handshake_reply/);
  assert.match(brokerWorker, /session\.keepalive_due/);
  assert.match(androidJni, /next_handshake_attempt/);
  assert.match(androidPlugin, /stateDecoder\.sessionShouldKeepalive/);
  assert.doesNotMatch(androidPlugin, /lastUsbWriteAt|consecutiveReadErrors/);
});

test("advanced device operations select their wire messages in shared Rust", () => {
  const commands = source("packages/rust/qc-protocol/src/commands.rs");
  const rpc = source("services/device-broker/src/rpc.rs");
  const python = source("services/device-gateway/src/qc_device_gateway/device.py");
  for (const operation of ["AddBlock", "RemoveBlock", "MoveBlock", "SetFootswitch", "SetChainInput", "SetChainOutput", "SetChainSplit", "SetRoutingParameter", "SavePreset"]) assert.match(commands, new RegExp(operation));
  assert.match(rpc, /device\.command\.operation/);
  assert.match(python, /_native_transport_method/);
});

test("one shared Rust gateway runtime owns verified reads and persistent preset policy", () => {
  const runtime = source("packages/rust/qc-device-runtime/src/request.rs");
  const protocolResponses = source("packages/rust/qc-protocol/src/responses.rs");
  const broker = source("services/device-broker/src/rpc.rs");
  const brokerWorker = source("services/device-broker/src/worker.rs");
  const androidJni = source("packages/rust/qc-android/src/lib.rs");
  const androidJava = source("apps/android/android/app/src/main/java/com/qccontrol/mobile/QcUsbPlugin.java");

  assert.match(runtime, /pub enum GatewayVerification/);
  assert.match(runtime, /pub struct GatewayTransaction/);
  assert.match(runtime, /pub fn merge_expected_state/);
  assert.match(runtime, /pub fn plan_gateway_read/);
  assert.match(runtime, /pub fn plan_preset_mutation/);
  assert.match(runtime, /pub fn decode\(&self, payload: &\[u8\]\)/);
  for (const decoder of ["decode_device_identity", "decode_inhibited_modules", "decode_preset_screenshot", "decode_captured_screen"]) {
    assert.match(protocolResponses, new RegExp(`pub fn ${decoder}`));
  }

  assert.match(broker, /runtime_request::plan_gateway_read/);
  assert.match(broker, /plan\.projection\.decode/);
  assert.match(broker, /GatewayTransaction::new/);
  assert.match(brokerWorker, /runtime_request::plan_preset_mutation/);
  assert.match(androidJni, /plan_gateway_read/);
  assert.match(androidJni, /projection\.decode/);
  assert.match(androidJni, /plan_preset_mutation/);
  assert.match(androidJni, /GatewayTransaction::new/);
  assert.match(androidJni, /merge_expected_state/);
  assert.match(androidJava, /stateDecoder\.recordSavedPreset\(workflow\)/);
  assert.match(androidJava, /resolvePendingGatewayTransactions/);
  assert.match(androidJava, /resolvePendingPresetLibraryReads/);
  assert.doesNotMatch(androidJava, /pollRelayVerification|pollPresetLibrary/);

  for (const host of [broker, androidJava]) {
    assert.doesNotMatch(host, /VersionMessage|ScreenshotMessage|CompilerInhibitedModulesMessage|RemoteControlMessage|png_dimensions/);
    assert.doesNotMatch(host, /Pasting a preset requires explicit overwrite|The source and destination preset slots are identical/);
  }
});

test("application payload types are generated once for TypeScript, Rust, and Python", () => {
  const schema = JSON.parse(source("contracts/qc-payloads.v1.schema.json"));
  const typescript = source("packages/typescript/qc-client/src/generated-payloads.ts");
  const rust = source("packages/rust/qc-protocol/src/generated_payloads.rs");
  const python = source("services/device-gateway/src/qc_device_gateway/generated_payloads.py");
  for (const name of schema["x-generate"]) {
    assert.match(typescript, new RegExp(`interface ${name}\\b`));
    assert.match(python, new RegExp(`class ${name}\\b`));
  }
  for (const name of schema["x-rust-types"]) assert.match(rust, new RegExp(`struct ${name}\\b`));
  assert.match(source("package.json"), /generate-qc-payloads\.mjs --check/);
});

test("ModelRepo projection and conversational control no longer have platform copies", () => {
  const coreChat = source("packages/typescript/qc-core/src/chat-session.ts");
  const windows = source("apps/windows/src/App.tsx");
  const android = source("apps/android/src/App.tsx");
  assert.match(coreChat, /runToolConversation/);
  assert.match(windows, /runToolConversation/);
  assert.match(windows, /<ChatDock/);
  assert.match(windows, /<MenuBar/);
  assert.match(android, /appendConversationMessage/);
  assert.doesNotMatch(windows, /function CollapsibleQcResult/);
  assert.doesNotMatch(windows, /function (?:MenuBar|ConnectionBadge|ChatStatusBadge)/);
  assert.throws(() => source("services/device-gateway/src/qc_device_gateway/parameter_scales.py"));
});
