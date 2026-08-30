import type { PresetSnapshot } from "@ndsp-qc/client";

export type AssistantIntent =
  | { kind: "inspect" }
  | { kind: "scene"; index: number }
  | { kind: "bank"; direction: -1 | 1 }
  | { kind: "view"; view: "tuner" | "gig" }
  | { kind: "recall"; location: string }
  | { kind: "tempo"; bpm: number }
  | { kind: "bypass"; desired: "bypassed" | "enabled" | "toggle" }
  | { kind: "parameter"; parameter: string; value: string }
  | { kind: "help" };

export function parseAssistantIntent(input: string): AssistantIntent {
  const value = input.trim();
  const normalized = value.toLowerCase().replace(/[?.!]+$/g, "").trim();

  const tempo = normalized.match(/^(?:set|change|adjust)\s+(?:the\s+)?tempo\s+(?:to|at)\s+(\d{2,3})(?:\s*bpm)?$/);
  if (tempo) return { kind: "tempo", bpm: Number(tempo[1]) };

  const parameter = normalized.match(/^(?:set|change|adjust)\s+(.+?)\s+(?:to|at)\s+(.+)$/);
  if (parameter) return { kind: "parameter", parameter: parameter[1].trim(), value: parameter[2].trim() };

  const scene = normalized.match(/(?:^|\b)(?:select|switch to|go to|activate)?\s*scene\s+([a-h1-8])\b/);
  if (scene) {
    const token = scene[1];
    return { kind: "scene", index: /^[1-8]$/.test(token) ? Number(token) - 1 : token.charCodeAt(0) - 97 };
  }

  const recall = normalized.match(/^(?:recall|load|open|switch to)\s+(?:preset\s+)?(\d{1,2}[a-h])$/);
  if (recall) return { kind: "recall", location: recall[1].toUpperCase() };
  if (/\bbank\s+(?:up|next)\b|\bnext\s+bank\b/.test(normalized)) return { kind: "bank", direction: 1 };
  if (/\bbank\s+(?:down|previous|prev)\b|\bprevious\s+bank\b/.test(normalized)) return { kind: "bank", direction: -1 };
  if (/\b(?:open|show)?\s*tuner\b/.test(normalized)) return { kind: "view", view: "tuner" };
  if (/\b(?:open|show)?\s*gig\s+view\b/.test(normalized)) return { kind: "view", view: "gig" };
  if (/\b(?:bypass|mute|turn off)\b.*\b(?:selected|block|effect)?\b/.test(normalized)) return { kind: "bypass", desired: "bypassed" };
  if (/\b(?:enable|unbypass|turn on)\b.*\b(?:selected|block|effect)?\b/.test(normalized)) return { kind: "bypass", desired: "enabled" };
  if (/\btoggle\b.*\b(?:bypass|selected|block|effect)\b/.test(normalized)) return { kind: "bypass", desired: "toggle" };
  if (/\b(?:what|which|show|inspect|status|current|tell me)\b/.test(normalized) || normalized === "where am i") return { kind: "inspect" };
  return { kind: "help" };
}

export function formatSnapshotSummary(snapshot: PresetSnapshot): string {
  const active = snapshot.blocks.filter((block) => block.bypassed === false).length;
  const bypassed = snapshot.blocks.filter((block) => block.bypassed === true).length;
  return `${snapshot.deviceName} is on ${snapshot.setlistName} ${snapshot.presetLocation} · ${snapshot.presetName}, Scene ${String.fromCharCode(65 + snapshot.activeScene)} (${snapshot.scenes[snapshot.activeScene] ?? "unnamed"}), ${snapshot.tempo} BPM. The Grid has ${snapshot.blocks.length} blocks (${active} active, ${bypassed} bypassed) and is ${snapshot.dirty ? "modified but not saved" : "clean"}.`;
}

export const assistantHelp = "Try “what preset is active?”, “scene C”, “bank up”, “recall 6B”, “set tempo to 120”, “open tuner”, “bypass selected block”, or “set Gain to 55%”. Performance actions run immediately; temporary edits show a preview first.";
