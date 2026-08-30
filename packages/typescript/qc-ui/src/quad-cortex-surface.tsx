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
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (block.kind === "amp") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M5 25 10 7l4 18 4-13 3 13 3-8 3 8" /></svg>;
  if (block.kind === "cab") return <svg viewBox="0 0 32 32" aria-hidden="true"><rect {...common} x="6" y="5" width="20" height="22" rx="2" /><circle {...common} cx="16" cy="16" r="6" /><circle fill="currentColor" cx="16" cy="16" r="1.5" /></svg>;
  if (block.kind === "capture") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M4 19c4-12 6 12 10 0s6 12 10 0 3-4 4-2" /></svg>;
  if (block.kind === "delay") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M7 16h4m3 0h4m3 0h4M9 10v12m7-9v6m7-9v12" /></svg>;
  if (block.kind === "reverb") return <svg viewBox="0 0 32 32" aria-hidden="true"><circle {...common} cx="11" cy="16" r="5" /><circle {...common} cx="21" cy="16" r="5" /><path {...common} d="M7 10 4 7m3 15-3 3m21-15 3-3m-3 15 3 3" /></svg>;
  if (block.kind === "mod") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M4 18c4-13 8 13 12 0s8 13 12 0" /></svg>;
  if (block.kind === "utility") return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M7 10h18M7 16h18M7 22h18M12 7v6m8 0v6m-5 0v6" /></svg>;
  return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M6 10h20v12H6zM9 16h14" /></svg>;
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
    style={{ "--block-color": blockColors[block.kind] } as CSSProperties}
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
        <button title="Undo" aria-label="Undo">↶</button>
        <div className="scene-control">
          <button className="scene-indicator" aria-label="Select scene" aria-expanded={sceneMenuOpen} onClick={() => setSceneMenuOpen((open) => !open)}><span>{String.fromCharCode(65 + snapshot.activeScene)}</span></button>
          {sceneMenuOpen && <div className="scene-dropdown" role="menu" aria-label="Scenes">
            {snapshot.scenes.map((scene, index) => <button key={scene} role="menuitem" className={snapshot.activeScene === index ? "is-active" : ""} onClick={() => {
              setSceneMenuOpen(false);
              onAction({ kind: "switch", role: `footswitch:${String.fromCharCode(65 + index)}`, phase: "release" });
            }}><span>{String.fromCharCode(65 + index)}</span>{scene}</button>)}
          </div>}
        </div>
        <button title="Save preset" aria-label="Save preset">▣</button>
        <button title="More" aria-label="Preset menu">⋮</button>
        <div className="mode-readout"><span>▦</span>{snapshot.mode}</div>
      </div>
    </header>
    <div className="coros-workspace">
      <div className="row-rail row-rail-left" aria-hidden="true"><span className="io-pill"><i />In<br />1</span><span className="add-row">＋</span><span className="add-row">＋</span><span className="add-row">＋</span></div>
      <div className="routing-lanes">
        {visibleRows.map((row) => <div className="routing-lane" key={row}>
          <span className="lane-wire" aria-hidden="true" />
          {Array.from({ length: 6 }, (_, index) => {
            const column = index + 1;
            const block = snapshot.blocks.find((candidate) => candidate.row === row && candidate.column === column);
            return <div className="coros-slot" key={`${row}-${column}`}>{block ? <ScreenBlock block={block} selected={selectedBlockId === block.id} onAction={onAction} /> : <button className="empty-slot" aria-label={`Empty slot row ${row + 1}, column ${column + 1}`}>＋</button>}</div>;
          })}
        </div>)}
      </div>
      <div className="row-rail row-rail-right" aria-hidden="true"><span className="io-pill">Out<br />1/2</span><span className="add-row">＋</span><span className="add-row">＋</span><span className="add-row">＋</span></div>
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
    <div className="rear-connectors" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <span key={index} />)}</div>
    <div className="chassis-edge" aria-hidden="true" />
    <MasterVolume onAction={onAction} />
    <div className="device-plate"><span className="pulse-mark">⌁</span> QUAD CORTEX <small>CONTROL SURFACE</small></div>
    <div className="qc-screen-bezel"><CorOsGrid snapshot={snapshot} selectedBlockId={selectedBlockId} onAction={onAction} /></div>
    <div className="screen-nav-control"><span className="nav-arrow">⌃</span><HardwareSwitch role={bankUp.role} label="BANK UP" compact accent="#83ddfa" onAction={onAction} /><span className="nav-arrow">⌄</span></div>
    <div className="footswitch-deck">
      <div className="footswitch-row">{scenes.slice(0, 4).map((control, index) => <HardwareSwitch key={control.id} role={control.role} label={control.label} active={snapshot.activeScene === index} accent={accents[index]} onAction={onAction} />)}<HardwareSwitch role={bankDown.role} label="BANK DOWN" accent="#d8dde0" onAction={onAction} /></div>
      <div className="mode-bracket" aria-hidden="true"><span>＋</span><strong>MODE</strong><span>−</span></div>
      <div className="footswitch-row">{scenes.slice(4).map((control, index) => <HardwareSwitch key={control.id} role={control.role} label={control.label} active={snapshot.activeScene === index + 4} accent={accents[index + 4]} onAction={onAction} />)}<HardwareSwitch role={tempo.role} label="TEMPO" accent="#e6e6e6" onAction={onAction} /></div>
      <span className="tuner-hint">TEMPO<br />HOLD: TUNER</span>
    </div>
  </section>;
}
