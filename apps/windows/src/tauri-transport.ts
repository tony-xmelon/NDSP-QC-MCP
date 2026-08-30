import type { BlockDetails, ConnectionState, DeviceActionResult, DiagnosticsReport, GatewayTransport, ParameterActionResult, PresetList, PresetSlotList, RuntimeStatus, SavePresetResult, WorkspaceDocument, WorkspaceFileResult } from "@ndsp-qc/client";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

async function callTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!window.__TAURI_INTERNALS__) {
    throw new Error("Desktop runtime is not active. Start with npm run tauri:dev.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export function reportVoiceCapability(available: boolean): Promise<void> {
  if (!window.__TAURI_INTERNALS__) return Promise.resolve();
  return callTauri<void>("report_voice_capability", { available });
}

export function reportVoiceEvent(event: string): Promise<void> {
  if (!window.__TAURI_INTERNALS__) return Promise.resolve();
  return callTauri<void>("report_voice_event", { event });
}

export const tauriTransport: GatewayTransport = {
  async runtimeStatus(): Promise<RuntimeStatus> {
    if (!window.__TAURI_INTERNALS__) {
      return {
        platform: "Browser preview",
        gatewayAvailable: false,
        message: "UI preview mode — the device gateway is not attached."
      };
    }
    return callTauri<RuntimeStatus>("runtime_status");
  },
  reconnect(): Promise<ConnectionState> {
    return callTauri<ConnectionState>("reconnect_device");
  },
  resetSession(): Promise<ConnectionState> {
    return callTauri<ConnectionState>("reset_device_session");
  },
  disconnect(): Promise<ConnectionState> {
    return callTauri<ConnectionState>("disconnect_device");
  },
  currentSnapshot(): Promise<import("@ndsp-qc/client").PresetSnapshot> {
    return callTauri<import("@ndsp-qc/client").PresetSnapshot>("current_snapshot");
  },
  selectScene(scene: number, expectedPresetName: string): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("select_scene", { scene, expectedPresetName });
  },
  toggleBypass(row: number, column: number, expectedScene: number, expectedBypassed: boolean, desiredBypassed: boolean, expectedPresetName: string): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("toggle_bypass", { row, column, expectedScene, expectedBypassed, desiredBypassed, expectedPresetName });
  },
  moveBlock(row: number, fromColumn: number, toColumn: number, expectedModelId: number, expectedPresetName: string): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("move_block", { row, fromColumn, toColumn, expectedModelId, expectedPresetName });
  },
  setBlockFootswitch(row: number, column: number, footswitch: number | null, expectedFootswitch: number | null, expectedModelId: number, expectedPresetName: string): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("set_block_footswitch", { row, column, footswitch, expectedFootswitch, expectedModelId, expectedPresetName });
  },
  setChainInput(row: number, inputId: number, expectedInputId: number, expectedPresetName: string): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("set_chain_input", { row, inputId, expectedInputId, expectedPresetName });
  },
  setChainOutput(row: number, outputId: number, expectedOutputId: number, expectedPresetName: string): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("set_chain_output", { row, outputId, expectedOutputId, expectedPresetName });
  },
  listPresets(refresh = false): Promise<PresetList> {
    return callTauri<PresetList>("list_presets", { refresh });
  },
  navigateBank(direction: -1 | 1, expectedPresetName: string, expectedPosition: number): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("navigate_bank", { direction, expectedPresetName, expectedPosition });
  },
  recallPreset(setlistKey: string, position: number, expectedPresetName: string, expectedPosition: number): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("recall_preset", { setlistKey, position, expectedPresetName, expectedPosition });
  },
  reloadPreset(expectedPresetName: string, expectedPosition: number): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("reload_preset", { expectedPresetName, expectedPosition });
  },
  blockDetails(row: number, column: number, expectedPresetName: string): Promise<BlockDetails> {
    return callTauri<BlockDetails>("block_details", { row, column, expectedPresetName });
  },
  setParameter(row: number, column: number, parameterIndex: number, value: number, expectedValue: number, expectedScene: number, expectedPresetName: string): Promise<ParameterActionResult> {
    return callTauri<ParameterActionResult>("set_parameter", { row, column, parameterIndex, value, expectedValue, expectedScene, expectedPresetName });
  },
  setTempo(bpm: number, expectedTempo: number, expectedPresetName: string): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("set_tempo", { bpm, expectedTempo, expectedPresetName });
  },
  pressFootswitch(index: number, expectedMode: import("@ndsp-qc/client").PresetSnapshot["mode"], expectedPresetName: string): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("press_footswitch", { index, expectedMode, expectedPresetName });
  },
  listPresetSlots(): Promise<PresetSlotList> {
    return callTauri<PresetSlotList>("list_preset_slots");
  },
  savePresetAs(setlistKey: string, position: number, name: string, expectedPresetName: string, expectedPosition: number, confirmOverwrite: boolean): Promise<SavePresetResult> {
    return callTauri<SavePresetResult>("save_preset_as", { setlistKey, position, name, expectedPresetName, expectedPosition, confirmOverwrite });
  },
  showTuner(shown = true): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("show_tuner", { shown });
  },
  showGigView(shown = true): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("show_gig_view", { shown });
  }
};

export const workspaceFiles = {
  saveAs(document: WorkspaceDocument, suggestedName: string): Promise<WorkspaceFileResult> {
    return callTauri<WorkspaceFileResult>("save_workspace_as", { document, suggestedName });
  },
  save(path: string, document: WorkspaceDocument): Promise<WorkspaceFileResult> {
    return callTauri<WorkspaceFileResult>("save_workspace", { path, document });
  },
  open(): Promise<WorkspaceFileResult> {
    return callTauri<WorkspaceFileResult>("open_workspace");
  }
};

export const diagnosticsFiles = {
  export(report: DiagnosticsReport): Promise<WorkspaceFileResult> {
    return callTauri<WorkspaceFileResult>("export_diagnostics", { report });
  }
};
