import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { GatewayTransport, PresetEntry, PresetList, PresetSnapshot, SavePresetResult } from "@ndsp-qc/client";
import type { PresetDirectoryState } from "./quad-cortex-surface";

export type PresetClipboard = Pick<PresetSnapshot,
  "setlistKey" | "setlistName" | "presetPosition" | "presetLocation" | "presetName"
>;

export interface WorkflowPrompts {
  confirm(message: string): boolean | Promise<boolean>;
  prompt(message: string, initialValue: string): string | null | Promise<string | null>;
}

export interface UsePresetWorkflowOptions {
  gateway: GatewayTransport;
  snapshotRef: MutableRefObject<PresetSnapshot>;
  setSnapshot: Dispatch<SetStateAction<PresetSnapshot>>;
  connected: boolean;
  pending: boolean;
  setPending: Dispatch<SetStateAction<boolean>>;
  prompts: WorkflowPrompts;
  notice(message: string): void;
  fail(error: unknown): void;
  onPresetChanged?(snapshot: PresetSnapshot): void;
}

export interface PresetWorkflowController {
  presetList?: PresetList;
  directoryOpen: boolean;
  directoryLoading: boolean;
  saveOpen: boolean;
  saveName: string;
  clipboard?: PresetClipboard;
  openDirectory(refresh?: boolean): Promise<void>;
  closeDirectory(): void;
  loadDirectory(refresh?: boolean, setlistKey?: string, quiet?: boolean): Promise<PresetList | undefined>;
  recall(entry: PresetEntry): Promise<void>;
  recallLocation(location: string): Promise<string>;
  reload(): Promise<void>;
  openSave(): void;
  closeSave(): void;
  setSaveName(name: string): void;
  save(): Promise<void>;
  saveCurrentUnsaved(name: string): Promise<string>;
  copy(): void;
  paste(): Promise<void>;
  rename(suggestedName?: string): Promise<void>;
  refresh(): Promise<void>;
  commitSavedPreset(result: SavePresetResult): PresetSnapshot;
  resetCache(): void;
  directoryProps: PresetDirectoryState;
  saveProps: {
    open: boolean;
    name: string;
    disabled: boolean;
    onNameChange(name: string): void;
    onSave(): void;
    onCancel(): void;
  };
}

/**
 * Shared preset-library and persistent-preset controller.
 *
 * Windows and Android provide only their gateway, connection state, prompts,
 * and presentation callbacks. All validation, sequencing, loading, clipboard,
 * and authoritative snapshot reconciliation lives here.
 */
export function usePresetWorkflow(options: UsePresetWorkflowOptions): PresetWorkflowController {
  const {
    gateway, snapshotRef, setSnapshot, connected, pending, setPending,
    prompts, notice, fail, onPresetChanged
  } = options;
  const [presetList, setPresetList] = useState<PresetList>();
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [presetListLoading, setPresetListLoading] = useState(false);
  const [presetFoldersLoading, setPresetFoldersLoading] = useState(false);
  const [presetFoldersPending, setPresetFoldersPending] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [clipboard, setClipboard] = useState<PresetClipboard>();
  const loadSequence = useRef(0);
  const foldersLoaded = useRef(false);

  const unavailable = useCallback((action: string) => {
    if (!connected) {
      notice(`Connect the Quad Cortex before ${action}.`);
      return true;
    }
    if (pending) {
      notice("A device command is already in progress.");
      return true;
    }
    return false;
  }, [connected, notice, pending]);

  const commitPreset = useCallback((next: PresetSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
    onPresetChanged?.(next);
  }, [onPresetChanged, setSnapshot, snapshotRef]);

  const commitSavedPreset = useCallback((result: SavePresetResult) => {
    const next = {
      ...(result.snapshot ?? snapshotRef.current),
      presetName: result.savedName,
      dirty: false
    };
    commitPreset(next);
    setPresetList((current) => current && current.setlistKey === next.setlistKey
      ? {
          ...current,
          currentPosition: next.presetPosition,
          presets: current.presets.map((entry) => entry.position === next.presetPosition
            ? { ...entry, name: result.savedName }
            : entry)
        }
      : current);
    return next;
  }, [commitPreset, snapshotRef]);

  const loadDirectory = useCallback(async (refresh = false, setlistKey?: string, quiet = false) => {
    const sequence = ++loadSequence.current;
    setPresetListLoading(true);
    try {
      const list = await gateway.listPresets(refresh, setlistKey);
      if (sequence === loadSequence.current) setPresetList(list);
      return list;
    } catch (error) {
      if (!quiet) fail(error);
      return undefined;
    } finally {
      if (sequence === loadSequence.current) setPresetListLoading(false);
    }
  }, [fail, gateway]);

  const loadFolders = useCallback(async (refresh = false, quiet = false) => {
    setPresetFoldersLoading(true);
    try {
      const result = await gateway.listPresetFolders(refresh);
      foldersLoaded.current = !result.loading;
      setPresetFoldersPending(Boolean(result.loading));
      setPresetList((current) => current ? { ...current, folders: result.folders } : current);
    } catch (error) {
      if (!quiet) fail(error);
    } finally {
      setPresetFoldersLoading(false);
    }
  }, [fail, gateway]);

  useEffect(() => {
    if (!directoryOpen || presetListLoading || !presetList?.loading) return;
    const timer = window.setTimeout(() => void loadDirectory(false, presetList.setlistKey, true), 400);
    return () => window.clearTimeout(timer);
  }, [directoryOpen, loadDirectory, presetList?.loading, presetList?.setlistKey, presetListLoading]);

  useEffect(() => {
    if (!directoryOpen || presetFoldersLoading || !presetFoldersPending) return;
    const timer = window.setTimeout(() => void loadFolders(false, true), 400);
    return () => window.clearTimeout(timer);
  }, [directoryOpen, loadFolders, presetFoldersLoading, presetFoldersPending]);

  const openDirectory = useCallback(async (refresh = false) => {
    if (unavailable("opening its preset browser")) return;
    setDirectoryOpen(true);
    if (refresh || !presetList || presetList.setlistKey !== snapshotRef.current.setlistKey) {
      await loadDirectory(refresh, snapshotRef.current.setlistKey);
    }
    if (refresh || !foldersLoaded.current) void loadFolders(refresh);
  }, [loadDirectory, loadFolders, presetList, snapshotRef, unavailable]);

  const recall = useCallback(async (entry: PresetEntry) => {
    const current = snapshotRef.current;
    if (!presetList || entry.position === current.presetPosition || unavailable("recalling a preset")) return;
    setPending(true);
    notice(`Recalling ${entry.location} · ${entry.name}…`);
    try {
      const result = await gateway.recallPreset(presetList.setlistKey, entry.position, current.presetName, current.presetPosition);
      if (result.snapshot) commitPreset(result.snapshot);
      notice(result.detail ?? `${entry.location} · ${entry.name} recalled.`);
      setDirectoryOpen(false);
    } catch (error) {
      fail(error);
    } finally {
      setPending(false);
    }
  }, [commitPreset, fail, gateway, notice, presetList, setPending, snapshotRef, unavailable]);

  const recallLocation = useCallback(async (location: string): Promise<string> => {
    const current = snapshotRef.current;
    if (!connected) throw new Error("Connect the Quad Cortex before recalling a preset.");
    if (pending) throw new Error("A device command is already in progress.");
    const list = presetList?.setlistKey === current.setlistKey && !presetList.loading
      ? presetList
      : await gateway.listPresets(false, current.setlistKey);
    const entry = list.presets.find((candidate) => candidate.location.toUpperCase() === location.toUpperCase());
    if (!entry) throw new Error(`${location.toUpperCase()} is empty in ${list.setlistName}.`);
    if (entry.position === current.presetPosition) return `${entry.location} · ${entry.name} is already active.`;
    setPending(true);
    try {
      const result = await gateway.recallPreset(list.setlistKey, entry.position, current.presetName, current.presetPosition);
      if (result.snapshot) commitPreset(result.snapshot);
      setDirectoryOpen(false);
      return result.detail ?? `${entry.location} · ${entry.name} recalled.`;
    } finally {
      setPending(false);
    }
  }, [commitPreset, connected, gateway, pending, presetList, setPending, snapshotRef]);

  const reload = useCallback(async () => {
    const current = snapshotRef.current;
    if (unavailable("discarding preset changes")) return;
    if (!await prompts.confirm(`Discard all unsaved changes to ${current.presetLocation} · ${current.presetName} and reload it from the Quad Cortex?`)) return;
    setPending(true);
    notice("Reloading the stored preset…");
    try {
      const result = await gateway.reloadPreset(current.presetName, current.presetPosition);
      if (result.snapshot) commitPreset(result.snapshot);
      notice(result.detail ?? "Stored preset reloaded.");
    } catch (error) {
      fail(error);
    } finally {
      setPending(false);
    }
  }, [commitPreset, fail, gateway, notice, prompts, setPending, snapshotRef, unavailable]);

  const openSave = useCallback(() => {
    if (unavailable("saving a preset")) return;
    setDirectoryOpen(false);
    setSaveName(snapshotRef.current.presetName === "Unsaved" ? "" : snapshotRef.current.presetName);
    setSaveOpen(true);
  }, [snapshotRef, unavailable]);

  const save = useCallback(async () => {
    const current = snapshotRef.current;
    const name = saveName.trim();
    if (!saveOpen || !name || unavailable("saving a preset")) return;
    setPending(true);
    notice(`Saving preset to ${current.presetLocation}…`);
    try {
      const result = await gateway.savePresetAs(
        current.setlistKey,
        current.presetPosition,
        name,
        current.presetName,
        current.presetPosition,
        current.presetName !== "Unsaved"
      );
      commitSavedPreset(result);
      notice(result.detail ?? `${current.presetLocation} saved.`);
      setSaveOpen(false);
    } catch (error) {
      fail(error);
    } finally {
      setPending(false);
    }
  }, [commitSavedPreset, fail, gateway, notice, saveName, saveOpen, setPending, snapshotRef, unavailable]);

  const saveCurrentUnsaved = useCallback(async (requestedName: string): Promise<string> => {
    const current = snapshotRef.current;
    const name = requestedName.trim();
    if (!connected) throw new Error("Connect the Quad Cortex before saving a device preset.");
    if (pending) throw new Error("A device command is already in progress.");
    if (!name) throw new Error("A preset name is required for device save.");
    if (current.presetName !== "Unsaved") throw new Error("The active preset is already stored. Use Save As or Rename for an occupied slot.");
    setPending(true);
    notice(`Saving preset to ${current.presetLocation}…`);
    try {
      const result = await gateway.savePresetAs(
        current.setlistKey,
        current.presetPosition,
        name,
        current.presetName,
        current.presetPosition,
        false
      );
      commitSavedPreset(result);
      const detail = result.detail ?? `${current.presetLocation} saved.`;
      notice(detail);
      return detail;
    } finally {
      setPending(false);
    }
  }, [commitSavedPreset, connected, gateway, notice, pending, setPending, snapshotRef]);

  const copy = useCallback(() => {
    const current = snapshotRef.current;
    if (unavailable("copying a preset")) return;
    if (current.dirty) {
      notice("Save or discard the current changes before copying this preset.");
      return;
    }
    if (current.presetName === "Unsaved") {
      notice("The current slot does not contain a stored preset to copy.");
      return;
    }
    setClipboard({
      setlistKey: current.setlistKey,
      setlistName: current.setlistName,
      presetPosition: current.presetPosition,
      presetLocation: current.presetLocation,
      presetName: current.presetName
    });
    notice(`Copied preset ${current.presetLocation} · ${current.presetName}. Navigate to a user preset slot and choose Paste Preset.`);
  }, [notice, snapshotRef, unavailable]);

  const paste = useCallback(async () => {
    const current = snapshotRef.current;
    if (!clipboard) {
      notice("Copy a stored preset before pasting.");
      return;
    }
    if (unavailable("pasting a preset")) return;
    if (current.dirty) {
      notice("Save or discard the destination's unsaved changes before pasting a preset.");
      return;
    }
    if (clipboard.setlistKey === current.setlistKey && clipboard.presetPosition === current.presetPosition) {
      notice("The copied preset is already loaded in this slot.");
      return;
    }
    if (!await prompts.confirm(`Replace ${current.presetLocation} · ${current.presetName} with a copy of ${clipboard.presetLocation} · ${clipboard.presetName}? This overwrites the stored destination preset.`)) return;
    setPending(true);
    notice(`Copying ${clipboard.presetLocation} · ${clipboard.presetName} to ${current.presetLocation}…`);
    try {
      const result = await gateway.copyPreset(
        clipboard.setlistKey,
        clipboard.presetPosition,
        clipboard.presetName,
        current.setlistKey,
        current.presetPosition,
        current.presetName,
        current.presetPosition,
        true
      );
      commitSavedPreset(result);
      await loadDirectory(true, current.setlistKey, true);
      notice(result.detail ?? `${current.presetLocation} replaced.`);
    } catch (error) {
      fail(error);
    } finally {
      setPending(false);
    }
  }, [clipboard, commitSavedPreset, fail, gateway, loadDirectory, notice, prompts, setPending, snapshotRef, unavailable]);

  const rename = useCallback(async (suggestedName = snapshotRef.current.presetName) => {
    const current = snapshotRef.current;
    if (unavailable("renaming a preset")) return;
    const name = (await prompts.prompt("New preset name", suggestedName))?.trim();
    if (!name || name === current.presetName) return;
    if (!await prompts.confirm(`Rename ${current.presetLocation} from “${current.presetName}” to “${name}”? This overwrites the stored preset name.`)) return;
    setPending(true);
    notice(`Renaming ${current.presetLocation}…`);
    try {
      const result = await gateway.renameCurrentPreset(name, current.presetName, current.presetPosition, true);
      commitSavedPreset(result);
      await loadDirectory(true, current.setlistKey, true);
      notice(result.detail ?? `${current.presetLocation} renamed.`);
    } catch (error) {
      fail(error);
    } finally {
      setPending(false);
    }
  }, [commitSavedPreset, fail, gateway, loadDirectory, notice, prompts, setPending, snapshotRef, unavailable]);

  const refresh = useCallback(async () => {
    if (unavailable("refreshing device state")) return;
    setPending(true);
    notice("Refreshing complete device state…");
    try {
      const current = await gateway.currentSnapshot();
      commitPreset(current);
      notice("Live preset state refreshed.");
    } catch (error) {
      fail(error);
    } finally {
      setPending(false);
    }
  }, [commitPreset, fail, gateway, notice, setPending, unavailable]);

  const presetAction = useCallback((action: "upload" | "edit" | "copy" | "cut" | "paste" | "delete", entry: PresetEntry) => {
    if (action === "edit" && presetList?.setlistKey === snapshotRef.current.setlistKey && entry.position === snapshotRef.current.presetPosition) {
      void rename(entry.name);
      return;
    }
    notice(action === "edit"
      ? `Recall ${entry.location} · ${entry.name} before renaming it.`
      : `${action === "upload" ? "Upload to Cloud" : action === "copy" ? "Copy" : action === "cut" ? "Cut" : action === "paste" ? "Paste" : "Delete"} for ${entry.location} · ${entry.name} is not exposed by the current USB gateway.`);
  }, [notice, presetList?.setlistKey, rename, snapshotRef]);

  const directoryProps: PresetDirectoryState = {
    open: directoryOpen,
    list: presetList,
    loading: presetListLoading || presetFoldersLoading,
    disabled: pending,
    onClose: () => setDirectoryOpen(false),
    onRefresh: () => void openDirectory(true),
    onRecall: (entry) => void recall(entry),
    onSelectSetlist: (setlistKey) => void loadDirectory(false, setlistKey),
    onPresetAction: presetAction
  };

  return {
    presetList,
    directoryOpen,
    directoryLoading: presetListLoading || presetFoldersLoading,
    saveOpen,
    saveName,
    clipboard,
    openDirectory,
    closeDirectory: () => setDirectoryOpen(false),
    loadDirectory,
    recall,
    recallLocation,
    reload,
    openSave,
    closeSave: () => setSaveOpen(false),
    setSaveName,
    save,
    saveCurrentUnsaved,
    copy,
    paste,
    rename,
    refresh,
    commitSavedPreset,
    resetCache: () => {
      loadSequence.current += 1;
      foldersLoaded.current = false;
      setPresetList(undefined);
      setPresetFoldersPending(false);
    },
    directoryProps,
    saveProps: {
      open: saveOpen,
      name: saveName,
      disabled: pending,
      onNameChange: setSaveName,
      onSave: () => void save(),
      onCancel: () => {
        setSaveOpen(false);
        notice("Preset save cancelled.");
      }
    }
  };
}
