import { parseAssistantAccessMode, type AssistantAccessMode } from "@ndsp-qc/core";

export const ASSISTANT_ACCESS_MODE_STORAGE_KEY = "qc.control.assistant-access-mode.v1";

type AccessModeStorage = Pick<Storage, "getItem" | "setItem">;

export function readAssistantAccessMode(storage: AccessModeStorage, legacyKeys: readonly string[] = []): AssistantAccessMode {
  const current = storage.getItem(ASSISTANT_ACCESS_MODE_STORAGE_KEY);
  if (current !== null) return parseAssistantAccessMode(current);
  for (const key of legacyKeys) {
    const legacy = storage.getItem(key);
    if (legacy === null) continue;
    const mode = parseAssistantAccessMode(legacy);
    storage.setItem(ASSISTANT_ACCESS_MODE_STORAGE_KEY, mode);
    return mode;
  }
  return parseAssistantAccessMode(undefined);
}

export function writeAssistantAccessMode(storage: AccessModeStorage, mode: AssistantAccessMode): void {
  storage.setItem(ASSISTANT_ACCESS_MODE_STORAGE_KEY, mode);
}
