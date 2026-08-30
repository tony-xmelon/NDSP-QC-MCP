import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import type { GridBlock, PresetSnapshot } from "@ndsp-qc/client";
import type { FormFactorManifest, HardwareControl } from "@ndsp-qc/form-factors";

export type HardwareAction =
  | { kind: "switch"; role: string; phase: "press" | "release" }
  | { kind: "rotate"; role: string; delta: number }
  | { kind: "select-block"; blockId: string };

interface QuadCortexSurfaceProps {
  formFactor: FormFactorManifest;
  snapshot: PresetSnapshot;
  selectedBlockId?: string;
  skinClassName: string;
  onAction: (action: HardwareAction) => void;
}

const blockColors: Record<string, string> = {
  input: "#ff8b22", utility: "#d7b940", capture: "#ff8a35", amp: "#ed4b43", cab: "#f03f55",
  mod: "#44d86e", delay: "#427cff", reverb: "#26d6c6", output: "#16c8be"
};

function DeviceGlyph({ block }: { block: GridBlock }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const kind = block.glyph ?? block.kind;
  if (kind === "amp") return <svg viewBox="0 0 32 32" aria-hidden="true"><rect {...common} x="7" y="9" width="18" height="5" rx=".5" /><rect {...common} x="7" y="18" width="18" height="5" rx=".5" /></svg>;
  if (kind === "cab") return <svg viewBox="0 0 32 32" aria-hidden="true"><circle {...common} cx="16" cy="17" r="7" /><circle fill="currentColor" cx="16" cy="17" r="2" /><circle fill="currentColor" cx="7" cy="8" r="1.5" /><circle fill="currentColor" cx="25" cy="8" r="1.5" /></svg>;
  if (kind === "capture") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M6 25 10 7l2 18 4-16-1 16m3 0 7-13m-7 13 10-6m-10 6h11" /></svg>;
  if (kind === "cube") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M6 11h13v15H6zM6 11l7-6h13v15l-7 6M19 11l7-6M19 26l7-6" /></svg>;
  if (kind === "delay") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M7 16h4m3 0h4m3 0h4M9 10v12m7-9v6m7-9v12" /></svg>;
  if (kind === "reverb") return <svg viewBox="0 0 32 32" aria-hidden="true"><circle {...common} cx="11" cy="13" r="5" /><circle {...common} cx="21" cy="13" r="5" /><circle fill="currentColor" cx="11" cy="13" r="1.4" /><circle fill="currentColor" cx="21" cy="13" r="1.4" /><path {...common} d="M6 22h10m0 0h10M8 25h6m4 0h6" /></svg>;
  if (kind === "mod") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M4 18c4-13 8 13 12 0s8 13 12 0" /></svg>;
  if (kind === "utility") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M7 10h18M7 16h18M7 22h18M12 7v6m8 0v6m-5 0v6" /></svg>;
  return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M6 10h20v12H6zM9 16h14" /></svg>;
}

function ActionGlyph({ kind }: { kind: "undo" | "save" | "mode" | "more" }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "undo") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M10 9H4V3M5 9a12 12 0 1 1-1 13" /><path {...common} d="m4 9 6-6" /></svg>;
  if (kind === "save") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M6 4h17l4 4v19H6zM10 4v8h12V4M12 22h9" /><path {...common} d="m19 17 5 5-5 5" /></svg>;
  if (kind === "mode") return <svg viewBox="0 0 32 32" aria-hidden="true">
    <path {...common} d="M5 8h22M5 16h22M5 24h22" />
    <circle fill="currentColor" cx="11" cy="8" r="3.2" /><circle fill="currentColor" cx="22" cy="16" r="3.2" /><circle fill="currentColor" cx="13" cy="24" r="3.2" />
  </svg>;
  return <svg viewBox="0 0 32 32" aria-hidden="true"><circle fill="currentColor" cx="16" cy="6" r="2.2" /><circle fill="currentColor" cx="16" cy="16" r="2.2" /><circle fill="currentColor" cx="16" cy="26" r="2.2" /></svg>;
}

function HardwareSwitch({ role, label, active, accent, compact = false, onAction }: {
  role: string; label: string; active?: boolean; accent?: string; compact?: boolean; onAction: (action: HardwareAction) => void;
}) {
  const release = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onAction({ kind: "switch", role, phase: "release" });
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)) {
      event.preventDefault();
      onAction({ kind: "rotate", role, delta: event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1 });
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
    onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); onAction({ kind: "switch", role, phase: "press" }); }}
    onPointerUp={release} onPointerCancel={release} onKeyDown={keyboard} onWheel={wheel}
  >
    <span className="switch-led" aria-hidden="true" />
    <span className="switch-ring" aria-hidden="true"><span className="switch-cap" /></span>
    <span className="switch-label">{label}</span>
  </button>;
}

function MasterVolume({ onAction }: { onAction: (action: HardwareAction) => void }) {
  return <div className="master-volume">
    <button className="power-button" aria-label="Power and lock menu" onClick={() => onAction({ kind: "switch", role: "power", phase: "release" })}><span /></button>
    <button className="volume-knob" aria-label="Master volume knob" onWheel={(event) => {
      event.preventDefault();
      onAction({ kind: "rotate", role: "master-volume", delta: event.deltaY < 0 ? 1 : -1 });
    }}><span /></button>
    <strong>VOLUME</strong>
  </div>;
}

function ScreenBlock({ block, selected, onAction }: { block: GridBlock; selected: boolean; onAction: (action: HardwareAction) => void }) {
  return <button
    className={`coros-block${block.bypassed ? " is-bypassed" : ""}${selected ? " is-selected" : ""}`}
    style={{ "--block-color": block.color ?? blockColors[block.kind] } as CSSProperties}
    title={block.name} aria-label={block.name} aria-pressed={selected}
    onClick={() => onAction({ kind: "select-block", blockId: block.id })}
  ><DeviceGlyph block={block} /><span className="block-tooltip">{block.name}</span></button>;
}

function CorOsGrid({ snapshot, selectedBlockId, onAction }: Pick<QuadCortexSurfaceProps, "snapshot" | "selectedBlockId" | "onAction">) {
  const [sceneMenuOpen, setSceneMenuOpen] = useState(false);
  const visibleRows = [0, 1, 2, 3];
  return <div className="qc-screen" aria-label="CorOS Grid">
    <header className="coros-header">
      <div className="coros-title"><span>{snapshot.presetLocation.slice(0, -1)}</span><em>{snapshot.presetLocation.slice(-1)}</em><strong>{snapshot.presetName}</strong></div>
      <div className="coros-actions" aria-label="Preset actions">
        <button title="Undo" aria-label="Undo"><ActionGlyph kind="undo" /></button>
        <div className="scene-control">
          <button className="scene-indicator" aria-label="Select scene" aria-expanded={sceneMenuOpen} onClick={() => setSceneMenuOpen((open) => !open)}><span>{String.fromCharCode(65 + snapshot.activeScene)}</span></button>
          {sceneMenuOpen && <div className="scene-dropdown" role="menu" aria-label="Scenes">
            {snapshot.scenes.map((scene, index) => <button key={scene} role="menuitem" className={snapshot.activeScene === index ? "is-active" : ""} onClick={() => {
              setSceneMenuOpen(false);
              onAction({ kind: "switch", role: `footswitch:${String.fromCharCode(65 + index)}`, phase: "release" });
            }}><span>{String.fromCharCode(65 + index)}</span>{scene}</button>)}
          </div>}
        </div>
        <button title="Save preset" aria-label="Save preset"><ActionGlyph kind="save" /></button>
        <button title="More" aria-label="Preset menu"><ActionGlyph kind="more" /></button>
        <div className="mode-readout"><ActionGlyph kind="mode" />{snapshot.mode}</div>
      </div>
    </header>
    <div className="coros-workspace">
      <div className="row-rail row-rail-left" aria-hidden="true"><span className="io-pill"><i />In<br />1</span><span className="add-row">＋</span><span className="io-pill">Prev.<br />Row</span><span className="add-row">＋</span></div>
      <div className="routing-lanes">
        {visibleRows.map((row) => <div className="routing-lane" key={row}>
          <span className="lane-wire" aria-hidden="true" />
          {Array.from({ length: 8 }, (_, column) => {
            const block = snapshot.blocks.find((candidate) => candidate.row === row && candidate.column === column);
            return <div className="coros-slot" key={`${row}-${column}`}>{block ? <ScreenBlock block={block} selected={selectedBlockId === block.id} onAction={onAction} /> : <button className="empty-slot" aria-label={`Empty slot row ${row + 1}, column ${column + 1}`}>＋</button>}</div>;
          })}
        </div>)}
      </div>
      <div className="row-rail row-rail-right" aria-hidden="true"><span className="io-pill">Row<br />3</span><span className="add-row">＋</span><span className="io-pill output-pill">Multi<br />Out<i /></span><span className="add-row">＋</span></div>
    </div>
  </div>;
}

function controlByRole(controls: HardwareControl[], role: string) { return controls.find((control) => control.role === role); }

export function QuadCortexSurface({ formFactor, snapshot, selectedBlockId, skinClassName, onAction }: QuadCortexSurfaceProps) {
  const scenes = formFactor.controls.filter((control) => control.group === "scene");
  const bankUp = controlByRole(formFactor.controls, "bank:up")!;
  const bankDown = controlByRole(formFactor.controls, "bank:down")!;
  const tempo = controlByRole(formFactor.controls, "tempo")!;
  const accents = ["#c7adff", "#4bd89a", "#f6da58", "#70d7ff", "#c7adff", "#4bd89a", "#f6da58", "#70d7ff"];
  return <section className={`qc-chassis ${skinClassName}`} aria-label={formFactor.displayName}>
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
