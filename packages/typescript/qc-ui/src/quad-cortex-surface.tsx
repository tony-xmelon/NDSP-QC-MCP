import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import type { GridBlock, PresetSnapshot } from "@ndsp-qc/client";
import type { FormFactorManifest, HardwareControl, SkinManifest } from "@ndsp-qc/form-factors";

export type HardwareAction =
  | { kind: "switch"; role: string; phase: "press" | "release" }
  | { kind: "rotate"; role: string; delta: number }
  | { kind: "select-block"; blockId: string };

interface QuadCortexSurfaceProps {
  formFactor: FormFactorManifest;
  snapshot: PresetSnapshot;
  selectedBlockId?: string;
  skin: SkinManifest;
  onAction: (action: HardwareAction) => void;
}

const blockColors: Record<string, string> = {
  input: "#ff8b22", utility: "#d7b940", capture: "#ff8a35", amp: "#ed4b43", cab: "#f03f55",
  mod: "#44d86e", delay: "#427cff", reverb: "#26d6c6", output: "#16c8be"
};

function DeviceGlyph({ block }: { block: GridBlock }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const kind = block.glyph ?? block.kind;
  if (kind === "gate") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M5 22c4 0 5-13 9-13s5 13 9 13h4M7 24 24 7" /></svg>;
  if (kind === "compressor") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M7 8v16m5-12v8m4-10v12m4-8v4m5-10v16" /></svg>;
  if (kind === "capture-grid") return <svg viewBox="0 0 32 32" aria-hidden="true"><rect fill="currentColor" x="7" y="8" width="4" height="4" rx=".7" /><rect fill="currentColor" x="14" y="8" width="4" height="4" rx=".7" /><rect fill="currentColor" x="21" y="8" width="4" height="4" rx=".7" /><rect fill="currentColor" x="10.5" y="15" width="4" height="4" rx=".7" /><rect fill="currentColor" x="17.5" y="15" width="4" height="4" rx=".7" /><path {...common} d="M7 24h18" /></svg>;
  if (kind === "wave") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M4 18c3-12 6 12 9 0s6 12 9 0 5 3 6 1" /></svg>;
  if (kind === "level") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M5 16h4m2-5v10m3-14v18m3-11v4m3-9v14m3-7h4" /></svg>;
  if (kind === "amp") return <svg viewBox="0 0 32 32" aria-hidden="true"><rect {...common} x="7" y="9" width="18" height="5" rx=".5" /><rect {...common} x="7" y="18" width="18" height="5" rx=".5" /></svg>;
  if (kind === "cab") return <svg viewBox="0 0 32 32" aria-hidden="true"><circle {...common} cx="16" cy="16" r="7" /><circle fill="currentColor" cx="16" cy="16" r="2" /><circle fill="currentColor" cx="7" cy="8" r="1.5" /><circle fill="currentColor" cx="25" cy="8" r="1.5" /><circle fill="currentColor" cx="7" cy="24" r="1.5" /><circle fill="currentColor" cx="25" cy="24" r="1.5" /></svg>;
  if (kind === "capture") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M6 26 11 7M8 26l6-16m-4 16 8-14m-6 14 11-11m-9 11 13-6m-11 6h12" /></svg>;
  if (kind === "cube") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M6 11h13v15H6zM6 11l7-6h13v15l-7 6M19 11l7-6M19 26l7-6" /></svg>;
  if (kind === "delay") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M7 16h4m3 0h4m3 0h4M9 10v12m7-9v6m7-9v12" /></svg>;
  if (kind === "reverb") return <svg viewBox="0 0 32 32" aria-hidden="true"><circle {...common} cx="11" cy="13" r="5" /><circle {...common} cx="21" cy="13" r="5" /><circle fill="currentColor" cx="11" cy="13" r="1.4" /><circle fill="currentColor" cx="21" cy="13" r="1.4" /><path {...common} d="M6 22h10m0 0h10M8 25h6m4 0h6" /></svg>;
  if (kind === "mod") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M4 18c4-13 8 13 12 0s8 13 12 0" /></svg>;
  if (kind === "utility") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M7 10h18M7 16h18M7 22h18M12 7v6m8 0v6m-5 0v6" /></svg>;
  return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M6 10h20v12H6zM9 16h14" /></svg>;
}

function HardwareSwitch({ role, label, active, accent, compact = false, onAction }: {
  role: string; label: string; active?: boolean; accent?: string; compact?: boolean; onAction: (action: HardwareAction) => void;
}) {
  const drag = useRef<{ pointerId: number; lastY: number; rotated: boolean } | null>(null);
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
      onAction({ kind: "rotate", role, delta: event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1 });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onAction({ kind: "switch", role, phase: "press" });
      onAction({ kind: "switch", role, phase: "release" });
    }
  };
  const wheel = (event: WheelEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onAction({ kind: "rotate", role, delta: event.deltaY < 0 ? 1 : -1 });
  };
  return <button
    className={`hardware-switch${active ? " is-active" : ""}${compact ? " is-compact" : ""}`}
    style={{ "--switch-accent": accent ?? "var(--accent)" } as CSSProperties}
    aria-label={`${label} encoder footswitch`} aria-pressed={active}
    title={`${label}: tap to press; drag vertically, use the mouse wheel, or press arrow keys to rotate`}
    onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); drag.current = { pointerId: event.pointerId, lastY: event.clientY, rotated: false }; }}
    onPointerMove={(event) => {
      const gesture = drag.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const steps = Math.trunc((gesture.lastY - event.clientY) / 12);
      if (!steps) return;
      gesture.rotated = true;
      gesture.lastY -= steps * 12;
      onAction({ kind: "rotate", role, delta: steps });
    }}
    onPointerUp={(event) => release(event)} onPointerCancel={(event) => release(event, true)} onKeyDown={keyboard} onWheel={wheel}
  >
    <span className="switch-led" aria-hidden="true" />
    <span className="switch-ring" aria-hidden="true"><span className="switch-cap" /></span>
    <span className="switch-label">{label}</span>
  </button>;
}

function MasterVolume({ onAction }: { onAction: (action: HardwareAction) => void }) {
  const drag = useRef<{ pointerId: number; lastY: number } | null>(null);
  return <div className="master-volume">
    <button className="power-button" aria-label="Power and lock menu" onClick={() => onAction({ kind: "switch", role: "power", phase: "release" })}><svg className="power-icon" viewBox="3 2 18 20" aria-hidden="true"><path d="M12 3v8M7.3 6.4a7.5 7.5 0 1 0 9.4 0" /></svg></button>
    <button className="volume-knob" aria-label="Master volume knob" title="Drag vertically, use the mouse wheel, or press arrow keys to adjust volume" onPointerDown={(event) => {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { pointerId: event.pointerId, lastY: event.clientY };
    }} onPointerMove={(event) => {
      const gesture = drag.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const steps = Math.trunc((gesture.lastY - event.clientY) / 12);
      if (!steps) return;
      gesture.lastY -= steps * 12;
      onAction({ kind: "rotate", role: "master-volume", delta: steps });
    }} onPointerUp={(event) => {
      drag.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={() => { drag.current = null; }} onKeyDown={(event) => {
      if (!["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)) return;
      event.preventDefault();
      onAction({ kind: "rotate", role: "master-volume", delta: event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1 });
    }} onWheel={(event) => {
      event.preventDefault();
      onAction({ kind: "rotate", role: "master-volume", delta: event.deltaY < 0 ? 1 : -1 });
    }}><span /></button>
    <strong>VOLUME</strong>
  </div>;
}

function CorOsGrid({ snapshot, selectedBlockId, onAction }: Pick<QuadCortexSurfaceProps, "snapshot" | "selectedBlockId" | "onAction">) {
  const [sceneMenuOpen, setSceneMenuOpen] = useState(false);
  const columns = [98, 184, 273, 361, 448, 528, 616, 703];
  const screenBlocks = snapshot.blocks.filter((block) => (block.row === 0 || block.row === 2) && block.column >= 0 && block.column < 8);
  const sceneLetter = String.fromCharCode(65 + snapshot.activeScene);
  const renderBlock = (block: GridBlock) => {
    const cx = columns[block.column];
    const cy = block.row === 0 ? 147 : 334;
    const color = block.color ?? blockColors[block.kind];
    const selected = selectedBlockId === block.id;
    return <g key={block.id} opacity={block.bypassed ? .16 : 1} color="#f2f2f2">
      <rect x={cx - 31} y={cy - 31} width="62" height="62" rx="10" fill="#030304" stroke={selected ? "#f5f5f5" : color} strokeWidth={block.bypassed ? 1.5 : 2.2} />
      <svg x={cx - 18} y={cy - 18} width="36" height="36" viewBox="0 0 32 32"><DeviceGlyph block={block} /></svg>
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
        <path d="M18 115h24" stroke="#f28c22" strokeWidth="3" strokeLinecap="round" /><text x="30" y="143" fill="#dedede" fontSize="15"><tspan x="30">In</tspan><tspan x="30" dy="18">1</tspan></text><text x="30" y="252" fill="#d7d7d7" fontSize="28">＋</text><text x="30" y="327" fill="#dedede" fontSize="13"><tspan x="30">Prev.</tspan><tspan x="30" dy="17">Row</tspan></text><text x="30" y="440" fill="#d7d7d7" fontSize="28">＋</text>
        <text x="770" y="143" fill="#dedede" fontSize="14"><tspan x="770">Row</tspan><tspan x="770" dy="18">3</tspan></text><text x="770" y="252" fill="#d7d7d7" fontSize="28">＋</text><text x="770" y="327" fill="#dedede" fontSize="13"><tspan x="770">Multi</tspan><tspan x="770" dy="17">Out</tspan></text><path d="M758 375h24" stroke="#e6403d" strokeWidth="3" strokeLinecap="round" /><text x="770" y="440" fill="#d7d7d7" fontSize="28">＋</text>
      </g>
      <g stroke="#c9c9ca" strokeWidth="2"><path d="M52 145H748" /><path d="M52 333H748" /></g><g fill="#050506" stroke="#efefef" strokeWidth="2"><circle cx="53" cy="145" r="6" /><circle cx="574" cy="145" r="6" /><circle cx="154" cy="333" r="5" /></g>
      <g filter="url(#blockGlow)">{screenBlocks.map(renderBlock)}</g>
    </svg>
    <div className="coros-vector-actions" aria-label="Preset actions"><button className="vector-action-hit undo-hit" title="Undo" aria-label="Undo" /><button className="vector-action-hit scene-hit" aria-label="Select scene" aria-expanded={sceneMenuOpen} onClick={() => setSceneMenuOpen((open) => !open)} /><button className="vector-action-hit save-hit" title="Save preset" aria-label="Save preset" /><button className="vector-action-hit more-hit" title="More" aria-label="Preset menu" /></div>
    {screenBlocks.map((block) => <button key={block.id} className="coros-vector-block-hit" style={{ left: `${columns[block.column] / 8}%`, top: `${(block.row === 0 ? 147 : 334) / 4.8}%` }} title={block.name} aria-label={block.name} aria-pressed={selectedBlockId === block.id} onClick={() => onAction({ kind: "select-block", blockId: block.id })} />)}
    {sceneMenuOpen && <div className="scene-dropdown vector-scene-dropdown" role="menu" aria-label="Scenes">{snapshot.scenes.map((scene, index) => <button key={scene} role="menuitem" className={snapshot.activeScene === index ? "is-active" : ""} onClick={() => { setSceneMenuOpen(false); onAction({ kind: "switch", role: `footswitch:${String.fromCharCode(65 + index)}`, phase: "release" }); }}><span>{String.fromCharCode(65 + index)}</span>{scene}</button>)}</div>}
  </div>;
}

function controlByRole(controls: HardwareControl[], role: string) { return controls.find((control) => control.role === role); }

export function QuadCortexSurface({ formFactor, snapshot, selectedBlockId, skin, onAction }: QuadCortexSurfaceProps) {
  const scenes = formFactor.controls.filter((control) => control.group === "scene");
  const bankUp = controlByRole(formFactor.controls, "bank:up")!;
  const bankDown = controlByRole(formFactor.controls, "bank:down")!;
  const tempo = controlByRole(formFactor.controls, "tempo")!;
  const accents = ["#c7adff", "#4bd89a", "#f6da58", "#70d7ff", "#c7adff", "#4bd89a", "#f6da58", "#70d7ff"];
  const svgCropStyle = skin.svgAsset ? {
    width: `${skin.svgAsset.sourceWidth / skin.svgAsset.crop.width * 100}%`,
    left: `${-skin.svgAsset.crop.x / skin.svgAsset.crop.width * 100}%`,
    top: `${-skin.svgAsset.crop.y / skin.svgAsset.crop.height * 100}%`
  } as CSSProperties : undefined;
  return <section className={`qc-chassis ${skin.className}`} aria-label={formFactor.displayName}>
    {skin.svgAsset && <div className="official-svg-viewport" aria-hidden="true"><img className="official-svg-source" src={skin.svgAsset.url} alt="" style={svgCropStyle} /></div>}
    <div className="chassis-edge" aria-hidden="true" />
    <MasterVolume onAction={onAction} />
    <div className="device-plate"><svg className="pulse-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1 3.5 8H7l-1 7 6.5-8H9z" /></svg><span>QUADCORTEX</span><small>CONTROL SURFACE</small></div>
    <div className="qc-screen-bezel"><CorOsGrid snapshot={snapshot} selectedBlockId={selectedBlockId} onAction={onAction} /></div>
    <div className="screen-nav-control"><span className="nav-arrow nav-arrow-up" /><HardwareSwitch role={bankUp.role} label="BANK UP" compact accent="#83ddfa" onAction={onAction} /><span className="nav-arrow nav-arrow-down" /></div>
    <div className="footswitch-deck">
      <div className="footswitch-row">{scenes.slice(0, 4).map((control, index) => <HardwareSwitch key={control.id} role={control.role} label={control.label} active={snapshot.activeScene === index} accent={accents[index]} onAction={onAction} />)}<HardwareSwitch role={bankDown.role} label="BANK DOWN" accent="#d8dde0" onAction={onAction} /></div>
      <div className="mode-bracket" aria-hidden="true"><span>＋</span><strong>MODE</strong><span>−</span></div>
      <div className="footswitch-row">{scenes.slice(4).map((control, index) => <HardwareSwitch key={control.id} role={control.role} label={control.label} active={snapshot.activeScene === index + 4} accent={accents[index + 4]} onAction={onAction} />)}<HardwareSwitch role={tempo.role} label="TEMPO" accent="#e6e6e6" onAction={onAction} /></div>
      <span className="tuner-hint">TEMPO<br />HOLD: TUNER</span>
    </div>
  </section>;
}
