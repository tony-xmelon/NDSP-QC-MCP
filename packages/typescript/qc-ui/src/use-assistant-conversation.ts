import { useCallback, useRef, useState } from "react";
import { appendConversationMessage, type ConversationMessage, type ConversationRole } from "@ndsp-qc/core";

export interface AssistantSubmission<TAttachment> {
  token: number;
  promptText: string;
  attachments: TAttachment[];
}

export interface AssistantConversationOptions<TAttachment> {
  initialMessages?: ConversationMessage<TAttachment>[];
  maximumInputLength?: number;
}

/**
 * Provider-neutral chat state shared by desktop and mobile shells. Providers
 * retain model calls and cancellation APIs; this hook owns message identity,
 * input clearing, attachment handoff, and the single active-request guard.
 */
export function useAssistantConversation<TAttachment = never>(options: AssistantConversationOptions<TAttachment> = {}) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ConversationMessage<TAttachment>[]>(options.initialMessages ?? []);
  const [pending, setPending] = useState(false);
  const nextMessageId = useRef(Math.max(0, ...(options.initialMessages ?? []).map((message) => message.id)) + 1);
  const nextRequestToken = useRef(1);
  const activeRequestToken = useRef<number | undefined>(undefined);
  const pendingRef = useRef(false);

  const append = useCallback((role: ConversationRole, text: string, attachments?: TAttachment[]) => {
    setMessages((current) => appendConversationMessage(current, nextMessageId.current++, role, text, attachments));
  }, []);

  const begin = useCallback((text: string, attachments: TAttachment[] = [], attachmentFallback = "Please analyze the attached file."): AssistantSubmission<TAttachment> | undefined => {
    const trimmed = text.trim().slice(0, options.maximumInputLength ?? Number.MAX_SAFE_INTEGER);
    if (pendingRef.current || (!trimmed && attachments.length === 0)) return undefined;
    const promptText = trimmed || attachmentFallback;
    const token = nextRequestToken.current++;
    activeRequestToken.current = token;
    pendingRef.current = true;
    setPending(true);
    setInput("");
    append("user", promptText, attachments);
    return { token, promptText, attachments };
  }, [append, options.maximumInputLength]);

  const finish = useCallback((token: number) => {
    if (activeRequestToken.current !== token) return;
    activeRequestToken.current = undefined;
    pendingRef.current = false;
    setPending(false);
  }, []);

  const cancel = useCallback(() => {
    activeRequestToken.current = undefined;
    pendingRef.current = false;
    setPending(false);
  }, []);

  return { input, setInput, messages, setMessages, pending, append, begin, finish, cancel };
}
