import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import type { GridBlock, PresetSnapshot } from "@ndsp-qc/client";
import type { FormFactorManifest, HardwareControl, SkinManifest } from "@ndsp-qc/form-factors";
import { footswitchLeds } from "./footswitch-leds";
import "./live-surface.css";

export type HardwareAction =
  | { kind: "switch"; role: string; phase: "press" | "release" }
  | { kind: "rotate"; role: string; delta: number }
  | { kind: "select-scene"; scene: number }
  | { kind: "select-block"; blockId: string };

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
}

const officialBlockSprite = "/qc-block-samples.svg";
const officialBlockTiles: Record<string, [number, number]> = {
  utility: [0, 0], equalizer: [80, 0], modulation: [160, 0], splitter: [240, 0],
  amp: [320, 0], drive: [400, 0], cab: [480, 0], gate: [0, 82],
  compressor: [80, 82], delay: [160, 82], loop: [240, 82], level: [320, 82],
  wah: [400, 82], pitch: [480, 82], reverb: [560, 82]
};

function deviceBlockTile(block: GridBlock): [number, number] {
  if (block.glyph && officialBlockTiles[block.glyph]) return officialBlockTiles[block.glyph];
  const category = (block.category ?? block.kind).toLowerCase();
  const name = block.name.toLowerCase();
  if (name.includes("gate")) return officialBlockTiles.gate;
  if (category.includes("equalizer")) return officialBlockTiles.equalizer;
  if (category.includes("compressor")) return officialBlockTiles.compressor;
  if (category.includes("pitch")) return officialBlockTiles.pitch;
  if (category.includes("modulation")) return officialBlockTiles.modulation;
  if (category.includes("overdrive") || category.includes("capture")) return officialBlockTiles.drive;
  if (category.includes("amplifier")) return officialBlockTiles.amp;
  if (category.includes("cab") || category.includes("impulse")) return officialBlockTiles.cab;
  if (category.includes("delay")) return officialBlockTiles.delay;
  if (category.includes("reverb")) return officialBlockTiles.reverb;
  if (category.includes("fx loop")) return officialBlockTiles.loop;
  if (category.includes("wah") || category.includes("filter")) return officialBlockTiles.wah;
  if (name === "gain" || name.includes("level")) return officialBlockTiles.level;
  return officialBlockTiles.utility;
}

function DeviceGlyph({ block, x, y, size = 64 }: { block: GridBlock; x: number; y: number; size?: number }) {
  const [tileX, tileY] = deviceBlockTile(block);
  return <svg className="official-block-tile" x={x - size / 2} y={y - size / 2} width={size} height={size} viewBox={`${tileX} ${tileY} 70 70`} preserveAspectRatio="xMidYMid meet" overflow="hidden" aria-hidden="true">
    <image href={officialBlockSprite} x="0" y="0" width="710" height="152" />
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

function CorOsGrid({ snapshot, selectedBlockId, onAction, onOpenPreset, onUndo, canUndo, undoLabel, onSave, onOpenRouting, onRefresh }: Pick<QuadCortexSurfaceProps, "snapshot" | "selectedBlockId" | "onAction" | "onOpenPreset" | "onUndo" | "canUndo" | "undoLabel" | "onSave" | "onOpenRouting" | "onRefresh">) {
  const [sceneMenuOpen, setSceneMenuOpen] = useState(false);
  const [screenMenuOpen, setScreenMenuOpen] = useState(false);
  const columns = [98, 184, 273, 361, 448, 528, 616, 703];
  const rowY = [151, 243, 338, 430];
  const screenBlocks = snapshot.blocks.filter((block) => block.row >= 0 && block.row < 4 && block.column >= 0 && block.column < 8);
  const sceneLetter = String.fromCharCode(65 + snapshot.activeScene);
  const routes = rowY.map((_, row) => snapshot.routes.find((route) => route.row === row));
  const splitRows = new Set(routes.flatMap((route) => route?.splitColumn === undefined ? [] : [route.row + 1]));
  const displayInput = (row: number) => {
    const input = routes[row]?.input;
    if (input !== "Internal") return input;
    if (splitRows.has(row)) return "Lane";
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
    const firstY = y - (lines.length - 1) * 10;
    return <text x={x} y={firstY} fill="#ededed" fontWeight="700" fontSize={label === "+" ? 29 : 15}>{lines.map((line, index) => <tspan key={`${line}-${index}`} x={x} dy={index ? 20 : 0}>{line}</tspan>)}</text>;
  };
  const splitPath = (row: number) => {
    const route = routes[row];
    if (route?.splitColumn === undefined || row >= rowY.length - 1) return null;
    const splitX = columns[Math.max(0, Math.min(7, route.splitColumn))];
    const rejoins = route.mixColumn !== undefined && route.mixColumn >= 0;
    const mixX = rejoins ? columns[Math.max(0, Math.min(7, route.mixColumn!))] : 748;
    const lowerStart = Math.max(52, splitX - 46);
    const lowerEnd = rejoins ? Math.max(lowerStart + 24, mixX - 46) : mixX;
    return <g key={`split-${row}`} fill="none" stroke="#e5e5e5" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={`M${splitX} ${rowY[row]} C${splitX} ${rowY[row] + 31},${lowerStart} ${rowY[row + 1] - 31},${lowerStart} ${rowY[row + 1]} H${lowerEnd}${rejoins ? ` C${mixX - 14} ${rowY[row + 1]},${mixX} ${rowY[row] + 31},${mixX} ${rowY[row]}` : ""}`} />
      <circle cx={splitX} cy={rowY[row]} r="7" fill="#050506" stroke="#efefef" />
      <text x={splitX} y={rowY[row] + 3.5} textAnchor="middle" fill="#efefef" stroke="none" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="9">S</text>
      {rejoins && <><circle cx={mixX} cy={rowY[row]} r="7" fill="#050506" stroke="#efefef" /><text x={mixX} y={rowY[row] + 3.5} textAnchor="middle" fill="#efefef" stroke="none" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="9">M</text></>}
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
      <defs><filter id="blockGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
      <rect width="800" height="480" fill="#020202" />
      <g transform="matrix(.96 0 0 1 -4 0)" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="68" letterSpacing="-2"><text x="14" y="75" fill="#f4f4f4">{snapshot.presetLocation.slice(0, -1)}</text><text x="56" y="75" textLength="42" lengthAdjust="spacingAndGlyphs" fill="#3ee77b">{snapshot.presetLocation.slice(-1)}</text><text x="114" y="75" fill="#f4f4f4" fontStyle="italic">{snapshot.presetName}{snapshot.dirty ? "*" : ""}</text></g>
      <g fill="none" stroke="#f0f0f0" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M633 13a14 14 0 1 0 4 13M633 13h-10m10 0-5 8" /><path d="M709 11h20l6 6v24h-26zM714 11v11h15V11M715 29h13" /></g>
      {!snapshot.dirty && <path d="m718 34 4 4 9-10" fill="none" stroke="#3ee77b" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />}
      <rect x="654" y="9" width="31" height="31" rx="4" fill="#f2cf32" /><text x="669.5" y="34" textAnchor="middle" fill="#141414" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="25">{sceneLetter}</text>
      <g fill="#f2f2f2"><circle cx="766" cy="15" r="2.2" /><circle cx="766" cy="25" r="2.2" /><circle cx="766" cy="35" r="2.2" /></g>
      <g transform="translate(652 55) scale(.9) translate(-525 -78)"><path d="M535.723 79.2008C532.977 81.2508 530.778 82.8924 529.127 84.1255L528.27 84.7656C527.385 85.4269 526.705 85.9358 526.228 86.2924C525.319 86.9726 524.915 87.9041 525.015 89.087L542.055 84.521C541.833 83.0083 542.929 81.2361 545.255 79.1766C544.988 78.8037 544.691 78.4115 544.363 78C542.639 80.0488 540.862 81.2219 539.031 81.5192C537.2 81.8165 536.097 81.0437 535.723 79.2008ZM543.102 84.2407L547.01 83.1933C547.096 82.4398 546.701 81.3799 545.825 80.0139C543.899 81.7499 543.016 83.1667 543.102 84.2407ZM547.559 85.3468L525.619 91.2257C525.399 90.7294 525.237 90.2624 525.135 89.8246L525.201 90.0724L547.243 84.1663L547.559 85.3468ZM529.966 92.3084L533.966 91.2257V94.675L536.966 94.675V98.675H526.966V94.675L529.966 94.675V92.3084Z" fill="#f0f0f0" /></g><text x="681" y="76" fill="#f0f0f0" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="24">{snapshot.mode}</text>
      <g fill="#171719" fontFamily="Arial, Helvetica, sans-serif" fontWeight="600" textAnchor="middle">
        <rect x="8" y="108" width="44" height="86" rx="9" /><rect x="8" y="203" width="44" height="79" rx="9" /><rect x="8" y="297" width="44" height="82" rx="9" /><rect x="8" y="390" width="44" height="79" rx="9" /><rect x="748" y="108" width="44" height="86" rx="9" /><rect x="748" y="203" width="44" height="79" rx="9" /><rect x="748" y="297" width="44" height="82" rx="9" /><rect x="748" y="390" width="44" height="79" rx="9" />
        <path d="M18 115h24" stroke="#f28c22" strokeWidth="3" strokeLinecap="round" />
        {rowY.map((y, row) => <g key={`rails-${row}`}>{railLabel(displayInput(row), 30, y)}{railLabel(displayOutput(row), 770, y)}</g>)}
      </g>
      <g stroke="#c9c9ca" strokeWidth="2">{rowY.map((y, row) => <path key={`row-${row}`} d={`M52 ${y}H748`} />)}</g>
      {rowY.map((_, row) => splitPath(row))}
      <g filter="url(#blockGlow)">{screenBlocks.map(renderBlock)}</g>
    </svg>
    <div className="coros-vector-actions" aria-label="Grid controls">
      <button className="vector-action-hit preset-title-hit" title="Open device presets" aria-label={`Open preset browser; current preset ${snapshot.presetLocation} ${snapshot.presetName}`} onClick={onOpenPreset} />
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
    {screenMenuOpen && <div className="coros-screen-menu" role="menu" aria-label="Grid menu"><button role="menuitem" onClick={() => { setScreenMenuOpen(false); onOpenPreset(); }}>Open Preset…</button><button role="menuitem" onClick={() => { setScreenMenuOpen(false); onSave(); }}>Save Preset…</button><button role="menuitem" onClick={() => { setScreenMenuOpen(false); onOpenRouting(); }}>Edit Signal Routing…</button><button role="menuitem" onClick={() => { setScreenMenuOpen(false); onRefresh(); }}>Refresh Grid</button><button role="menuitem" disabled={!canUndo} onClick={() => { setScreenMenuOpen(false); onUndo(); }}>Undo {undoLabel ?? "Last Action"}</button></div>}
  </div>;
}

function controlByRole(controls: HardwareControl[], role: string) { return controls.find((control) => control.role === role); }

export function QuadCortexSurface({ formFactor, snapshot, selectedBlockId, skin, onAction, onOpenPreset, onUndo, canUndo, undoLabel, onSave, onOpenRouting, onRefresh }: QuadCortexSurfaceProps) {
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
    <div className="qc-screen-bezel"><CorOsGrid snapshot={snapshot} selectedBlockId={selectedBlockId} onAction={onAction} onOpenPreset={onOpenPreset} onUndo={onUndo} canUndo={canUndo} undoLabel={undoLabel} onSave={onSave} onOpenRouting={onOpenRouting} onRefresh={onRefresh} /></div>
    <div className="screen-nav-control"><span className="nav-arrow nav-arrow-up" /><HardwareSwitch role={bankUp.role} label="BANK UP" compact accent="#83ddfa" onAction={onAction} /><span className="nav-arrow nav-arrow-down" /></div>
    <div className="footswitch-deck">
      <div className="footswitch-row">{scenes.slice(0, 4).map((control, index) => <HardwareSwitch key={control.id} role={control.role} label={control.label} active={leds[index].active} assigned={leds[index].assigned} accent={leds[index].color} onAction={onAction} />)}<HardwareSwitch role={bankDown.role} label="BANK DOWN" accent="#d8dde0" onAction={onAction} /></div>
      <div className="mode-bracket" aria-hidden="true"><span>＋</span><strong>MODE</strong><span>−</span></div>
      <div className="footswitch-row">{scenes.slice(4).map((control, index) => <HardwareSwitch key={control.id} role={control.role} label={control.label} active={leds[index + 4].active} assigned={leds[index + 4].assigned} accent={leds[index + 4].color} onAction={onAction} />)}<HardwareSwitch role={tempo.role} label="TEMPO" active={snapshot.tempoLedEnabled} pulseBpm={snapshot.tempoLedEnabled ? snapshot.tempo : undefined} accent="#e6e6e6" onAction={onAction} /></div>
      <span className="tuner-hint">TEMPO<br />HOLD: TUNER</span>
    </div>
  </section>;
}
