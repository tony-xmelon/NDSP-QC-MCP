import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import type { GridBlock, PresetEntry, PresetList, PresetSnapshot } from "@ndsp-qc/client";
import type { FormFactorManifest, HardwareControl, SkinManifest } from "@ndsp-qc/form-factors";
import { footswitchLeds } from "./footswitch-leds";
import { officialBlockVisual } from "./block-visuals";
import { REFERENCE_BLOCK_ICONS } from "./reference-block-icons";
import "./live-surface.css";

export type HardwareAction =
  | { kind: "switch"; role: string; phase: "press" | "release" }
  | { kind: "rotate"; role: string; delta: number }
  | { kind: "select-scene"; scene: number }
  | { kind: "select-block"; blockId: string };

export type CorOsContextAction = "edit-details" | "preset-midi-out" | "favorite" | "delete-preset" | "new-capture" | "tempo" | "cpu-monitor" | "settings";

export interface PresetDirectoryState {
  open: boolean;
  list?: PresetList;
  loading: boolean;
  disabled: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onRecall: (entry: PresetEntry) => void;
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
  onOpenRouting: (row?: number, side?: "input" | "output") => void;
  onRefresh: () => void;
  presetDirectory?: PresetDirectoryState;
  onContextAction?: (action: CorOsContextAction) => void;
}

const officialBlockSprite = "/qc-block-samples.svg";
function DeviceGlyph({ block, x, y, size = 64 }: { block: GridBlock; x: number; y: number; size?: number }) {
  const visual = officialBlockVisual(block);
  const [tileX, tileY] = visual.tile;
  if (visual.referenceAsset) return <image className="official-block-tile" x={x - size / 2} y={y - size / 2} width={size} height={size} href={REFERENCE_BLOCK_ICONS[visual.referenceAsset]} preserveAspectRatio="xMidYMid meet" aria-hidden="true" />;
  return <svg className="official-block-tile" x={x - size / 2} y={y - size / 2} width={size} height={size} viewBox={`${tileX} ${tileY} 70 70`} preserveAspectRatio="xMidYMid meet" overflow="hidden" aria-hidden="true">
    <image href={officialBlockSprite} x="0" y="0" width="710" height="152" />
    <rect x={tileX + 3} y={tileY + 3} width="64" height="64" rx="14" fill="none" stroke="#000" strokeWidth="5" />
    <rect x={tileX + 3} y={tileY + 3} width="64" height="64" rx="14" fill="none" stroke={visual.color} strokeWidth="2.4" />
  </svg>;
}

function HardwareSwitch({ role, label, active, assigned = false, accent, compact = false, pulseBpm, onAction }: {
  role: string; label: string; active?: boolean; assigned?: boolean; accent?: string; compact?: boolean; pulseBpm?: number; onAction: (action: HardwareAction) => void;
}) {
  const drag = useRef<{ pointerId: number; lastY: number; rotated: boolean } | null>(null);
  const hideValueTimer = useRef<number | undefined>(undefined);
  const [encoderValue, setEncoderValue] = useState(50);
  const [showValue, setShowValue] = useState(false);
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
      onAction({ kind: "switch", role, phase: "press" });
      onAction({ kind: "switch", role, phase: "release" });
    }
  };
  const wheel = (event: WheelEvent<HTMLButtonElement>) => {
    event.preventDefault();
    rotate(event.deltaY < 0 ? 1 : -1);
  };
  return <button
    className={`hardware-switch${active ? " is-active" : ""}${assigned ? " is-assigned" : ""}${compact ? " is-compact" : ""}${pulseBpm ? " is-tempo-pulse" : ""}`}
    style={{ "--switch-accent": accent ?? "var(--accent)", "--tempo-period": pulseBpm ? `${60 / pulseBpm}s` : undefined } as CSSProperties}
    aria-label={`${label} encoder footswitch`} aria-pressed={active} aria-valuetext={`${encoderValue} percent`}
    title={`${label}: tap to press; drag vertically, use the mouse wheel, or press arrow keys to rotate`}
    onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); drag.current = { pointerId: event.pointerId, lastY: event.clientY, rotated: false }; }}
    onPointerMove={(event) => {
      const gesture = drag.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const steps = Math.trunc((gesture.lastY - event.clientY) / 12);
      if (!steps) return;
      gesture.rotated = true;
      gesture.lastY -= steps * 12;
      rotate(steps);
    }}
    onPointerUp={(event) => release(event)} onPointerCancel={(event) => release(event, true)} onKeyDown={keyboard} onWheel={wheel}
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

function CorOsDirectory({ snapshot, directory }: { snapshot: PresetSnapshot; directory: PresetDirectoryState }) {
  const currentBank = Math.floor(snapshot.presetPosition / 8) + 1;
  const [selectedBank, setSelectedBank] = useState(currentBank);
  useEffect(() => {
    if (directory.open) setSelectedBank(currentBank);
  }, [currentBank, directory.open]);
  const banks = Array.from(new Set(directory.list?.presets.map((entry) => Math.floor(entry.position / 8) + 1) ?? [])).sort((a, b) => a - b);
  const presets = directory.list?.presets.filter((entry) => Math.floor(entry.position / 8) + 1 === selectedBank) ?? [];

  return <section className="coros-directory" aria-label="Preset Directory">
    <header className="coros-directory-header">
      <button className="directory-category" aria-label="Preset categories"><span className="directory-grid-icon">⠿</span><strong>PRESETS</strong><span>⌄</span></button>
      <div className="directory-tools" aria-label="Directory tools"><button aria-label="Search presets">⌕</button><button aria-label="Sort presets">⇅</button><button aria-label="Select multiple presets">☷</button><button className="directory-close" aria-label="Return to Grid" onClick={directory.onClose}>×</button></div>
    </header>
    <div className="coros-directory-body">
      <nav className="directory-folders" aria-label="Preset folders">
        <button><span>★</span>FAVORITES</button>
        <button><span>◷</span>RECENT</button>
        <div className="directory-section-label">PRESETS</div>
        <button><span>↓</span>DOWNLOADS</button>
        <button><span>☁</span>CLOUD PRESETS</button>
        <button><span>▦</span>FACTORY PRESETS</button>
        <button className="is-active"><span>▦</span>{directory.list?.setlistName ?? snapshot.setlistName}</button>
      </nav>
      <nav className="directory-banks" aria-label="Preset banks">
        {banks.length ? banks.map((bank) => <button key={bank} className={bank === selectedBank ? "is-active" : ""} onClick={() => setSelectedBank(bank)}><span>BANK</span>{bank}</button>) : <span className="directory-loading">{directory.loading ? "READING…" : "NO BANKS"}</span>}
      </nav>
      <div className="directory-presets" role="listbox" aria-label={`Bank ${selectedBank} presets`}>
        <div className="directory-list-heading"><span>BANK {selectedBank}</span><span>{presets.length}/8</span></div>
        {directory.loading && !directory.list ? <div className="directory-loading">READING PRESETS FROM QUAD CORTEX…</div> : presets.map((entry) => <button key={entry.position} role="option" aria-selected={entry.position === snapshot.presetPosition} className={entry.position === snapshot.presetPosition ? "is-current" : ""} disabled={directory.disabled} onClick={() => directory.onRecall(entry)}><strong>{entry.location}</strong><span>{entry.name}</span><span className="preset-row-more">•••</span></button>)}
      </div>
    </div>
    <footer className="coros-directory-footer"><span>{directory.list ? `${directory.list.presets.length} PRESETS` : "DEVICE DIRECTORY"}</span><button onClick={directory.onRefresh} disabled={directory.loading || directory.disabled}>↻ REFRESH</button></footer>
  </section>;
}

function CorOsGrid({ snapshot, selectedBlockId, onAction, onOpenPreset, onUndo, canUndo, undoLabel, onSave, onOpenRouting, onRefresh, presetDirectory, onContextAction }: Pick<QuadCortexSurfaceProps, "snapshot" | "selectedBlockId" | "onAction" | "onOpenPreset" | "onUndo" | "canUndo" | "undoLabel" | "onSave" | "onOpenRouting" | "onRefresh" | "presetDirectory" | "onContextAction">) {
  const [sceneMenuOpen, setSceneMenuOpen] = useState(false);
  const [screenMenuOpen, setScreenMenuOpen] = useState(false);
  const columns = [98, 184, 273, 361, 448, 528, 616, 703];
  const routeColumns = [75, 141, 228.5, 317, 404.5, 488, 572, 659.5];
  const rowY = [151, 243, 338, 430];
  const screenBlocks = snapshot.blocks.filter((block) => block.row >= 0 && block.row < 4 && block.column >= 0 && block.column < 8);
  const sceneLetter = String.fromCharCode(65 + snapshot.activeScene);
  const presetTitle = `${snapshot.presetName}${snapshot.dirty ? "*" : ""}`;
  const presetTitleWidthAtFullSize = (() => {
    if (typeof document === "undefined") return presetTitle.length * 40;
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return presetTitle.length * 40;
    context.font = `${snapshot.dirty ? "italic " : ""}800 68px Arial`;
    return context.measureText(presetTitle).width;
  })();
  const presetTitleFontSize = Math.max(22, Math.min(68, 68 * 520 / Math.max(1, presetTitleWidthAtFullSize)));
  const squeezePresetTitle = presetTitleWidthAtFullSize * presetTitleFontSize / 68 > 520;
  const presetTitleBaseline = 75 - (68 - presetTitleFontSize) * .28;
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
  const splitRouteForLowerRow = (row: number) => row > 0 && routes[row - 1]?.splitColumn !== undefined ? routes[row - 1] : undefined;
  const rowRail = (row: number) => {
    const parentRoute = splitRouteForLowerRow(row);
    if (!parentRoute) return <path key={`row-${row}`} d={`M52 ${rowY[row]}H748`} />;
    const startX = routeColumns[Math.max(0, Math.min(7, parentRoute.splitColumn!))];
    const rejoins = parentRoute.mixColumn !== undefined && parentRoute.mixColumn >= 0;
    const endX = rejoins ? routeColumns[Math.max(0, Math.min(7, parentRoute.mixColumn!))] : 748;
    return <path key={`row-${row}`} d={`M${startX} ${rowY[row]}H${endX}`} />;
  };
  const routeToken = (kind: "S" | "M", x: number, y: number) => {
    const color = kind === "S" ? "#0a74e0" : "#e44a5d";
    return <g>
      <circle cx={x} cy={y} r="15" fill="#000" stroke="none" />
      <circle cx={x} cy={y} r="13" fill={color} stroke="none" />
      <text x={x} y={y + 5.5} textAnchor="middle" fill="#fff" stroke="none" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="16">{kind}</text>
    </g>;
  };
  const splitPath = (row: number) => {
    const route = routes[row];
    if (route?.splitColumn === undefined || row >= rowY.length - 1) return null;
    const splitX = routeColumns[Math.max(0, Math.min(7, route.splitColumn))];
    const rejoins = route.mixColumn !== undefined && route.mixColumn >= 0;
    const mixX = rejoins ? routeColumns[Math.max(0, Math.min(7, route.mixColumn!))] : 748;
    const middleY = (rowY[row] + rowY[row + 1]) / 2;
    return <g key={`split-${row}`} fill="none" stroke="#8f9092" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={`M${splitX} ${rowY[row]} C${splitX} ${middleY - 13},${splitX} ${middleY + 13},${splitX} ${rowY[row + 1]}`} />
      {rejoins && <path d={`M${mixX} ${rowY[row + 1]} C${mixX} ${middleY + 13},${mixX} ${middleY - 13},${mixX} ${rowY[row]}`} />}
      {routeToken("S", splitX, rowY[row])}
      {rejoins && routeToken("M", mixX, rowY[row])}
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
  return <div className="qc-screen coros-vector-screen" aria-label="CorOS Grid">
    <svg className="coros-vector-canvas" viewBox="0 0 800 480" preserveAspectRatio="none" role="img" aria-label={`${snapshot.presetLocation} ${snapshot.presetName}, ${snapshot.mode} mode`}>
      <rect width="800" height="480" fill="#020202" />
      <g transform="matrix(.96 0 0 1 -4 0)" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="68" letterSpacing="-2"><text x="14" y="75" fill="#f4f4f4">{snapshot.presetLocation.slice(0, -1)}</text><text x="56" y="75" textLength="42" lengthAdjust="spacingAndGlyphs" fill="#3ee77b">{snapshot.presetLocation.slice(-1)}</text><text x="114" y={presetTitleBaseline} fill="#f4f4f4" fontSize={presetTitleFontSize} fontStyle={snapshot.dirty ? "italic" : "normal"} textLength={squeezePresetTitle ? 520 : undefined} lengthAdjust={squeezePresetTitle ? "spacingAndGlyphs" : undefined}>{presetTitle}</text></g>
      <g fill="none" stroke="#f0f0f0" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M633 13A13 13 0 1 1 620 26" />
        <path d="M626 15L634 9V20Z" fill="#f0f0f0" stroke="none" />
      </g>
      <g fill={snapshot.dirty ? "#f0f0f0" : "#525252"}>
        <path d="M726 23H715V17H721V20H723V17H726V23Z" />
        <path d="M733 17.9863V23.7568C732.398 23.2743 731.726 22.8769 731 22.583V18.8047L727.252 15H714.001C713.448 15 713 15.4477 713 16V32C713 32.5523 713.448 33 714.001 33H720.584C720.878 33.7258 721.274 34.3984 721.757 35H714.002C712.344 34.9999 711 33.6568 711 32V16C711 14.3432 712.344 13.0001 714.002 13H728.09L733 17.9863Z" />
      </g>
      {!snapshot.dirty && <path d="M722 30C722 33.3137 724.686 36 728 36C731.314 36 734 33.3137 734 30C734 26.6863 731.314 24 728 24C724.686 24 722 26.6863 722 30ZM732.113 27.5324L730.681 26.314L726.712 30.6742L724.792 29.155L723.564 30.6016L726.91 33.2496L732.113 27.5324Z" fill="#45f862" />}
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
      <button className="vector-action-hit preset-title-hit" title="Open device Directory" aria-label={`Open preset Directory; current preset ${snapshot.presetLocation} ${snapshot.presetName}`} onClick={() => { setSceneMenuOpen(false); setScreenMenuOpen(false); onOpenPreset(); }} />
      <button className="vector-action-hit undo-hit" title={canUndo ? `Undo ${undoLabel ?? "last action"}` : "Nothing to undo"} aria-label={canUndo ? `Undo ${undoLabel ?? "last action"}` : "Nothing to undo"} onClick={onUndo} />
      <button className="vector-action-hit scene-hit" aria-label="Select scene" aria-expanded={sceneMenuOpen} onClick={() => { setScreenMenuOpen(false); setSceneMenuOpen((open) => !open); }} />
      <button className="vector-action-hit save-hit" title="Save preset to Quad Cortex" aria-label="Save preset to Quad Cortex" onClick={onSave} />
      <button className="vector-action-hit more-hit" title="Grid menu" aria-label="Open Grid menu" aria-expanded={screenMenuOpen} onClick={() => { setSceneMenuOpen(false); setScreenMenuOpen((open) => !open); }} />
      {rowY.map((_, row) => <div key={`route-hits-${row}`}>
        <button className="vector-route-hit input-route-hit" style={{ top: `${(108 + row * 94) / 4.8}%` }} aria-label={`Edit row ${row + 1} input`} title={`Edit row ${row + 1} input`} onClick={() => onOpenRouting(row, "input")} />
        <button className="vector-route-hit output-route-hit" style={{ top: `${(108 + row * 94) / 4.8}%` }} aria-label={`Edit row ${row + 1} output`} title={`Edit row ${row + 1} output`} onClick={() => onOpenRouting(row, "output")} />
      </div>)}
    </div>
    {screenBlocks.map((block) => <button key={block.id} className="coros-vector-block-hit" style={{ left: `${columns[block.column] / 8}%`, top: `${rowY[block.row] / 4.8}%` }} title={`Row ${block.row + 1}, ${block.name}`} aria-label={`Row ${block.row + 1}, ${block.name}`} aria-pressed={selectedBlockId === block.id} onClick={() => onAction({ kind: "select-block", blockId: block.id })} />)}
    {sceneMenuOpen && <div className="scene-dropdown vector-scene-dropdown" role="menu" aria-label="Scenes">{snapshot.scenes.map((scene, index) => <button key={scene} role="menuitem" className={snapshot.activeScene === index ? "is-active" : ""} onClick={() => { setSceneMenuOpen(false); onAction({ kind: "select-scene", scene: index }); }}><span>{String.fromCharCode(65 + index)}</span>{scene}</button>)}</div>}
    {screenMenuOpen && <div className="coros-screen-menu" role="menu" aria-label="Grid contextual menu">
      <button role="menuitem" onClick={() => { setScreenMenuOpen(false); onSave(); }}><span className="context-menu-icon">⇥</span>Save as…</button>
      <button role="menuitem" onClick={() => { setScreenMenuOpen(false); onContextAction?.("edit-details"); }}><span className="context-menu-icon">✎</span>Edit details</button>
      <button role="menuitem" onClick={() => { setScreenMenuOpen(false); onContextAction?.("preset-midi-out"); }}><span className="context-menu-icon">M</span>Preset MIDI Out</button>
      <button role="menuitem" onClick={() => { setScreenMenuOpen(false); onContextAction?.("favorite"); }}><span className="context-menu-icon">☆</span>Add to favorites</button>
      <button role="menuitem" className="context-danger" onClick={() => { setScreenMenuOpen(false); onContextAction?.("delete-preset"); }}><span className="context-menu-icon">⌫</span>Delete preset</button>
      <div className="context-menu-section">QUAD CORTEX</div>
      <button role="menuitem" onClick={() => { setScreenMenuOpen(false); onContextAction?.("new-capture"); }}><span className="context-menu-icon">◇</span>New Neural Capture</button>
      <button role="menuitem" onClick={() => { setScreenMenuOpen(false); onContextAction?.("tempo"); }}><span className="context-menu-icon">♩</span>Tempo</button>
      <button role="menuitem" onClick={() => { setScreenMenuOpen(false); onContextAction?.("cpu-monitor"); }}><span className="context-menu-icon">▥</span>CPU monitor</button>
      <button role="menuitem" onClick={() => { setScreenMenuOpen(false); onContextAction?.("settings"); }}><span className="context-menu-icon">⚙</span>Settings</button>
    </div>}
    {presetDirectory?.open && <CorOsDirectory snapshot={snapshot} directory={presetDirectory} />}
  </div>;
}

function controlByRole(controls: HardwareControl[], role: string) { return controls.find((control) => control.role === role); }

export function QuadCortexSurface({ formFactor, snapshot, selectedBlockId, skin, onAction, onOpenPreset, onUndo, canUndo, undoLabel, onSave, onOpenRouting, onRefresh, presetDirectory, onContextAction }: QuadCortexSurfaceProps) {
  const scenes = formFactor.controls.filter((control) => control.group === "scene");
  const bankUp = controlByRole(formFactor.controls, "bank:up")!;
  const bankDown = controlByRole(formFactor.controls, "bank:down")!;
  const tempo = controlByRole(formFactor.controls, "tempo")!;
  const leds = footswitchLeds(snapshot);
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
    <div className="qc-screen-bezel"><CorOsGrid snapshot={snapshot} selectedBlockId={selectedBlockId} onAction={onAction} onOpenPreset={onOpenPreset} onUndo={onUndo} canUndo={canUndo} undoLabel={undoLabel} onSave={onSave} onOpenRouting={onOpenRouting} onRefresh={onRefresh} presetDirectory={presetDirectory} onContextAction={onContextAction} /></div>
    <div className="screen-nav-control"><span className="nav-arrow nav-arrow-up" /><HardwareSwitch role={bankUp.role} label="BANK UP" compact accent="#83ddfa" onAction={onAction} /><span className="nav-arrow nav-arrow-down" /></div>
    <div className="footswitch-deck">
      <div className="footswitch-row">{scenes.slice(0, 4).map((control, index) => <HardwareSwitch key={control.id} role={control.role} label={control.label} active={leds[index].active} assigned={leds[index].assigned} accent={leds[index].color} onAction={onAction} />)}<HardwareSwitch role={bankDown.role} label="BANK DOWN" accent="#d8dde0" onAction={onAction} /></div>
      <div className="mode-bracket" aria-hidden="true"><span>＋</span><strong>MODE</strong><span>−</span></div>
      <div className="footswitch-row">{scenes.slice(4).map((control, index) => <HardwareSwitch key={control.id} role={control.role} label={control.label} active={leds[index + 4].active} assigned={leds[index + 4].assigned} accent={leds[index + 4].color} onAction={onAction} />)}<HardwareSwitch role={tempo.role} label="TEMPO" active={snapshot.tempoLedEnabled} pulseBpm={snapshot.tempoLedEnabled ? snapshot.tempo : undefined} accent="#e6e6e6" onAction={onAction} /></div>
      <span className="tuner-hint">TEMPO<br />HOLD: TUNER</span>
    </div>
  </section>;
}
