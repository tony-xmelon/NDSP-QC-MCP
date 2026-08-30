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
}

const officialBlockSprite = "/qc-block-samples.svg";
const officialBlockTiles: Record<string, [number, number]> = {
  gate: [0, 82], compressor: [80, 0], "capture-grid": [480, 82], wave: [160, 0],
  level: [160, 82], amp: [480, 0], cab: [80, 82], capture: [400, 82],
  cube: [240, 82], delay: [240, 0], reverb: [320, 0], mod: [160, 0], utility: [80, 0]
};

function DeviceGlyph({ block, x, y, size = 64 }: { block: GridBlock; x: number; y: number; size?: number }) {
  const [tileX, tileY] = officialBlockTiles[block.glyph ?? block.kind] ?? [480, 0];
  return <svg className="official-block-tile" x={x - size / 2} y={y - size / 2} width={size} height={size} viewBox={`${tileX} ${tileY} 70 70`} preserveAspectRatio="xMidYMid meet" overflow="hidden" aria-hidden="true">
    <image href={officialBlockSprite} x="0" y="0" width="710" height="152" />
  </svg>;
}

function HardwareSwitch({ role, label, active, accent, compact = false, pulseBpm, onAction }: {
  role: string; label: string; active?: boolean; accent?: string; compact?: boolean; pulseBpm?: number; onAction: (action: HardwareAction) => void;
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
      onAction({ kind: "switch", role, phase: "press" });
      onAction({ kind: "switch", role, phase: "release" });
    }
  };
  const wheel = (event: WheelEvent<HTMLButtonElement>) => {
    event.preventDefault();
    rotate(event.deltaY < 0 ? 1 : -1);
  };
  return <button
    className={`hardware-switch${active || pressed ? " is-active" : ""}${compact ? " is-compact" : ""}${pulseBpm ? " is-tempo-pulse" : ""}`}
    style={{ "--switch-accent": accent ?? "var(--accent)", "--tempo-period": pulseBpm ? `${60 / pulseBpm}s` : undefined } as CSSProperties}
    aria-label={`${label} encoder footswitch`} aria-pressed={active} aria-valuetext={`${encoderValue} percent`}
    title={`${label}: tap to press; drag vertically, use the mouse wheel, or press arrow keys to rotate`}
    onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); setPressed(true); drag.current = { pointerId: event.pointerId, lastY: event.clientY, rotated: false }; }}
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

function CorOsGrid({ snapshot, selectedBlockId, onAction }: Pick<QuadCortexSurfaceProps, "snapshot" | "selectedBlockId" | "onAction">) {
  const [sceneMenuOpen, setSceneMenuOpen] = useState(false);
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
    const firstY = y - (lines.length - 1) * 8;
    return <text x={x} y={firstY} fill="#dedede" fontSize={label === "+" ? 25 : 11}>{lines.map((line, index) => <tspan key={`${line}-${index}`} x={x} dy={index ? 16 : 0}>{line}</tspan>)}</text>;
  };
  const splitPath = (row: number) => {
    const route = routes[row];
    if (route?.splitColumn === undefined || row >= rowY.length - 1) return null;
    const splitX = columns[Math.max(0, Math.min(7, route.splitColumn))];
    const rejoins = route.mixColumn !== undefined && route.mixColumn >= 0;
    const mixX = rejoins ? columns[Math.max(0, Math.min(7, route.mixColumn!))] : 748;
    return <g key={`split-${row}`} fill="none" stroke="#c9c9ca" strokeWidth="2">
      <path d={`M${splitX} ${rowY[row]}V${rowY[row + 1]}H${mixX}`} />
      <circle cx={splitX} cy={rowY[row]} r="5" fill="#050506" stroke="#efefef" />
      {rejoins && <circle cx={mixX} cy={rowY[row]} r="5" fill="#050506" stroke="#efefef" />}
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
      <g transform="matrix(.96 0 0 1 -4 0)" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="68" letterSpacing="-2"><text x="14" y="75" fill="#f4f4f4">{snapshot.presetLocation.slice(0, -1)}</text><text x="56" y="75" textLength="42" lengthAdjust="spacingAndGlyphs" fill="#3ee77b">{snapshot.presetLocation.slice(-1)}</text><text x="114" y="75" fill="#f4f4f4">{snapshot.presetName}</text></g>
      <g fill="none" stroke="#f0f0f0" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M635 16a13 13 0 1 1-13 2M622 18v-9m0 9 8-5" /><path d="M709 11h20l6 6v24h-26zM714 11v10h14V11m-10 14h10m-5 2 7 7-7 7" /></g>
      <rect x="654" y="9" width="31" height="31" rx="4" fill="#f2cf32" /><text x="669.5" y="34" textAnchor="middle" fill="#141414" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="25">{sceneLetter}</text>
      <g fill="#f2f2f2"><circle cx="766" cy="15" r="2.2" /><circle cx="766" cy="25" r="2.2" /><circle cx="766" cy="35" r="2.2" /></g>
      <g stroke="#f0f0f0" strokeWidth="3" strokeLinecap="round"><path d="M653 57h28M653 66h28M653 75h28" /><circle fill="#f0f0f0" cx="661" cy="57" r="3.5" /><circle fill="#f0f0f0" cx="674" cy="66" r="3.5" /><circle fill="#f0f0f0" cx="663" cy="75" r="3.5" /></g><text x="691" y="76" fill="#f0f0f0" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="24">{snapshot.mode}</text>
      <g fill="#171719" fontFamily="Arial, Helvetica, sans-serif" fontWeight="600" textAnchor="middle">
        <rect x="8" y="108" width="44" height="86" rx="9" /><rect x="8" y="203" width="44" height="79" rx="9" /><rect x="8" y="297" width="44" height="82" rx="9" /><rect x="8" y="390" width="44" height="79" rx="9" /><rect x="748" y="108" width="44" height="86" rx="9" /><rect x="748" y="203" width="44" height="79" rx="9" /><rect x="748" y="297" width="44" height="82" rx="9" /><rect x="748" y="390" width="44" height="79" rx="9" />
        <path d="M18 115h24" stroke="#f28c22" strokeWidth="3" strokeLinecap="round" />
        {rowY.map((y, row) => <g key={`rails-${row}`}>{railLabel(displayInput(row), 30, y)}{railLabel(displayOutput(row), 770, y)}</g>)}
      </g>
      <g stroke="#c9c9ca" strokeWidth="2">{rowY.map((y, row) => <path key={`row-${row}`} d={`M52 ${y}H748`} />)}</g>
      {rowY.map((_, row) => splitPath(row))}
      <g filter="url(#blockGlow)">{screenBlocks.map(renderBlock)}</g>
    </svg>
    <div className="coros-vector-actions" aria-label="Preset actions"><button className="vector-action-hit undo-hit" title="Undo is unavailable; use the app's verified Discard Unsaved Changes command" aria-label="Undo unavailable" disabled /><button className="vector-action-hit scene-hit" aria-label="Select scene" aria-expanded={sceneMenuOpen} onClick={() => setSceneMenuOpen((open) => !open)} /><button className="vector-action-hit save-hit" title="Use File > Save Preset to Quad Cortex for destination review" aria-label="Use the File menu to save a preset" disabled /><button className="vector-action-hit more-hit" title="Use the application menus for preset operations" aria-label="Use the application menus for preset operations" disabled /></div>
    {screenBlocks.map((block) => <button key={block.id} className="coros-vector-block-hit" style={{ left: `${columns[block.column] / 8}%`, top: `${rowY[block.row] / 4.8}%` }} title={`Row ${block.row + 1}, ${block.name}`} aria-label={`Row ${block.row + 1}, ${block.name}`} aria-pressed={selectedBlockId === block.id} onClick={() => onAction({ kind: "select-block", blockId: block.id })} />)}
    {sceneMenuOpen && <div className="scene-dropdown vector-scene-dropdown" role="menu" aria-label="Scenes">{snapshot.scenes.map((scene, index) => <button key={scene} role="menuitem" className={snapshot.activeScene === index ? "is-active" : ""} onClick={() => { setSceneMenuOpen(false); onAction({ kind: "select-scene", scene: index }); }}><span>{String.fromCharCode(65 + index)}</span>{scene}</button>)}</div>}
  </div>;
}

function controlByRole(controls: HardwareControl[], role: string) { return controls.find((control) => control.role === role); }

export function QuadCortexSurface({ formFactor, snapshot, selectedBlockId, skin, onAction }: QuadCortexSurfaceProps) {
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
    {skin.svgAsset && <div className="official-svg-viewport" aria-hidden="true"><img className="official-svg-source" src={skin.svgAsset.url} alt="" style={svgCropStyle} /></div>}
    <div className="chassis-edge" aria-hidden="true" />
    <MasterVolume value={snapshot.masterVolume} onAction={onAction} />
    <div className="device-plate"><svg className="pulse-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1 3.5 8H7l-1 7 6.5-8H9z" /></svg><span>QUADCORTEX</span><small>CONTROL SURFACE</small></div>
    <div className="qc-screen-bezel"><CorOsGrid snapshot={snapshot} selectedBlockId={selectedBlockId} onAction={onAction} /></div>
    <div className="screen-nav-control"><span className="nav-arrow nav-arrow-up" /><HardwareSwitch role={bankUp.role} label="BANK UP" compact accent="#83ddfa" onAction={onAction} /><span className="nav-arrow nav-arrow-down" /></div>
    <div className="footswitch-deck">
      <div className="footswitch-row">{scenes.slice(0, 4).map((control, index) => <HardwareSwitch key={control.id} role={control.role} label={control.label} active={leds[index].active} accent={leds[index].color} onAction={onAction} />)}<HardwareSwitch role={bankDown.role} label="BANK DOWN" accent="#d8dde0" onAction={onAction} /></div>
      <div className="mode-bracket" aria-hidden="true"><span>＋</span><strong>MODE</strong><span>−</span></div>
      <div className="footswitch-row">{scenes.slice(4).map((control, index) => <HardwareSwitch key={control.id} role={control.role} label={control.label} active={leds[index + 4].active} accent={leds[index + 4].color} onAction={onAction} />)}<HardwareSwitch role={tempo.role} label="TEMPO" active={snapshot.tempoLedEnabled} pulseBpm={snapshot.tempoLedEnabled ? snapshot.tempo : undefined} accent="#e6e6e6" onAction={onAction} /></div>
      <span className="tuner-hint">TEMPO<br />HOLD: TUNER</span>
    </div>
  </section>;
}
