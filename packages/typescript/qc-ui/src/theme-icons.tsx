import type { PresetSnapshot } from "@ndsp-qc/client";
import { QC_COLORS, QC_TYPOGRAPHY } from "@ndsp-qc/theme";

export type QcDirectoryIconName = "grid" | "download" | "cloud" | "folder" | "new-folder" | "sort" | "upload" | "search" | "done";
export type QcEditorIconName = "save" | "change" | "copy" | "paste" | "reset" | "defaults" | "expression" | "looper" | "mute" | "remove" | "assignment-expression" | "band-power" | "footswitch" | "scene-previous" | "scene-next" | "bypass" | "confirm" | "waveform";
export type QcHardwareIconName = "power" | "brand-pulse";
export type QcScreenHeaderGlyphName = "undo" | "save" | "menu";

export function QcHardwareIcon({ kind, className }: { kind: QcHardwareIconName; className?: string }) {
  if (kind === "power") return <svg className={className} viewBox="3 2 18 20" aria-hidden="true"><path d="M12 3v8M7.3 6.4a7.5 7.5 0 1 0 9.4 0" /></svg>;
  return <svg className={className} viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1 3.5 8H7l-1 7 6.5-8H9z" /></svg>;
}

export function QcScreenHeaderGlyph({ kind }: { kind: QcScreenHeaderGlyphName }) {
  if (kind === "undo") return <g fill="none" stroke={QC_COLORS.hardware.whiteLed} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M633 13A13 13 0 1 1 620 26" /><path d="M626 15L634 9V20Z" fill={QC_COLORS.hardware.whiteLed} stroke="none" /></g>;
  if (kind === "save") return <path d="M712 13H728L733 18V35H711V14C711 13.448 711.448 13 712 13ZM716 15V22H727V15H716ZM716 27V35H728V27H716Z" fill={QC_COLORS.hardware.whiteLed} fillRule="evenodd" />;
  return <g fill={QC_COLORS.hardware.whiteLed}><circle cx="766" cy="15" r="2.2" /><circle cx="766" cy="25" r="2.2" /><circle cx="766" cy="35" r="2.2" /></g>;
}

/** Shared CorOS routing glyph vocabulary used by both app hosts. */
export function QcRouteGlyph({ side, label }: { side: "input" | "output"; label: string }) {
  if (label === "Internal") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="2" /><path d="M7.5 12h9M12 7.5v9" /></svg>;
  if (label.startsWith("USB ")) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21V4M12 4 8.5 7.5M12 4l3.5 3.5M12 12H7.5l-2.5-2.5M12 16h4.5l2.5-2.5" /><circle cx="5" cy="9.5" r="1.25" /><rect x="17.5" y="11" width="3" height="3" /></svg>;
  if (label.startsWith("Return ") && label.includes("/")) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 5H11a4 4 0 0 0-4 4v1m0 0L4.5 7.5M7 10l2.5-2.5M20 14h-9a4 4 0 0 0-4 4v1m0 0-2.5-2.5M7 19l2.5-2.5" /></svg>;
  if (label.startsWith("Return ")) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6H12a6 6 0 0 0-6 6v7m0 0-3.5-3.5M6 19l3.5-3.5" /></svg>;
  if (label === "Multi Out") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5a7 7 0 1 0 0 13" /><path d="M7 9h11M7 15h11M15 6l3 3-3 3M15 12l3 3-3 3" /></svg>;
  if (label.startsWith("Send ")) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h5m-2.5-2.5L8 12l-2.5 2.5" /><rect x="8" y="6.5" width="13" height="11" rx="2" /><text x="14.5" y="14.4" textAnchor="middle" fill="currentColor" stroke="none" fontFamily={QC_TYPOGRAPHY.devicePlain} fontWeight="700" fontSize="6.5">FX</text></svg>;
  if (label === "Out 1/2" || label === "Out 1" || label === "Out 2") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="7.6" r="1.15" /><circle cx="8.2" cy="14.2" r="1.15" /><circle cx="15.8" cy="14.2" r="1.15" /></svg>;
  if (label.startsWith("Out ")) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5a7 7 0 1 0 0 13" /><path d="M8 12h12m-3-3 3 3-3 3" /></svg>;
  if (label.includes("/") || label.startsWith("Row ")) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={side === "input" ? "M4 7h13l-3-3m3 3-3 3M4 17h13l-3-3m3 3-3 3" : "M4 7h13m0 0-3-3m3 3-3 3M4 17h13m0 0-3-3m3 3-3 3"} /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="12" r="3" /><path d={side === "input" ? "M10 12h10l-3-3m3 3-3 3" : "M14 12H4l3-3m-3 3 3 3"} /></svg>;
}

export function QcModeGlyph({ mode }: { mode: PresetSnapshot["mode"] }) {
  if (mode === "PRESET") return <g fill="currentColor">{[0, 8, 16].map((y) => <g key={y} transform={`translate(0 ${y})`}><rect x="0" y="1" width="6" height="6" rx=".8" /><rect x="9" y="1" width="6" height="6" rx=".8" /><rect x="18" y="1" width="6" height="6" rx=".8" /><rect x="5" y="3" width="5" height="2" /><rect x="14" y="3" width="5" height="2" /></g>)}</g>;
  if (mode === "SCENE") return <g fill="currentColor" fontFamily={QC_TYPOGRAPHY.devicePlain} fontWeight="800" fontSize="6.5" textAnchor="middle"><rect x="0" y="0" width="11" height="10" rx="1" /><rect x="13" y="0" width="11" height="10" rx="1" /><rect x="0" y="12" width="11" height="10" rx="1" /><rect x="13" y="12" width="11" height="10" rx="1" /><text x="5.5" y="7.2" fill={QC_COLORS.device.panel}>A</text><text x="18.5" y="7.2" fill={QC_COLORS.device.panel}>B</text><text x="5.5" y="19.2" fill={QC_COLORS.device.panel}>C</text><text x="18.5" y="19.2" fill={QC_COLORS.device.panel}>D</text></g>;
  if (mode === "HYBRID") return <g><g transform="scale(.68)"><QcModeGlyph mode="SCENE" /></g><g transform="translate(9 8) scale(.62)"><QcModeGlyph mode="STOMP" /></g></g>;
  return <g transform="translate(-525 -78)" fill="currentColor"><path d="M535.723 79.2008C532.977 81.2508 530.778 82.8924 529.127 84.1255L528.27 84.7656C527.385 85.4269 526.705 85.9358 526.228 86.2924C525.319 86.9726 524.915 87.9041 525.015 89.087L542.055 84.521C541.833 83.0083 542.929 81.2361 545.255 79.1766C544.988 78.8037 544.691 78.4115 544.363 78C542.639 80.0488 540.862 81.2219 539.031 81.5192C537.2 81.8165 536.097 81.0437 535.723 79.2008ZM543.102 84.2407L547.01 83.1933C547.096 82.4398 546.701 81.3799 545.825 80.0139C543.899 81.7499 543.016 83.1667 543.102 84.2407ZM547.559 85.3468L525.619 91.2257C525.399 90.7294 525.237 90.2624 525.135 89.8246L525.201 90.0724L547.243 84.1663L547.559 85.3468ZM529.966 92.3084L533.966 91.2257V94.675L536.966 94.675V98.675H526.966V94.675L529.966 94.675V92.3084Z" /></g>;
}

export function QcDirectoryIcon({ kind }: { kind: QcDirectoryIconName }) {
  if (kind === "grid") return <svg viewBox="0 0 24 24" aria-hidden="true">{[3, 10, 17].flatMap((x) => [3, 10, 17].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="5" height="5" rx=".6" />))}</svg>;
  if (kind === "download") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" /></svg>;
  if (kind === "cloud") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 19h11a4 4 0 0 0 .7-7.94A6.5 6.5 0 0 0 5.7 9.4 4.8 4.8 0 0 0 6.5 19Z" /></svg>;
  if (kind === "folder") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h7l2 2h9v11H3Z" /><rect x="9" y="11" width="6" height="6" rx="1" className="folder-number" /></svg>;
  if (kind === "new-folder") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v11H3ZM7 2v8M3 6h8" /></svg>;
  if (kind === "sort") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h8m-8 6h6m-6 6h10M16 5l2 2 3-4m-5 10 2 2 3-4m-5 8 2 2 3-4" /></svg>;
  if (kind === "upload") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16M12 17V4m-5 5 5-5 5 5M4 6h3m-3 5h3m-3 5h3" /></svg>;
  if (kind === "search") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 13 5 5L20 6" /></svg>;
}

export function QcEditorIcon({ kind }: { kind: QcEditorIconName }) {
  if (kind === "save") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h13l3 3v15H4Z"/><path d="M8 3v6h8V3M8 16h8"/></svg>;
  if (kind === "change") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h15m0 0-3-3m3 3-3 3M20 16H5m0 0 3-3m-3 3 3 3"/></svg>;
  if (kind === "copy") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="4" width="12" height="12" rx="2"/><path d="M16 16v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h2"/></svg>;
  if (kind === "paste") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6H5v15h14V6h-4"/><rect x="8" y="3" width="8" height="5" rx="1.5"/></svg>;
  if (kind === "reset") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8V3m0 5h5M5.8 7.2A8 8 0 1 1 4 15"/></svg>;
  if (kind === "defaults") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4v16M12 4v16M19 4v16M2 9h6M9 15h6M16 8h6"/></svg>;
  if (kind === "expression") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19h12l-1.7-9H8.2ZM8.2 10 9.5 5h5l1.8 5M9 22h6"/></svg>;
  if (kind === "looper") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7a7 7 0 1 1-1.7 7M7 7H3m4 0V3"/><circle cx="12" cy="12" r="2"/></svg>;
  if (kind === "mute") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4ZM17 9l4 6m0-6-4 6"/></svg>;
  if (kind === "remove") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7M10 11v6m4-6v6"/></svg>;
  if (kind === "assignment-expression") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18h12l-1.6-8.4H8.1L6 18Zm2.2-8.4 1-3.6h5.7l1.5 3.6M9 21h6" /></svg>;
  if (kind === "band-power" || kind === "bypass") return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3v12M8.5 7.7a11 11 0 1 0 15 0" /></svg>;
  if (kind === "footswitch") return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 22h14M11 22l1.6-7h6.8l1.6 7M13.5 15l1-5h3l1 5" /></svg>;
  if (kind === "scene-previous") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 3 12l8 8zM21 4l-8 8 8 8z" /></svg>;
  if (kind === "scene-next") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 4 8 8-8 8zM3 4l8 8-8 8z" /></svg>;
  if (kind === "confirm") return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="m8 16.5 5.2 5.1L24.5 10" /></svg>;
  return <svg viewBox="0 0 80 32" aria-hidden="true"><path d="M2 16h11l7-12 14 24L48 4l7 12h23" /></svg>;
}
