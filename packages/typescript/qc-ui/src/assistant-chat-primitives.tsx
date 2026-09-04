import { useEffect, useRef, useState } from "react";
import type { AssistantAccessMode } from "@ndsp-qc/core";
import { QcUiIcon } from "./theme-icons";

export interface AssistantAttachment {
  name: string;
  mediaType: string;
  data: string;
}

export const ASSISTANT_ACCESS_OPTIONS: ReadonlyArray<{ value: AssistantAccessMode; label: string }> = [
  { value: "read-only", label: "Read-only" },
  { value: "performance", label: "Performance" },
  { value: "modify", label: "Modify" },
  { value: "full", label: "Full control" }
];

export function AssistantAccessSelect(props: {
  value: AssistantAccessMode;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  onChange: (value: AssistantAccessMode) => void;
}) {
  return <select
    className={props.className}
    value={props.value}
    disabled={props.disabled}
    aria-label={props.ariaLabel ?? "Assistant device access"}
    onChange={(event) => props.onChange(event.target.value as AssistantAccessMode)}
  >
    {ASSISTANT_ACCESS_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
  </select>;
}

export function AssistantAttachmentList<TAttachment extends AssistantAttachment>(props: {
  attachments?: readonly TAttachment[];
  className?: string;
  imageClassName?: string;
  fileClassName?: string;
}) {
  if (!props.attachments?.length) return null;
  return <div className={props.className}>
    {props.attachments.map((attachment, index) => attachment.mediaType.startsWith("image/")
      ? <img className={props.imageClassName} key={`${attachment.name}-${index}`} src={`data:${attachment.mediaType};base64,${attachment.data}`} alt={attachment.name} />
      : <span className={props.fileClassName} key={`${attachment.name}-${index}`}><QcUiIcon kind="file" /> {attachment.name}</span>)}
  </div>;
}

export function CollapsibleAssistantResult({ text }: { text: string }) {
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
