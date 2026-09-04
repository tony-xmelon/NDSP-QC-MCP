import { useCallback, useRef } from "react";
import type { GatewayTransport, GridBlock } from "@ndsp-qc/client";
import { recordTempoTap, sceneLetter, type QcDeviceTransport } from "@ndsp-qc/core";
import type { DeviceHistoryEntry } from "./use-device-history";
import type { QcController } from "./use-qc-controller";

export interface PerformanceWorkflowOptions {
  controller: QcController;
  transport: QcDeviceTransport;
  gateway: GatewayTransport;
  connected: boolean;
  demo: boolean;
  guardDirtyPreset?: boolean;
  recordHistory?: (entry: DeviceHistoryEntry) => void;
  onPresetChanged?: () => void;
  notice(message: string): void;
  fail(error: unknown): void;
}

/**
 * Shared controller for commands that must feel like the QC's physical surface.
 * Native hosts supply transports; optimistic state, rapid repeated input, error
 * recovery, and history semantics stay identical on Windows and Android.
 */
export function usePerformanceWorkflow(options: PerformanceWorkflowOptions) {
  const {
    controller, transport, gateway, connected, demo,
    guardDirtyPreset = true, recordHistory, onPresetChanged, notice, fail
  } = options;
  const tapTimes = useRef<number[]>([]);

  const selectScene = useCallback(async (index: number, reportFailure = false) => {
    const scene = Math.max(0, Math.min(controller.snapshotRef.current.scenes.length - 1, index));
    if (demo) {
      controller.settleCommand(controller.beginScene(scene));
      notice(`Demo: selected Scene ${sceneLetter(scene)}. Hardware was not changed.`);
      return;
    }
    if (!connected) {
      const error = new Error("Connect the Quad Cortex before selecting a scene.");
      if (reportFailure) throw error;
      notice(error.message);
      return;
    }
    try {
      const result = await controller.runScene(transport, scene);
      notice(result.detail ?? `Scene ${sceneLetter(scene)} selected.`);
    } catch (error) {
      fail(error);
      if (reportFailure) throw error;
    }
  }, [connected, controller, demo, fail, notice, transport]);

  const setBlockBypass = useCallback(async (block: GridBlock, bypassed: boolean, reportFailure = false) => {
    const previousBypassed = block.bypassed ?? false;
    if (demo) {
      controller.settleCommand(controller.beginBypass(block.id, bypassed));
      notice(`Demo: ${block.name} ${bypassed ? "bypassed" : "enabled"} locally.`);
      return;
    }
    if (!connected) {
      const error = new Error("Connect the Quad Cortex before changing bypass.");
      if (reportFailure) throw error;
      notice(error.message);
      return;
    }
    try {
      const activeScene = controller.snapshotRef.current.activeScene;
      const result = await controller.runBypass(transport, block.id, block.row, block.column, bypassed);
      recordHistory?.({
        label: `${previousBypassed ? "enable" : "bypass"} ${block.name}`,
        execute: (current) => gateway.toggleBypass(block.row, block.column, activeScene, bypassed, previousBypassed, current.presetName),
        redo: (current) => gateway.toggleBypass(block.row, block.column, activeScene, previousBypassed, bypassed, current.presetName)
      });
      notice(result.detail ?? `${block.name} ${bypassed ? "bypassed" : "enabled"}.`);
    } catch (error) {
      fail(error);
      if (reportFailure) throw error;
    }
  }, [connected, controller, demo, fail, gateway, notice, recordHistory, transport]);

  const toggleBlockBypass = useCallback((block: GridBlock, reportFailure = false) => (
    setBlockBypass(block, !(block.bypassed ?? false), reportFailure)
  ), [setBlockBypass]);

  const selectModeSlot = useCallback(async (slot: 0 | 1 | 2) => {
    const selectedMode = controller.snapshotRef.current.modeSlots?.find((entry) => entry.slot === slot)
      ?? { label: (["PRESET", "SCENE", "STOMP"] as const)[slot] };
    if (demo) {
      controller.settleCommand(controller.beginModeSlot(slot));
      notice(`Demo: ${selectedMode.label} mode selected.`);
      return;
    }
    if (!connected) {
      notice("Connect the Quad Cortex before selecting a mode.");
      return;
    }
    try {
      const result = await controller.runModeSlot(transport, slot);
      notice(result.detail ?? `${selectedMode.label} mode selected.`);
    } catch (error) {
      fail(error);
    }
  }, [connected, controller, demo, fail, notice, transport]);

  const pressFootswitch = useCallback(async (index: number) => {
    const label = sceneLetter(index);
    if (demo) {
      controller.settleCommand(controller.beginFootswitch(index));
      notice(`Demo: Footswitch ${label} activated locally; hardware was not changed.`);
      return;
    }
    if (!connected) {
      notice("Connect the Quad Cortex before pressing a footswitch.");
      return;
    }
    try {
      const before = controller.snapshotRef.current;
      const result = await controller.runFootswitch(transport, index);
      if (controller.snapshotRef.current.presetPosition !== before.presetPosition) onPresetChanged?.();
      recordHistory?.({
        label: `Footswitch ${label}`,
        execute: (current) => gateway.pressFootswitch(index, current.mode, current.presetName),
        redo: (current) => gateway.pressFootswitch(index, current.mode, current.presetName)
      });
      notice(result.detail ?? `Footswitch ${label} pressed.`);
    } catch (error) {
      fail(error);
    }
  }, [connected, controller, demo, fail, gateway, notice, onPresetChanged, recordHistory, transport]);

  const movePreset = useCallback(async (direction: -1 | 1, reportFailure = false) => {
    if (demo) {
      controller.settleCommand(controller.beginPresetMove(direction, direction > 0 ? "Next preset" : "Previous preset"));
      notice("Demo: changed preset locally; hardware was not changed.");
      return;
    }
    if (!connected) {
      const error = new Error("Connect the Quad Cortex before navigating presets.");
      if (reportFailure) throw error;
      notice(error.message);
      return;
    }
    const current = controller.snapshotRef.current;
    if (guardDirtyPreset && current.dirty) {
      const error = new Error("Save or discard the current preset changes before navigating presets.");
      if (reportFailure) throw error;
      notice(error.message);
      return;
    }
    const target = current.presetPosition + direction;
    if (target < 0 || target > 255) {
      notice(`Already at the ${direction > 0 ? "last" : "first"} preset.`);
      return;
    }
    try {
      const result = await controller.runPresetMove(transport, direction);
      onPresetChanged?.();
      notice(result.detail ?? "Preset recalled.");
    } catch (error) {
      fail(error);
      if (reportFailure) throw error;
    }
  }, [connected, controller, demo, fail, guardDirtyPreset, notice, onPresetChanged, transport]);

  const navigateBank = useCallback(async (direction: -1 | 1, reportFailure = false): Promise<string | undefined> => {
    if (demo || !connected) {
      const error = new Error("Connect the Quad Cortex before navigating banks.");
      if (reportFailure) throw error;
      notice(error.message);
      return undefined;
    }
    try {
      const current = controller.snapshotRef.current;
      const result = await gateway.navigateBank(direction, current.presetName, current.presetPosition);
      if (result.snapshot) controller.setSnapshot(result.snapshot);
      onPresetChanged?.();
      notice(result.detail);
      return result.detail;
    } catch (error) {
      fail(error);
      if (reportFailure) throw error;
      return undefined;
    }
  }, [connected, controller, demo, fail, gateway, notice, onPresetChanged]);

  const tapTempo = useCallback(async () => {
    const result = recordTempoTap(tapTimes.current, performance.now());
    tapTimes.current = result.taps;
    const token = result.bpm === undefined ? undefined : controller.beginTempo(result.bpm);
    if (demo) {
      if (token) controller.settleCommand(token);
      notice(result.bpm === undefined ? "Tap again to set the tempo." : `Demo: tempo ${result.bpm} BPM.`);
      return;
    }
    if (!connected) {
      if (token) controller.failCommand(token);
      notice("Connect the Quad Cortex before sending Tap Tempo.");
      return;
    }
    try {
      const sent = await transport.tapTempo(controller.snapshotRef.current);
      notice(sent.detail ?? "Tap Tempo sent.");
    } catch (error) {
      if (token) controller.failCommand(token);
      fail(error);
    }
  }, [connected, controller, demo, fail, notice, transport]);

  const showDeviceView = useCallback(async (view: "tuner" | "gig") => {
    if (demo || !connected) {
      notice(`Connect the Quad Cortex before opening ${view === "tuner" ? "the tuner" : "Gig View"}.`);
      return;
    }
    try {
      const current = controller.snapshotRef.current;
      const result = view === "tuner" ? await transport.setTuner(true, current) : await transport.setGigView(true, current);
      notice(result.detail ?? `${view === "tuner" ? "Tuner" : "Gig View"} opened.`);
    } catch (error) {
      fail(error);
    }
  }, [connected, controller, demo, fail, notice, transport]);

  return { selectScene, setBlockBypass, toggleBlockBypass, selectModeSlot, pressFootswitch, movePreset, navigateBank, tapTempo, showDeviceView };
}
