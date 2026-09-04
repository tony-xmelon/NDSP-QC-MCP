import type {
  BlockDetails, ConnectionState, DeviceImage, GatewayTransport, PresetSnapshot,
  SavePresetResult
} from "@ndsp-qc/client";
import {
  assistantAccessPermitsTool, formatSnapshotSummary, isSharedQcAssistantTool,
  type AssistantAccessMode, type AssistantToolCall
} from "@ndsp-qc/core";
import { parameterNormalizedValue } from "./parameter-model.ts";

export interface QcActionExecutionContext {
  gateway: GatewayTransport;
  snapshot: PresetSnapshot;
  connected: boolean;
  accessMode?: AssistantAccessMode;
  selectedBlockId?: string;
}

export interface QcActionExecutionResult {
  detail: string;
  snapshot?: PresetSnapshot;
  block?: BlockDetails;
  connection?: ConnectionState;
  savedPreset?: SavePresetResult;
  image?: DeviceImage;
  clearSelection?: boolean;
  data?: unknown;
}

const numberArgument = (call: AssistantToolCall, name: string): number => {
  const value = call.arguments[name];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${call.name} returned an invalid ${name}.`);
  return value;
};

const integerArgument = (call: AssistantToolCall, name: string): number => {
  const value = numberArgument(call, name);
  if (!Number.isInteger(value)) throw new Error(`${call.name} returned a non-integer ${name}.`);
  return value;
};

const booleanArgument = (call: AssistantToolCall, name: string): boolean => {
  const value = call.arguments[name];
  if (typeof value !== "boolean") throw new Error(`${call.name} returned an invalid ${name}.`);
  return value;
};

const stringArgument = (call: AssistantToolCall, name: string): string => {
  const value = call.arguments[name];
  if (typeof value !== "string") throw new Error(`${call.name} returned an invalid ${name}.`);
  return value;
};

const nullableIntegerArgument = (call: AssistantToolCall, name: string): number | null => {
  const value = call.arguments[name];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${call.name} returned an invalid ${name}.`);
  return value;
};

const confirmation = (call: AssistantToolCall, name: "confirm_risky_operation" | "confirm_persistent_write") => {
  if (!booleanArgument(call, name)) throw new Error(`${call.name} requires explicit user confirmation; no device action was taken.`);
};

const closeEnough = (left: number, right: number) => Math.abs(left - right) < .000001;

const assertExpectedNumber = (call: AssistantToolCall, name: string, actual: number) => {
  const expected = numberArgument(call, name);
  if (!closeEnough(expected, actual)) throw new Error(`${call.name} was based on stale ${name}; refresh device state and try again.`);
};

const assertExpectedString = (call: AssistantToolCall, name: string, actual: string) => {
  const expected = stringArgument(call, name);
  if (expected !== actual) throw new Error(`${call.name} was prepared for “${expected}”, but “${actual}” is active; no device action was taken.`);
};

const actionResult = (result: { detail: string; snapshot?: PresetSnapshot }): QcActionExecutionResult => ({
  detail: result.detail,
  snapshot: result.snapshot
});

const summarizeSnapshot = (snapshot: PresetSnapshot, selectedBlockId?: string) => {
  const blocks = snapshot.blocks
    .filter((block) => block.column >= 0 && block.column < 8)
    .map((block) => `r${block.row}c${block.column}=${block.name}${block.modelId === undefined ? "" : `#${block.modelId}`}${block.bypassed === undefined ? "" : block.bypassed ? "[bypassed]" : "[enabled]"}`)
    .join(", ");
  const routes = snapshot.routes
    .map((route) => `row${route.row}:in${route.inputId ?? "?"}->out${route.outputId ?? "?"},split=${route.splitColumn ?? "none"},mix=${route.mixColumn ?? "none"}`)
    .join("; ");
  const selected = snapshot.blocks.find((block) => block.id === selectedBlockId);
  return `${formatSnapshotSummary(snapshot)} Grid: ${blocks || "empty"}. Routes: ${routes || "unavailable"}. Selected: ${selected ? `r${selected.row}c${selected.column} ${selected.name}` : "none"}.`;
};

/** Execute one generated QC action identically for every UI and model provider. */
export async function executeQcAction(call: AssistantToolCall, context: QcActionExecutionContext): Promise<QcActionExecutionResult> {
  const { gateway, snapshot, connected, accessMode = "full", selectedBlockId } = context;
  if (!isSharedQcAssistantTool(call.name)) throw new Error(`Unsupported shared QC action “${call.name}”; no device action was taken.`);
  if (!assistantAccessPermitsTool(accessMode, call.name)) {
    throw new Error(`Assistant ${accessMode} access does not permit ${call.name}; no device action was taken.`);
  }

  if (call.name === "reconnect_device" || call.name === "reset_device_session" || call.name === "disconnect_device") {
    confirmation(call, "confirm_risky_operation");
    const connection = call.name === "reconnect_device"
      ? await gateway.reconnect()
      : call.name === "reset_device_session"
        ? await gateway.resetSession()
        : await gateway.disconnect();
    const next = connection.phase === "ready" ? await gateway.currentSnapshot() : undefined;
    return { detail: connection.detail, connection, snapshot: next, clearSelection: true };
  }

  if (!connected) throw new Error("Connect the Quad Cortex before using that device action.");

  if (call.name === "get_current_preset") {
    return { detail: summarizeSnapshot(snapshot, selectedBlockId), data: snapshot };
  }
  if (call.name === "get_state_events") {
    const frames = await gateway.currentStateEvents(integerArgument(call, "after_sequence"), integerArgument(call, "limit"));
    const stateCount = frames.frames.reduce((total, frame) => total + frame.states.length, 0);
    const latest = frames.frames.at(-1)?.sequence;
    return { detail: `${frames.frames.length} native frame${frames.frames.length === 1 ? "" : "s"}, ${stateCount} state event${stateCount === 1 ? "" : "s"}${latest === undefined ? "" : `; latest sequence ${latest}`}.`, data: frames };
  }
  if (call.name === "get_tempo_clock") {
    const clock = await gateway.currentTempoClock();
    const detail = clock.available
      ? `Tempo clock is available${clock.currentBar === undefined ? "" : ` at bar ${clock.currentBar}, beat ${clock.currentBeat ?? "?"}, tick ${clock.currentTick ?? "?"}`}.`
      : "Tempo clock is not currently available.";
    return { detail, data: clock };
  }
  if (call.name === "get_block_details") {
    assertExpectedString(call, "expected_preset_name", snapshot.presetName);
    const row = integerArgument(call, "row");
    const column = integerArgument(call, "column");
    const block = await gateway.blockDetails(row, column, snapshot.presetName);
    const values = block.parameters.map((parameter) => `${parameter.name}: ${parameter.displayValue}${parameter.units && !parameter.displayValue.includes(parameter.units) ? ` ${parameter.units}` : ""}${parameter.scaleKnown === false ? " (normalized only; exact display scale unavailable)" : ""}`).join(", ");
    return { detail: `${block.name} at row ${row}, column ${column}${values ? ` — ${values}` : " exposes no readable parameters"}.`, block, data: block };
  }
  if (call.name === "list_models") {
    const catalog = await gateway.listModels();
    const rawQuery = call.arguments.query;
    if (rawQuery !== null && typeof rawQuery !== "string") throw new Error("list_models returned an invalid query.");
    const query = typeof rawQuery === "string" ? rawQuery.trim().toLocaleLowerCase() : "";
    const matches = catalog.models.filter((model) => !query || `${model.name} ${model.category} ${model.basedOn}`.toLocaleLowerCase().includes(query));
    const shown = matches.slice(0, 50);
    return { detail: `${query ? `${matches.length} matching` : `${catalog.models.length} installed`} models${shown.length ? `: ${shown.map((model) => `${model.id}=${model.name} [${model.category}]`).join(", ")}${matches.length > shown.length ? `, plus ${matches.length - shown.length} more` : ""}` : "."}`, data: catalog };
  }
  if (call.name === "list_presets") {
    const setlist = call.arguments.setlist_key;
    if (setlist !== null && typeof setlist !== "string") throw new Error("list_presets returned an invalid setlist_key.");
    const list = await gateway.listPresets(booleanArgument(call, "refresh"), typeof setlist === "string" ? setlist : undefined);
    const shown = list.presets.slice(0, 80);
    return { detail: `${list.setlistName} contains ${list.presets.length} presets${shown.length ? `: ${shown.map((entry) => `${entry.location}=${entry.name}`).join(", ")}${list.presets.length > shown.length ? `, plus ${list.presets.length - shown.length} more` : ""}` : "."}`, data: list };
  }
  if (call.name === "list_preset_folders") {
    const folders = await gateway.listPresetFolders(booleanArgument(call, "refresh"));
    return { detail: `Preset folders: ${folders.folders.map((folder) => `${folder.name} [${folder.key}]${folder.isFactory ? " (factory, read-only)" : ""}`).join(", ") || "none"}.`, data: folders };
  }
  if (call.name === "list_preset_slots") {
    const slots = await gateway.listPresetSlots();
    return { detail: `${slots.setlistName} save slots: ${slots.slots.map((slot) => `${slot.location}=${slot.occupied ? slot.name : "Empty"}`).join(", ")}.`, data: slots };
  }
  if (call.name === "get_master_volume") {
    const volume = await gateway.currentMasterVolume();
    return { detail: `Quad Cortex master volume is ${volume.value}.`, snapshot: { ...snapshot, masterVolume: volume.value }, data: volume };
  }
  if (call.name === "get_device_identity") {
    const identity = await gateway.identity();
    return { detail: `Quad Cortex ${identity.customName || "device"}; serial ${identity.serial}${identity.appFwVersion ? `; firmware ${identity.appFwVersion}` : ""}.`, data: identity };
  }
  if (call.name === "get_inhibited_modules") {
    const modules = await gateway.inhibitedModules();
    return { detail: `Global Gate is ${modules.globalGate ? "inhibited" : "available"}; Global EQ is ${modules.globalEq ? "inhibited" : "available"}.`, data: modules };
  }
  if (call.name === "get_preset_screenshot" || call.name === "capture_screen") {
    const image = call.name === "capture_screen"
      ? await gateway.captureScreen()
      : await gateway.presetScreenshot(stringArgument(call, "folder_name"), integerArgument(call, "position"), booleanArgument(call, "is_factory"));
    return { detail: `Captured Quad Cortex image (${image.width}×${image.height} PNG).`, image };
  }
  if (call.name === "preview_parameter" || call.name === "set_parameter") {
    assertExpectedString(call, "expected_preset_name", snapshot.presetName);
    assertExpectedNumber(call, "expected_scene", snapshot.activeScene);
    const row = integerArgument(call, "row");
    const column = integerArgument(call, "column");
    const parameterIndex = integerArgument(call, "parameter_index");
    const details = await gateway.blockDetails(row, column, snapshot.presetName);
    const parameter = details.parameters.find((candidate) => candidate.index === parameterIndex);
    if (!parameter?.writable || parameter.normalizedValue === null) throw new Error("That parameter is not currently writable with verified state.");
    assertExpectedNumber(call, "expected_value", parameter.normalizedValue);
    const requested = numberArgument(call, "value");
    const value = call.name === "preview_parameter" || parameter.options.length > 1 ? requested : parameterNormalizedValue(parameter, requested);
    if (call.name === "preview_parameter") {
      const preview = await gateway.previewParameter(row, column, parameterIndex, value, snapshot.activeScene, snapshot.presetName);
      return { detail: preview.detail, data: preview };
    }
    if (parameter.scaleKnown === false) throw new Error(`${parameter.name} does not yet have a verified Quad Cortex display scale. It was not changed.`);
    const result = await gateway.setParameter(row, column, parameterIndex, value, parameter.normalizedValue, snapshot.activeScene, snapshot.presetName);
    return { detail: result.detail, snapshot: result.snapshot, block: result.block, data: result };
  }
  if (call.name === "create_device_backup") {
    confirmation(call, "confirm_persistent_write");
    const name = stringArgument(call, "name").trim();
    if (!name) throw new Error("A backup name is required.");
    const backup = await gateway.createDeviceBackup(name);
    return { detail: backup.cancelled ? "Device backup cancelled." : `Native Quad Cortex backup saved as ${backup.name}.`, data: backup };
  }
  if (call.name === "set_device_name") {
    confirmation(call, "confirm_persistent_write");
    const name = stringArgument(call, "name").trim();
    if (!name) throw new Error("A device name is required.");
    const result = await gateway.setDeviceName(name);
    return { ...actionResult(result), data: result.identity };
  }
  if (call.name === "undo_device" || call.name === "redo_device") {
    confirmation(call, "confirm_risky_operation");
    return actionResult(call.name === "undo_device" ? await gateway.undo() : await gateway.redo());
  }
  if (call.name === "tap_screen") {
    confirmation(call, "confirm_risky_operation");
    return actionResult(await gateway.tapScreen(integerArgument(call, "x"), integerArgument(call, "y")));
  }
  if (call.name === "show_tuner") return actionResult(await gateway.showTuner(booleanArgument(call, "shown")));
  if (call.name === "show_gig_view") return actionResult(await gateway.showGigView(booleanArgument(call, "shown")));
  if (call.name === "set_master_volume") {
    confirmation(call, "confirm_risky_operation");
    assertExpectedNumber(call, "expected_value", snapshot.masterVolume);
    const value = integerArgument(call, "value");
    if (value < 0 || value > 100) throw new Error("Master volume must be an integer from 0 through 100.");
    return actionResult(await gateway.setMasterVolume(value, snapshot.masterVolume));
  }

  assertExpectedString(call, "expected_preset_name", snapshot.presetName);

  if (call.name === "select_scene") return actionResult(await gateway.selectScene(integerArgument(call, "scene"), snapshot.presetName));
  if (call.name === "copy_scene") return actionResult(await gateway.copyScene(integerArgument(call, "from_scene"), integerArgument(call, "to_scene"), booleanArgument(call, "swap"), snapshot.presetName));
  if (call.name === "set_scene_label") {
    const label = call.arguments.label;
    if (label !== null && typeof label !== "string") throw new Error("set_scene_label returned an invalid label.");
    return actionResult(await gateway.setSceneLabel(integerArgument(call, "scene"), label as string | null, snapshot.presetName));
  }
  if (call.name === "set_scene_color") return actionResult(await gateway.setSceneColor(integerArgument(call, "scene"), integerArgument(call, "color"), snapshot.presetName));
  if (call.name === "press_footswitch") {
    const expectedMode = stringArgument(call, "expected_mode");
    if (expectedMode !== snapshot.mode) throw new Error("press_footswitch was based on a stale device mode; no action was taken.");
    return actionResult(await gateway.pressFootswitch(integerArgument(call, "index"), snapshot.mode, snapshot.presetName));
  }
  if (call.name === "tap_tempo") {
    const expectedMode = stringArgument(call, "expected_mode");
    if (expectedMode !== snapshot.mode) throw new Error("tap_tempo was based on a stale device mode; no action was taken.");
    return actionResult(await gateway.tapTempo(snapshot.mode, snapshot.presetName));
  }
  if (call.name === "navigate_bank") {
    assertExpectedNumber(call, "expected_position", snapshot.presetPosition);
    const direction = integerArgument(call, "direction");
    if (direction !== -1 && direction !== 1) throw new Error("Bank direction must be -1 or 1.");
    return { ...actionResult(await gateway.navigateBank(direction, snapshot.presetName, snapshot.presetPosition)), clearSelection: true };
  }
  if (call.name === "select_mode_slot") {
    const slot = integerArgument(call, "slot");
    if (slot < 0 || slot > 2) throw new Error("Mode slot must be 0, 1, or 2.");
    return actionResult(await gateway.selectModeSlot(slot as 0 | 1 | 2, snapshot.presetName));
  }
  if (call.name === "recall_preset") {
    assertExpectedNumber(call, "expected_position", snapshot.presetPosition);
    const result = await gateway.recallPreset(stringArgument(call, "setlist_key"), integerArgument(call, "position"), snapshot.presetName, snapshot.presetPosition);
    return { ...actionResult(result), clearSelection: true };
  }
  if (call.name === "reload_preset") {
    confirmation(call, "confirm_risky_operation");
    assertExpectedNumber(call, "expected_position", snapshot.presetPosition);
    return { ...actionResult(await gateway.reloadPreset(snapshot.presetName, snapshot.presetPosition)), clearSelection: true };
  }
  if (call.name === "set_tempo") {
    assertExpectedNumber(call, "expected_tempo", snapshot.tempo);
    return actionResult(await gateway.setTempo(numberArgument(call, "bpm"), snapshot.tempo, snapshot.presetName));
  }
  if (call.name === "set_bypass") {
    assertExpectedNumber(call, "expected_scene", snapshot.activeScene);
    const row = integerArgument(call, "row");
    const column = integerArgument(call, "column");
    const block = snapshot.blocks.find((candidate) => candidate.row === row && candidate.column === column);
    if (!block || block.bypassed === undefined) throw new Error("The requested Grid location does not contain a bypass-capable block.");
    const expected = booleanArgument(call, "expected_bypassed");
    if (expected !== block.bypassed) throw new Error("set_bypass was based on stale bypass state; refresh and try again.");
    const desired = booleanArgument(call, "desired_bypassed");
    if (desired === block.bypassed) return { detail: `${block.name} is already ${desired ? "bypassed" : "enabled"}.` };
    return actionResult(await gateway.toggleBypass(row, column, snapshot.activeScene, block.bypassed, desired, snapshot.presetName));
  }
  if (call.name === "move_block") {
    const row = integerArgument(call, "row");
    const from = integerArgument(call, "from_column");
    const block = snapshot.blocks.find((candidate) => candidate.row === row && candidate.column === from);
    if (!block || block.modelId === undefined) throw new Error("The requested source cell does not contain a movable model block.");
    assertExpectedNumber(call, "expected_model_id", block.modelId);
    return actionResult(await gateway.moveBlock(row, from, integerArgument(call, "to_column"), block.modelId, snapshot.presetName));
  }
  if (call.name === "add_block") return actionResult(await gateway.addBlock(integerArgument(call, "row"), integerArgument(call, "column"), integerArgument(call, "model_id"), snapshot.presetName));
  if (call.name === "remove_block") {
    const row = integerArgument(call, "row");
    const column = integerArgument(call, "column");
    const block = snapshot.blocks.find((candidate) => candidate.row === row && candidate.column === column);
    if (!block || block.modelId === undefined) throw new Error("The requested Grid cell does not contain a removable model block.");
    assertExpectedNumber(call, "expected_model_id", block.modelId);
    return actionResult(await gateway.removeBlock(row, column, block.modelId, snapshot.presetName));
  }
  if (call.name === "set_block_footswitch") {
    const row = integerArgument(call, "row");
    const column = integerArgument(call, "column");
    const block = snapshot.blocks.find((candidate) => candidate.row === row && candidate.column === column);
    if (!block || block.modelId === undefined) throw new Error("The requested Grid cell does not contain an assignable model block.");
    assertExpectedNumber(call, "expected_model_id", block.modelId);
    const expected = nullableIntegerArgument(call, "expected_footswitch");
    if (expected !== (block.footswitch ?? null)) throw new Error("set_block_footswitch was based on a stale assignment; refresh and try again.");
    const footswitch = nullableIntegerArgument(call, "footswitch");
    return actionResult(await gateway.setBlockFootswitch(row, column, footswitch, expected, block.modelId, snapshot.presetName));
  }
  if (call.name === "set_chain_input" || call.name === "set_chain_output" || call.name === "set_chain_split") {
    const row = integerArgument(call, "row");
    const route = snapshot.routes.find((candidate) => candidate.row === row);
    if (!route) throw new Error("That signal row does not exist.");
    if (call.name === "set_chain_input") {
      if (route.inputId === undefined) throw new Error("The current input route ID is unavailable for verified replacement.");
      assertExpectedNumber(call, "expected_input_id", route.inputId);
      return actionResult(await gateway.setChainInput(row, integerArgument(call, "input_id"), route.inputId, snapshot.presetName));
    }
    if (call.name === "set_chain_output") {
      if (route.outputId === undefined) throw new Error("The current output route ID is unavailable for verified replacement.");
      assertExpectedNumber(call, "expected_output_id", route.outputId);
      return actionResult(await gateway.setChainOutput(row, integerArgument(call, "output_id"), route.outputId, snapshot.presetName));
    }
    const expectedSplit = nullableIntegerArgument(call, "expected_split_column");
    const expectedMix = nullableIntegerArgument(call, "expected_mix_column");
    if (expectedSplit !== (route.splitColumn ?? null) || expectedMix !== (route.mixColumn ?? null)) throw new Error("set_chain_split was based on stale routing state; refresh and try again.");
    return actionResult(await gateway.setChainSplit(row, nullableIntegerArgument(call, "split_column"), nullableIntegerArgument(call, "mix_column"), expectedSplit, expectedMix, snapshot.presetName));
  }
  if (call.name === "save_preset_as") {
    confirmation(call, "confirm_persistent_write");
    assertExpectedNumber(call, "expected_position", snapshot.presetPosition);
    const name = stringArgument(call, "name").trim();
    if (!name) throw new Error("A preset name is required for device save.");
    const savedPreset = await gateway.savePresetAs(stringArgument(call, "setlist_key"), integerArgument(call, "position"), name, snapshot.presetName, snapshot.presetPosition, booleanArgument(call, "confirm_overwrite"));
    return { detail: savedPreset.detail, snapshot: savedPreset.snapshot, savedPreset };
  }
  if (call.name === "rename_current_preset") {
    confirmation(call, "confirm_persistent_write");
    assertExpectedNumber(call, "expected_position", snapshot.presetPosition);
    const name = stringArgument(call, "new_name").trim();
    if (!name) throw new Error("A new preset name is required.");
    const savedPreset = await gateway.renameCurrentPreset(name, snapshot.presetName, snapshot.presetPosition, true);
    return { detail: savedPreset.detail, snapshot: savedPreset.snapshot, savedPreset };
  }
  if (call.name === "copy_preset") {
    confirmation(call, "confirm_persistent_write");
    assertExpectedNumber(call, "expected_position", snapshot.presetPosition);
    const savedPreset = await gateway.copyPreset(
      stringArgument(call, "source_setlist_key"), integerArgument(call, "source_position"), stringArgument(call, "source_name"),
      stringArgument(call, "destination_setlist_key"), integerArgument(call, "destination_position"), snapshot.presetName,
      snapshot.presetPosition, booleanArgument(call, "confirm_overwrite")
    );
    return { detail: savedPreset.detail, snapshot: savedPreset.snapshot, savedPreset };
  }

  const exhaustive: never = call.name;
  throw new Error(`Unsupported shared QC action “${exhaustive}”.`);
}
