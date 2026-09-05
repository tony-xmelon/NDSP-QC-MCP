import { useCallback, useEffect, useRef } from "react";
import type { BlockDetails, BlockParameter, GatewayTransport, PresetSnapshot } from "@ndsp-qc/client";
import type { BlockEditorSessionController } from "./use-block-editor-session";
import type { DeviceHistoryEntry } from "./use-device-history";

type Preview = { row: number; column: number; parameterIndex: number; value: number; expectedValue: number; revision: number; expectedScene: number; expectedPresetName: string };

export interface ParameterWorkflowOptions {
  gateway: GatewayTransport;
  snapshot: PresetSnapshot;
  editor: BlockEditorSessionController;
  connected: boolean;
  pending: boolean;
  setPending(pending: boolean): void;
  reconcile(snapshot: PresetSnapshot): void;
  recordHistory(entry: DeviceHistoryEntry): void;
  notice(message: string): void;
  fail(error: unknown): void;
}

/** Shared low-latency parameter preview, coalescing, verified commit, and recovery. */
export function useParameterWorkflow(options: ParameterWorkflowOptions) {
  const { gateway, snapshot, editor, connected, pending, setPending, reconcile, recordHistory, notice, fail } = options;
  const timers = useRef(new Map<number, number>());
  const targets = useRef(new Map<number, number>());
  const clock = useRef(0);
  const revisions = useRef(new Map<number, number>());
  const previewQueue = useRef<Preview | undefined>(undefined);
  const previewRunning = useRef(false);
  const previewWaiters = useRef<Array<() => void>>([]);
  const detailsRef = useRef(editor.details);
  useEffect(() => { detailsRef.current = editor.details; }, [editor.details]);

  const resolveWaiters = useCallback(() => {
    if (previewRunning.current || previewQueue.current) return;
    for (const resolve of previewWaiters.current.splice(0)) resolve();
  }, []);

  const drainPreviews = useCallback(async () => {
    if (previewRunning.current) return;
    previewRunning.current = true;
    try {
      while (previewQueue.current) {
        const next = previewQueue.current;
        previewQueue.current = undefined;
        try { await gateway.previewParameter(next.row, next.column, next.parameterIndex, next.value, next.expectedValue, next.expectedScene, next.expectedPresetName); }
        catch { /* The verified release write owns reconciliation and errors. */ }
      }
    } finally {
      previewRunning.current = false;
      resolveWaiters();
    }
  }, [gateway, resolveWaiters]);

  const waitForPreviews = useCallback(() => !previewRunning.current && !previewQueue.current
    ? Promise.resolve()
    : new Promise<void>((resolve) => previewWaiters.current.push(resolve)), []);

  const cancel = useCallback(() => {
    clock.current += 1;
    revisions.current.clear();
    targets.current.clear();
    previewQueue.current = undefined;
    for (const timer of timers.current.values()) window.clearTimeout(timer);
    timers.current.clear();
    resolveWaiters();
  }, [resolveWaiters]);

  useEffect(() => cancel, [cancel]);

  const applyResolvedParameter = useCallback(async (
    details: BlockDetails,
    parameter: BlockParameter,
    value: number,
    reportFailure = false,
    stillCurrent: () => boolean = () => true
  ): Promise<string | undefined> => {
    if (parameter.normalizedValue === null || (pending && !reportFailure)) return;
    if (Math.abs(value - parameter.normalizedValue) < .000001) return;
    if (!connected) {
      editor.updateParameter(parameter, value);
      reconcile({ ...snapshot, dirty: true });
      const detail = `Preview: ${details.name} · ${parameter.name} adjusted.`;
      notice(detail);
      return detail;
    }
    const row = details.row;
    const column = details.column;
    setPending(true);
    notice(`Applying ${parameter.name}…`);
    try {
      const result = await gateway.setParameter(row, column, parameter.index, value, parameter.normalizedValue, snapshot.activeScene, snapshot.presetName);
      if (stillCurrent()) {
        editor.load(result.block);
        detailsRef.current = result.block;
        if (result.snapshot) reconcile(result.snapshot);
        recordHistory({ label: `${details.name} ${parameter.name}`, execute: (current) => gateway.setParameter(row, column, parameter.index, parameter.normalizedValue as number, value, snapshot.activeScene, current.presetName), redo: (current) => gateway.setParameter(row, column, parameter.index, value, parameter.normalizedValue as number, snapshot.activeScene, current.presetName) });
        notice(result.detail);
        return result.detail;
      }
    } catch (error) {
      if (reportFailure) throw error;
      if (stillCurrent()) fail(error);
    } finally {
      setPending(false);
    }
  }, [connected, editor, fail, gateway, notice, pending, reconcile, recordHistory, setPending, snapshot]);

  const apply = useCallback(async (parameter: BlockParameter, value: number, revision: number) => {
    const details = detailsRef.current;
    if (!details) return;
    const stillCurrent = () => revisions.current.get(parameter.index) === revision
      && detailsRef.current?.row === details.row
      && detailsRef.current?.column === details.column;
    await applyResolvedParameter(details, parameter, value, false, stillCurrent);
    if (stillCurrent()) targets.current.delete(parameter.index);
  }, [applyResolvedParameter]);

  const draft = useCallback((parameter: BlockParameter, value: number) => {
    const revision = ++clock.current;
    revisions.current.set(parameter.index, revision);
    targets.current.set(parameter.index, value);
    editor.draft(parameter, value);
    if (connected && !snapshot.dirty) reconcile({ ...snapshot, dirty: true });
    const continuous = !parameter.options.length && ["float", "floatwithled", "int", "fader"].includes(parameter.type.toLocaleLowerCase());
    const details = detailsRef.current;
    if (connected && continuous && details && parameter.normalizedValue !== null) {
      previewQueue.current = { row: details.row, column: details.column, parameterIndex: parameter.index, value, expectedValue: parameter.normalizedValue, revision, expectedScene: snapshot.activeScene, expectedPresetName: snapshot.presetName };
      void drainPreviews();
    }
    return revision;
  }, [connected, drainPreviews, editor, reconcile, snapshot]);

  const commit = useCallback((parameter: BlockParameter, value: number) => {
    const revision = draft(parameter, value);
    const existing = timers.current.get(parameter.index);
    if (existing !== undefined) window.clearTimeout(existing);
    timers.current.set(parameter.index, window.setTimeout(async () => {
      timers.current.delete(parameter.index);
      await waitForPreviews();
      if (revisions.current.get(parameter.index) === revision) await apply(parameter, value, revision);
    }, 8));
  }, [apply, draft, waitForPreviews]);

  const commitBatch = useCallback(async (changes: Array<{ parameter: BlockParameter; value: number }>) => {
    const details = detailsRef.current;
    if (!details || pending || !changes.length) return;
    if (!connected) {
      editor.updateParameters(changes);
      reconcile({ ...snapshot, dirty: true });
      notice(`Preview: ${details.name} parameters adjusted.`);
      return;
    }
    setPending(true);
    notice("Applying parameter changes…");
    try {
      let currentBlock = details;
      let latestSnapshot: PresetSnapshot | undefined;
      let detail = "Parameters applied and verified.";
      for (const change of changes) {
        const current = currentBlock.parameters.find((parameter) => parameter.index === change.parameter.index);
        if (!current || current.normalizedValue === null || Math.abs(current.normalizedValue - change.value) < .000001) continue;
        const result = await gateway.setParameter(currentBlock.row, currentBlock.column, current.index, change.value, current.normalizedValue, snapshot.activeScene, snapshot.presetName);
        currentBlock = result.block;
        latestSnapshot = result.snapshot ?? latestSnapshot;
        detail = result.detail;
      }
      editor.load(currentBlock);
      detailsRef.current = currentBlock;
      if (latestSnapshot) reconcile(latestSnapshot);
      notice(detail);
    } catch (error) {
      fail(error);
      try { editor.load(await gateway.blockDetails(details.row, details.column, snapshot.presetName)); } catch { /* Live state will reconcile. */ }
    } finally { setPending(false); }
  }, [connected, editor, fail, gateway, notice, pending, reconcile, setPending, snapshot]);

  const targetValue = useCallback((parameter: BlockParameter) => targets.current.get(parameter.index) ?? editor.drafts[parameter.index] ?? parameter.normalizedValue ?? 0, [editor.drafts]);
  const hasPendingChanges = useCallback(() => timers.current.size > 0 || targets.current.size > 0, []);

  return { draft, commit, commitBatch, applyResolvedParameter, cancel, targetValue, hasPendingChanges, updateDetails: (details: typeof editor.details) => { detailsRef.current = details; if (details) editor.load(details); } };
}
