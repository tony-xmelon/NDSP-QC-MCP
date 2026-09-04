import type { WorkflowPrompts } from "./use-preset-workflow";

/** Browser-backed confirmation adapter shared by the two webview shells. */
export const browserWorkflowPrompts: WorkflowPrompts = {
  confirm: (message) => window.confirm(message),
  prompt: (message, initialValue) => window.prompt(message, initialValue)
};
