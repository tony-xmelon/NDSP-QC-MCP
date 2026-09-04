import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { PresetSnapshot } from "@ndsp-qc/client";
import { QcCommandCoordinator, type QcAssistantDeviceCommand, type QcCommandResult, type QcCommandToken, type QcDeviceTransport, type QcStateUpdate } from "@ndsp-qc/core";

export interface QcController {
  snapshot: PresetSnapshot;
  snapshotRef: MutableRefObject<PresetSnapshot>;
  setSnapshot: Dispatch<SetStateAction<PresetSnapshot>>;
  updateSnapshot(transform: (current: PresetSnapshot) => PresetSnapshot): void;
  beginScene(scene: number): QcCommandToken;
  beginPresetMove(delta: -1 | 1, name?: string): QcCommandToken;
  beginModeSlot(slot: 0 | 1 | 2): QcCommandToken;
  beginTempo(tempo: number): QcCommandToken;
  beginBypass(blockId: string, bypassed: boolean): QcCommandToken;
  beginFootswitch(index: number): QcCommandToken;
  failCommand(token: QcCommandToken): void;
  settleCommand(token: QcCommandToken): void;
  resetCommands(): void;
  reconcileFrame(states: readonly QcStateUpdate[], now?: number): { snapshot: PresetSnapshot; states: QcStateUpdate[] };
  reconcileSnapshot(incoming: PresetSnapshot, observedAt?: number, now?: number): PresetSnapshot;
  runScene(transport: QcDeviceTransport, scene: number): Promise<QcCommandResult>;
  runPresetMove(transport: QcDeviceTransport, delta: -1 | 1, name?: string): Promise<QcCommandResult>;
  runModeSlot(transport: QcDeviceTransport, slot: 0 | 1 | 2): Promise<QcCommandResult>;
  runTempo(transport: QcDeviceTransport, tempo: number): Promise<QcCommandResult>;
  runBypass(transport: QcDeviceTransport, blockId: string, row: number, column: number, bypassed: boolean): Promise<QcCommandResult>;
  runFootswitch(transport: QcDeviceTransport, index: number): Promise<QcCommandResult>;
  runAssistantCommand(transport: QcDeviceTransport, command: QcAssistantDeviceCommand): Promise<QcCommandResult>;
}

/** Shared realtime React controller used by every QC application shell. */
export function useQcController(initialSnapshot: PresetSnapshot): QcController {
  const [snapshot, commitReactSnapshot] = useState(initialSnapshot);
  const snapshotRef = useRef(initialSnapshot);
  const coordinatorRef = useRef<QcCommandCoordinator | null>(null);
  const presetMoveQueueRef = useRef<Array<{
    transport: QcDeviceTransport;
    delta: -1 | 1;
    expected: PresetSnapshot;
    token: QcCommandToken;
    resolve: (result: QcCommandResult) => void;
    reject: (error: unknown) => void;
  }>>([]);
  const presetMoveRunningRef = useRef(false);
  if (!coordinatorRef.current) coordinatorRef.current = new QcCommandCoordinator();

  // React may batch state changes while native frames continue arriving. Keep
  // the imperative reference authoritative and commit both in one operation.
  const setSnapshot = useCallback<Dispatch<SetStateAction<PresetSnapshot>>>((action) => {
    const next = typeof action === "function" ? action(snapshotRef.current) : action;
    snapshotRef.current = next;
    commitReactSnapshot(next);
  }, []);

  const updateSnapshot = useCallback((transform: (current: PresetSnapshot) => PresetSnapshot) => {
    setSnapshot(transform);
  }, [setSnapshot]);

  const begin = useCallback((command: { snapshot: PresetSnapshot; token: QcCommandToken }) => {
    setSnapshot(command.snapshot);
    return command.token;
  }, [setSnapshot]);

  const beginScene = useCallback((scene: number) => begin(coordinatorRef.current!.beginScene(snapshotRef.current, scene)), [begin]);
  const beginPresetMove = useCallback((delta: -1 | 1, name?: string) => begin(coordinatorRef.current!.beginPresetMove(snapshotRef.current, delta, name)), [begin]);
  const beginModeSlot = useCallback((slot: 0 | 1 | 2) => begin(coordinatorRef.current!.beginModeSlot(snapshotRef.current, slot)), [begin]);
  const beginTempo = useCallback((tempo: number) => begin(coordinatorRef.current!.beginTempo(snapshotRef.current, tempo)), [begin]);
  const beginBypass = useCallback((blockId: string, bypassed: boolean) => begin(coordinatorRef.current!.beginBypass(snapshotRef.current, blockId, bypassed)), [begin]);
  const beginFootswitch = useCallback((index: number) => begin(coordinatorRef.current!.beginFootswitch(snapshotRef.current, index)), [begin]);

  const failCommand = useCallback((token: QcCommandToken) => {
    setSnapshot((current) => coordinatorRef.current!.fail(current, token));
  }, [setSnapshot]);
  const settleCommand = useCallback((token: QcCommandToken) => coordinatorRef.current!.settle(token), []);
  const resetCommands = useCallback(() => coordinatorRef.current!.reset(), []);

  const reconcileFrame = useCallback((states: readonly QcStateUpdate[], now?: number) => {
    const reduced = coordinatorRef.current!.reconcileFrame(snapshotRef.current, states, now);
    if (reduced.states.length) setSnapshot(reduced.snapshot);
    return reduced;
  }, [setSnapshot]);

  const reconcileSnapshot = useCallback((incoming: PresetSnapshot, observedAt?: number, now?: number) => (
    coordinatorRef.current!.reconcileSnapshot(incoming, observedAt, now)
  ), []);

  const runCommand = useCallback(async (
    preview: () => QcCommandToken,
    send: (expected: PresetSnapshot) => Promise<QcCommandResult>
  ): Promise<QcCommandResult> => {
    const expected = snapshotRef.current;
    const token = preview();
    try {
      const result = await send(expected);
      if (result.snapshot) setSnapshot(coordinatorRef.current!.reconcileSnapshot(result.snapshot));
      return result;
    } catch (error) {
      setSnapshot((current) => coordinatorRef.current!.fail(current, token));
      throw error;
    }
  }, [setSnapshot]);

  const runScene = useCallback((transport: QcDeviceTransport, scene: number) => runCommand(
    () => beginScene(scene),
    (expected) => transport.selectScene(scene, expected)
  ), [beginScene, runCommand]);
  const runPresetMove = useCallback((transport: QcDeviceTransport, delta: -1 | 1, name?: string): Promise<QcCommandResult> => {
    const expected = snapshotRef.current;
    const token = beginPresetMove(delta, name);
    const promise = new Promise<QcCommandResult>((resolve, reject) => {
      presetMoveQueueRef.current.push({ transport, delta, expected, token, resolve, reject });
    });
    if (!presetMoveRunningRef.current) {
      presetMoveRunningRef.current = true;
      void (async () => {
        while (presetMoveQueueRef.current.length) {
          const entry = presetMoveQueueRef.current[0];
          try {
            const result = await entry.transport.movePreset(entry.delta, entry.expected);
            if (result.snapshot) setSnapshot(coordinatorRef.current!.reconcileSnapshot(result.snapshot));
            presetMoveQueueRef.current.shift();
            entry.resolve(result);
          } catch (error) {
            const failed = presetMoveQueueRef.current.splice(0);
            setSnapshot((current) => failed.reduce(
              (state, pending) => coordinatorRef.current!.fail(state, pending.token),
              current
            ));
            for (const pending of failed) pending.reject(error);
          }
        }
        presetMoveRunningRef.current = false;
      })();
    }
    return promise;
  }, [beginPresetMove, setSnapshot]);
  const runModeSlot = useCallback((transport: QcDeviceTransport, slot: 0 | 1 | 2) => runCommand(
    () => beginModeSlot(slot),
    (expected) => transport.selectModeSlot(slot, expected)
  ), [beginModeSlot, runCommand]);
  const runTempo = useCallback((transport: QcDeviceTransport, tempo: number) => runCommand(
    () => beginTempo(tempo),
    (expected) => transport.setTempo(tempo, expected)
  ), [beginTempo, runCommand]);
  const runBypass = useCallback((transport: QcDeviceTransport, blockId: string, row: number, column: number, bypassed: boolean) => runCommand(
    () => beginBypass(blockId, bypassed),
    (expected) => transport.setBypass(row, column, bypassed, expected)
  ), [beginBypass, runCommand]);
  const runFootswitch = useCallback((transport: QcDeviceTransport, index: number) => runCommand(
    () => beginFootswitch(index),
    (expected) => transport.pressFootswitch(index, expected)
  ), [beginFootswitch, runCommand]);
  const runAssistantCommand = useCallback((transport: QcDeviceTransport, command: QcAssistantDeviceCommand) => {
    if (command.kind === "scene") return runScene(transport, command.scene);
    if (command.kind === "preset-step") return runPresetMove(transport, command.delta);
    if (command.kind === "tempo") return runTempo(transport, command.bpm);
    if (command.kind === "bypass") return runBypass(transport, command.blockId, command.row, command.column, command.bypassed);
    return command.view === "tuner"
      ? transport.setTuner(command.show, snapshotRef.current)
      : transport.setGigView(command.show, snapshotRef.current);
  }, [runBypass, runPresetMove, runScene, runTempo]);

  return {
    snapshot,
    snapshotRef,
    setSnapshot,
    updateSnapshot,
    beginScene,
    beginPresetMove,
    beginModeSlot,
    beginTempo,
    beginBypass,
    beginFootswitch,
    failCommand,
    settleCommand,
    resetCommands,
    reconcileFrame,
    reconcileSnapshot,
    runScene,
    runPresetMove,
    runModeSlot,
    runTempo,
    runBypass,
    runFootswitch,
    runAssistantCommand
  };
}
