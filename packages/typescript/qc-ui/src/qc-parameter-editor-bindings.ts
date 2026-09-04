import type { PresetSnapshot } from "@ndsp-qc/client";
import { QC_COLORS } from "@ndsp-qc/theme";
import type { CorOsParameterEditorProps } from "./parameter-editor";
import { officialBlockVisual } from "./block-visuals";
import type { BlockEditorSessionController } from "./use-block-editor-session";
import type { useGridWorkflow } from "./use-grid-workflow";
import type { useParameterWorkflow } from "./use-parameter-workflow";
import type { usePerformanceWorkflow } from "./use-performance-workflow";

export interface QcParameterEditorBindingOptions {
  snapshot: PresetSnapshot;
  selectedBlockId: string;
  editor: BlockEditorSessionController;
  grid: ReturnType<typeof useGridWorkflow>;
  parameter: ReturnType<typeof useParameterWorkflow>;
  performance: ReturnType<typeof usePerformanceWorkflow>;
  connected: boolean;
  pending: boolean;
  notice(message: string): void;
  openExpression(): void;
}

const unavailableLabels = {
  "save-device-preset": "Save Current Parameters As…",
  "change-device": "Change device",
  "reset-defaults": "Reset to defaults",
  "set-parameters-defaults": "Set parameters as defaults",
  "assign-looper-actions": "Assign Looper X Actions",
  "mute-bypass": "Mute/Bypass"
} as const;

/** Build the identical parameter-screen behavior used by desktop and mobile. */
export function qcParameterEditorBindings(options: QcParameterEditorBindingOptions): CorOsParameterEditorProps | undefined {
  const { snapshot, selectedBlockId, editor, grid, parameter, performance, connected, pending, notice, openExpression } = options;
  const details = editor.details;
  if (!details) return undefined;
  const selected = snapshot.blocks.find((block) => block.id === selectedBlockId)
    ?? snapshot.blocks.find((block) => block.row === details.row && block.column === details.column);
  const routingNode = details.column === 8 ? "splitter" : details.column === 9 ? "mixer" : undefined;
  const accent = routingNode === "splitter"
    ? QC_COLORS.category.equalizer
    : routingNode === "mixer"
      ? QC_COLORS.category.synth
      : officialBlockVisual(selected ?? { id: "editor", name: details.name, kind: "utility", category: details.category, row: details.row, column: details.column }).color;

  return {
    details,
    drafts: editor.drafts,
    accent,
    activeScene: snapshot.activeScene,
    scenes: snapshot.scenes,
    bypassed: Boolean(selected?.bypassed),
    footswitch: selected?.footswitch,
    routingNode,
    disabled: pending,
    page: editor.page,
    onPageChange: editor.setPage,
    onDraftChange: parameter.draft,
    onCommit: parameter.commit,
    onCommitBatch: (changes) => void parameter.commitBatch(changes),
    onToggleBypass: () => { if (selected) void performance.toggleBlockBypass(selected); },
    onSceneSelect: (scene) => void performance.selectScene(scene),
    footswitchAssignmentPending: grid.footswitchAssignmentPending,
    onFootswitchAssignmentStart: (assignmentPending) => {
      grid.setFootswitchAssignmentPending(assignmentPending);
      notice(assignmentPending
        ? "Press footswitch A–H to assign it; press the currently assigned switch to remove the assignment."
        : "Footswitch assignment cancelled.");
    },
    clipboardModelId: grid.clipboard?.modelId,
    contextActionEnabled: {
      "save-device-preset": false,
      "change-device": false,
      "copy-device": true,
      "paste-device": Boolean(grid.clipboard && grid.clipboard.modelId === details.modelId && connected && !pending),
      "reset-defaults": false,
      "set-parameters-defaults": false,
      expression: true,
      "assign-looper-actions": false,
      "mute-bypass": false,
      remove: connected && !pending
    },
    onContextAction: (action) => {
      if (action === "copy-device") { void grid.copy(); return; }
      if (action === "paste-device") { void grid.paste(); return; }
      if (action === "remove") { void grid.remove(); return; }
      if (action === "expression") { openExpression(); return; }
      notice(`${unavailableLabels[action]} is present in its CorOS position, but this write is not exposed by the current USB gateway.`);
    },
    onClose: () => {
      parameter.cancel();
      grid.close();
    }
  };
}
