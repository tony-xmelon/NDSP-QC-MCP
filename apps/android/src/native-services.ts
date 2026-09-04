import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { createGatewayClientTransport, type GatewayTransport, type PresetSnapshot } from "@ndsp-qc/client";
import { createQcGatewayTransport, type AssistantAccessMode, type QcDeviceTransport, type QcStateUpdate } from "@ndsp-qc/core";

export type { QcStateUpdate } from "@ndsp-qc/core";

export type QcUsbDevice = {
  deviceId: number;
  name: string;
  manufacturer?: string;
  permission: boolean;
  interfaces: number;
};

interface GeminiNativePlugin {
  generate(options: { prompt: string; model: string }): Promise<{
    text: string;
    model: string;
    modelVersion?: string;
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    totalTokens: number;
  }>;
}

interface QcUsbNativePlugin {
  scan(): Promise<{ devices: QcUsbDevice[]; connected: boolean; synchronized: boolean }>;
  connect(): Promise<{ connected: boolean; synchronized: boolean; name: string; deviceId: number }>;
  disconnect(): Promise<void>;
  diagnostics(): Promise<{ connected: boolean; device: string; messagesReceived: number; messagesSent: number; decodeErrors: number; expectedWriteStalls: number; lastMessageType: number; connectedAt: number; setlistKnown: boolean; presetPosition: number; modelCount: number; readAttempts: number; negativeReads: number; interfaceId: number; inputEndpointAddress: number; inputMaxPacketSize: number; reportBytes: number; midiAvailable: boolean; midiInterfaceId: number; midiOutputEndpointAddress: number; lastMidiQueueDelayMs: number; maxMidiQueueDelayMs: number; lastStateAt: number; lastError?: string }>;
  gatewayInvoke(options: { method: string; params?: Record<string, unknown>; expectedState?: Record<string, unknown> }): Promise<unknown>;
  addListener(eventName: "qcStateBatch", listener: (frame: { states: QcStateUpdate[]; observedAt: number }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "qcConnection", listener: (status: { state: "available" | "disconnected"; name?: string }) => void): Promise<PluginListenerHandle>;
}

interface VoiceInputNativePlugin {
  available(): Promise<{ available: boolean }>;
  start(): Promise<{ transcript: string }>;
  stop(): Promise<void>;
  addListener(eventName: "partialResult", listener: (result: { transcript: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "voiceState", listener: (result: { state: string }) => void): Promise<PluginListenerHandle>;
}

export type RelayState = "stopped" | "connecting" | "connected" | "reconnecting" | "pairing_required" | "invalid_endpoint";
export type ControlAccessMode = AssistantAccessMode;
interface QcRelayNativePlugin {
  status(): Promise<{ paired: boolean; state: RelayState; endpoint?: string; accessMode: ControlAccessMode }>;
  pair(options: { endpoint: string; pairingCode: string; deviceName?: string }): Promise<{ paired: boolean; endpoint: string }>;
  start(): Promise<void>;
  setAccessMode(options: { mode: ControlAccessMode }): Promise<{ accessMode: ControlAccessMode }>;
  unpair(): Promise<void>;
  addListener(eventName: "relayState", listener: (result: { state: RelayState }) => void): Promise<PluginListenerHandle>;
}

export const GeminiNative = registerPlugin<GeminiNativePlugin>("Gemini");
export const QcUsbNative = registerPlugin<QcUsbNativePlugin>("QcUsb");
export const VoiceInputNative = registerPlugin<VoiceInputNativePlugin>("VoiceInput");
export const QcRelayNative = registerPlugin<QcRelayNativePlugin>("QcRelay");

export const androidGatewayTransport = createGatewayClientTransport<GatewayTransport>(
  (method, params) => QcUsbNative.gatewayInvoke({ method, params }) as Promise<never>,
  "rpc"
);

/** Android and Windows deliberately share the exact UI transport adapter. */
export function createAndroidQcTransport(currentSnapshot: () => PresetSnapshot): QcDeviceTransport {
  return createQcGatewayTransport(androidGatewayTransport, currentSnapshot);
}
