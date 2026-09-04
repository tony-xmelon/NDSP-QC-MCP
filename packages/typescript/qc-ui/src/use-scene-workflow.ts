import { useCallback, useState } from "react";
import { QC_SCENE_COLORS, type GatewayTransport, type PresetSnapshot } from "@ndsp-qc/client";
import type { DeviceHistoryEntry } from "./use-device-history";
import type { WorkflowPrompts } from "./use-preset-workflow";

export interface SceneWorkflowOptions {
  gateway: GatewayTransport;
  snapshot: PresetSnapshot;
  connected: boolean;
  pending: boolean;
  setPending(pending: boolean): void;
  reconcile(snapshot: PresetSnapshot): void;
  recordHistory(entry: DeviceHistoryEntry): void;
  prompts: WorkflowPrompts;
  notice(message: string): void;
  fail(error: unknown): void;
  onOpen?(): void;
  onClose?(): void;
}

/** Shared scene copy/swap, label, and color workflow. */
export function useSceneWorkflow(options: SceneWorkflowOptions) {
  const { gateway, snapshot, connected, pending, setPending, reconcile, recordHistory, prompts, notice, fail, onOpen, onClose } = options;
  const [sourceScene, setSourceScene] = useState(0);
  const [destinationScene, setDestinationScene] = useState(1);
  const [swap, setSwap] = useState(false);
  const [label, setLabel] = useState(snapshot.scenes[snapshot.activeScene] ?? "");
  const [color, setColor] = useState(Math.max(0, QC_SCENE_COLORS.indexOf((snapshot.sceneColors?.[snapshot.activeScene] ?? QC_SCENE_COLORS[snapshot.activeScene]) as typeof QC_SCENE_COLORS[number])));

  const unavailable = useCallback(() => {
    if (!connected || pending) {
      notice(!connected ? "Connect the Quad Cortex before editing scenes." : "A device command is already in progress.");
      return true;
    }
    return false;
  }, [connected, notice, pending]);

  const open = useCallback(() => {
    if (unavailable()) return;
    const scene = snapshot.activeScene;
    setSourceScene(scene);
    setDestinationScene(scene === snapshot.scenes.length - 1 ? 0 : scene + 1);
    setLabel(snapshot.scenes[scene] ?? "");
    setColor(Math.max(0, QC_SCENE_COLORS.indexOf((snapshot.sceneColors?.[scene] ?? QC_SCENE_COLORS[scene]) as typeof QC_SCENE_COLORS[number])));
    onOpen?.();
  }, [onOpen, snapshot.activeScene, snapshot.sceneColors, snapshot.scenes, unavailable]);

  const commit = useCallback(async (labelText: string, action: () => ReturnType<GatewayTransport["undo"]>, history?: DeviceHistoryEntry) => {
    if (unavailable()) return;
    setPending(true);
    notice(`${labelText}…`);
    try {
      const result = await action();
      if (result.snapshot) reconcile(result.snapshot);
      if (history) recordHistory(history);
      notice(result.detail);
    } catch (error) { fail(error); }
    finally { setPending(false); }
  }, [fail, notice, reconcile, recordHistory, setPending, unavailable]);

  const copy = useCallback(async () => {
    if (sourceScene === destinationScene) { notice("Choose a different destination scene."); return; }
    const verb = swap ? "Swap" : "Copy";
    if (!await prompts.confirm(`${verb} Scene ${String.fromCharCode(65 + sourceScene)} ${swap ? "with" : "to"} Scene ${String.fromCharCode(65 + destinationScene)}? This is temporary until the preset is saved.`)) return;
    await commit(`${verb}ping scenes`, () => gateway.copyScene(sourceScene, destinationScene, swap, snapshot.presetName), {
      label: `${verb.toLocaleLowerCase()} scenes`, execute: () => gateway.undo(), redo: () => gateway.redo()
    });
  }, [commit, destinationScene, gateway, notice, prompts, snapshot.presetName, sourceScene, swap]);

  const saveLabel = useCallback(async () => {
    const next = label.trim();
    const previous = snapshot.scenes[sourceScene] ?? "";
    if (next === previous) return;
    await commit(`Updating Scene ${String.fromCharCode(65 + sourceScene)} label`, () => gateway.setSceneLabel(sourceScene, next || null, snapshot.presetName), {
      label: `Scene ${String.fromCharCode(65 + sourceScene)} label`,
      execute: (current) => gateway.setSceneLabel(sourceScene, previous || null, current.presetName),
      redo: (current) => gateway.setSceneLabel(sourceScene, next || null, current.presetName)
    });
  }, [commit, gateway, label, snapshot.presetName, snapshot.scenes, sourceScene]);

  const saveColor = useCallback(async () => {
    const previousHex = snapshot.sceneColors?.[sourceScene] ?? QC_SCENE_COLORS[sourceScene];
    const previous = Math.max(0, QC_SCENE_COLORS.indexOf(previousHex as typeof QC_SCENE_COLORS[number]));
    if (color === previous) return;
    await commit(`Updating Scene ${String.fromCharCode(65 + sourceScene)} color`, () => gateway.setSceneColor(sourceScene, color, snapshot.presetName), {
      label: `Scene ${String.fromCharCode(65 + sourceScene)} color`,
      execute: (current) => gateway.setSceneColor(sourceScene, previous, current.presetName),
      redo: (current) => gateway.setSceneColor(sourceScene, color, current.presetName)
    });
  }, [color, commit, gateway, snapshot.presetName, snapshot.sceneColors, sourceScene]);

  return { sourceScene, setSourceScene, destinationScene, setDestinationScene, swap, setSwap, label, setLabel, color, setColor, colors: QC_SCENE_COLORS, open, close: onClose, copy, saveLabel, saveColor };
}
