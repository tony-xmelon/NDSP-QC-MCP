import { useCallback } from "react";
import type { DeviceActionResult, GatewayTransport, PresetSnapshot } from "@ndsp-qc/client";
import { useCommandJournal } from "./use-command-journal";

export interface DeviceHistoryEntry {
  label: string;
  execute(current: PresetSnapshot): Promise<DeviceActionResult>;
  redo(current: PresetSnapshot): Promise<DeviceActionResult>;
}

export interface DeviceHistoryOptions {
  gateway: GatewayTransport;
  snapshot: PresetSnapshot;
  connected: boolean;
  pending: boolean;
  setPending(pending: boolean): void;
  reconcile(snapshot: PresetSnapshot): void;
  notice(message: string): void;
  fail(error: unknown): void;
}

/** Shared verified one-step history used by every device-editing workflow. */
export function useDeviceHistory(options: DeviceHistoryOptions) {
  const journal = useCommandJournal<DeviceHistoryEntry>();
  const { undoEntry, redoEntry, record, clear, markUndone, markRedone } = journal;
  const { gateway, snapshot, connected, pending, setPending, reconcile, notice, fail } = options;

  const run = useCallback(async (direction: "undo" | "redo") => {
    const entry = direction === "undo" ? undoEntry : redoEntry;
    if (!entry) {
      notice(`There is no app action to ${direction}.`);
      return;
    }
    if (!connected || pending) {
      notice(!connected ? `Connect the Quad Cortex before ${direction}ing a live action.` : "A device command is already in progress.");
      return;
    }
    setPending(true);
    notice(`${direction === "undo" ? "Undoing" : "Redoing"} ${entry.label}…`);
    try {
      const result = await (direction === "undo" ? entry.execute(snapshot) : entry.redo(snapshot));
      const verified = result.snapshot ?? await gateway.currentSnapshot();
      reconcile(verified);
      if (direction === "undo") markUndone(entry);
      else markRedone(entry);
      notice(`${direction === "undo" ? "Undid" : "Redid"} ${entry.label}. ${result.detail}`);
    } catch (error) {
      fail(error);
      try { reconcile(await gateway.currentSnapshot()); } catch { /* Retain the entry for retry. */ }
    } finally {
      setPending(false);
    }
  }, [connected, fail, gateway, markRedone, markUndone, notice, pending, reconcile, redoEntry, setPending, snapshot, undoEntry]);

  return {
    undoEntry,
    redoEntry,
    record,
    clear,
    markUndone,
    markRedone,
    undo: () => run("undo"),
    redo: () => run("redo")
  };
}
