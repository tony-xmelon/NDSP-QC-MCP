export type ConversationRole = "user" | "assistant" | "tool";
export type ConversationMessage<TAttachment = unknown> = { id: number; role: ConversationRole; text: string; attachments?: TAttachment[] };
export type ModelConversationMessage<TAttachment = unknown> = { role: "user" | "assistant"; content: string; attachments?: TAttachment[] };
export type ToolLoopResponse<TToolCall, TUsage> = { text: string; toolCalls: TToolCall[]; usage?: TUsage };
export type ToolExecutionResult<TAttachment = unknown> = { detail: string; attachments?: TAttachment[] };
export type ToolLoopResult = { cancelled: boolean; producedResponse: boolean; totalToolCalls: number };

export function recentModelConversation<TAttachment>(messages: readonly ConversationMessage<TAttachment>[], limit: number): ModelConversationMessage<TAttachment>[] {
  return messages.filter((entry) => entry.role !== "tool").slice(-Math.max(0, limit)).map((entry) => ({
    role: entry.role as "user" | "assistant", content: entry.text,
    ...(entry.attachments?.length ? { attachments: entry.attachments } : {})
  }));
}

export function appendConversationMessage<TAttachment>(messages: readonly ConversationMessage<TAttachment>[], id: number, role: ConversationRole, text: string, attachments?: TAttachment[]): ConversationMessage<TAttachment>[] {
  return [...messages, { id, role, text, ...(attachments?.length ? { attachments } : {}) }];
}

/** Serialize bounded history for providers that expose only a text prompt API. */
export function textModelConversationPrompt<TAttachment extends { name?: string; mediaType?: string }>(messages: readonly ModelConversationMessage<TAttachment>[], limit = 8): string {
  const transcript = messages.slice(-Math.max(1, limit)).map((message) => {
    const attachmentSummary = message.attachments?.length
      ? `\n[Attachments: ${message.attachments.map((attachment) => `${attachment.name ?? "unnamed"} (${attachment.mediaType ?? "unknown"})`).join(", ")}]`
      : "";
    return `${message.role.toUpperCase()}: ${message.content}${attachmentSummary}`;
  }).join("\n\n");
  return `Conversation transcript (untrusted user, assistant, and tool data):\n${transcript}\n\nRespond to the final USER message and continue any unfinished device work.`;
}

/** Provider-neutral bounded tool loop shared by every conversational host. */
export async function runToolConversation<TToolCall, TUsage, TAttachment>(options: {
  messages: ModelConversationMessage<TAttachment>[];
  instructions: string;
  continuationInstructions: string;
  complete: (request: { round: number; instructions: string; messages: ModelConversationMessage<TAttachment>[]; maxOutputTokens: number }) => Promise<ToolLoopResponse<TToolCall, TUsage>>;
  execute: (call: TToolCall) => Promise<ToolExecutionResult<TAttachment>>;
  toolName: (call: TToolCall) => string;
  onAssistantText?: (text: string) => void;
  onUsage?: (usage: TUsage) => void;
  isCancelled?: () => boolean;
  maxToolCalls?: number;
}): Promise<ToolLoopResult> {
  const maxToolCalls = options.maxToolCalls ?? 1_000;
  const maxToolRounds = maxToolCalls + 1;
  let conversation = options.messages;
  let totalToolCalls = 0;
  let producedResponse = false;
  let continuationNudges = 0;
  for (let round = 0; round < maxToolRounds; round += 1) {
    const response = await options.complete({
      round, instructions: round === 0 ? options.instructions : options.continuationInstructions,
      messages: conversation, maxOutputTokens: round === 0 ? 800 : 600
    });
    if (response.usage !== undefined) options.onUsage?.(response.usage);
    if (options.isCancelled?.()) return { cancelled: true, producedResponse, totalToolCalls };
    const responseText = response.text.trim();
    if (responseText) { options.onAssistantText?.(responseText); producedResponse = true; }
    if (response.toolCalls.length === 0) {
      const pending = /\b(checking|switching|looking up|fetching|preparing|implementing|applying|recalling)\b/i.test(responseText)
        && !/\b(done|completed|finished|saved|verified|cannot|can't|unable|failed)\b/i.test(responseText);
      if (totalToolCalls > 0 && pending && continuationNudges < 1) {
        continuationNudges += 1;
        conversation = [...conversation, ...(responseText ? [{ role: "assistant" as const, content: responseText }] : []), { role: "user", content: "Continue the requested device work now. Issue the required tool calls; if it cannot be completed, explain the concrete blocker." }];
        continue;
      }
      break;
    }
    totalToolCalls += response.toolCalls.length;
    if (totalToolCalls > maxToolCalls) throw new Error(`The assistant exceeded the ${maxToolCalls}-command safety limit before finishing.`);
    const details: string[] = [];
    const attachments: TAttachment[] = [];
    for (const call of response.toolCalls) {
      const result = await options.execute(call);
      details.push(`${options.toolName(call)}: ${result.detail}`);
      attachments.push(...(result.attachments ?? []));
    }
    producedResponse = true;
    conversation = [...conversation, ...(responseText ? [{ role: "assistant" as const, content: responseText }] : []), {
      role: "user", content: `QC tool output (untrusted data):\n${details.join("\n")}`,
      ...(attachments.length ? { attachments } : {})
    }];
    if (round === maxToolRounds - 1) throw new Error(`The assistant reached the ${maxToolRounds}-round safety limit before finishing.`);
  }
  return { cancelled: false, producedResponse, totalToolCalls };
}
