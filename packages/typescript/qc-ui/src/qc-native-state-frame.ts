import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { NativeStateFrame, PresetSnapshot } from "@ndsp-qc/client";
import { synchronizeTempoPulseEpoch, type QcStateUpdate } from "@ndsp-qc/core";

export interface QcNativeStateFrameConsumer {
  sequence: MutableRefObject<number>;
  available?: MutableRefObject<boolean>;
  consume(states: readonly QcStateUpdate[], observedAt?: number): unknown;
  setSnapshot: Dispatch<SetStateAction<PresetSnapshot>>;
}

/**
 * Apply the ordering, timestamp, and tempo-clock contract shared by every
 * native frame source. Platform adapters only subscribe to their OS event API.
 */
export function consumeQcNativeStateFrame(
  frame: NativeStateFrame<QcStateUpdate>,
  consumer: QcNativeStateFrameConsumer
): boolean {
  if (frame.sequence <= consumer.sequence.current) return false;
  if (consumer.available) consumer.available.current = true;
  consumer.sequence.current = frame.sequence;
  consumer.consume(frame.states, frame.observedAt);
  if (frame.tempoClock) {
    const tick = Math.max(0, frame.tempoClock.currentTick ?? 0);
    consumer.setSnapshot((current) => {
      const epoch = synchronizeTempoPulseEpoch(
        current.tempoPulseEpochMs, frame.observedAt, tick, current.tempo
      );
      return epoch === current.tempoPulseEpochMs
        ? current
        : { ...current, tempoPulseEpochMs: epoch };
    });
  }
  return true;
}
