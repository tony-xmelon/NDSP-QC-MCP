import { useCallback, useEffect, useRef } from "react";
import type { GatewayTransport, PresetSnapshot } from "@ndsp-qc/client";
import type { DeviceHistoryEntry } from "./use-device-history";
import type { QcController } from "./use-qc-controller";

type TempoSource = "Encoder" | "Tap";

export interface ContinuousControlWorkflowOptions {
  controller: QcController;
  gateway: GatewayTransport;
  connected: boolean;
  demo: boolean;
  reconcile(snapshot: PresetSnapshot): void;
  recordHistory?(entry: DeviceHistoryEntry): void;
  notice(message: string): void;
  fail(error: unknown): void;
}

type TempoQueue = {
  timer?: number;
  running: boolean;
  expected?: number;
  original?: number;
  target?: number;
  source: TempoSource;
  token?: ReturnType<QcController["beginTempo"]>;
};

type VolumeQueue = {
  timer?: number;
  running: boolean;
  expected?: number;
  target?: number;
};

/** Coalesced realtime encoders with one in-flight write and latest-value wins. */
export function useContinuousControlWorkflow(options: ContinuousControlWorkflowOptions) {
  const { controller, gateway, connected, demo, reconcile, recordHistory, notice, fail } = options;
  const tempo = useRef<TempoQueue>({ running: false, source: "Encoder" });
  const volume = useRef<VolumeQueue>({ running: false });

  const drainTempo = useCallback(async () => {
    const queue = tempo.current;
    if (queue.running || queue.target === undefined || queue.expected === undefined) return;
    queue.running = true;
    if (queue.timer !== undefined) window.clearTimeout(queue.timer);
    queue.timer = undefined;
    try {
      while (queue.target !== undefined) {
        const target = queue.target;
        const expected = queue.expected;
        const source = queue.source;
        queue.target = undefined;
        const result = await gateway.setTempo(target, expected, controller.snapshotRef.current.presetName);
        queue.expected = result.snapshot?.tempo ?? target;
        if (result.snapshot) reconcile(controller.reconcileSnapshot(result.snapshot));
        notice(result.detail ?? `${source} tempo set to ${target} BPM and verified on the Quad Cortex.`);
      }
      const original = queue.original;
      const finalValue = queue.expected;
      if (original !== undefined && finalValue !== undefined && original !== finalValue) {
        recordHistory?.({
          label: "tempo change",
          execute: (current) => gateway.setTempo(original, finalValue, current.presetName),
          redo: (current) => gateway.setTempo(finalValue, original, current.presetName)
        });
      }
    } catch (error) {
      if (queue.token) controller.failCommand(queue.token);
      fail(error);
      try { reconcile(controller.reconcileSnapshot(await gateway.currentSnapshot())); } catch { /* Preserve the command error. */ }
    } finally {
      queue.running = false;
      if (queue.target !== undefined) {
        queue.timer = window.setTimeout(() => void drainTempo(), 0);
      } else {
        queue.expected = undefined;
        queue.original = undefined;
      }
    }
  }, [controller, fail, gateway, notice, reconcile, recordHistory]);

  const queueTempo = useCallback((requestedBpm: number, source: TempoSource = "Encoder") => {
    const bpm = Math.max(40, Math.min(240, Math.round(requestedBpm)));
    if (demo) {
      controller.settleCommand(controller.beginTempo(bpm));
      notice(`Demo: ${source.toLocaleLowerCase()} tempo ${bpm} BPM.`);
      return;
    }
    if (!connected) { notice("Connect the Quad Cortex before changing tempo."); return; }
    const queue = tempo.current;
    if (queue.expected === undefined) {
      queue.expected = controller.snapshotRef.current.tempo;
      queue.original = queue.expected;
    }
    queue.target = bpm;
    queue.source = source;
    queue.token = controller.beginTempo(bpm);
    notice(`${source} tempo: ${bpm} BPM…`);
    if (queue.timer !== undefined) window.clearTimeout(queue.timer);
    if (!queue.running) queue.timer = window.setTimeout(() => void drainTempo(), source === "Tap" ? 180 : 40);
  }, [connected, controller, demo, drainTempo, notice]);

  const adjustTempo = useCallback((delta: number) => {
    queueTempo((tempo.current.target ?? controller.snapshotRef.current.tempo) + delta, "Encoder");
  }, [controller, queueTempo]);

  const drainVolume = useCallback(async () => {
    const queue = volume.current;
    if (queue.running || queue.target === undefined || queue.expected === undefined) return;
    queue.running = true;
    if (queue.timer !== undefined) window.clearTimeout(queue.timer);
    queue.timer = undefined;
    try {
      while (queue.target !== undefined) {
        const target = queue.target;
        const expected = queue.expected;
        queue.target = undefined;
        const result = await gateway.setMasterVolume(target, expected);
        queue.expected = result.snapshot?.masterVolume ?? target;
        if (result.snapshot) reconcile(result.snapshot);
        notice(result.detail ?? `Master Volume set to ${target}.`);
      }
    } catch (error) {
      fail(error);
      try { reconcile(await gateway.currentSnapshot()); } catch { /* Preserve the command error. */ }
    } finally {
      queue.running = false;
      if (queue.target !== undefined) queue.timer = window.setTimeout(() => void drainVolume(), 0);
      else queue.expected = undefined;
    }
  }, [fail, gateway, notice, reconcile]);

  const adjustMasterVolume = useCallback((delta: number) => {
    const value = Math.max(0, Math.min(100, Math.round((volume.current.target ?? controller.snapshotRef.current.masterVolume) + delta)));
    if (demo) {
      reconcile({ ...controller.snapshotRef.current, masterVolume: value });
      notice(`Demo: Master Volume ${value}.`);
      return;
    }
    if (!connected) { notice("Connect the Quad Cortex before changing Master Volume."); return; }
    const queue = volume.current;
    if (queue.expected === undefined) queue.expected = controller.snapshotRef.current.masterVolume;
    queue.target = value;
    reconcile({ ...controller.snapshotRef.current, masterVolume: value });
    notice(`Master Volume: ${value}…`);
    if (queue.timer !== undefined) window.clearTimeout(queue.timer);
    if (!queue.running) queue.timer = window.setTimeout(() => void drainVolume(), 40);
  }, [connected, controller, demo, drainVolume, notice, reconcile]);

  const cancel = useCallback(() => {
    if (tempo.current.timer !== undefined) window.clearTimeout(tempo.current.timer);
    if (volume.current.timer !== undefined) window.clearTimeout(volume.current.timer);
    tempo.current.timer = undefined;
    tempo.current.target = undefined;
    volume.current.timer = undefined;
    volume.current.target = undefined;
  }, []);

  useEffect(() => cancel, [cancel]);
  return { queueTempo, adjustTempo, adjustMasterVolume, cancel };
}
