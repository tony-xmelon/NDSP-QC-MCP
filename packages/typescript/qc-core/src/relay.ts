import type { AssistantAccessMode } from "./assistant-tools.ts";

export type PublicRelayState =
  | "stopped"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "pairing_required"
  | "invalid_endpoint";

export interface PublicRelayStatus {
  paired: boolean;
  state: PublicRelayState;
  accessMode: AssistantAccessMode;
  endpoint?: string;
  deviceId?: string;
}

/** Platform-neutral control plane for the authenticated outbound relay. */
export interface PublicRelayPort {
  status(): Promise<PublicRelayStatus>;
  pair(endpoint: string, pairingCode: string, deviceName?: string): Promise<PublicRelayStatus>;
  start(): Promise<void>;
  unpair(): Promise<PublicRelayStatus>;
  setAccessMode(mode: AssistantAccessMode): Promise<PublicRelayStatus>;
}
