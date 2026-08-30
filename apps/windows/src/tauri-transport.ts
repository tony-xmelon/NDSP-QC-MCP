import type { ConnectionState, GatewayTransport, RuntimeStatus } from "@ndsp-qc/client";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

async function callTauri<T>(command: string): Promise<T> {
  if (!window.__TAURI_INTERNALS__) {
    throw new Error("Desktop runtime is not active. Start with npm run tauri:dev.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command);
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
  }
};
