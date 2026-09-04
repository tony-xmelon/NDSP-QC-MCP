import type { BlockDetails, ConnectionState, PresetSnapshot, SavePresetResult } from "@ndsp-qc/client";
import type { QcActionExecutionResult } from "./qc-action-executor";

export interface QcActionImageAttachment {
  name: string;
  mediaType: "image/png";
  data: string;
}

export interface QcActionOutcomeHandlers {
  setConnection: (connection: ConnectionState) => void;
  commitSavedPreset: (saved: SavePresetResult) => void;
  commitSnapshot: (snapshot: PresetSnapshot) => void;
  currentBlock?: Pick<BlockDetails, "row" | "column">;
  updateBlock: (block: BlockDetails) => void;
  clearSelection: () => void;
  now?: () => number;
}

/** Apply shared tool results consistently while native shells retain state ownership. */
export function reconcileQcActionOutcome(result: QcActionExecutionResult, handlers: QcActionOutcomeHandlers): QcActionImageAttachment | undefined {
  if (result.connection) handlers.setConnection(result.connection);
  if (result.savedPreset) handlers.commitSavedPreset(result.savedPreset);
  else if (result.snapshot) handlers.commitSnapshot(result.snapshot);
  if (result.block && handlers.currentBlock?.row === result.block.row && handlers.currentBlock.column === result.block.column) handlers.updateBlock(result.block);
  if (result.clearSelection) handlers.clearSelection();
  return result.image ? {
    name: `qc-screen-${(handlers.now ?? Date.now)()}.png`,
    mediaType: "image/png",
    data: result.image.pngBase64
  } : undefined;
}
