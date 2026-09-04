import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { QC_GRID_COLUMNS, QC_GRID_ROWS, type GridBlock, type PresetEntry, type PresetList, type PresetSnapshot } from "@ndsp-qc/client";
import { footswitchLeds, routePickerGroup, routePickerLabel, sceneLetter as sceneLabel, type QcSurfaceAction } from "@ndsp-qc/core";
import type { FormFactorManifest, HardwareControl, SkinManifest } from "@ndsp-qc/form-factors";
import { blockUsesActiveFill, officialBlockVisual, pluginBadge } from "./block-visuals";
import { CorOsParameterEditor, type CorOsParameterEditorProps } from "./parameter-editor";
import { parameterEditorAccent, parameterEditorControlSlots, parameterEditorPageSize } from "./parameter-model";
import { REFERENCE_BLOCK_ICONS } from "./reference-block-icons";
import { DIRECTORY_PRESET_CONTEXT_MENU, GRID_CONTEXT_MENU, gridBlocksByRow, mixAnchorX, openSplitPath, presetTitleLayout, rejoinSplitPath, rowHasVisibleSignalRail, splitAnchorX, type CorOsContextAction } from "./coros-ui";
import "./surface-shell.css";
import "./live-surface.css";

export type { CorOsContextAction } from "./coros-ui";

export type HardwareAction = QcSurfaceAction;

export interface PresetDirectoryState {
  open: boolean;
  list?: PresetList;
  loading: boolean;
  disabled: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onRecall: (entry: PresetEntry) => void;
  onSelectSetlist: (setlistKey: string) => void;
  onPresetAction: (action: "upload" | "edit" | "copy" | "cut" | "paste" | "delete", entry: PresetEntry) => void;
}

export interface CorOsRoutingPickerState {
  row: number;
  side: "input" | "output";
  options: readonly (readonly [number, string])[];
  value: number;
  disabled: boolean;
  onSelect: (value: number) => void;
  onClose: () => void;
}

export interface CorOsSavePresetState {
  open: boolean;
  name: string;
  disabled: boolean;
  onNameChange: (name: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function RoutePickerGlyph({ side, label }: { side: "input" | "output"; label: string }) {
  if (label === "Internal") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="2" /><path d="M7.5 12h9M12 7.5v9" /></svg>;
  if (label.startsWith("USB ")) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21V4M12 4 8.5 7.5M12 4l3.5 3.5M12 12H7.5l-2.5-2.5M12 16h4.5l2.5-2.5" /><circle cx="5" cy="9.5" r="1.25" /><rect x="17.5" y="11" width="3" height="3" /></svg>;
  if (label.startsWith("Return ") && label.includes("/")) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 5H11a4 4 0 0 0-4 4v1m0 0L4.5 7.5M7 10l2.5-2.5M20 14h-9a4 4 0 0 0-4 4v1m0 0-2.5-2.5M7 19l2.5-2.5" /></svg>;
  if (label.startsWith("Return ")) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6H12a6 6 0 0 0-6 6v7m0 0-3.5-3.5M6 19l3.5-3.5" /></svg>;
  if (label === "Multi Out") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5a7 7 0 1 0 0 13" /><path d="M7 9h11M7 15h11M15 6l3 3-3 3M15 12l3 3-3 3" /></svg>;
  if (label.startsWith("Send ")) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h5m-2.5-2.5L8 12l-2.5 2.5" /><rect x="8" y="6.5" width="13" height="11" rx="2" /><text x="14.5" y="14.4" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="6.5">FX</text></svg>;
  if (label === "Out 1/2" || label === "Out 1" || label === "Out 2") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="7.6" r="1.15" /><circle cx="8.2" cy="14.2" r="1.15" /><circle cx="15.8" cy="14.2" r="1.15" /></svg>;
  if (label.startsWith("Out ")) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5a7 7 0 1 0 0 13" /><path d="M8 12h12m-3-3 3 3-3 3" /></svg>;
  if (label.includes("/") || label.startsWith("Row ")) return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={side === "input" ? "M4 7h13l-3-3m3 3-3 3M4 17h13l-3-3m3 3-3 3" : "M4 7h13m0 0-3-3m3 3-3 3M4 17h13m0 0-3-3m3 3-3 3"} /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="12" r="3" /><path d={side === "input" ? "M10 12h10l-3-3m3 3-3 3" : "M14 12H4l3-3m-3 3 3 3"} /></svg>;
}

interface QuadCortexSurfaceProps {
  formFactor: FormFactorManifest;
  snapshot: PresetSnapshot;
  selectedBlockId?: string;
  skin: SkinManifest;
  onAction: (action: HardwareAction) => void;
  onOpenPreset: () => void;
  onUndo: () => void;
  canUndo: boolean;
  undoLabel?: string;
  onSave: () => void;
  onOpenRouting: (row: number, side: "input" | "output") => void;
  onRefresh: () => void;
  presetDirectory?: PresetDirectoryState;
  routingPicker?: CorOsRoutingPickerState;
  savePreset?: CorOsSavePresetState;
  parameterEditor?: CorOsParameterEditorProps;
  onContextAction?: (action: CorOsContextAction) => void;
}

const officialBlockSprite = "/qc-block-samples.svg";
function DeviceGlyph({ block, x, y, size = 64 }: { block: GridBlock; x: number; y: number; size?: number }) {
  const visual = officialBlockVisual(block);
  const [tileX, tileY] = visual.tile;
  const badge = pluginBadge(block);
  const fill = blockUsesActiveFill(block) ? <rect
    className="official-block-active-fill"
    x={x - size / 2}
    y={y - size / 2}
    width={size}
    height={size}
    rx={size * .2}
    fill={visual.color}
    fillOpacity=".3"
    style={{ mixBlendMode: "screen" }}
    pointerEvents="none"
    aria-hidden="true"
  /> : null;
  const pluginLabel = badge ? <g className="official-plugin-badge" aria-hidden="true">
    <rect x={x - size * .225} y={y - size * .565} width={size * .45} height={size * .205} rx={size * .065} fill={visual.color} />
    <text x={x} y={y - size * .405} textAnchor="middle" fill="#111214" stroke="none" fontFamily="Arial, Helvetica, sans-serif" fontWeight="900" fontSize={size * .145}>{badge}</text>
  </g> : null;
  if (visual.referenceAsset) return <g><image className="official-block-tile" x={x - size / 2} y={y - size / 2} width={size} height={size} href={REFERENCE_BLOCK_ICONS[visual.referenceAsset]} preserveAspectRatio="xMidYMid meet" aria-hidden="true" />{fill}{pluginLabel}</g>;
  return <g><svg className="official-block-tile" x={x - size / 2} y={y - size / 2} width={size} height={size} viewBox={`${tileX} ${tileY} 70 70`} preserveAspectRatio="xMidYMid meet" overflow="hidden" aria-hidden="true">
    <image href={officialBlockSprite} x="0" y="0" width="710" height="152" />
    <rect x={tileX + 3} y={tileY + 3} width="64" height="64" rx="14" fill="none" stroke="#000" strokeWidth="5" />
    <rect x={tileX + 3} y={tileY + 3} width="64" height="64" rx="14" fill="none" stroke={visual.color} strokeWidth="2.4" />
  </svg>{fill}{pluginLabel}</g>;
}

function HardwareSwitch({ role, label, active, assigned = false, accent, compact = false, pulseBpm, pulseEpochMs, onAction }: {
  role: string; label: string; active?: boolean; assigned?: boolean; accent?: string; compact?: boolean; pulseBpm?: number; pulseEpochMs?: number; onAction: (action: HardwareAction) => void;
}) {
  const drag = useRef<{ pointerId: number; lastY: number; rotated: boolean } | null>(null);
  const hideValueTimer = useRef<number | undefined>(undefined);
  const [encoderValue, setEncoderValue] = useState(50);
  const [showValue, setShowValue] = useState(false);
  const [pressed, setPressed] = useState(false);
  const rotate = (delta: number) => {
    setEncoderValue((current) => Math.max(0, Math.min(100, current + delta)));
    setShowValue(true);
    if (hideValueTimer.current !== undefined) window.clearTimeout(hideValueTimer.current);
    hideValueTimer.current = window.setTimeout(() => setShowValue(false), 900);
    onAction({ kind: "rotate", role, delta });
  };
  const release = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const gesture = drag.current;
    drag.current = null;
    setPressed(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && gesture && !gesture.rotated) {
      onAction({ kind: "switch", role, phase: "press" });
      onAction({ kind: "switch", role, phase: "release" });
    }
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)) {
      event.preventDefault();
      rotate(event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (event.repeat) return;
      setPressed(true);
      onAction({ kind: "switch", role, phase: "press" });
      onAction({ kind: "switch", role, phase: "release" });
    }
  };
  const wheel = (event: WheelEvent<HTMLButtonElement>) => {
    event.preventDefault();
    rotate(event.deltaY < 0 ? 1 : -1);
  };
  const tempoPeriodMs = pulseBpm ? 60_000 / pulseBpm : undefined;
  const tempoPhaseMs = tempoPeriodMs && pulseEpochMs !== undefined
    ? ((Date.now() - pulseEpochMs) % tempoPeriodMs + tempoPeriodMs) % tempoPeriodMs
    : undefined;
  return <button
    className={`hardware-switch${active ? " is-active" : ""}${pressed ? " is-pressed" : ""}${assigned ? " is-assigned" : ""}${compact ? " is-compact" : ""}${pulseBpm ? " is-tempo-pulse" : ""}`}
    style={{ "--switch-accent": accent ?? "var(--accent)", "--tempo-period": tempoPeriodMs ? `${tempoPeriodMs}ms` : undefined, "--tempo-phase-delay": tempoPhaseMs !== undefined ? `${-tempoPhaseMs}ms` : undefined } as CSSProperties}
    aria-label={`${label} encoder footswitch`} aria-pressed={Boolean(active || pressed)} aria-valuetext={`${encoderValue} percent`}
    title={`${label}: tap to press; drag vertically, use the mouse wheel, or press arrow keys to rotate`}
    onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); drag.current = { pointerId: event.pointerId, lastY: event.clientY, rotated: false }; setPressed(true); }}
    onPointerMove={(event) => {
      const gesture = drag.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const steps = Math.trunc((gesture.lastY - event.clientY) / 12);
      if (!steps) return;
      gesture.rotated = true;
      gesture.lastY -= steps * 12;
      rotate(steps);
    }}
    onPointerUp={(event) => release(event)} onPointerCancel={(event) => release(event, true)} onKeyDown={keyboard} onKeyUp={(event) => { if (event.key === "Enter" || event.key === " ") setPressed(false); }} onBlur={() => setPressed(false)} onWheel={wheel}
  >
    <span className="switch-led" aria-hidden="true" />
    <span className="switch-ring" aria-hidden="true"><span className="switch-cap" /><span className={`rotation-readout${showValue ? " is-visible" : ""}`}>{encoderValue}</span></span>
    <span className="switch-label">{label}</span>
  </button>;
}

function MasterVolume({ value, onAction }: { value: number; onAction: (action: HardwareAction) => void }) {
  const drag = useRef<{ pointerId: number; lastY: number } | null>(null);
  const hideValueTimer = useRef<number | undefined>(undefined);
  const [showValue, setShowValue] = useState(false);
  const rotate = (delta: number) => {
    setShowValue(true);
    if (hideValueTimer.current !== undefined) window.clearTimeout(hideValueTimer.current);
    hideValueTimer.current = window.setTimeout(() => setShowValue(false), 900);
    onAction({ kind: "rotate", role: "master-volume", delta });
  };
  const angle = -135 + value * 2.7;
  return <div className="master-volume">
    <button className="power-button" aria-label="Power and lock menu" onClick={() => onAction({ kind: "switch", role: "power", phase: "release" })}><svg className="power-icon" viewBox="3 2 18 20" aria-hidden="true"><path d="M12 3v8M7.3 6.4a7.5 7.5 0 1 0 9.4 0" /></svg></button>
    <button className="volume-knob" style={{ "--volume-angle": `${angle}deg` } as CSSProperties} aria-label="Master volume knob" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-valuetext={`${value} percent`} title={`Master Volume ${value}; drag vertically, use the mouse wheel, or press arrow keys`} onPointerDown={(event) => {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { pointerId: event.pointerId, lastY: event.clientY };
    }} onPointerMove={(event) => {
      const gesture = drag.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const steps = Math.trunc((gesture.lastY - event.clientY) / 12);
      if (!steps) return;
      gesture.lastY -= steps * 12;
      rotate(steps);
    }} onPointerUp={(event) => {
      drag.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={() => { drag.current = null; }} onKeyDown={(event) => {
      if (!["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)) return;
      event.preventDefault();
      rotate(event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1);
    }} onWheel={(event) => {
      event.preventDefault();
      rotate(event.deltaY < 0 ? 1 : -1);
    }}><span className="volume-pointer" /><span className={`rotation-readout${showValue ? " is-visible" : ""}`}>{value}</span></button>
    <strong>VOLUME</strong>
  </div>;
}

function ModeGlyph({ mode }: { mode: PresetSnapshot["mode"] }) {
  if (mode === "PRESET") {
    return <g fill="#f0f0f0">
      {[0, 8, 16].map((y) => <g key={y} transform={`translate(0 ${y})`}>
        <rect x="0" y="1" width="6" height="6" rx=".8" /><rect x="9" y="1" width="6" height="6" rx=".8" /><rect x="18" y="1" width="6" height="6" rx=".8" />
        <rect x="5" y="3" width="5" height="2" /><rect x="14" y="3" width="5" height="2" />
      </g>)}
    </g>;
  }
  if (mode === "SCENE") {
    return <g fill="#f0f0f0" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="6.5" textAnchor="middle">
      <rect x="0" y="0" width="11" height="10" rx="1" /><rect x="13" y="0" width="11" height="10" rx="1" /><rect x="0" y="12" width="11" height="10" rx="1" /><rect x="13" y="12" width="11" height="10" rx="1" />
      <text x="5.5" y="7.2" fill="#111">A</text><text x="18.5" y="7.2" fill="#111">B</text><text x="5.5" y="19.2" fill="#111">C</text><text x="18.5" y="19.2" fill="#111">D</text>
    </g>;
  }
  if (mode === "HYBRID") {
    return <g><g transform="scale(.68)"><ModeGlyph mode="SCENE" /></g><g transform="translate(9 8) scale(.62)"><ModeGlyph mode="STOMP" /></g></g>;
  }
  return <g transform="translate(-525 -78)"><path d="M535.723 79.2008C532.977 81.2508 530.778 82.8924 529.127 84.1255L528.27 84.7656C527.385 85.4269 526.705 85.9358 526.228 86.2924C525.319 86.9726 524.915 87.9041 525.015 89.087L542.055 84.521C541.833 83.0083 542.929 81.2361 545.255 79.1766C544.988 78.8037 544.691 78.4115 544.363 78C542.639 80.0488 540.862 81.2219 539.031 81.5192C537.2 81.8165 536.097 81.0437 535.723 79.2008ZM543.102 84.2407L547.01 83.1933C547.096 82.4398 546.701 81.3799 545.825 80.0139C543.899 81.7499 543.016 83.1667 543.102 84.2407ZM547.559 85.3468L525.619 91.2257C525.399 90.7294 525.237 90.2624 525.135 89.8246L525.201 90.0724L547.243 84.1663L547.559 85.3468ZM529.966 92.3084L533.966 91.2257V94.675L536.966 94.675V98.675H526.966V94.675L529.966 94.675V92.3084Z" fill="#f0f0f0" /></g>;
}

function DirectoryIcon({ kind }: { kind: "grid" | "download" | "cloud" | "folder" | "new-folder" | "sort" | "upload" | "search" | "done" }) {
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

function CorOsDirectory({ snapshot, directory }: { snapshot: PresetSnapshot; directory: PresetDirectoryState }) {
  const viewingActiveSetlist = directory.list?.setlistKey === snapshot.setlistKey;
  const currentBank = viewingActiveSetlist ? Math.floor(snapshot.presetPosition / 8) + 1 : 1;
  const [selectedBank, setSelectedBank] = useState(currentBank);
  const [presetMenuPosition, setPresetMenuPosition] = useState<number>();
  const [uploadMode, setUploadMode] = useState(false);
  useEffect(() => {
    if (directory.open) setSelectedBank(currentBank);
  }, [currentBank, directory.list?.setlistKey, directory.open]);
  const highestBank = Math.max(1, ...(directory.list?.presets.map((entry) => Math.floor(entry.position / 8) + 1) ?? []));
  const banks = Array.from({ length: highestBank }, (_, index) => index + 1);
  const presets = directory.list?.presets.filter((entry) => Math.floor(entry.position / 8) + 1 === selectedBank) ?? [];
  const factoryFolder = directory.list?.folders.find((folder) => folder.isFactory);
  const userFolders = directory.list?.folders.filter((folder) => !folder.isFactory) ?? [];
  const runPresetAction = (action: "upload" | "edit" | "copy" | "cut" | "paste" | "delete", entry: PresetEntry) => {
    setPresetMenuPosition(undefined);
    directory.onPresetAction(action, entry);
  };

  return <section className="coros-directory" aria-label="Preset Directory">
    <header className="coros-directory-header">
      <button className="directory-category" aria-label="Preset categories"><span className="directory-grid-icon"><DirectoryIcon kind="grid" /></span><strong>Presets</strong><span className="directory-chevron">▼</span></button>
      <div className="directory-tools" aria-label="Directory tools">
        <button aria-label="Sort presets"><DirectoryIcon kind="sort" /></button>
        <button className={uploadMode ? "is-active" : ""} aria-label="Upload to Cloud" aria-pressed={uploadMode} onClick={() => { setPresetMenuPosition(undefined); setUploadMode((active) => !active); }}><DirectoryIcon kind="upload" /></button>
        <button aria-label="Search presets"><DirectoryIcon kind="search" /></button>
        <span className="directory-tool-divider" />
        <button className="directory-close" aria-label="Return to Grid" onClick={directory.onClose}><DirectoryIcon kind="done" /></button>
      </div>
    </header>
    <div className="coros-directory-body">
      <nav className="directory-folders" aria-label="Preset folders">
        <button><span><DirectoryIcon kind="download" /></span>Downloads</button>
        <button><span><DirectoryIcon kind="cloud" /></span>Cloud Presets</button>
        <button className={factoryFolder?.key === directory.list?.setlistKey ? "is-active" : ""} onClick={() => factoryFolder && directory.onSelectSetlist(factoryFolder.key)}><span><DirectoryIcon kind="folder" /></span>Factory Presets</button>
        {userFolders.map((folder) => <button key={folder.key} className={folder.key === directory.list?.setlistKey ? "is-active" : ""} onClick={() => directory.onSelectSetlist(folder.key)}><span><DirectoryIcon kind="folder" /></span>{folder.name}<b>⋮</b></button>)}
        {!userFolders.length && <button className="is-active"><span><DirectoryIcon kind="folder" /></span>{directory.list?.setlistName ?? snapshot.setlistName}<b>⋮</b></button>}
        <button className="directory-new-setlist" disabled><span><DirectoryIcon kind="new-folder" /></span>New Setlist</button>
      </nav>
      <nav className="directory-banks" aria-label="Preset banks">
        {banks.length ? banks.map((bank) => <button key={bank} className={bank === selectedBank ? "is-active" : ""} onClick={() => setSelectedBank(bank)}>{bank}</button>) : <span className="directory-loading">{directory.loading ? "READING…" : "NO BANKS"}</span>}
      </nav>
      <div className="directory-presets" role="listbox" aria-label={`Bank ${selectedBank} presets`}>
        {directory.loading && !directory.list ? <div className="directory-loading">READING PRESETS FROM QUAD CORTEX…</div> : presets.map((entry) => <div key={entry.position} role="option" aria-selected={viewingActiveSetlist && entry.position === snapshot.presetPosition} className={`directory-preset-row${viewingActiveSetlist && entry.position === snapshot.presetPosition ? " is-current" : ""}${uploadMode ? " is-upload-mode" : ""}`}>
          <button className="preset-recall" disabled={directory.disabled} onClick={() => directory.onRecall(entry)}><strong>{entry.location}</strong><span>{entry.name}</span></button>
          {uploadMode ? <button className="preset-upload-action" onClick={() => runPresetAction("upload", entry)}>UPLOAD</button> : <button className="preset-row-more" aria-label={`Open menu for ${entry.location} ${entry.name}`} aria-expanded={presetMenuPosition === entry.position} onClick={() => setPresetMenuPosition((position) => position === entry.position ? undefined : entry.position)}>⋮</button>}
          {presetMenuPosition === entry.position && <div className="preset-context-menu" role="menu" aria-label={`${entry.name} menu`}>
            {DIRECTORY_PRESET_CONTEXT_MENU.map((item) => <button key={item.action} role="menuitem" className={"danger" in item && item.danger ? "context-danger" : undefined} disabled={"requiresPreset" in item && item.requiresPreset && entry.name === "Unsaved"} onClick={() => runPresetAction(item.action, entry)}>{item.label}</button>)}
          </div>}
        </div>)}
      </div>
    </div>
  </section>;
}

function CorOsGrid({ snapshot, selectedBlockId, onAction, onOpenPreset, onUndo, canUndo, undoLabel, onSave, onOpenRouting, onRefresh, presetDirectory, routingPicker, savePreset, onContextAction }: Pick<QuadCortexSurfaceProps, "snapshot" | "selectedBlockId" | "onAction" | "onOpenPreset" | "onUndo" | "canUndo" | "undoLabel" | "onSave" | "onOpenRouting" | "onRefresh" | "presetDirectory" | "routingPicker" | "savePreset" | "onContextAction">) {
  const [sceneMenuOpen, setSceneMenuOpen] = useState(false);
  const [screenMenuOpen, setScreenMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const routePickerGroups = routingPicker ? (routingPicker.side === "input" ? ["MONO", "STEREO", ""] : ["STEREO", "MONO", "OTHER"]).map((name) => ({
    name,
    options: routingPicker.options.filter(([value]) => routePickerGroup(routingPicker.side, value) === name)
  })).filter((group) => group.options.length) : [];
  const selectedRoute = routingPicker?.options.find(([value]) => value === routingPicker.value);
  const runGridMenuAction = (action: (typeof GRID_CONTEXT_MENU)[number]["action"]) => {
    setScreenMenuOpen(false);
    if (action === "save-as") onSave();
    else onContextAction?.(action);
  };
  const columns = [98, 184, 273, 361, 448, 528, 616, 703];
  const rowY = [151, 243, 338, 430];
  const screenBlocks = snapshot.blocks.filter((block) => block.row >= 0 && block.row < QC_GRID_ROWS && block.column >= 0 && block.column < QC_GRID_COLUMNS);
  const tabBlocksByRow = gridBlocksByRow(screenBlocks);
  const sceneLetter = sceneLabel(snapshot.activeScene);
  const presetBank = snapshot.presetLocation.slice(0, -1);
  const presetSlot = snapshot.presetLocation.slice(-1);
  const presetLocation = `${presetBank}${presetSlot}`;
  const presetTitle = `${snapshot.presetName}${snapshot.dirty ? "*" : ""}`;
  const measureHeaderText = (text: string, italic = false) => {
    if (typeof document === "undefined") return text.length * 40;
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return text.length * 40;
    context.font = `${italic ? "italic " : ""}800 68px Arial`;
    return context.measureText(text).width;
  };
  const presetLocationWidth = measureHeaderText(presetLocation) - Math.max(0, presetLocation.length - 1);
  // The official header reserves a clear gutter before Undo. Derive the title
  // width from its actual start so multi-digit banks cannot push it underneath
  // the icon while retaining the QC's natural inline bank/slot/name flow.
  const presetTitleWidthAtFullSize = measureHeaderText(presetTitle, snapshot.dirty);
  const {
    start: presetTitleStart,
    maxWidth: presetTitleMaxWidth,
    fontSize: presetTitleFontSize,
    squeeze: squeezePresetTitle,
    baseline: presetTitleBaseline
  } = presetTitleLayout(presetLocationWidth, presetTitleWidthAtFullSize);
  const routes = rowY.map((_, row) => snapshot.routes.find((route) => route.row === row));
  const displayInput = (row: number) => {
    const input = routes[row]?.input;
    if (input !== "Internal") return input;
    if (row === 2 && ["Row 3", "Rows 3/4"].includes(routes[0]?.output ?? "")) return "Prev. Row";
    return "+";
  };
  const displayOutput = (row: number) => routes[row]?.output === "Internal" ? "+" : routes[row]?.output;
  const routeLines = (label: string | undefined) => {
    const value = label ?? "+";
    const words = value.split(" ");
    return words.length > 1 ? [words[0], words.slice(1).join(" ")] : [value];
  };
  const railLabel = (label: string | undefined, x: number, y: number) => {
    const lines = routeLines(label);
    if (label === "+") return <g stroke="#dedede" strokeWidth="1.7" strokeLinecap="round"><path d={`M${x - 10} ${y}h20`} /><path d={`M${x} ${y - 10}v20`} /></g>;
    const firstY = y - (lines.length - 1) * 8.5;
    return <text x={x} y={firstY} fill="#e6e6e6" stroke="none" fontFamily="Helvetica Neue, Helvetica, Arial, sans-serif" fontWeight="400" fontSize="14.5">{lines.map((line, index) => <tspan key={`${line}-${index}`} x={x} dy={index ? 17 : 0}>{line}</tspan>)}</text>;
  };
  const rowRail = (row: number) => rowHasVisibleSignalRail(tabBlocksByRow[row].length, routes[row])
    ? <path key={`row-${row}`} d={`M52 ${rowY[row]}H748`} />
    : null;
  const routeToken = (kind: "S" | "M", x: number, y: number, row: number) => {
    const color = kind === "S" ? "#0a74e0" : "#e44a5d";
    const node = kind === "S" ? "splitter" : "mixer";
    const selected = selectedBlockId === `routing-${row}-${node}`;
    return <g>
      {selected && <circle cx={x} cy={y} r="18" fill="none" stroke="#fff" strokeWidth="2" />}
      <circle cx={x} cy={y} r="15" fill="#000" stroke="none" />
      <circle cx={x} cy={y} r="13" fill={color} stroke="none" />
      <text x={x} y={y + 5.5} textAnchor="middle" fill="#fff" stroke="none" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="16">{kind}</text>
    </g>;
  };
  const splitPath = (row: number) => {
    const route = routes[row];
    if (route?.splitColumn === undefined || row >= rowY.length - 1) return null;
    const splitX = splitAnchorX(route.splitColumn);
    const rejoins = route.mixColumn !== undefined && route.mixColumn >= 0;
    const mixX = rejoins ? mixAnchorX(route.mixColumn!) : 748;
    return <g key={`split-${row}`} fill="none" stroke="#8f9092" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={openSplitPath(splitX, rowY[row], rowY[row + 1])} />
      {rejoins && <path d={rejoinSplitPath(mixX, rowY[row], rowY[row + 1])} />}
      {routeToken("S", splitX, rowY[row], row)}
      {rejoins && routeToken("M", mixX, rowY[row], row)}
    </g>;
  };
  const renderBlock = (block: GridBlock) => {
    const cx = columns[block.column];
    const cy = rowY[block.row];
    const selected = selectedBlockId === block.id;
    return <g key={block.id} opacity={block.bypassed ? .48 : 1}>
      <DeviceGlyph block={block} x={cx} y={cy} />
      {selected && <rect x={cx - 34} y={cy - 34} width="68" height="68" rx="15" fill="none" stroke="#f5f5f5" strokeWidth="2" />}
      {block.bypassed && <path d={`M${cx - 32} ${cy}H${cx + 32}`} fill="none" stroke="#c9c9ca" strokeWidth="2" opacity=".9" />}
    </g>;
  };
  const rowActionStops = (row: number) => {
    const route = routes[row];
    const stops = tabBlocksByRow[row].map((block) => ({
      key: block.id,
      x: columns[block.column],
      element: <button key={block.id} className="coros-vector-block-hit" style={{ left: `${columns[block.column] / 8}%`, top: `${rowY[block.row] / 4.8}%` }} title={`Row ${block.row + 1}, ${block.name}`} aria-label={`Row ${block.row + 1}, ${block.name}`} aria-pressed={selectedBlockId === block.id} onClick={() => onAction({ kind: "select-block", blockId: block.id })} />
    }));
    if (route?.splitColumn !== undefined && row < rowY.length - 1) {
      const splitX = splitAnchorX(route.splitColumn);
      const splitId = `routing-${row}-splitter`;
      stops.push({
        key: splitId,
        x: splitX,
        element: <button key={splitId} className="coros-vector-route-node-hit" style={{ left: `${splitX / 8}%`, top: `${rowY[row] / 4.8}%` }} title={`Open row ${row + 1} Splitter parameters`} aria-label={`Row ${row + 1} Splitter parameters`} aria-pressed={selectedBlockId === splitId} onClick={() => onAction({ kind: "select-routing-node", row, node: "splitter" })} />
      });
      if (route.mixColumn !== undefined && route.mixColumn >= 0) {
        const mixX = mixAnchorX(route.mixColumn);
        const mixId = `routing-${row}-mixer`;
        stops.push({
          key: mixId,
          x: mixX,
          element: <button key={mixId} className="coros-vector-route-node-hit" style={{ left: `${mixX / 8}%`, top: `${rowY[row] / 4.8}%` }} title={`Open row ${row + 1} Mixer parameters`} aria-label={`Row ${row + 1} Mixer parameters`} aria-pressed={selectedBlockId === mixId} onClick={() => onAction({ kind: "select-routing-node", row, node: "mixer" })} />
        });
      }
    }
    return stops.sort((left, right) => left.x - right.x).map((stop) => stop.element);
  };
  return <div className="qc-screen coros-vector-screen" aria-label="CorOS Grid">
    <svg className="coros-vector-canvas" viewBox="0 0 800 480" preserveAspectRatio="none" role="img" aria-label={`${snapshot.presetLocation} ${snapshot.presetName}, ${snapshot.mode} mode`}>
      <rect width="800" height="480" fill="#020202" />
      <g transform="matrix(.96 0 0 1 -4 0)" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="68"><text x="14" y="75"><tspan fill="#f4f4f4" letterSpacing="-1">{presetBank}</tspan><tspan fill="#3ee77b" letterSpacing="-1">{presetSlot}</tspan><tspan className={`preset-title${snapshot.dirty ? " is-dirty" : ""}`} dx="16" dy={presetTitleBaseline - 75} fill="#f4f4f4" fontSize={presetTitleFontSize} fontStyle={snapshot.dirty ? "italic" : "normal"} textLength={squeezePresetTitle ? presetTitleMaxWidth : undefined} lengthAdjust={squeezePresetTitle ? "spacingAndGlyphs" : undefined}>{presetTitle}</tspan></text></g>
      <g fill="none" stroke="#f0f0f0" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M633 13A13 13 0 1 1 620 26" />
        <path d="M626 15L634 9V20Z" fill="#f0f0f0" stroke="none" />
      </g>
      <path
        d="M712 13H728L733 18V35H711V14C711 13.448 711.448 13 712 13ZM716 15V22H727V15H716ZM716 27V35H728V27H716Z"
        fill="#f0f0f0"
        fillRule="evenodd"
      />
      <rect x="654" y="9" width="31" height="31" rx="4" fill="#f2cf32" /><text x="669.5" y="34" textAnchor="middle" fill="#141414" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="25">{sceneLetter}</text>
      <g fill="#f2f2f2"><circle cx="766" cy="15" r="2.2" /><circle cx="766" cy="25" r="2.2" /><circle cx="766" cy="35" r="2.2" /></g>
      <g transform="translate(652 55)"><ModeGlyph mode={snapshot.mode} /></g><text x="681" y="76" fill="#f0f0f0" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="22.5">{snapshot.mode}</text>
      <g fill="#171719" stroke="#050505" strokeWidth="1.5" fontFamily="Helvetica Neue, Helvetica, Arial, sans-serif" textAnchor="middle">
        {rowY.flatMap((y, row) => [<rect key={`in-${row}`} x="8" y={y - 39} width="44" height="78" rx="15" />, <rect key={`out-${row}`} x="748" y={y - 39} width="44" height="78" rx="15" />])}
        <path d="M19 118h22" stroke="#f28c22" strokeWidth="3" strokeLinecap="round" />
        {rowY.map((y, row) => <g key={`rails-${row}`}>{railLabel(displayInput(row), 30, y)}{railLabel(displayOutput(row), 770, y)}</g>)}
      </g>
      <g fill="none" stroke="#8f9092" strokeWidth="1.4">{rowY.map((_, row) => rowRail(row))}</g>
      {rowY.map((_, row) => splitPath(row))}
      <g>{screenBlocks.map(renderBlock)}</g>
    </svg>
    <div className="coros-vector-actions" aria-label="Grid controls">
      <button className="vector-action-hit preset-title-hit" title="Open device Directory" aria-label={`Open preset Directory; current preset ${snapshot.presetLocation} ${snapshot.presetName}`} onClick={() => { setSceneMenuOpen(false); setScreenMenuOpen(false); setModeMenuOpen(false); onOpenPreset(); }} />
      <button className="vector-action-hit undo-hit" title={canUndo ? `Undo ${undoLabel ?? "last action"}` : "Nothing to undo"} aria-label={canUndo ? `Undo ${undoLabel ?? "last action"}` : "Nothing to undo"} onClick={onUndo} />
      <button className="vector-action-hit scene-hit" aria-label="Select scene" aria-expanded={sceneMenuOpen} onClick={() => { setScreenMenuOpen(false); setModeMenuOpen(false); setSceneMenuOpen((open) => !open); }} />
      <button className="vector-action-hit save-hit" title="Save preset to Quad Cortex" aria-label="Save preset to Quad Cortex" onClick={onSave} />
      <button className="vector-action-hit more-hit" title="Grid menu" aria-label="Open Grid menu" aria-expanded={screenMenuOpen} onClick={() => { setSceneMenuOpen(false); setModeMenuOpen(false); setScreenMenuOpen((open) => !open); }} />
      <button className="vector-action-hit mode-hit" title="Mode menu" aria-label={`Open mode menu; current mode ${snapshot.mode}`} aria-expanded={modeMenuOpen} onClick={() => { setSceneMenuOpen(false); setScreenMenuOpen(false); setModeMenuOpen((open) => !open); }} />
      {rowY.map((_, row) => <div key={`line-hits-${row}`} role="group" aria-label={`Signal line ${row + 1}`}>
        <button className="vector-route-hit input-route-hit" style={{ top: `${(108 + row * 94) / 4.8}%` }} aria-label={`Edit row ${row + 1} input`} title={`Edit row ${row + 1} input`} onClick={() => onOpenRouting(row, "input")} />
        {rowActionStops(row)}
        <button className="vector-route-hit output-route-hit" style={{ top: `${(108 + row * 94) / 4.8}%` }} aria-label={`Edit row ${row + 1} output`} title={`Edit row ${row + 1} output`} onClick={() => onOpenRouting(row, "output")} />
      </div>)}
    </div>
    {sceneMenuOpen && <div className="scene-dropdown vector-scene-dropdown" role="menu" aria-label="Scenes">{snapshot.scenes.map((scene, index) => <button key={scene} role="menuitem" className={snapshot.activeScene === index ? "is-active" : ""} onClick={() => { setSceneMenuOpen(false); onAction({ kind: "select-scene", scene: index }); }}><span>{sceneLabel(index)}</span>{scene}</button>)}</div>}
    {modeMenuOpen && <div className="scene-dropdown vector-mode-dropdown" role="menu" aria-label="Modes">{(snapshot.modeSlots ?? (["PRESET", "SCENE", "STOMP"] as const).map((mode, slot) => ({ slot: slot as 0 | 1 | 2, label: mode, mode }))).map((entry) => <button key={`${entry.slot}-${entry.label}`} role="menuitem" className={snapshot.mode === entry.mode ? "is-active" : ""} onClick={() => { setModeMenuOpen(false); onAction({ kind: "select-mode-slot", slot: entry.slot }); }}>{entry.label}</button>)}</div>}
    {screenMenuOpen && <div className="coros-screen-menu" role="menu" aria-label="Grid contextual menu">
      {GRID_CONTEXT_MENU.slice(0, 6).map((item) => <button key={item.label} role="menuitem" className={"danger" in item && item.danger ? "context-danger" : ""} onClick={() => runGridMenuAction(item.action)}><span className="context-menu-icon">{item.icon}</span>{item.label}</button>)}
      <div className="context-menu-section">QUAD CORTEX</div>
      {GRID_CONTEXT_MENU.slice(6).map((item) => <button key={item.label} role="menuitem" onClick={() => runGridMenuAction(item.action)}><span className="context-menu-icon">{item.icon}</span>{item.label}</button>)}
    </div>}
    {routingPicker && <>
      <button className="coros-route-picker-dismiss" aria-label="Close route selection" onClick={routingPicker.onClose} />
      <svg className="coros-route-focus-layer" viewBox="0 0 800 480" preserveAspectRatio="none" aria-hidden="true">
        <rect width="800" height="480" fill="#f3f3f3" fillOpacity=".86" />
        <rect x={routingPicker.side === "input" ? 8 : 748} y={rowY[routingPicker.row] - 39} width="44" height="78" rx="15" fill="#171719" stroke="#050505" strokeWidth="1.5" />
        <g textAnchor="middle">{railLabel(routingPicker.side === "input" ? displayInput(routingPicker.row) : displayOutput(routingPicker.row), routingPicker.side === "input" ? 30 : 770, rowY[routingPicker.row])}</g>
      </svg>
      <section className={`coros-route-picker is-${routingPicker.side}`} aria-label={`Row ${routingPicker.row + 1} ${routingPicker.side} selection`}>
        <header><RoutePickerGlyph side={routingPicker.side} label={selectedRoute?.[1] ?? "Internal"} /><span>{routePickerLabel(routingPicker.side, selectedRoute?.[1] ?? "Internal")}</span></header>
        <div className="coros-route-options" role="listbox" aria-label={`${routingPicker.side === "input" ? "Input" : "Output"} routes`}>
          {routePickerGroups.map((group) => <div className="coros-route-group" role="group" aria-label={group.name || "Unassigned"} key={group.name || "unassigned"}>
            {group.name && <strong>{group.name}</strong>}
            {group.options.map(([value, label]) => <button key={value} role="option" aria-selected={value === routingPicker.value} disabled={routingPicker.disabled} onClick={() => routingPicker.onSelect(value)}><RoutePickerGlyph side={routingPicker.side} label={label} /><span>{routePickerLabel(routingPicker.side, label)}</span></button>)}
          </div>)}
        </div>
      </section>
    </>}
    {savePreset?.open && <section className="coros-save-preset" aria-label={`Save preset to ${snapshot.presetLocation}`}>
      <header><button type="button" onClick={savePreset.onCancel} disabled={savePreset.disabled}>CANCEL</button><strong>SAVE PRESET</strong><button type="button" className="is-primary" onClick={savePreset.onSave} disabled={savePreset.disabled || !savePreset.name.trim()}>SAVE</button></header>
      <div className="coros-save-location"><span>DESTINATION</span><strong>{snapshot.setlistName}</strong><b>{snapshot.presetLocation}</b></div>
      <label className="coros-save-name"><span>PRESET NAME</span><input autoFocus maxLength={80} value={savePreset.name} disabled={savePreset.disabled} onChange={(event) => savePreset.onNameChange(event.target.value)} /></label>
      <div className="coros-save-keyboard" aria-label="Preset name keyboard">
        {["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"].map((row) => <div key={row}>{[...row].map((letter) => <button type="button" key={letter} disabled={savePreset.disabled || savePreset.name.length >= 80} onClick={() => savePreset.onNameChange(`${savePreset.name}${letter}`)}>{letter}</button>)}</div>)}
        <div className="keyboard-actions"><button type="button" disabled={savePreset.disabled || !savePreset.name} onClick={() => savePreset.onNameChange(savePreset.name.slice(0, -1))}>⌫</button><button type="button" className="space-key" disabled={savePreset.disabled || savePreset.name.length >= 80} onClick={() => savePreset.onNameChange(`${savePreset.name} `)}>SPACE</button></div>
      </div>
    </section>}
    {presetDirectory?.open && <CorOsDirectory snapshot={snapshot} directory={presetDirectory} />}
  </div>;
}

function controlByRole(controls: HardwareControl[], role: string) { return controls.find((control) => control.role === role); }

export function QuadCortexSurface({ formFactor, snapshot, selectedBlockId, skin, onAction, onOpenPreset, onUndo, canUndo, undoLabel, onSave, onOpenRouting, onRefresh, presetDirectory, routingPicker, savePreset, parameterEditor, onContextAction }: QuadCortexSurfaceProps) {
  const scenes = formFactor.controls.filter((control) => control.group === "scene");
  const bankUp = controlByRole(formFactor.controls, "bank:up")!;
  const bankDown = controlByRole(formFactor.controls, "bank:down")!;
  const tempo = controlByRole(formFactor.controls, "tempo")!;
  const leds = footswitchLeds(snapshot);
  const parameterLeds = parameterEditor ? (() => {
    const editorAccent = parameterEditorAccent(parameterEditor.details.name, parameterEditor.accent);
    const size = parameterEditorPageSize(parameterEditor.details.category, parameterEditor.details.parameters);
    const visible = parameterEditorControlSlots(
      parameterEditor.details.parameters.filter((parameter) => parameter.normalizedValue !== null),
      parameterEditor.details.category,
      parameterEditor.page,
      size
    );
    return Array.from({ length: 10 }, (_, index) => ({
      active: Boolean(visible[index]),
      assigned: Boolean(visible[index]),
      color: /\bcab\b/i.test(parameterEditor.details.category) && (
        (parameterEditor.page === 0 && index >= 5 && index <= 8)
        || (parameterEditor.page === 1 && index === 2)
      ) ? "#ffd236" : editorAccent
    }));
  })() : undefined;
  const parameterLed = (slot: number, fallback: { active: boolean; assigned: boolean; color: string }) => parameterLeds?.[slot] ?? fallback;
  const navigationLedColor = "#f4f4f4";
  const bankDownLed = parameterLed(4, { active: false, assigned: false, color: navigationLedColor });
  const svgCropStyle = skin.svgAsset ? {
    width: `${skin.svgAsset.sourceWidth / skin.svgAsset.crop.width * 100}%`,
    left: `${-skin.svgAsset.crop.x / skin.svgAsset.crop.width * 100}%`,
    top: `${-skin.svgAsset.crop.y / skin.svgAsset.crop.height * 100}%`
  } as CSSProperties : undefined;
  return <section className={`qc-chassis ${skin.className}`} aria-label={formFactor.displayName}>
    {skin.svgAsset && <div className="official-svg-viewport" aria-hidden="true"><img className="official-svg-source" src={`${skin.svgAsset.url}#qc-foreground`} alt="" style={svgCropStyle} /></div>}
    <div className="chassis-edge" aria-hidden="true" />
    <MasterVolume value={snapshot.masterVolume} onAction={onAction} />
    <div className="device-plate"><svg className="pulse-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1 3.5 8H7l-1 7 6.5-8H9z" /></svg><span>QUADCORTEX</span><small>CONTROL SURFACE</small></div>
    <div className="qc-screen-bezel"><CorOsGrid snapshot={snapshot} selectedBlockId={selectedBlockId} onAction={onAction} onOpenPreset={onOpenPreset} onUndo={onUndo} canUndo={canUndo} undoLabel={undoLabel} onSave={onSave} onOpenRouting={onOpenRouting} onRefresh={onRefresh} presetDirectory={presetDirectory} routingPicker={routingPicker} savePreset={savePreset} onContextAction={onContextAction} />{parameterEditor && <CorOsParameterEditor {...parameterEditor} />}</div>
    <div className="screen-nav-control"><span className="nav-arrow nav-arrow-up" /><HardwareSwitch role={bankUp.role} label="BANK UP" compact active={Boolean(parameterEditor)} assigned={Boolean(parameterEditor)} accent={navigationLedColor} onAction={onAction} /><span className="nav-arrow nav-arrow-down" /></div>
    <div className="footswitch-deck">
      <div className="footswitch-row">{scenes.slice(0, 4).map((control, index) => { const led = parameterLed(index, leds[index]); return <HardwareSwitch key={control.id} role={control.role} label={control.label} active={led.active} assigned={led.assigned} accent={led.color} onAction={onAction} />; })}<HardwareSwitch role={bankDown.role} label="BANK DOWN" active={bankDownLed.active} assigned={bankDownLed.assigned} accent={bankDownLed.color} onAction={onAction} /></div>
      <div className="mode-bracket" aria-hidden="true"><span>＋</span><strong>MODE</strong><span>−</span></div>
      <div className="footswitch-row">{scenes.slice(4).map((control, index) => { const led = parameterLed(index + 5, leds[index + 4]); return <HardwareSwitch key={control.id} role={control.role} label={control.label} active={led.active} assigned={led.assigned} accent={led.color} onAction={onAction} />; })}<HardwareSwitch role={tempo.role} label="TEMPO" active={parameterLeds ? parameterLeds[9].active : snapshot.tempoLedEnabled} assigned={parameterLeds ? parameterLeds[9].assigned : snapshot.tempoLedEnabled} pulseBpm={!parameterLeds && snapshot.tempoLedEnabled ? snapshot.tempo : undefined} pulseEpochMs={!parameterLeds ? snapshot.tempoPulseEpochMs : undefined} accent={parameterLeds ? parameterLeds[9].color : "#35ee76"} onAction={onAction} /></div>
      <span className="tuner-hint">TEMPO<br />HOLD: TUNER</span>
    </div>
  </section>;
}
