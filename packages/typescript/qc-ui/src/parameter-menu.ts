import type { BlockDetails } from "@ndsp-qc/client";

export type ParameterEditorContextAction =
  | "save-device-preset" | "change-device" | "copy-device" | "paste-device"
  | "reset-defaults" | "set-parameters-defaults" | "expression"
  | "assign-looper-actions" | "mute-bypass" | "remove";

export interface ParameterContextMenuItem {
  action: ParameterEditorContextAction;
  label: string;
  icon: "save" | "change" | "copy" | "paste" | "reset" | "defaults" | "expression" | "looper" | "mute" | "remove";
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function parameterContextMenuItems(details: Pick<BlockDetails, "name" | "category" | "modelId">, clipboardModelId?: number): ParameterContextMenuItem[] {
  const category = details.category.trim().toLowerCase();
  const supportsDevicePresets = !/(?:neural\s*capture|input|output|splitter|mixer)/i.test(category);
  const looper = /looper/i.test(`${details.category} ${details.name}`);
  const fxLoop = /fx\s*loop/i.test(`${details.category} ${details.name}`);
  return [
    ...(supportsDevicePresets ? [{ action: "save-device-preset", label: "Save Current Parameters As…", icon: "save" } as const] : []),
    { action: "change-device", label: "Change device", icon: "change", separatorBefore: supportsDevicePresets },
    { action: "copy-device", label: "Copy device", icon: "copy" },
    { action: "paste-device", label: "Paste device", icon: "paste", disabled: clipboardModelId !== details.modelId },
    { action: "reset-defaults", label: "Reset to defaults", icon: "reset" },
    { action: "set-parameters-defaults", label: "Set parameters as defaults", icon: "defaults" },
    { action: "expression", label: "Assign Expression Pedal", icon: "expression" },
    ...(looper ? [{ action: "assign-looper-actions", label: "Assign Looper X Actions", icon: "looper" } as const] : []),
    ...(fxLoop ? [{ action: "mute-bypass", label: "Mute/Bypass", icon: "mute" } as const] : []),
    { action: "remove", label: "Remove block from the grid", icon: "remove", separatorBefore: true }
  ];
}
