import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { GatewayTransport, PresetSnapshot } from "@ndsp-qc/client";
import type { QcDeviceTransport } from "@ndsp-qc/core";
import type { BlockEditorSessionController } from "./use-block-editor-session";
import { useDeviceHistory } from "./use-device-history";
import { useGridWorkflow } from "./use-grid-workflow";
import { useParameterWorkflow } from "./use-parameter-workflow";
import { usePerformanceWorkflow } from "./use-performance-workflow";
import { usePresetWorkflow, type WorkflowPrompts } from "./use-preset-workflow";
import type { QcController } from "./use-qc-controller";
import { useRoutingWorkflow } from "./use-routing-workflow";
import { useSceneWorkflow } from "./use-scene-workflow";

export interface QcWorkflowPanels {
  openRouting?(): void;
  openBlock?(): void;
  openAddBlock?(): void;
  openScenes?(): void;
  close?(): void;
}

export interface UseQcWorkflowsOptions {
  controller: QcController;
  transport: QcDeviceTransport;
  gateway: GatewayTransport;
  editor: BlockEditorSessionController;
  selectedBlockId: string;
  setSelectedBlockId: Dispatch<SetStateAction<string>>;
  connected: boolean;
  demo: boolean;
  pending: boolean;
  setPending: Dispatch<SetStateAction<boolean>>;
  prompts: WorkflowPrompts;
  panels?: QcWorkflowPanels;
  notice(message: string): void;
  fail(error: unknown): void;
  performanceFail?(error: unknown): void;
  onPresetChanged?(snapshot?: PresetSnapshot): void;
}

/**
 * Composes every cross-platform QC editing workflow around one native gateway.
 * Hosts retain presentation, connection lifecycle, and provider integrations;
 * command sequencing, reconciliation, history, and preset transitions live here.
 */
export function useQcWorkflows(options: UseQcWorkflowsOptions) {
  const {
    controller, transport, gateway, editor, selectedBlockId, setSelectedBlockId,
    connected, demo, pending, setPending, prompts, panels, notice, fail,
    performanceFail = fail, onPresetChanged
  } = options;

  const reconcile = useCallback((next: PresetSnapshot) => {
    controller.snapshotRef.current = next;
    controller.setSnapshot(next);
    setSelectedBlockId((current) => next.blocks.some((block) => block.id === current) ? current : "");
  }, [controller, setSelectedBlockId]);

  const history = useDeviceHistory({
    gateway, snapshot: controller.snapshot, connected, pending, setPending,
    reconcile, notice, fail
  });

  const finishPresetTransition = useCallback((next?: PresetSnapshot) => {
    setSelectedBlockId((current) => next?.blocks.some((block) => block.id === current) ? current : "");
    editor.close();
    history.clear();
    onPresetChanged?.(next);
  }, [editor, history, onPresetChanged, setSelectedBlockId]);

  const preset = usePresetWorkflow({
    gateway,
    snapshotRef: controller.snapshotRef,
    setSnapshot: controller.setSnapshot,
    connected,
    pending,
    setPending,
    prompts,
    notice,
    fail,
    onPresetChanged: finishPresetTransition
  });

  const routing = useRoutingWorkflow({
    gateway,
    snapshot: controller.snapshot,
    connected,
    pending,
    setPending,
    reconcile,
    recordHistory: history.record,
    prompts,
    notice,
    fail,
    onOpenAdvanced: panels?.openRouting
  });

  const grid = useGridWorkflow({
    gateway,
    snapshot: controller.snapshot,
    selectedBlockId,
    setSelectedBlockId,
    editor,
    connected,
    pending,
    setPending,
    reconcile,
    recordHistory: history.record,
    prompts,
    notice,
    fail,
    closePresetDirectory: preset.closeDirectory,
    onOpenManagement: panels?.openBlock,
    onOpenAdd: panels?.openAddBlock,
    onClosePanel: panels?.close
  });

  const parameter = useParameterWorkflow({
    gateway,
    snapshot: controller.snapshot,
    editor,
    connected,
    pending,
    setPending,
    reconcile,
    recordHistory: history.record,
    notice,
    fail
  });

  const scene = useSceneWorkflow({
    gateway,
    snapshot: controller.snapshot,
    connected,
    pending,
    setPending,
    reconcile,
    recordHistory: history.record,
    prompts,
    notice,
    fail,
    onOpen: panels?.openScenes,
    onClose: panels?.close
  });

  const performance = usePerformanceWorkflow({
    controller,
    transport,
    gateway,
    connected,
    demo,
    recordHistory: history.record,
    onPresetChanged: () => finishPresetTransition(),
    notice,
    fail: performanceFail
  });

  return { reconcile, history, preset, routing, grid, parameter, scene, performance };
}
