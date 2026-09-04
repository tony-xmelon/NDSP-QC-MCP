import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { GatewayTransport, PresetSnapshot } from "@ndsp-qc/client";
import { inputRouteOptions, outputRouteOptions, routeDraftsFromSnapshot, routeOptionValue, routeOptionsForRow, type RouteDrafts } from "@ndsp-qc/core";
import type { CorOsRoutingPickerState } from "./quad-cortex-surface";
import type { DeviceHistoryEntry } from "./use-device-history";
import type { WorkflowPrompts } from "./use-preset-workflow";

export type RoutePicker = { row: number; side: "input" | "output" };

export interface RoutingWorkflowOptions {
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
  onOpenAdvanced?(): void;
}

export interface RoutingWorkflowController {
  drafts: RouteDrafts;
  setDrafts: Dispatch<SetStateAction<RouteDrafts>>;
  picker?: RoutePicker;
  pickerProps?: CorOsRoutingPickerState;
  open(): void;
  openPicker(row: number, side: "input" | "output"): void;
  closePicker(): void;
  applyRoute(row: number, side: "input" | "output", selected?: number): Promise<void>;
  applySplit(row: number): Promise<void>;
}

/** Shared route validation, mutation, verification, and history controller. */
export function useRoutingWorkflow(options: RoutingWorkflowOptions): RoutingWorkflowController {
  const { gateway, snapshot, connected, pending, setPending, reconcile, recordHistory, prompts, notice, fail, onOpenAdvanced } = options;
  const [drafts, setDrafts] = useState<RouteDrafts>({});
  const [picker, setPicker] = useState<RoutePicker>();

  const open = useCallback(() => {
    if (!connected) { notice("Connect the Quad Cortex before editing signal routing."); return; }
    const liveRoutes = snapshot.routes.filter((route) => route.inputId !== undefined && route.outputId !== undefined);
    if (!liveRoutes.length) { notice("Refresh the complete device state before editing routing."); return; }
    setDrafts(routeDraftsFromSnapshot({ routes: liveRoutes }));
    onOpenAdvanced?.();
  }, [connected, notice, onOpenAdvanced, snapshot.routes]);

  const openPicker = useCallback((row: number, side: "input" | "output") => {
    const route = snapshot.routes.find((candidate) => candidate.row === row);
    if (!connected || route?.inputId === undefined || route.outputId === undefined) {
      notice(!connected ? "Connect the Quad Cortex before changing signal routing." : "Refresh the complete device state before changing this route.");
      return;
    }
    setPicker((current) => current?.row === row && current.side === side ? undefined : { row, side });
    notice(`Select row ${row + 1} ${side} on the Quad Cortex screen.`);
  }, [connected, notice, snapshot.routes]);

  const applyRoute = useCallback(async (row: number, side: "input" | "output", selected?: number) => {
    const route = snapshot.routes.find((candidate) => candidate.row === row);
    const draft = drafts[row];
    const expected = side === "input"
      ? routeOptionValue("input", route?.inputId, route?.input ?? "Internal")
      : routeOptionValue("output", route?.outputId, route?.output ?? "Internal");
    const desired = selected ?? (side === "input" ? draft?.inputId : draft?.outputId);
    if (desired === undefined || pending) return;
    if (!connected) { notice("Connect the Quad Cortex before changing signal routing."); return; }
    if (expected === desired) { setPicker(undefined); return; }
    setPending(true);
    notice(`Updating row ${row + 1} ${side}…`);
    try {
      const execute = (value: number, previous: number, presetName: string) => side === "input"
        ? gateway.setChainInput(row, value, previous, presetName)
        : gateway.setChainOutput(row, value, previous, presetName);
      const result = await execute(desired, expected, snapshot.presetName);
      if (result.snapshot) {
        reconcile(result.snapshot);
        setDrafts(routeDraftsFromSnapshot(result.snapshot));
      }
      recordHistory({
        label: `row ${row + 1} ${side}`,
        execute: (current) => execute(expected, desired, current.presetName),
        redo: (current) => execute(desired, expected, current.presetName)
      });
      setPicker(undefined);
      notice(result.detail);
    } catch (error) { fail(error); }
    finally { setPending(false); }
  }, [connected, drafts, fail, gateway, notice, pending, reconcile, recordHistory, setPending, snapshot.presetName, snapshot.routes]);

  const applySplit = useCallback(async (row: number) => {
    const route = snapshot.routes.find((candidate) => candidate.row === row);
    const draft = drafts[row];
    if (!route || !draft || pending) return;
    if (!connected) { notice("Connect the Quad Cortex before changing signal routing."); return; }
    const expectedSplit = route.splitColumn ?? null;
    const expectedMix = route.splitColumn === undefined ? null : route.mixColumn ?? -1;
    if (draft.splitColumn === expectedSplit && draft.mixColumn === expectedMix) return;
    const description = draft.splitColumn === null ? "return it to a serial path" : `branch at column ${draft.splitColumn + 1}${draft.mixColumn === -1 ? " without a rejoin" : ` and rejoin at column ${Number(draft.mixColumn) + 1}`}`;
    if (!await prompts.confirm(`Row ${row + 1}: ${description}? Audio may be interrupted. This is temporary until the preset is saved.`)) return;
    setPending(true);
    notice(`Updating row ${row + 1} parallel routing…`);
    try {
      const result = await gateway.setChainSplit(row, draft.splitColumn, draft.mixColumn, expectedSplit, expectedMix, snapshot.presetName);
      if (result.snapshot) {
        reconcile(result.snapshot);
        setDrafts(routeDraftsFromSnapshot(result.snapshot));
      }
      recordHistory({
        label: `row ${row + 1} branch routing`,
        execute: (current) => gateway.setChainSplit(row, expectedSplit, expectedMix, draft.splitColumn, draft.mixColumn, current.presetName),
        redo: (current) => gateway.setChainSplit(row, draft.splitColumn, draft.mixColumn, expectedSplit, expectedMix, current.presetName)
      });
      notice(result.detail);
    } catch (error) { fail(error); }
    finally { setPending(false); }
  }, [connected, drafts, fail, gateway, notice, pending, prompts, reconcile, recordHistory, setPending, snapshot.presetName, snapshot.routes]);

  const pickerProps = useMemo<CorOsRoutingPickerState | undefined>(() => {
    if (!picker) return undefined;
    const route = snapshot.routes.find((candidate) => candidate.row === picker.row);
    const value = picker.side === "input"
      ? routeOptionValue("input", route?.inputId, route?.input ?? "Internal")
      : routeOptionValue("output", route?.outputId, route?.output ?? "Internal");
    return {
      ...picker,
      options: routeOptionsForRow(picker.side, picker.row, value, snapshot.routes),
      value,
      disabled: pending,
      onSelect: (selected) => void applyRoute(picker.row, picker.side, selected),
      onClose: () => setPicker(undefined)
    };
  }, [applyRoute, pending, picker, snapshot.routes]);

  return { drafts, setDrafts, picker, pickerProps, open, openPicker, closePicker: () => setPicker(undefined), applyRoute, applySplit };
}
