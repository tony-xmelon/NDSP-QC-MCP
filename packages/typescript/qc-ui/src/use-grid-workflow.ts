import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { BlockDetails, DeviceActionResult, GatewayTransport, GridBlock, ModelEntry, PresetSnapshot } from "@ndsp-qc/client";
import { demoBlockDetails, sceneLetter } from "@ndsp-qc/core";
import type { BlockEditorSessionController } from "./use-block-editor-session";
import type { DeviceHistoryEntry } from "./use-device-history";
import type { WorkflowPrompts } from "./use-preset-workflow";

export interface GridWorkflowOptions {
  gateway: GatewayTransport;
  snapshot: PresetSnapshot;
  selectedBlockId: string;
  setSelectedBlockId: Dispatch<SetStateAction<string>>;
  editor: BlockEditorSessionController;
  connected: boolean;
  pending: boolean;
  setPending(pending: boolean): void;
  reconcile(snapshot: PresetSnapshot): void;
  recordHistory(entry: DeviceHistoryEntry): void;
  prompts: WorkflowPrompts;
  notice(message: string): void;
  fail(error: unknown): void;
  closePresetDirectory?(): void;
  onOpenManagement?(): void;
  onOpenAdd?(): void;
  onClosePanel?(): void;
}

/** Shared Grid block catalog, selection, editor, clipboard, and mutation workflow. */
export function useGridWorkflow(options: GridWorkflowOptions) {
  const {
    gateway, snapshot, selectedBlockId, setSelectedBlockId, editor, connected, pending, setPending,
    reconcile, recordHistory, prompts, notice, fail, closePresetDirectory, onOpenManagement, onOpenAdd, onClosePanel
  } = options;
  const [moveDestination, setMoveDestination] = useState<number>();
  const [footswitchDraft, setFootswitchDraft] = useState<number | null>(null);
  const [footswitchAssignmentPending, setFootswitchAssignmentPending] = useState(false);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [addCell, setAddCell] = useState("");
  const [addModelId, setAddModelId] = useState<number>();
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [clipboard, setClipboard] = useState<BlockDetails>();
  const request = useRef(0);
  const details = editor.details;

  const filteredModels = useMemo(() => {
    const query = modelFilter.trim().toLocaleLowerCase();
    return query ? models.filter((model) => `${model.name} ${model.category} ${model.basedOn ?? ""}`.toLocaleLowerCase().includes(query)) : models;
  }, [modelFilter, models]);

  const close = useCallback(() => {
    request.current += 1;
    setSelectedBlockId("");
    editor.close();
    setDetailsLoading(false);
    setMoveDestination(undefined);
    setFootswitchDraft(null);
    setFootswitchAssignmentPending(false);
    onClosePanel?.();
    notice("Parameter editor closed.");
  }, [editor, notice, onClosePanel, setSelectedBlockId]);

  const openBlock = useCallback(async (block: GridBlock) => {
    if (pending) { notice("A device command is already in progress."); return; }
    const sequence = ++request.current;
    closePresetDirectory?.();
    setFootswitchAssignmentPending(false);
    setMoveDestination(undefined);
    if (!connected) {
      const preview = demoBlockDetails(block, snapshot.activeScene);
      setSelectedBlockId(block.id);
      setFootswitchDraft(block.footswitch ?? null);
      editor.load(preview, true);
      notice(`Preview: ${block.name} parameter editor opened with the ${preview.category} control layout.`);
      return;
    }
    setDetailsLoading(true);
    notice(`Reading ${block.name} parameters…`);
    try {
      const next = await gateway.blockDetails(block.row, block.column, snapshot.presetName);
      if (sequence !== request.current) return;
      setSelectedBlockId(block.id);
      setFootswitchDraft(block.footswitch ?? null);
      editor.load(next, true);
      notice(`${next.name} parameters synchronized.`);
    } catch (error) { if (sequence === request.current) fail(error); }
    finally { if (sequence === request.current) setDetailsLoading(false); }
  }, [closePresetDirectory, connected, editor, fail, gateway, notice, pending, setSelectedBlockId, snapshot.activeScene, snapshot.presetName]);

  const openRoutingNode = useCallback(async (row: number, node: "splitter" | "mixer") => {
    if (!connected) { notice(`Connect the Quad Cortex to read the live ${node === "splitter" ? "Splitter" : "Mixer"} parameters.`); return; }
    if (pending) { notice("A device command is already in progress."); return; }
    const sequence = ++request.current;
    const column = node === "splitter" ? 8 : 9;
    const name = node === "splitter" ? "Splitter" : "Mixer";
    closePresetDirectory?.();
    setFootswitchAssignmentPending(false);
    setMoveDestination(undefined);
    setDetailsLoading(true);
    notice(`Reading ${name} parameters…`);
    try {
      const next = await gateway.blockDetails(row, column, snapshot.presetName);
      if (sequence !== request.current) return;
      setSelectedBlockId(`routing-${row}-${node}`);
      setFootswitchDraft(null);
      editor.load(next, true);
      notice(`${name} parameters synchronized.`);
    } catch (error) { if (sequence === request.current) fail(error); }
    finally { if (sequence === request.current) setDetailsLoading(false); }
  }, [closePresetDirectory, connected, editor, fail, gateway, notice, pending, setSelectedBlockId, snapshot.presetName]);

  useEffect(() => {
    if (!details || details.scene === snapshot.activeScene) return;
    if (!connected) { editor.setScene(snapshot.activeScene); return; }
    let cancelled = false;
    setDetailsLoading(true);
    void gateway.blockDetails(details.row, details.column, snapshot.presetName).then((next) => {
      if (!cancelled) {
        editor.load(next);
        notice(`${next.name} synchronized for Scene ${sceneLetter(snapshot.activeScene)}.`);
      }
    }).catch((error) => { if (!cancelled) fail(error); }).finally(() => { if (!cancelled) setDetailsLoading(false); });
    return () => { cancelled = true; };
  }, [connected, details?.column, details?.row, details?.scene, editor, fail, gateway, notice, snapshot.activeScene, snapshot.presetName]);

  const move = useCallback(async () => {
    if (!details || moveDestination === undefined || pending) return;
    const block = snapshot.blocks.find((candidate) => candidate.row === details.row && candidate.column === details.column);
    if (!connected || !block?.modelId) { notice(!connected ? "Connect the Quad Cortex before moving a block." : "Refresh the live Grid before moving this block."); return; }
    if (!await prompts.confirm(`Move “${block.name}” from row ${block.row + 1}, column ${block.column + 1} to column ${moveDestination + 1}? This is temporary until the preset is saved.`)) return;
    setPending(true);
    notice(`Moving ${block.name}…`);
    try {
      const destination = moveDestination;
      const result = await gateway.moveBlock(block.row, block.column, destination, block.modelId, snapshot.presetName);
      if (result.snapshot) reconcile(result.snapshot);
      setSelectedBlockId(`block-${block.row}-${destination}`);
      recordHistory({ label: `move ${block.name}`, execute: (current) => gateway.moveBlock(block.row, destination, block.column, block.modelId as number, current.presetName), redo: (current) => gateway.moveBlock(block.row, block.column, destination, block.modelId as number, current.presetName) });
      onClosePanel?.();
      notice(result.detail);
    } catch (error) { fail(error); }
    finally { setPending(false); }
  }, [connected, details, fail, gateway, moveDestination, notice, onClosePanel, pending, prompts, reconcile, recordHistory, setPending, setSelectedBlockId, snapshot.blocks, snapshot.presetName]);

  const assignFootswitch = useCallback(async (requested = footswitchDraft) => {
    if (!details || pending) return;
    const block = snapshot.blocks.find((candidate) => candidate.row === details.row && candidate.column === details.column);
    if (!block || requested === (block.footswitch ?? null)) return;
    if (!connected || !block.modelId) { notice(!connected ? "Connect the Quad Cortex before changing a footswitch assignment." : "Refresh the live Grid before changing this assignment."); return; }
    const target = requested === null ? "unassign it from its STOMP footswitch" : `assign it to Footswitch ${sceneLetter(requested)}`;
    if (!await prompts.confirm(`${block.name}: ${target}? This is temporary until the preset is saved.`)) return;
    setPending(true);
    notice(`Updating ${block.name} footswitch assignment…`);
    try {
      const before = block.footswitch ?? null;
      const result = await gateway.setBlockFootswitch(block.row, block.column, requested, before, block.modelId, snapshot.presetName);
      if (result.snapshot) reconcile(result.snapshot);
      setFootswitchDraft(requested);
      recordHistory({ label: `${block.name} footswitch assignment`, execute: (current) => gateway.setBlockFootswitch(block.row, block.column, before, requested, block.modelId as number, current.presetName), redo: (current) => gateway.setBlockFootswitch(block.row, block.column, requested, before, block.modelId as number, current.presetName) });
      notice(result.detail);
    } catch (error) { fail(error); }
    finally { setPending(false); }
  }, [connected, details, fail, footswitchDraft, gateway, notice, pending, prompts, reconcile, recordHistory, setPending, snapshot.blocks, snapshot.presetName]);

  const remove = useCallback(async () => {
    const block = snapshot.blocks.find((candidate) => candidate.id === selectedBlockId);
    if (!block || block.column < 0 || !block.modelId || pending) return;
    if (!connected) { notice("Connect the Quad Cortex before removing a block."); return; }
    if (!await prompts.confirm(`Remove “${block.name}” from row ${block.row + 1}, column ${block.column + 1}? This is temporary and can be restored with Discard Unsaved Changes until the preset is saved.`)) return;
    setPending(true);
    notice(`Removing ${block.name}…`);
    try {
      const removed = await gateway.blockDetails(block.row, block.column, snapshot.presetName);
      const result = await gateway.removeBlock(block.row, block.column, block.modelId, snapshot.presetName);
      if (result.snapshot) reconcile(result.snapshot);
      setSelectedBlockId("");
      editor.close();
      recordHistory({
        label: `remove ${block.name}`,
        execute: async (current) => {
          let latest = await gateway.addBlock(block.row, block.column, block.modelId as number, current.presetName);
          let working = latest.snapshot ?? current;
          const defaults = await gateway.blockDetails(block.row, block.column, working.presetName);
          for (const parameter of removed.parameters) {
            const initial = defaults.parameters.find((candidate) => candidate.index === parameter.index);
            if (!parameter.writable || parameter.normalizedValue === null || initial?.normalizedValue === null || initial?.normalizedValue === undefined || Math.abs(parameter.normalizedValue - initial.normalizedValue) < .000001) continue;
            latest = await gateway.setParameter(block.row, block.column, parameter.index, parameter.normalizedValue, initial.normalizedValue, snapshot.activeScene, working.presetName);
            working = latest.snapshot ?? working;
          }
          const restored = working.blocks.find((candidate) => candidate.row === block.row && candidate.column === block.column);
          if ((block.footswitch ?? null) !== (restored?.footswitch ?? null)) {
            latest = await gateway.setBlockFootswitch(block.row, block.column, block.footswitch ?? null, restored?.footswitch ?? null, block.modelId as number, working.presetName);
            working = latest.snapshot ?? working;
          }
          const finalBlock = working.blocks.find((candidate) => candidate.row === block.row && candidate.column === block.column);
          if ((block.bypassed ?? false) !== (finalBlock?.bypassed ?? false)) latest = await gateway.toggleBypass(block.row, block.column, snapshot.activeScene, finalBlock?.bypassed ?? false, block.bypassed ?? false, working.presetName);
          return { ...latest, detail: `Restored ${block.name} and its previous settings.` };
        },
        redo: (current) => gateway.removeBlock(block.row, block.column, block.modelId as number, current.presetName)
      });
      onClosePanel?.();
      notice(result.detail);
    } catch (error) { fail(error); }
    finally { setPending(false); }
  }, [connected, editor, fail, gateway, notice, onClosePanel, pending, prompts, reconcile, recordHistory, selectedBlockId, setPending, setSelectedBlockId, snapshot.activeScene, snapshot.blocks, snapshot.presetName]);

  const openAdd = useCallback(async () => {
    if (!connected || pending) { notice(!connected ? "Connect the Quad Cortex before adding a block." : "A device command is already in progress."); return; }
    const firstEmpty = Array.from({ length: 32 }, (_, index) => `${Math.floor(index / 8)}:${index % 8}`).find((cell) => {
      const [row, column] = cell.split(":").map(Number);
      return !snapshot.blocks.some((block) => block.row === row && block.column === column);
    });
    if (!firstEmpty) { notice("The Grid has no empty block cells."); return; }
    setAddCell(firstEmpty);
    setModelFilter("");
    onOpenAdd?.();
    if (models.length) { setAddModelId(models[0].id); return; }
    setModelsLoading(true);
    try {
      const result = await gateway.listModels();
      setModels(result.models);
      setAddModelId(result.models[0]?.id);
      notice(`${result.models.length} installed block models synchronized.`);
    } catch (error) { fail(error); }
    finally { setModelsLoading(false); }
  }, [connected, fail, gateway, models, notice, onOpenAdd, pending, snapshot.blocks]);

  const add = useCallback(async () => {
    if (!addCell || addModelId === undefined || pending) return;
    const [row, column] = addCell.split(":").map(Number);
    const model = filteredModels.find((candidate) => candidate.id === addModelId);
    if (!model) return;
    if (!await prompts.confirm(`Place “${model.name}” at row ${row + 1}, column ${column + 1}? The QC may refuse it if the preset has insufficient DSP. This is temporary until saved.`)) return;
    setPending(true);
    notice(`Placing ${model.name}…`);
    try {
      const result = await gateway.addBlock(row, column, addModelId, snapshot.presetName);
      if (result.snapshot) reconcile(result.snapshot);
      setSelectedBlockId(`block-${row}-${column}`);
      recordHistory({ label: `add ${model.name}`, execute: (current) => gateway.removeBlock(row, column, addModelId, current.presetName), redo: (current) => gateway.addBlock(row, column, addModelId, current.presetName) });
      onClosePanel?.();
      notice(result.detail);
    } catch (error) { fail(error); }
    finally { setPending(false); }
  }, [addCell, addModelId, fail, filteredModels, gateway, notice, onClosePanel, pending, prompts, reconcile, recordHistory, setPending, setSelectedBlockId, snapshot.presetName]);

  const copy = useCallback(async () => {
    const block = snapshot.blocks.find((candidate) => candidate.id === selectedBlockId && candidate.column >= 0 && candidate.modelId !== undefined);
    if (!block) { notice("Select a Grid block before copying its settings."); return; }
    try {
      const next = connected ? await gateway.blockDetails(block.row, block.column, snapshot.presetName) : demoBlockDetails(block, snapshot.activeScene);
      setClipboard(next);
      notice(`Copied ${next.name} device parameters. Paste is available on another instance of the same model.`);
    } catch (error) { fail(error); }
  }, [connected, fail, gateway, notice, selectedBlockId, snapshot.activeScene, snapshot.blocks, snapshot.presetName]);

  const paste = useCallback(async () => {
    const source = clipboard;
    const target = snapshot.blocks.find((candidate) => candidate.id === selectedBlockId && candidate.column >= 0 && candidate.modelId !== undefined);
    if (!source || !target) { notice("Copy a device and select a compatible destination before pasting."); return; }
    if (target.modelId !== source.modelId) { notice(`Settings can only be pasted to the same model. ${target.name} does not match ${source.name}.`); return; }
    if (!connected || pending) { notice(!connected ? "Connect the Quad Cortex before pasting live block settings." : "A device command is already in progress."); return; }
    setPending(true);
    notice(`Pasting ${source.name} settings to ${target.name}…`);
    try {
      const destination = await gateway.blockDetails(target.row, target.column, snapshot.presetName);
      const changes = source.parameters.flatMap((parameter) => {
        const current = destination.parameters.find((candidate) => candidate.index === parameter.index);
        return parameter.writable && parameter.normalizedValue !== null && current?.writable && current.normalizedValue !== null && Math.abs(parameter.normalizedValue - current.normalizedValue) >= .000001
          ? [{ index: parameter.index, before: current.normalizedValue, after: parameter.normalizedValue }] : [];
      });
      if (!changes.length) { notice(`${target.name} already has the copied settings.`); return; }
      const applyChanges = async (current: PresetSnapshot, reverse: boolean) => {
        let working = current;
        let last: DeviceActionResult | undefined;
        for (const change of changes) {
          const value = reverse ? change.before : change.after;
          const expected = reverse ? change.after : change.before;
          last = await gateway.setParameter(target.row, target.column, change.index, value, expected, snapshot.activeScene, working.presetName);
          working = last.snapshot ?? working;
        }
        return { ...(last as DeviceActionResult), snapshot: working, detail: `${reverse ? "Restored" : "Pasted"} ${changes.length} ${target.name} parameter${changes.length === 1 ? "" : "s"}.` };
      };
      const result = await applyChanges(snapshot, false);
      reconcile(result.snapshot ?? snapshot);
      recordHistory({ label: `paste ${source.name} device`, execute: (current) => applyChanges(current, true), redo: (current) => applyChanges(current, false) });
      if (details?.row === target.row && details.column === target.column) editor.load(await gateway.blockDetails(target.row, target.column, snapshot.presetName));
      notice(result.detail);
    } catch (error) {
      fail(error);
      try { reconcile(await gateway.currentSnapshot()); } catch { /* Live state will reconcile. */ }
    } finally { setPending(false); }
  }, [clipboard, connected, details?.column, details?.row, editor, fail, gateway, notice, pending, reconcile, recordHistory, selectedBlockId, setPending, snapshot]);

  return {
    details, detailsLoading, moveDestination, setMoveDestination, footswitchDraft, setFootswitchDraft,
    footswitchAssignmentPending, setFootswitchAssignmentPending, models, modelsLoading, modelFilter,
    setModelFilter, filteredModels, addCell, setAddCell, addModelId, setAddModelId, clipboard,
    openBlock, openRoutingNode, close, openManagement: onOpenManagement, move, assignFootswitch,
    remove, openAdd, add, copy, paste
  };
}
