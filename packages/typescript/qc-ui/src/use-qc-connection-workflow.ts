import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { ConnectionPhase, ConnectionState } from "@ndsp-qc/client";

export type QcConnectionTransition = "absent" | "available" | "connecting" | "syncing" | "connected" | "error";

const transitionPhase: Record<QcConnectionTransition, ConnectionPhase> = {
  absent: "disconnected",
  available: "discovering",
  connecting: "opening",
  syncing: "syncing",
  connected: "ready",
  error: "needs-attention"
};

const transitionDetail: Record<QcConnectionTransition, string> = {
  absent: "Quad Cortex is not connected.",
  available: "Quad Cortex USB device is available.",
  connecting: "Opening the Quad Cortex USB session…",
  syncing: "Quad Cortex connected; synchronizing live state…",
  connected: "Quad Cortex connected.",
  error: "The Quad Cortex connection needs attention."
};

export interface QcConnectionPresentation {
  connected: boolean;
  busy: boolean;
  label: "USB" | "SYNC" | "WAIT" | "CONNECT";
  appearance: QcConnectionTransition;
}

export function qcConnectionPresentation(connection: ConnectionState): QcConnectionPresentation {
  if (connection.phase === "ready" && !connection.demo) return { connected: true, busy: false, label: "USB", appearance: "connected" };
  if (connection.phase === "syncing") return { connected: false, busy: true, label: "SYNC", appearance: "syncing" };
  if (["discovering", "opening", "handshaking"].includes(connection.phase)) return { connected: false, busy: true, label: "WAIT", appearance: connection.phase === "discovering" ? "available" : "connecting" };
  if (["needs-attention", "degraded"].includes(connection.phase)) return { connected: false, busy: false, label: "CONNECT", appearance: "error" };
  return { connected: false, busy: false, label: "CONNECT", appearance: "absent" };
}

/** Shared app-level connection state; native adapters only report transitions. */
export function useQcConnectionWorkflow(initial: ConnectionState) {
  const [connection, setConnection] = useState(initial);
  const transition = useCallback((status: QcConnectionTransition, detail = transitionDetail[status]) => {
    setConnection({ phase: transitionPhase[status], detail, demo: status !== "connected" && status !== "syncing" });
  }, []);
  const presentation = useMemo(() => qcConnectionPresentation(connection), [connection]);
  return { connection, setConnection: setConnection as Dispatch<SetStateAction<ConnectionState>>, transition, ...presentation };
}
