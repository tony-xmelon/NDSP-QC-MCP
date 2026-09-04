import type { GridBlock, PresetSnapshot } from "@ndsp-qc/client";
import { type AssistantIntent, assistantHelp, assistantIntentToolName, formatSnapshotSummary } from "./assistant.ts";
import { assistantIntentCommand, type QcAssistantDeviceCommand } from "./assistant-execution.ts";
import { assistantAccessPermitsTool, type AssistantAccessMode } from "./assistant-tools.ts";
import { sceneLetter } from "./state.ts";

export type OfflineAssistantIntentResolution =
  | { kind: "response"; intent: "inspect" | "help"; detail: string }
  | { kind: "denied"; detail: string }
  | { kind: "bypass"; block: GridBlock; targetBypassed: boolean; changed: boolean; label: string; command: Extract<QcAssistantDeviceCommand, { kind: "bypass" }> }
  | { kind: "parameter"; block: GridBlock; parameter: string; value: string }
  | { kind: "bank"; direction: -1 | 1 }
  | { kind: "recall"; location: string }
  | { kind: "command"; command: QcAssistantDeviceCommand };

/**
 * Resolve deterministic assistant text into a platform-neutral workflow step.
 * Native shells remain responsible for confirmation presentation and transport I/O.
 */
export function resolveOfflineAssistantIntent(
  intent: AssistantIntent,
  snapshot: PresetSnapshot,
  selectedBlockId: string | undefined,
  accessMode: AssistantAccessMode
): OfflineAssistantIntentResolution {
  if (intent.kind === "inspect") return { kind: "response", intent: "inspect", detail: formatSnapshotSummary(snapshot) };
  if (intent.kind === "help") return { kind: "response", intent: "help", detail: assistantHelp };

  const tool = assistantIntentToolName(intent);
  if (tool && !assistantAccessPermitsTool(accessMode, tool)) {
    return { kind: "denied", detail: `Assistant ${accessMode} access does not permit that operation. Manual on-screen controls remain available.` };
  }

  const selectedBlock = snapshot.blocks.find((block) => block.id === selectedBlockId);
  if (intent.kind === "bypass") {
    if (!selectedBlock || selectedBlock.bypassed === undefined) throw new Error("Select a bypass-capable block on the Grid first.");
    const targetBypassed = intent.desired === "toggle" ? !selectedBlock.bypassed : intent.desired === "bypassed";
    const command = assistantIntentCommand(intent, selectedBlock);
    if (!command || command.kind !== "bypass") throw new Error("That bypass command is not valid.");
    return {
      kind: "bypass",
      block: selectedBlock,
      targetBypassed,
      changed: targetBypassed !== selectedBlock.bypassed,
      label: `${targetBypassed ? "Bypass" : "Enable"} ${selectedBlock.name} in Scene ${sceneLetter(snapshot.activeScene)}`,
      command
    };
  }
  if (intent.kind === "parameter") {
    if (!selectedBlock) throw new Error("Select a block on the Grid first.");
    return { kind: "parameter", block: selectedBlock, parameter: intent.parameter, value: intent.value };
  }
  if (intent.kind === "bank") return { kind: "bank", direction: intent.direction };
  if (intent.kind === "recall") return { kind: "recall", location: intent.location };

  const command = assistantIntentCommand(intent, selectedBlock);
  if (!command) throw new Error("That QC command is not valid.");
  return { kind: "command", command };
}
