import type { ConnectionState, DeviceActionResult, GatewayTransport, RuntimeStatus } from "@ndsp-qc/client";

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
  currentSnapshot(): Promise<import("@ndsp-qc/client").PresetSnapshot> {
    return callTauri<import("@ndsp-qc/client").PresetSnapshot>("current_snapshot");
  },
  selectScene(scene: number, expectedPresetName: string): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("select_scene", { scene, expectedPresetName });
  },
  toggleBypass(row: number, column: number, expectedScene: number, expectedPresetName: string): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("toggle_bypass", { row, column, expectedScene, expectedPresetName });
  },
  showTuner(shown = true): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("show_tuner", { shown });
  },
  showGigView(shown = true): Promise<DeviceActionResult> {
    return callTauri<DeviceActionResult>("show_gig_view", { shown });
  }
};
