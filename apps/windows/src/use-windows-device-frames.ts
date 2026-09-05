import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import type { NativeStateFrames, PresetSnapshot } from "@ndsp-qc/client";
import type { QcStateUpdate } from "@ndsp-qc/core";
import { consumeQcNativeStateFrame } from "@ndsp-qc/ui";

type NativeFrame = NativeStateFrames<QcStateUpdate>["frames"][number];

export interface WindowsDeviceFrameSession {
  enabled: boolean;
  sequence: MutableRefObject<number>;
  available: MutableRefObject<boolean>;
  consume(states: readonly QcStateUpdate[], observedAt?: number): unknown;
  setSnapshot: Dispatch<SetStateAction<PresetSnapshot>>;
}

/** Windows-only subscription glue; all state reduction remains in shared UI/core. */
export function useWindowsDeviceFrames({
  enabled, sequence, available, consume, setSnapshot
}: WindowsDeviceFrameSession) {
  useEffect(() => {
    if (!enabled) {
      setSnapshot((current) => current.tempoPulseEpochMs === undefined
        ? current
        : { ...current, tempoPulseEpochMs: undefined });
      return;
    }
    let disposed = false;
    let detach: (() => void) | undefined;
    void listen<NativeFrame>("qc-state-frame", ({ payload: frame }) => {
      if (!disposed) consumeQcNativeStateFrame(frame, { sequence, available, consume, setSnapshot });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else detach = unlisten;
    }).catch(() => { available.current = false; });
    return () => {
      disposed = true;
      detach?.();
    };
  }, [available, consume, enabled, sequence, setSnapshot]);
}
