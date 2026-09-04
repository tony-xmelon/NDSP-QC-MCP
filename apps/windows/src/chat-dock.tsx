import { useEffect, useRef, useState, type ClipboardEventHandler, type ReactNode, type RefObject } from "react";
import type { ConversationMessage } from "@ndsp-qc/core";
import { MicrophoneIcon } from "@ndsp-qc/ui";
import type { ChatAttachment } from "./model-chat";

const attachmentTypes = "image/jpeg,image/png,image/webp,image/gif,audio/mpeg,audio/wav,audio/aiff,audio/aac,audio/ogg,audio/flac,audio/m4a,audio/opus,audio/webm,video/mp4,video/mpeg,video/quicktime,video/avi,video/webm,video/wmv,video/3gpp,application/pdf,.txt,.md,.markdown,.csv,.json,.xml,.yaml,.yml,.log,.js,.jsx,.ts,.tsx,.css,.html,.htm,.py,.rs,.toml";

function CollapsibleQcResult({ text }: { text: string }) {
  const content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useEffect(() => {
    const element = content.current;
    if (!element || expanded) return;
    const measure = () => setCanExpand(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [expanded, text]);

  return <div className={`qc-result${expanded ? " is-expanded" : ""}`}>
    <div ref={content} className={`qc-result-text${expanded ? "" : " is-collapsed"}`}>{text}</div>
    {canExpand && <button className="qc-result-toggle" type="button" aria-expanded={expanded} aria-label={expanded ? "Collapse QC result" : "Expand QC result"} onClick={() => setExpanded((value) => !value)}><i aria-hidden="true" /></button>}
  </div>;
}

export type ChatDockProps = {
  open: boolean;
  messages: ConversationMessage<ChatAttachment>[];
  conversationRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  value: string;
  attachments: ChatAttachment[];
  pendingAction?: ReactNode;
  modelValue: string;
  modelOptions: ReactNode;
  modelDisabled: boolean;
  listening: boolean;
  assistantPending: boolean;
  canCancel: boolean;
  usageTitle: string;
  usageLabel: string;
  quotaLabel: string;
  resetLabel: string;
  onRestore: () => void;
  onScroll: () => void;
  onUserScroll: () => void;
  onValueChange: (value: string) => void;
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>;
  onSend: () => void;
  onCancel: () => void;
  onFiles: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
  onSelectModel: (model: string) => void;
  onToggleMicrophone: () => void;
};

export function ChatDock(props: ChatDockProps) {
  if (!props.open) return <button className="restore-chat" onClick={props.onRestore}>Open assistant <span>Ctrl+L</span></button>;

  return <section className="chat-dock" aria-label="QC assistant">
    <div ref={props.conversationRef} className="conversation-preview" aria-live="polite" onScroll={props.onScroll} onWheel={props.onUserScroll} onTouchMove={props.onUserScroll} onPointerDown={props.onUserScroll}>
      {props.messages.map((item) => <div className={`${item.role}-message`} key={item.id}>
        {item.role !== "tool" && <span>{item.role.toUpperCase()}</span>}
        {item.attachments?.length ? <div className="chat-message-attachments">{item.attachments.map((attachment, index) => attachment.mediaType.startsWith("image/") ? <img key={`${attachment.name}-${index}`} src={`data:${attachment.mediaType};base64,${attachment.data}`} alt={attachment.name} /> : <span className="chat-file-chip" key={`${attachment.name}-${index}`}>▤ {attachment.name}</span>)}</div> : null}
        {item.role === "tool" ? <CollapsibleQcResult text={item.text} /> : item.text}
      </div>)}
    </div>
    {props.pendingAction}
    <div className="composer">
      <textarea ref={props.inputRef} value={props.value} onChange={(event) => props.onValueChange(event.target.value)} onPaste={props.onPaste} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); props.onSend(); }
      }} placeholder="Ask about this preset or describe a change…" rows={1} />
      {props.attachments.length > 0 && <div className="composer-attachments" aria-label="Attached files">{props.attachments.map((attachment, index) => <div className="composer-file" key={`${attachment.name}-${index}`}>{attachment.mediaType.startsWith("image/") ? <img src={`data:${attachment.mediaType};base64,${attachment.data}`} alt="" /> : <span className="composer-file-icon">▤</span>}<span>{attachment.name}</span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => props.onRemoveAttachment(index)}>×</button></div>)}</div>}
      <div className="composer-actions">
        <input ref={props.attachmentInputRef} className="visually-hidden" type="file" accept={attachmentTypes} multiple onChange={(event) => { props.onFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
        <select className="composer-model-select" aria-label="Conversational model" title="Conversational model" value={props.modelValue} disabled={props.modelDisabled} onChange={(event) => props.onSelectModel(event.target.value)}>{props.modelOptions}</select>
        <button type="button" className={`composer-tool${props.attachments.length ? " is-active" : ""}`} title="Attach files" aria-label="Attach files" onClick={() => props.attachmentInputRef.current?.click()} disabled={props.assistantPending || props.attachments.length >= 3}>＋</button>
        <button className={`mic-button${props.listening ? " is-listening" : ""}`} onClick={props.onToggleMicrophone} aria-pressed={props.listening} title="Push to talk" disabled={props.assistantPending}><MicrophoneIcon /><span>{props.listening ? "STOP" : "VOICE"}</span></button>
        <button className="send-button" onClick={props.assistantPending && props.canCancel ? props.onCancel : props.onSend} disabled={props.assistantPending ? !props.canCancel : !props.value.trim() && !props.attachments.length} aria-label={props.assistantPending && props.canCancel ? "Cancel assistant response" : "Send message"}>{props.assistantPending && props.canCancel ? "■" : "↵"}</button>
      </div>
    </div>
    <div className="safety-copy chat-quota-footer" title={props.usageTitle}>
      <span><strong>{props.usageLabel}</strong> tokens used</span>
      <span><strong>{props.quotaLabel}</strong> quota remaining</span>
      <span><strong>{props.resetLabel}</strong> reset</span>
    </div>
  </section>;
}
