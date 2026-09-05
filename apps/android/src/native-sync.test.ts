import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const javaSource = readFileSync(new URL("../android/app/src/main/java/com/qccontrol/mobile/QcUsbPlugin.java", import.meta.url), "utf8");
const usbProfileSource = readFileSync(new URL("../android/app/src/main/java/com/qccontrol/mobile/QcUsbProfile.java", import.meta.url), "utf8");
const servicesSource = readFileSync(new URL("./native-services.ts", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const liveStateSource = readFileSync(new URL("../../../packages/typescript/qc-ui/src/use-qc-live-state.ts", import.meta.url), "utf8");
const performanceWorkflowSource = readFileSync(new URL("../../../packages/typescript/qc-ui/src/use-performance-workflow.ts", import.meta.url), "utf8");
const coreStateSource = readFileSync(new URL("../../../packages/typescript/qc-core/src/state.ts", import.meta.url), "utf8");
const generatedPayloadSource = readFileSync(new URL("../../../packages/typescript/qc-client/src/generated-payloads.ts", import.meta.url), "utf8");
const coreFootswitchSource = readFileSync(new URL("../../../packages/typescript/qc-core/src/footswitch.ts", import.meta.url), "utf8");
const nativeDecoderSource = readFileSync(new URL("../android/app/src/main/java/com/qccontrol/mobile/QcNativeStateDecoder.java", import.meta.url), "utf8");
const rustStateSource = readFileSync(new URL("../../../packages/rust/qc-protocol/src/state.rs", import.meta.url), "utf8");
const rustCommandsSource = readFileSync(new URL("../../../packages/rust/qc-protocol/src/commands.rs", import.meta.url), "utf8");
const rustAndroidSource = readFileSync(new URL("../../../packages/rust/qc-android/src/lib.rs", import.meta.url), "utf8");
const rustRuntimeRequestSource = readFileSync(new URL("../../../packages/rust/qc-device-runtime/src/request.rs", import.meta.url), "utf8");
const rustResponseSource = readFileSync(new URL("../../../packages/rust/qc-protocol/src/responses.rs", import.meta.url), "utf8");
const sharedTransportSource = readFileSync(new URL("../../../packages/typescript/qc-core/src/gateway-transport.ts", import.meta.url), "utf8");
const generatedGatewaySource = readFileSync(new URL("../android/app/src/main/java/com/qccontrol/mobile/GeneratedGatewayMethods.java", import.meta.url), "utf8");
const remoteActionsSource = readFileSync(new URL("../android/app/src/main/java/com/qccontrol/mobile/GeneratedRemoteActions.java", import.meta.url), "utf8");
const relayProtocolSource = readFileSync(new URL("../android/app/src/main/java/com/qccontrol/mobile/RelayProtocol.java", import.meta.url), "utf8");
const actionContract = JSON.parse(readFileSync(new URL("../../../contracts/qc-actions.v1.json", import.meta.url), "utf8"));
const gatewayContract = JSON.parse(readFileSync(new URL("../../../contracts/gateway-methods.v1.json", import.meta.url), "utf8"));

test("tempo synchronizes in both directions over the native USB bridge", () => {
  assert.match(sharedTransportSource, /gateway\.setTempo\(bpm, state\.tempo, state\.presetName\)/);
  assert.match(generatedPayloadSource, /\| "tempo"/);
  assert.match(
    javaSource,
    /case "PLANNED_WRITE":[\s\S]{0,400}QcUsbProfile\.COMMAND_CONFIRMATION_TIMEOUT_MS/,
  );
  assert.match(
    javaSource,
    /case "PRESET_WRITE":[\s\S]{0,400}QcUsbProfile\.PRESET_SYNC_TIMEOUT_MS/,
  );
  assert.match(rustRuntimeRequestSource, /DeviceCommand::SetTempo\(bpm\)/);
  assert.match(rustCommandsSource, /pub fn set_tempo/);
  assert.match(rustStateSource, /decode_global_tempo/);
  assert.match(rustStateSource, /StateUpdate::new\("tempo"\)/);
  assert.match(rustStateSource, /tempo_led_enabled/);
  assert.match(appSource, /consumeQcNativeStateFrame\(frame/);
  assert.match(liveStateSource, /reconcileFrame\(states, observedAt\)/);
  assert.match(performanceWorkflowSource, /transport\.tapTempo\(controller\.snapshotRef\.current\)/);
});

test("USB attachment auto-connects and reports synchronization separately", () => {
  assert.match(servicesSource, /connected: boolean; synchronized: boolean/);
  assert.match(javaSource, /handshakeComplete && presetSynchronized && currentSetlist != null/);
  assert.match(appSource, /if \(state === "available"\)[\s\S]*attemptUsbConnection\(\)/);
  assert.match(appSource, /state\.kind === "preset"[\s\S]*usbSessionReady\.current[\s\S]*transitionConnection\("connected"\)/);
  assert.match(appSource, /label: usbLabel, appearance: usbState/);
});

test("A through H use the reported hardware mode and assignments", () => {
  assert.match(sharedTransportSource, /gateway\.pressFootswitch\(index, state\.mode, state\.presetName\)/);
  assert.match(rustStateSource, /preset[\s\S]{0,200}\.stomp_mode_assignments/);
  assert.match(rustStateSource, /footswitch: assignments\.get/);
  assert.match(performanceWorkflowSource, /controller\.beginFootswitch/);
  assert.match(coreFootswitchSource, /mode === "SCENE"/);
  assert.match(coreFootswitchSource, /mode === "PRESET"/);
  assert.match(coreFootswitchSource, /block\.footswitch === index/);
  assert.match(rustRuntimeRequestSource, /"device\.pressFootswitch"[\s\S]*profile::FOOTSWITCH_BASE_CONTROLLER/);
  assert.match(performanceWorkflowSource, /controller\.runFootswitch\(transport, index\)/);
});

test("mode slots A through C use the same shared transport contract and immediate MIDI lane", () => {
  assert.match(sharedTransportSource, /gateway\.selectModeSlot\(slot, state\.presetName\)/);
  assert.match(rustRuntimeRequestSource, /"device\.selectModeSlot"[\s\S]*profile::MODE_SLOT_CONTROLLER/);
  assert.match(performanceWorkflowSource, /controller\.runModeSlot\(transport, slot\)/);
});

test("Tap Tempo uses its explicit official MIDI control and live bypass updates are batched", () => {
  assert.match(sharedTransportSource, /gateway\.tapTempo\(state\.mode, state\.presetName\)/);
  assert.match(rustRuntimeRequestSource, /"device\.tapTempo"[\s\S]*profile::TAP_TEMPO_CONTROLLER/);
  assert.match(rustRuntimeRequestSource, /MidiControlChange/);
  assert.match(performanceWorkflowSource, /transport\.tapTempo\(controller\.snapshotRef\.current\)/);
  assert.match(rustStateSource, /StateUpdate::new\("bypassBatch"\)/);
  assert.match(coreStateSource, /state\.kind === "bypassBatch"/);
});

test("native USB remains open and command traffic is never blocked by startup", () => {
  assert.match(javaSource, /readerIo = Executors\.newSingleThreadExecutor\(\)/);
  assert.match(javaSource, /commandIo = Executors\.newSingleThreadExecutor\(\)/);
  assert.match(javaSource, /midiIo = Executors\.newSingleThreadExecutor\(\)/);
  assert.match(javaSource, /private CompletableFuture<org\.json\.JSONObject> relayMidi/);
  assert.match(javaSource, /if \(isReady\(\) && device != null && device\.getDeviceId\(\) == candidate\.getDeviceId\(\)\)/);
  assert.doesNotMatch(javaSource, /Thread\.sleep\(2000\)/);
  assert.match(javaSource, /midiIo\.execute\(\(\) ->/);
  assert.match(appSource, /consumeQcNativeStateFrame\(frame/);
  assert.match(liveStateSource, /reconcileFrame\(states, observedAt\)/);
  assert.match(readFileSync(new URL("../../../packages/typescript/qc-core/src/command-coordinator.ts", import.meta.url), "utf8"), /beginSnapshotMutation/);
  assert.match(rustStateSource, /catalog_refresh = Some\(true\)/);
});

test("one device frame crosses the bridge once with all realtime state updates", () => {
  assert.match(javaSource, /stateDecoder\.decode\(type, payload\)/);
  assert.match(rustStateSource, /fn decode_grid/);
  assert.match(javaSource, /notifyListeners\("qcStateBatch", frame, true\)/);
  assert.doesNotMatch(javaSource, /notifyListeners\("qcState", state/);
  assert.match(servicesSource, /addListener\(eventName: "qcStateBatch"/);
  assert.match(appSource, /QcUsbNative\.addListener\("qcStateBatch"/);
  assert.match(appSource, /consumeQcNativeStateFrame\(frame/);
  assert.match(coreStateSource, /reduceQcStateFrame/);
  assert.match(javaSource, /state\.put\("observedAt", observedAt\)/);
});

test("large model metadata never blocks the permanent USB reader", () => {
  assert.match(javaSource, /metadataIo = Executors\.newSingleThreadExecutor\(\)/);
  assert.match(javaSource, /if \(type == 51\) \{[\s\S]*scheduleModelCatalogDecode/);
  assert.match(javaSource, /metadataIo\.execute\(\(\) ->/);
  assert.match(javaSource, /stateDecoder\.installModelRepo\(payload\)/);
  assert.match(rustAndroidSource, /Parsing intentionally happens before the decoder lock/);
  assert.doesNotMatch(javaSource, /Base64\.encodeToString|notifyListeners\("qcUsbMessage"/, "raw frames must not be serialized across the bridge");
  assert.doesNotMatch(servicesSource, /addListener\(eventName: "qcUsbMessage"/);
  assert.match(appSource, /Promise\.all\(listenerPromises\)[\s\S]*QcUsbNative\.scan\(\)/, "listeners must be live before startup frames arrive");
  assert.match(javaSource, /stateDecoder\.initializationCommands\(\)/);
  assert.match(rustCommandsSource, /profile::LIVE_SUBSCRIPTIONS/);
});

test("the Capacitor bridge delegates commands, framing, and state to shared Rust", () => {
  assert.match(javaSource, /stateDecoder\.pushReport\(report\)/);
  assert.doesNotMatch(javaSource, /reportFlags|MAX_FRAME_REPORTS|List<byte\[]> reports/);
  assert.match(javaSource, /stateDecoder\.encodeFrame\(message\)/);
  assert.match(javaSource, /stateDecoder\.gatewayPlan\(method, JSObject\.fromJSONObject\(params\)\)/);
  assert.match(rustRuntimeRequestSource, /pub fn gateway_write_retryable/);
  assert.match(rustAndroidSource, /gateway_write_retryable\(&method\)/);
  assert.match(nativeDecoderSource, /final boolean retryable/);
  assert.match(javaSource, /registered != null && plan\.retryable/);
  assert.doesNotMatch(javaSource, /isIdempotentGatewayWrite/);
  assert.doesNotMatch(javaSource, /QcUsbFraming|QcProtobufWire|fieldVarint|fieldMessage/);
  assert.match(nativeDecoderSource, /System\.loadLibrary\("qc_android"\)/);
  assert.match(nativeDecoderSource, /nativeEncodeCommand/);
  assert.match(nativeDecoderSource, /nativePlanGatewayWrite/);
  assert.match(nativeDecoderSource, /nativeEncodeFrame/);
  assert.match(nativeDecoderSource, /nativePushReport/);
  assert.match(rustAndroidSource, /qc_protocol::state/);
  assert.match(rustAndroidSource, /qc_protocol::commands/);
  assert.match(rustAndroidSource, /qc_protocol::framing/);
  assert.match(rustAndroidSource, /qc_protocol::session::(?:FrameAssembler|\{[^}]*FrameAssembler)/);
});

test("Android feeds decoded state into the shared native device runtime", () => {
  assert.match(rustAndroidSource, /GatewaySnapshot/);
  assert.match(rustAndroidSource, /snapshot\.apply\(state\)/);
  assert.match(rustAndroidSource, /nativeSnapshot/);
  assert.match(rustAndroidSource, /plan_gateway_write/);
  assert.match(nativeDecoderSource, /JSObject snapshot\(\).*nativeSnapshot/);
});

test("Android generic dispatch covers the generated Grid, routing, and MIDI actions", () => {
  for (const method of ["device.moveBlock", "device.addBlock", "device.removeBlock", "device.setBlockFootswitch", "device.setChainInput", "device.setChainOutput", "device.setChainSplit"]) {
    assert.match(rustRuntimeRequestSource, new RegExp(method.replace(".", "\\.")));
  }
  assert.match(generatedGatewaySource, /case "device\.pressFootswitch": return "PLANNED_WRITE"/);
  assert.match(generatedGatewaySource, /case "device\.tapTempo": return "PLANNED_WRITE"/);
  assert.match(generatedGatewaySource, /case "device\.selectModeSlot": return "PLANNED_WRITE"/);
  assert.match(javaSource, /stateDecoder\.gatewayPlan\(method, JSObject\.fromJSONObject\(params\)\)/);
  assert.match(nativeDecoderSource, /PlannedGatewayWrite/);
});

test("Android remote relay consumes every generated MCP action with verified writes", () => {
  for (const action of actionContract.actions) {
    assert.match(remoteActionsSource, new RegExp(`"${action.rpc.replace(".", "\\.")}"`), `${action.rpc} is absent from Android remote policy`);
  }
  assert.match(relayProtocolSource, /GeneratedRemoteActions\.contains\(method\)/);
  assert.match(javaSource, /relayPlannedGatewayWrite\(/);
  assert.match(javaSource, /stateDecoder\.gatewayTransactionState\(/);
  assert.match(javaSource, /resolvePendingGatewayTransactions/);
  assert.doesNotMatch(javaSource, /pollRelayVerification/);
  assert.match(javaSource, /relayGatewayWorkflow\(method, params\)/);
  assert.match(nativeDecoderSource, /nativePlanGatewayWorkflow/);
  assert.match(rustAndroidSource, /plan_preset_mutation/);
  assert.match(rustRuntimeRequestSource, /pub fn plan_preset_mutation/);
  assert.doesNotMatch(javaSource, /relaySavePresetAs|relayRenamePreset|relayCopyPreset|relayGridVerification/);
  assert.match(javaSource, /stateDecoder\.modelList\(\)/);
  assert.match(javaSource, /relayPresetLibraryRead\(method, params\)/);
  assert.match(rustAndroidSource, /decode_preset_folder/);
  assert.match(rustAndroidSource, /nativePresetSlots/);
  for (const method of ["device.identity", "device.inhibitedModules", "device.presetScreenshot", "device.captureScreen"]) {
    assert.match(rustRuntimeRequestSource, new RegExp(method.replace(".", "\\.")));
  }
  assert.match(
    javaSource,
    /case "CORRELATED_READ":[\s\S]{0,250}relayGatewayRead\(method, params\)/,
  );
  assert.match(javaSource, /relaySetDeviceName\(params\)/);
  assert.match(javaSource, /relayTapScreen\(params\)/);
  assert.match(nativeDecoderSource, /nativePlanGatewayRead/);
  assert.match(nativeDecoderSource, /nativeDecodeGatewayResponse/);
  assert.match(rustResponseSource, /decode_device_identity/);
  assert.match(rustResponseSource, /decode_inhibited_modules/);
  assert.match(rustResponseSource, /decode_preset_screenshot/);
  assert.match(rustResponseSource, /decode_captured_screen/);
  assert.doesNotMatch(javaSource, /VersionMessage|ScreenshotMessage|CompilerInhibitedModulesMessage|RemoteControlMessage/);
});

test("Android relay has exact gateway parity with Windows", () => {
  const remote = new Set(["system.status", ...actionContract.actions.map((action: { rpc: string }) => action.rpc)]);
  const gateway = gatewayContract.methods.map((method: { rpc: string }) => method.rpc);
  assert.deepEqual([...remote].sort(), [...gateway].sort());
  for (const method of gateway) {
    assert.match(remoteActionsSource, new RegExp(`"${method.replace(".", "\\.")}"`));
  }
  for (const implementation of [
    "relayReconnect", "relayDisconnect", "relayStateEvents", "relayTempoClock",
    "relayCreateBackup"
  ]) assert.match(javaSource, new RegExp(implementation.replace(".", "\\.")));
  assert.match(javaSource, /relayPreviewParameter\(method, params\)/);
  assert.match(nativeDecoderSource, /nativeTempoClock/);
  assert.match(nativeDecoderSource, /nativeConsumeBackupChunk/);
  assert.match(rustAndroidSource, /decode_tempo_clock/);
  assert.match(rustAndroidSource, /BackupAssembler/);
  assert.match(javaSource, /public void gatewayInvoke\(PluginCall call\)/);
  assert.match(servicesSource, /gatewayInvoke\(options:/);
});

test("Android persists completed native backups without blocking USB reads", () => {
  assert.match(javaSource, /MediaStore\.Downloads\.EXTERNAL_CONTENT_URI/);
  assert.match(javaSource, /R\.string\.download_folder/);
  assert.match(javaSource, /metadataIo\.execute\(\(\) -> \{[\s\S]*saveBackupDocument/);
  assert.match(javaSource, /QcUsbProfile\.BACKUP_MAXIMUM_DOCUMENT_BYTES/);
  assert.match(usbProfileSource, /BACKUP_MAXIMUM_DOCUMENT_BYTES = 33554432/);
  assert.doesNotMatch(javaSource, /pending\.result\.complete\(JSObject\.fromJSONObject\(\(org\.json\.JSONObject\) update\.get\("backup"\)\)\)/);
});

test("Android and Windows apply the same safe native-backup retry boundary", () => {
  const windowsUsb = readFileSync(new URL("../../../services/device-broker/src/usb.rs", import.meta.url), "utf8");
  assert.match(rustAndroidSource, /"started": started/);
  assert.match(rustAndroidSource, /"ignoredPrefixChunks": ignored_prefix_chunks/);
  assert.match(javaSource, /scheduleBackupWatchdog\(pending, QcUsbProfile\.BACKUP_FIRST_CHUNK_TIMEOUT_MS\)/);
  assert.match(usbProfileSource, /BACKUP_FIRST_CHUNK_TIMEOUT_MS = 25000L/);
  assert.match(usbProfileSource, /BACKUP_STREAM_STALL_TIMEOUT_MS = 15000L/);
  assert.match(javaSource, /operation\.started[\s\S]*partial document was discarded/);
  assert.match(javaSource, /operation\.attempts >= QcUsbProfile\.BACKUP_MAXIMUM_ATTEMPTS/);
  assert.match(usbProfileSource, /BACKUP_MAXIMUM_ATTEMPTS = 3/);
  assert.match(windowsUsb, /!assembler\.started\(\)[\s\S]*BACKUP_MAXIMUM_ATTEMPTS/);
  assert.match(windowsUsb, /partial document was discarded and was not combined with a retry/);
  assert.match(javaSource, /pendingOperations\.timeout\(pending, QcUsbProfile\.BACKUP_TOTAL_TIMEOUT_MS/);
});

test("absolute Android preset writes use the bounded idempotent retry path", () => {
  assert.match(rustRuntimeRequestSource, /"device\.recallPreset"[\s\S]*"device\.reloadPreset"/);
  assert.doesNotMatch(rustRuntimeRequestSource, /\| "device\.navigateBank"/);
  assert.match(javaSource, /registered != null && plan\.retryable/);
  assert.doesNotMatch(javaSource, /isIdempotentGatewayWrite/);
});

test("live QC parameter frames update the open shared editor", () => {
  assert.match(generatedPayloadSource, /\| "parameter"/);
  assert.match(rustStateSource, /StateUpdate::new\("parameter"\)/);
  assert.match(rustStateSource, /parameter_overrides[\s\S]{0,100}\.insert/);
  assert.match(appSource, /useQcLiveState/);
  assert.match(liveStateSource, /state\.kind === "parameter"[\s\S]*editor\.updateParameters/);
});
