import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { QC_GRID_COLUMNS, QC_GRID_ROWS, type GridBlock, type PresetEntry, type PresetList, type PresetSnapshot } from "@ndsp-qc/client";
import { footswitchLeds, routePickerGroup, routePickerLabel, sceneLetter as sceneLabel, type QcSurfaceAction } from "@ndsp-qc/core";
import type { FormFactorManifest, HardwareControl, SkinManifest } from "@ndsp-qc/form-factors";
import { QC_COLORS, QC_VISUAL_ASSETS } from "@ndsp-qc/theme";
import { blockUsesActiveFill, officialBlockVisual, pluginBadge } from "./block-visuals";
import { CorOsParameterEditor, type CorOsParameterEditorProps } from "./parameter-editor";
import { parameterEditorAccent, parameterEditorControlSlots, parameterEditorPageSize } from "./parameter-model";
import { REFERENCE_BLOCK_ICONS } from "./reference-block-icons";
import { QcDirectoryIcon, QcModeGlyph, QcRouteGlyph } from "./theme-icons";
import { DIRECTORY_PRESET_CONTEXT_MENU, GRID_CONTEXT_MENU, gridBlocksByRow, mixAnchorX, openSplitPath, presetTitleLayout, presetTitlePresentation, rejoinSplitPath, routedPortIsPlugged, rowHasVisibleSignalRail, splitAnchorX, type CorOsContextAction } from "./coros-ui";
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

const officialBlockSprite = QC_VISUAL_ASSETS.blockSprite.url;

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
    <text x={x} y={y - size * .405} textAnchor="middle" fill={QC_COLORS.device.blockLabel} stroke="none" fontFamily="Arial, Helvetica, sans-serif" fontWeight="900" fontSize={size * .145}>{badge}</text>
  </g> : null;
  if (visual.referenceAsset) return <g><image className="official-block-tile" x={x - size / 2} y={y - size / 2} width={size} height={size} href={REFERENCE_BLOCK_ICONS[visual.referenceAsset]} preserveAspectRatio="xMidYMid meet" aria-hidden="true" />{fill}{pluginLabel}</g>;
  return <g><svg className="official-block-tile" x={x - size / 2} y={y - size / 2} width={size} height={size} viewBox={`${tileX} ${tileY} 70 70`} preserveAspectRatio="xMidYMid meet" overflow="hidden" aria-hidden="true">
    <image href={officialBlockSprite} x="0" y="0" width="710" height="152" />
    <rect x={tileX + 3} y={tileY + 3} width="64" height="64" rx="14" fill="none" stroke={QC_COLORS.captured.screen} strokeWidth="5" />
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
  const tempoPhaseMs = useMemo(() => tempoPeriodMs && pulseEpochMs !== undefined
    ? ((Date.now() - pulseEpochMs) % tempoPeriodMs + tempoPeriodMs) % tempoPeriodMs
    : undefined, [tempoPeriodMs, pulseEpochMs]);
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
      <button className="directory-category" aria-label="Preset categories"><span className="directory-grid-icon"><QcDirectoryIcon kind="grid" /></span><strong>Presets</strong><span className="directory-chevron">▼</span></button>
      <div className="directory-tools" aria-label="Directory tools">
        <button aria-label="Sort presets"><QcDirectoryIcon kind="sort" /></button>
        <button className={uploadMode ? "is-active" : ""} aria-label="Upload to Cloud" aria-pressed={uploadMode} onClick={() => { setPresetMenuPosition(undefined); setUploadMode((active) => !active); }}><QcDirectoryIcon kind="upload" /></button>
        <button aria-label="Search presets"><QcDirectoryIcon kind="search" /></button>
        <span className="directory-tool-divider" />
        <button className="directory-close" aria-label="Return to Grid" onClick={directory.onClose}><QcDirectoryIcon kind="done" /></button>
      </div>
    </header>
    <div className="coros-directory-body">
      <nav className="directory-folders" aria-label="Preset folders">
        <button><span><QcDirectoryIcon kind="download" /></span>Downloads</button>
        <button><span><QcDirectoryIcon kind="cloud" /></span>Cloud Presets</button>
        <button className={factoryFolder?.key === directory.list?.setlistKey ? "is-active" : ""} onClick={() => factoryFolder && directory.onSelectSetlist(factoryFolder.key)}><span><QcDirectoryIcon kind="folder" /></span>Factory Presets</button>
        {userFolders.map((folder) => <button key={folder.key} className={folder.key === directory.list?.setlistKey ? "is-active" : ""} onClick={() => directory.onSelectSetlist(folder.key)}><span><QcDirectoryIcon kind="folder" /></span>{folder.name}<b>⋮</b></button>)}
        {!userFolders.length && <button className="is-active"><span><QcDirectoryIcon kind="folder" /></span>{directory.list?.setlistName ?? snapshot.setlistName}<b>⋮</b></button>}
        <button className="directory-new-setlist" disabled><span><QcDirectoryIcon kind="new-folder" /></span>New Setlist</button>
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
  const titlePresentation = presetTitlePresentation(snapshot.presetName, snapshot.dirty);
  const presetTitle = titlePresentation.text;
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
  const connectionMark = (side: "input" | "output", row: number) => {
    const routeId = side === "input" ? routes[row]?.inputId : routes[row]?.outputId;
    if (!routedPortIsPlugged(side, routeId, snapshot.ioPorts)) return null;
    const x = side === "input" ? 19 : 759;
    return <path key={`${side}-connection-${row}`} d={`M${x} ${rowY[row] - 33}h22`} stroke={QC_COLORS.device.connectionMark} strokeWidth="3" strokeLinecap="round" />;
  };
  const routeLines = (label: string | undefined) => {
    const value = label ?? "+";
    const words = value.split(" ");
    return words.length > 1 ? [words[0], words.slice(1).join(" ")] : [value];
  };
  const railLabel = (label: string | undefined, x: number, y: number) => {
    const lines = routeLines(label);
    if (label === "+") return <g stroke={QC_COLORS.captured.utilityMark} strokeWidth="1.7" strokeLinecap="round"><path d={`M${x - 10} ${y}h20`} /><path d={`M${x} ${y - 10}v20`} /></g>;
    const firstY = y - (lines.length - 1) * 8.5;
    return <text x={x} y={firstY} fill={QC_COLORS.captured.routeText} stroke="none" fontFamily="Helvetica Neue, Helvetica, Arial, sans-serif" fontWeight="400" fontSize="14.5">{lines.map((line, index) => <tspan key={`${line}-${index}`} x={x} dy={index ? 17 : 0}>{line}</tspan>)}</text>;
  };
  const rowRail = (row: number) => rowHasVisibleSignalRail(tabBlocksByRow[row].length, routes[row])
    ? <path key={`row-${row}`} d={`M52 ${rowY[row]}H748`} />
    : null;
  const routeToken = (kind: "S" | "M", x: number, y: number, row: number) => {
    const color = kind === "S" ? QC_COLORS.category.equalizer : QC_COLORS.category.synth;
    const node = kind === "S" ? "splitter" : "mixer";
    const selected = selectedBlockId === `routing-${row}-${node}`;
    return <g>
      {selected && <circle cx={x} cy={y} r="18" fill="none" stroke={QC_COLORS.captured.primaryText} strokeWidth="2" />}
      <circle cx={x} cy={y} r="15" fill={QC_COLORS.captured.screen} stroke="none" />
      <circle cx={x} cy={y} r="13" fill={color} stroke="none" />
      <text x={x} y={y + 5.5} textAnchor="middle" fill={QC_COLORS.captured.primaryText} stroke="none" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="16">{kind}</text>
    </g>;
  };
  const splitPath = (row: number) => {
    const route = routes[row];
    if (route?.splitColumn === undefined || row >= rowY.length - 1) return null;
    const splitX = splitAnchorX(route.splitColumn);
    const rejoins = route.mixColumn !== undefined && route.mixColumn >= 0;
    const mixX = rejoins ? mixAnchorX(route.mixColumn!) : 748;
    return <g key={`split-${row}`} fill="none" stroke={QC_COLORS.device.splitPath} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
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
      {selected && <rect x={cx - 34} y={cy - 34} width="68" height="68" rx="15" fill="none" stroke={QC_COLORS.app.text} strokeWidth="2" />}
      {block.bypassed && <path d={`M${cx - 32} ${cy}H${cx + 32}`} fill="none" stroke={QC_COLORS.device.bypassPath} strokeWidth="2" opacity=".9" />}
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
      <rect width="800" height="480" fill={QC_COLORS.captured.screen} />
      <g transform="matrix(.96 0 0 1 -4 0)" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="68"><text x="14" y="75"><tspan fill={QC_COLORS.hardware.whiteLed} letterSpacing="-1">{presetBank}</tspan><tspan fill={QC_COLORS.device.presetSlotDefault} letterSpacing="-1">{presetSlot}</tspan><tspan className={`preset-title${snapshot.dirty ? " is-dirty" : ""}${titlePresentation.dimmed ? " is-unsaved" : ""}`} dx="16" dy={presetTitleBaseline - 75} fill={titlePresentation.dimmed ? QC_COLORS.captured.unsaved : QC_COLORS.hardware.whiteLed} fontSize={presetTitleFontSize} fontStyle={titlePresentation.italic ? "italic" : "normal"} textLength={squeezePresetTitle ? presetTitleMaxWidth : undefined} lengthAdjust={squeezePresetTitle ? "spacingAndGlyphs" : undefined}>{presetTitle}</tspan></text></g>
      <g fill="none" stroke={QC_COLORS.hardware.whiteLed} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M633 13A13 13 0 1 1 620 26" />
        <path d="M626 15L634 9V20Z" fill={QC_COLORS.hardware.whiteLed} stroke="none" />
      </g>
      <path
        d="M712 13H728L733 18V35H711V14C711 13.448 711.448 13 712 13ZM716 15V22H727V15H716ZM716 27V35H728V27H716Z"
        fill={QC_COLORS.hardware.whiteLed}
        fillRule="evenodd"
      />
      <rect x="654" y="9" width="31" height="31" rx="4" fill={QC_COLORS.captured.sceneBadge} /><text x="669.5" y="34" textAnchor="middle" fill={QC_COLORS.device.panel} fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="25">{sceneLetter}</text>
      <g fill={QC_COLORS.hardware.whiteLed}><circle cx="766" cy="15" r="2.2" /><circle cx="766" cy="25" r="2.2" /><circle cx="766" cy="35" r="2.2" /></g>
      <g transform="translate(652 55)" color={QC_COLORS.hardware.whiteLed}><QcModeGlyph mode={snapshot.mode} /></g><text x="681" y="76" fill={QC_COLORS.hardware.whiteLed} fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="22.5">{snapshot.mode}</text>
      <g fill={QC_COLORS.captured.routePill} stroke={QC_COLORS.captured.screen} strokeWidth="1.2" fontFamily="Helvetica Neue, Helvetica, Arial, sans-serif" textAnchor="middle">
        {rowY.flatMap((y, row) => [<rect key={`in-${row}`} x="8" y={y - 39} width="44" height="78" rx="15" />, <rect key={`out-${row}`} x="748" y={y - 39} width="44" height="78" rx="15" />])}
        {rowY.flatMap((_, row) => [connectionMark("input", row), connectionMark("output", row)])}
        {rowY.map((y, row) => <g key={`rails-${row}`}>{railLabel(displayInput(row), 30, y)}{railLabel(displayOutput(row), 770, y)}</g>)}
      </g>
      <g fill="none" stroke={QC_COLORS.captured.routeRail} strokeWidth="1.7">{rowY.map((_, row) => rowRail(row))}</g>
      {rowY.map((_, row) => splitPath(row))}
      {!screenBlocks.length && <g aria-label="Empty device slot">
        <rect x="66" y="119" width="64" height="64" rx="14" fill={QC_COLORS.captured.routePill} stroke={QC_COLORS.captured.screen} strokeWidth="1.2" />
        <g stroke={QC_COLORS.captured.utilityMark} strokeWidth="1.8" strokeLinecap="round"><path d="M88 151h20" /><path d="M98 141v20" /></g>
      </g>}
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
        <rect width="800" height="480" fill={QC_COLORS.device.focusOverlay} fillOpacity=".86" />
        <rect x={routingPicker.side === "input" ? 8 : 748} y={rowY[routingPicker.row] - 39} width="44" height="78" rx="15" fill={QC_COLORS.device.routeFocus} stroke={QC_COLORS.captured.screen} strokeWidth="1.5" />
        <g textAnchor="middle">{railLabel(routingPicker.side === "input" ? displayInput(routingPicker.row) : displayOutput(routingPicker.row), routingPicker.side === "input" ? 30 : 770, rowY[routingPicker.row])}</g>
      </svg>
      <section className={`coros-route-picker is-${routingPicker.side}`} aria-label={`Row ${routingPicker.row + 1} ${routingPicker.side} selection`}>
        <header><QcRouteGlyph side={routingPicker.side} label={selectedRoute?.[1] ?? "Internal"} /><span>{routePickerLabel(routingPicker.side, selectedRoute?.[1] ?? "Internal")}</span></header>
        <div className="coros-route-options" role="listbox" aria-label={`${routingPicker.side === "input" ? "Input" : "Output"} routes`}>
          {routePickerGroups.map((group) => <div className="coros-route-group" role="group" aria-label={group.name || "Unassigned"} key={group.name || "unassigned"}>
            {group.name && <strong>{group.name}</strong>}
            {group.options.map(([value, label]) => <button key={value} role="option" aria-selected={value === routingPicker.value} disabled={routingPicker.disabled} onClick={() => routingPicker.onSelect(value)}><QcRouteGlyph side={routingPicker.side} label={label} /><span>{routePickerLabel(routingPicker.side, label)}</span></button>)}
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
      ) ? QC_COLORS.category.pitch : editorAccent
    }));
  })() : undefined;
  const parameterLed = (slot: number, fallback: { active: boolean; assigned: boolean; color: string }) => parameterLeds?.[slot] ?? fallback;
  const navigationLedColor = QC_COLORS.hardware.whiteLed;
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
      <div className="footswitch-row">{scenes.slice(4).map((control, index) => { const led = parameterLed(index + 5, leds[index + 4]); return <HardwareSwitch key={control.id} role={control.role} label={control.label} active={led.active} assigned={led.assigned} accent={led.color} onAction={onAction} />; })}<HardwareSwitch role={tempo.role} label="TEMPO" active={parameterLeds ? parameterLeds[9].active : snapshot.tempoLedEnabled} assigned={parameterLeds ? parameterLeds[9].assigned : snapshot.tempoLedEnabled} pulseBpm={!parameterLeds && snapshot.tempoLedEnabled ? snapshot.tempo : undefined} pulseEpochMs={!parameterLeds ? snapshot.tempoPulseEpochMs : undefined} accent={parameterLeds ? parameterLeds[9].color : QC_COLORS.device.tempoLed} onAction={onAction} /></div>
      <span className="tuner-hint">TEMPO<br />HOLD: TUNER</span>
    </div>
  </section>;
}
