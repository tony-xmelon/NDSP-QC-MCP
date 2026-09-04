import { QC_GRID_COLUMNS, QC_MAXIMUM_TEMPO_BPM, QC_MINIMUM_TEMPO_BPM, type GridBlock } from "@ndsp-qc/client";
import type { AssistantIntent, ValidatedAssistantAction } from "./assistant.ts";
import type { QcCommandResult } from "./transport.ts";
import { sceneLetter } from "./state.ts";

export type QcAssistantDeviceCommand =
  | { kind: "scene"; scene: number }
  | { kind: "preset-step"; delta: -1 | 1 }
  | { kind: "tempo"; bpm: number }
  | { kind: "bypass"; blockId: string; row: number; column: number; bypassed: boolean; blockName: string }
  | { kind: "view"; view: "tuner" | "gig"; show: boolean };

function bypassCommand(block: GridBlock | undefined, bypassed: boolean): QcAssistantDeviceCommand {
  if (!block || block.bypassed === undefined || block.row < 0 || block.column < 0 || block.column >= QC_GRID_COLUMNS) {
    throw new Error("Select a bypass-capable Grid block first.");
  }
  return { kind: "bypass", blockId: block.id, row: block.row, column: block.column, bypassed, blockName: block.name };
}

/** Resolve a validated model proposal without giving the model transport access. */
export function assistantActionCommand(action: ValidatedAssistantAction, selectedBlock?: GridBlock): QcAssistantDeviceCommand {
  if (action.name === "select_scene") return { kind: "scene", scene: action.scene };
  if (action.name === "set_tempo") return { kind: "tempo", bpm: action.bpm };
  if (action.name === "next_preset") return { kind: "preset-step", delta: 1 };
  if (action.name === "previous_preset") return { kind: "preset-step", delta: -1 };
  if (action.name === "show_tuner") return { kind: "view", view: "tuner", show: action.show };
  if (action.name === "show_gig_view") return { kind: "view", view: "gig", show: action.show };
  if (action.name === "set_selected_block_bypass") return bypassCommand(selectedBlock, action.bypassed);
  throw new Error("Unsupported assistant action.");
}

/** Resolve deterministic typed input to the same platform-neutral command. */
export function assistantIntentCommand(intent: AssistantIntent, selectedBlock?: GridBlock): QcAssistantDeviceCommand | null {
  if (intent.kind === "scene") return { kind: "scene", scene: intent.index };
  if (intent.kind === "preset-step") return { kind: "preset-step", delta: intent.delta };
  if (intent.kind === "view") return { kind: "view", view: intent.view, show: true };
  if (intent.kind === "tempo") {
    if (!Number.isInteger(intent.bpm) || intent.bpm < QC_MINIMUM_TEMPO_BPM || intent.bpm > QC_MAXIMUM_TEMPO_BPM) throw new Error(`Tempo must be from ${QC_MINIMUM_TEMPO_BPM} through ${QC_MAXIMUM_TEMPO_BPM} BPM.`);
    return { kind: "tempo", bpm: intent.bpm };
  }
  if (intent.kind === "bypass") {
    if (!selectedBlock || selectedBlock.bypassed === undefined) return bypassCommand(selectedBlock, false);
    const bypassed = intent.desired === "toggle" ? !selectedBlock.bypassed : intent.desired === "bypassed";
    return bypassCommand(selectedBlock, bypassed);
  }
  return null;
}

export function assistantCommandDetail(command: QcAssistantDeviceCommand, result: QcCommandResult): string {
  if (result.detail) return result.detail;
  if (command.kind === "scene") return `Scene ${sceneLetter(command.scene)} selected.`;
  if (command.kind === "preset-step") return `Moved to the ${command.delta > 0 ? "next" : "previous"} preset.`;
  if (command.kind === "tempo") return `Tempo set to ${command.bpm} BPM.`;
  if (command.kind === "bypass") return `${command.blockName} ${command.bypassed ? "bypassed" : "enabled"}.`;
  return `${command.view === "tuner" ? "Tuner" : "Gig View"} ${command.show ? "opened" : "closed"}.`;
}
