import { createGatewayClientTransport, type DiagnosticsReport, type GatewayTransport, type RuntimeStatus, type WorkspaceDocument, type WorkspaceFileResult } from "@ndsp-qc/client";
import type { AssistantAccessMode } from "@ndsp-qc/core";
import { chatErrorMessage, type AntigravityModel, type ChatAttachment, type ChatCompletionRequest, type ChatCompletionResponse, type ChatQuota, type ChatSettings, type ChatSettingsUpdate, type GoogleOAuthResult } from "./model-chat";

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

export type PublicRelayState = "stopped" | "connecting" | "connected" | "reconnecting" | "pairing_required" | "invalid_endpoint";
export type ControlAccessMode = AssistantAccessMode;
export interface PublicRelayStatus {
  paired: boolean;
  state: PublicRelayState;
  accessMode: ControlAccessMode;
  endpoint?: string;
  deviceId?: string;
}

export const publicRelay = {
  status(): Promise<PublicRelayStatus> {
    return callTauri<PublicRelayStatus>("relay_status");
  },
  pair(endpoint: string, pairingCode: string, deviceName = "QC Control on Windows"): Promise<PublicRelayStatus> {
    return callTauri<PublicRelayStatus>("pair_public_relay", { endpoint, pairingCode, deviceName });
  },
  start(): Promise<void> {
    return callTauri<void>("start_public_relay");
  },
  unpair(): Promise<PublicRelayStatus> {
    return callTauri<PublicRelayStatus>("unpair_public_relay");
  },
  setAccessMode(mode: ControlAccessMode): Promise<PublicRelayStatus> {
    return callTauri<PublicRelayStatus>("set_public_relay_access_mode", { mode });
  }
};

async function callModel<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await callTauri<T>(command, args);
  } catch (error) {
    throw new Error(chatErrorMessage(error));
  }
}

export const modelChat = {
  settings(): Promise<ChatSettings> {
    return callModel<ChatSettings>("chat_settings");
  },
  updateSettings(settings: ChatSettingsUpdate): Promise<ChatSettings> {
    return callModel<ChatSettings>("update_chat_settings", { settings });
  },
  setApiKey(apiKey: string): Promise<ChatSettings> {
    return callModel<ChatSettings>("set_chat_api_key", { apiKey });
  },
  clearApiKey(): Promise<ChatSettings> {
    return callModel<ChatSettings>("clear_chat_api_key");
  },
  configureGoogleOAuthApp(clientId: string, clientSecret: string): Promise<ChatSettings> {
    return callModel<ChatSettings>("configure_google_oauth_app", { clientId, clientSecret });
  },
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return callModel<ChatCompletionResponse>("chat_with_model", { request });
  },
  quota(): Promise<ChatQuota> {
    return callModel<ChatQuota>("chat_quota");
  },
  antigravityModels(): Promise<AntigravityModel[]> {
    return callModel<AntigravityModel[]>("antigravity_models");
  },
  testConnection(): Promise<string> {
    return callModel<string>("test_chat_connection");
  },
  warm(): Promise<string> {
    return callModel<string>("warm_chat_provider");
  },
  cancel(requestId: string): Promise<void> {
    return callModel<void>("cancel_chat", { requestId });
  },
  fetchYoutubeReferenceAudio(url: string, startSeconds: number, durationSeconds: number, userConfirmedRights: boolean): Promise<{ detail: string; attachment: ChatAttachment }> {
    return callModel<{ detail: string; attachment: ChatAttachment }>("fetch_youtube_reference_audio", { url, startSeconds, durationSeconds, userConfirmedRights });
  },
  openExternalUrl(url: string): Promise<void> {
    return callModel<void>("open_external_url", { url });
  },
  connectGoogle(): Promise<GoogleOAuthResult> {
    return callModel<GoogleOAuthResult>("connect_google_oauth");
  },
  openGoogleSubscriptionSetup(): Promise<void> {
    return callModel<void>("open_google_subscription_setup");
  },
  selectGoogleProject(projectId: string): Promise<ChatSettings> {
    return callModel<ChatSettings>("select_google_project", { projectId });
  },
  disconnectGoogle(): Promise<ChatSettings> {
    return callModel<ChatSettings>("disconnect_google_oauth");
  }
};

const generatedGatewayTransport = createGatewayClientTransport<GatewayTransport>(
  <T,>(command: string, args?: Record<string, unknown>) => callTauri<T>(command, args)
);

export const tauriTransport: GatewayTransport = {
  ...generatedGatewayTransport,
  async runtimeStatus(): Promise<RuntimeStatus> {
    if (!window.__TAURI_INTERNALS__) {
      return {
        platform: "Browser preview",
        gatewayAvailable: false,
        message: "UI preview mode — the device gateway is not attached."
      };
    }
    return generatedGatewayTransport.runtimeStatus();
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
