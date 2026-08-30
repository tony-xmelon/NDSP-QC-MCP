import type { KeyboardEvent, PointerEvent, WheelEvent } from "react";
import type { PresetSnapshot } from "@ndsp-qc/client";
import type { FormFactorManifest } from "@ndsp-qc/form-factors";

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
  input: "cyan",
  utility: "slate",
  capture: "orange",
  amp: "red",
  cab: "amber",
  mod: "violet",
  delay: "blue",
  reverb: "purple",
  output: "green"
};

function HardwareSwitch({
  role,
  label,
  active,
  accent,
  onAction
}: {
  role: string;
  label: string;
  active?: boolean;
  accent?: string;
  onAction: (action: HardwareAction) => void;
}) {
  const release = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onAction({ kind: "switch", role, phase: "release" });
  };

  const keyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      event.preventDefault();
      onAction({ kind: "rotate", role, delta: 1 });
    }
    if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      event.preventDefault();
      onAction({ kind: "rotate", role, delta: -1 });
    }
  };

  const wheel = (event: WheelEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onAction({ kind: "rotate", role, delta: event.deltaY < 0 ? 1 : -1 });
  };

  return (
    <button
      className={`hardware-switch${active ? " is-active" : ""}`}
      style={{ "--switch-accent": accent ?? "var(--accent)" } as React.CSSProperties}
      aria-label={`${label} encoder footswitch`}
      aria-pressed={active}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onAction({ kind: "switch", role, phase: "press" });
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onKeyDown={keyboard}
      onWheel={wheel}
    >
      <span className="switch-label">{label}</span>
      <span className="switch-ring" aria-hidden="true"><span className="switch-cap" /></span>
      <span className="switch-hint">PRESS · TURN</span>
    </button>
  );
}

export function QuadCortexSurface({
  formFactor,
  snapshot,
  selectedBlockId,
  skinClassName,
  onAction
}: QuadCortexSurfaceProps) {
  const scenes = formFactor.controls.filter((control) => control.group === "scene");
  const navigation = formFactor.controls.filter((control) => control.group !== "scene");

  return (
    <section className={`qc-chassis ${skinClassName}`} aria-label={formFactor.displayName}>
      <div className="chassis-mark"><span>NEURAL CONTROL</span><small>UNOFFICIAL DESKTOP INTERFACE</small></div>

      <div className="switch-row switch-row-top">
        {scenes.slice(0, 4).map((control, index) => (
          <HardwareSwitch
            key={control.id}
            role={control.role}
            label={control.label}
            active={snapshot.activeScene === index}
            accent={["#63d3ff", "#42df9a", "#ffbd4a", "#ff6f63"][index]}
            onAction={onAction}
          />
        ))}
      </div>

      <div className="qc-screen-bezel">
        <div className="qc-screen">
          <header className="screen-header">
            <div className="preset-location">{snapshot.presetLocation}</div>
            <div className="preset-title"><strong>{snapshot.presetName}</strong><span>{snapshot.deviceName} · {snapshot.mode}</span></div>
            <div className="screen-tempo"><span>♩</span>{snapshot.tempo}</div>
          </header>

          <div className="scene-strip" role="tablist" aria-label="Scenes">
            {snapshot.scenes.map((scene, index) => (
              <button
                key={scene}
                role="tab"
                aria-selected={snapshot.activeScene === index}
                className={snapshot.activeScene === index ? "is-active" : ""}
                onClick={() => onAction({ kind: "switch", role: `footswitch:${String.fromCharCode(65 + index)}`, phase: "release" })}
              >
                <span>{String.fromCharCode(65 + index)}</span>{scene}
              </button>
            ))}
          </div>

          <div className="signal-grid" aria-label="Preset signal grid">
            {Array.from({ length: 32 }, (_, index) => {
              const row = Math.floor(index / 8);
              const column = index % 8;
              const block = snapshot.blocks.find((candidate) => candidate.row === row && candidate.column === column);
              return (
                <div className="grid-cell" key={`${row}-${column}`}>
                  {column < 7 && <span className="signal-line" aria-hidden="true" />}
                  {block ? (
                    <button
                      className={`effect-block block-${blockColors[block.kind]}${block.bypassed ? " is-bypassed" : ""}${selectedBlockId === block.id ? " is-selected" : ""}`}
                      onClick={() => onAction({ kind: "select-block", blockId: block.id })}
                      aria-pressed={selectedBlockId === block.id}
                    >
                      <span className="block-icon">{block.kind === "amp" ? "AMP" : block.kind.slice(0, 3).toUpperCase()}</span>
                      <span>{block.name}</span>
                    </button>
                  ) : <span className="empty-node" aria-hidden="true" />}
                </div>
              );
            })}
          </div>

          <footer className="screen-footer">
            <span>GRID</span><span>SCENES</span><span className="screen-footer-center">Demo state · device writes locked</span><span>•••</span>
          </footer>
        </div>
      </div>

      <aside className="navigation-switches">
        {navigation.map((control) => (
          <HardwareSwitch key={control.id} role={control.role} label={control.label} accent={control.group === "tempo" ? "#ff755f" : "#f2f4f8"} onAction={onAction} />
        ))}
      </aside>

      <div className="switch-row switch-row-bottom">
        {scenes.slice(4).map((control, index) => (
          <HardwareSwitch
            key={control.id}
            role={control.role}
            label={control.label}
            active={snapshot.activeScene === index + 4}
            accent={["#a88aff", "#ef70db", "#f68f49", "#f3f3f3"][index]}
            onAction={onAction}
          />
        ))}
      </div>
    </section>
  );
}
