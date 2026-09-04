import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from "react";
import type { BlockDetails, BlockParameter } from "@ndsp-qc/client";
import { sceneLetter } from "@ndsp-qc/core";
import { QC_COLORS } from "@ndsp-qc/theme";
import { parameterControlKind, parameterDisplay, parameterEditorAccent, parameterEditorFamily, parameterEditorIsFullScreen, parameterEditorPageCount, parameterEditorPageSize, parameterEditorPageSlots, parameterEditorTabs, parameterNormalizedValue, parameterRealValue, parameterStep, type ParameterEditorFamily } from "./parameter-model";
import { parameterContextMenuItems, type ParameterEditorContextAction } from "./parameter-menu";
import { QcEditorIcon } from "./theme-icons";

export type { ParameterEditorContextAction } from "./parameter-menu";

export interface CorOsParameterEditorProps {
  details: BlockDetails;
  drafts: Record<number, number>;
  accent: string;
  activeScene: number;
  scenes: string[];
  bypassed: boolean;
  footswitch?: number;
  routingNode?: "splitter" | "mixer";
  disabled?: boolean;
  page: number;
  onPageChange: (page: number) => void;
  onDraftChange: (parameter: BlockParameter, value: number) => void;
  onCommit: (parameter: BlockParameter, value: number) => void;
  onCommitBatch?: (changes: Array<{ parameter: BlockParameter; value: number }>) => void;
  onToggleBypass: () => void;
  onSceneSelect: (scene: number) => void;
  footswitchAssignmentPending?: boolean;
  onFootswitchAssignmentStart: (pending: boolean) => void;
  onContextAction: (action: ParameterEditorContextAction) => void;
  clipboardModelId?: number;
  contextActionEnabled?: Partial<Record<ParameterEditorContextAction, boolean>>;
  onClose: () => void;
}

function clamp(value: number) { return Math.max(0, Math.min(1, value)); }
function editorCategoryLabel(category: string) { return category.toUpperCase(); }

function ParameterControl({ parameter, value, slot, accent, disabled, onDraftChange, onCommit }: {
  parameter: BlockParameter;
  value: number;
  slot: number;
  accent: string;
  disabled?: boolean;
  onDraftChange: (parameter: BlockParameter, value: number) => void;
  onCommit: (parameter: BlockParameter, value: number) => void;
}) {
  const valueRef = useRef(value);
  const drag = useRef<{ pointerId: number; y: number } | undefined>(undefined);
  const wheelTimer = useRef<number | undefined>(undefined);
  const [localValue, setLocalValue] = useState(value);
  useEffect(() => { valueRef.current = value; setLocalValue(value); }, [value]);
  const update = (next: number) => {
    const stepped = parameterStep(parameter);
    const normalized = clamp(Math.round(clamp(next) / stepped) * stepped);
    valueRef.current = normalized;
    setLocalValue(normalized);
    onDraftChange(parameter, normalized);
  };
  const nudge = (direction: number) => update(valueRef.current + direction * parameterStep(parameter));
  const finish = () => onCommit(parameter, valueRef.current);
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const steps = Math.trunc((drag.current.y - event.clientY) / 7);
    if (!steps) return;
    drag.current.y -= steps * 7;
    nudge(steps);
  };
  const pointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    finish();
  };
  const wheel = (event: WheelEvent<HTMLButtonElement>) => {
    event.preventDefault();
    nudge(event.deltaY < 0 ? 1 : -1);
    if (wheelTimer.current !== undefined) window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(finish, 55);
  };
  const optionIndex = parameter.options.length > 1 ? Math.round(localValue * (parameter.options.length - 1)) : 0;
  const controlKind = parameter.type.trim().toLowerCase();
  const renderedKind = parameterControlKind(parameter);
  const meter = renderedKind === "meter";
  const fader = renderedKind === "fader";
  const ledBacked = controlKind === "floatwithled";
  const rotarySwitch = controlKind === "rotaryswitch";
  const switchControl = renderedKind === "switch";
  const toggleButton = renderedKind === "button";
  const switchOptions = parameter.options.length > 1 ? parameter.options : ["Off", "On"];
  const switchIndex = Math.round(localValue * (switchOptions.length - 1));
  const switchThumbTop = 5 + (switchOptions.length <= 1 ? 0 : (switchOptions.length - 1 - switchIndex) * 47 / (switchOptions.length - 1));
  const controlDisabled = Boolean(disabled || !parameter.writable || parameter.enabled === false);
  const rotaryStepCount = rotarySwitch ? Math.max(2, parameter.options.length || parameter.steps || 2) : 0;
  const encoderLabel = ["A", "B", "C", "D", "▼", "E", "F", "G", "H", "T"][slot];
  return <div className={`coros-parameter${meter ? " is-meter" : fader ? " is-fader" : switchControl ? ` is-switch is-${switchOptions.length}-way` : toggleButton ? " is-button" : renderedKind === "select" ? " is-dropdown" : " is-knob"}${rotarySwitch ? " is-rotary-switch" : ""}${ledBacked ? " has-led" : ""}${parameter.sceneMode ? " is-scene" : ""}${controlDisabled ? " is-disabled" : ""}`}>
    <span className="parameter-name">{parameter.name}</span>
    {parameter.expression != null && parameter.expression > 0 && <span className="parameter-expression" title={`Assigned to Expression Pedal ${parameter.expression}${parameter.expressionMinimum != null && parameter.expressionMaximum != null ? ` (${Math.round(parameter.expressionMinimum * 100)}–${Math.round(parameter.expressionMaximum * 100)}%)` : ""}`}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18h12l-1.6-8.4H8.1L6 18Zm2.2-8.4 1-3.6h5.7l1.5 3.6M9 21h6" /></svg><b>EXP {parameter.expression}</b></span>}
    {meter ? <div className="parameter-gr-meter" role="meter" aria-label={parameter.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(localValue * 100)} style={{ "--meter-level": `${localValue * 100}%` } as CSSProperties}><span /></div> : fader ? <button className="parameter-fader" disabled={controlDisabled} aria-label={`${parameter.name}: ${parameterDisplay(parameter, localValue)}`} style={{ "--parameter-position": `${localValue * 100}%`, "--parameter-accent": accent } as CSSProperties} onPointerDown={(event) => {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { pointerId: event.pointerId, y: event.clientY };
    }} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onWheel={wheel} onKeyDown={(event) => {
      if (!["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)) return;
      event.preventDefault(); nudge(event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1);
    }} onKeyUp={(event) => { if (["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)) finish(); }}><span /></button> : renderedKind === "select" ? <select aria-label={parameter.name} value={optionIndex} disabled={controlDisabled} onChange={(event) => {
      const next = Number(event.target.value) / (parameter.options.length - 1);
      update(next); onCommit(parameter, next);
    }}>{parameter.options.map((option, index) => <option key={`${option}-${index}`} value={index}>{option}</option>)}</select> : switchControl ? <><button className="parameter-switch" disabled={controlDisabled} aria-label={`${parameter.name}: ${parameterDisplay(parameter, localValue)}`} onClick={() => { const nextIndex = (switchIndex + 1) % switchOptions.length; const next = nextIndex / (switchOptions.length - 1); update(next); onCommit(parameter, next); }}><span style={{ top: `${switchThumbTop}%` }} /></button><span className="parameter-switch-labels">{[...switchOptions].reverse().map((option, reverseIndex) => { const index = switchOptions.length - 1 - reverseIndex; const next = index / (switchOptions.length - 1); return <button key={`${option}-${index}`} className={index === switchIndex ? "is-active" : ""} disabled={controlDisabled} onClick={() => { update(next); onCommit(parameter, next); }}>{option}</button>; })}</span></> : toggleButton ? <button className={`parameter-toggle-button${localValue >= .5 ? " is-on" : ""}`} disabled={controlDisabled} aria-pressed={localValue >= .5} onClick={() => { const next = localValue >= .5 ? 0 : 1; update(next); onCommit(parameter, next); }}>{parameter.options[Math.round(localValue * Math.max(0, parameter.options.length - 1))] ?? parameter.name}</button> : <button className="parameter-knob" disabled={controlDisabled} aria-label={`${parameter.name}: ${parameterDisplay(parameter, localValue)}`} style={{ "--parameter-angle": `${-135 + localValue * 270}deg`, "--parameter-position": `${localValue * 100}%`, "--parameter-accent": accent } as CSSProperties} onPointerDown={(event) => {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { pointerId: event.pointerId, y: event.clientY };
    }} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onWheel={wheel} onKeyDown={(event) => {
      if (!["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)) return;
      event.preventDefault(); nudge(event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1);
    }} onKeyUp={(event) => { if (["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)) finish(); }}>{rotarySwitch && <span className="parameter-step-dots" aria-hidden="true">{Array.from({ length: rotaryStepCount }, (_, index) => <i key={index} className={`parameter-step-dot${index === optionIndex ? " is-filled is-current" : ""}`} style={{ "--parameter-dot-angle": `${-135 + index * 270 / (rotaryStepCount - 1)}deg` } as CSSProperties} />)}</span>}<span className="parameter-knob-cap"><i /></span></button>}
    {ledBacked && <i className={`parameter-signal-led${(parameter.ledValue ?? 0) > .02 ? " is-active" : ""}`} aria-hidden="true" />}
    <strong className="parameter-value">{parameterDisplay(parameter, localValue)}</strong>
    <small className="parameter-encoder">{encoderLabel}</small>
  </div>;
}

type EqBand = {
  number: number;
  gain?: BlockParameter;
  frequency?: BlockParameter;
  q?: BlockParameter;
  type?: BlockParameter;
  bypass?: BlockParameter;
};

function eqBands(parameters: BlockParameter[]): EqBand[] {
  const bands = new Map<number, EqBand>();
  for (const parameter of parameters) {
    const match = parameter.name.match(/^N?(\d+)\s*(GAIN|FREQ(?:UENCY)?|Q|TYPE|BYPASS)$/i);
    if (!match) continue;
    const number = Number(match[1]);
    const band = bands.get(number) ?? { number };
    const field = match[2].toUpperCase();
    if (field === "GAIN") band.gain = parameter;
    else if (field.startsWith("FREQ")) band.frequency = parameter;
    else if (field === "Q") band.q = parameter;
    else if (field === "TYPE") band.type = parameter;
    else band.bypass = parameter;
    bands.set(number, band);
  }
  return [...bands.values()].sort((left, right) => left.number - right.number);
}

function parameterWithName(parameter: BlockParameter, name: string, options?: string[]): BlockParameter {
  return { ...parameter, name, options: options ?? parameter.options, type: options ? "enum" : parameter.type, steps: options?.length ?? parameter.steps };
}

function EqResponseGraph({ bands, selectedBand, drafts, accent, disabled, onSelectBand, onDraftChange, onCommit }: {
  bands: EqBand[];
  selectedBand: number;
  drafts: Record<number, number>;
  accent: string;
  disabled?: boolean;
  onSelectBand: (band: number) => void;
} & ControlCallbacks) {
  const drag = useRef<{ pointerId: number; x: number; y: number; frequency?: BlockParameter; gain?: BlockParameter; frequencyValue: number; frequencyGraphValue: number; gainValue: number } | undefined>(undefined);
  const value = (parameter: BlockParameter | undefined, fallback: number) => parameter ? drafts[parameter.index] ?? parameter.normalizedValue ?? fallback : fallback;
  const graphFrequency = (parameter: BlockParameter | undefined, normalized: number, fallback: number) => {
    if (!parameter) return fallback;
    const frequency = Math.max(20, Math.min(20000, parameterRealValue(parameter, normalized)));
    return Math.log10(frequency / 20) / Math.log10(20000 / 20);
  };
  const points = bands.map((band, index) => ({
    band,
    x: 5 + graphFrequency(band.frequency, value(band.frequency, .5), bands.length === 1 ? .5 : index / (bands.length - 1)) * 90,
    y: 50 - (value(band.gain, .5) - .5) * 76,
    bypassed: value(band.bypass, 0) >= .5
  }));
  const activePoints = points.filter((point) => !point.bypassed).sort((left, right) => left.x - right.x);
  const polyline = [[0, 50], ...activePoints.map((point) => [point.x, point.y]), [100, 50]].map(([x, y]) => `${x},${y}`).join(" ");
  const updateDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const panel = event.currentTarget.closest(".eq-response-panel")?.getBoundingClientRect();
    if (!panel) return;
    const nextFrequencyGraph = clamp(drag.current.frequencyGraphValue + (event.clientX - drag.current.x) / panel.width);
    const nextFrequency = drag.current.frequency
      ? parameterNormalizedValue(drag.current.frequency, 20 * Math.pow(1000, nextFrequencyGraph))
      : clamp(drag.current.frequencyValue + (event.clientX - drag.current.x) / panel.width);
    const nextGain = clamp(drag.current.gainValue - (event.clientY - drag.current.y) / (panel.height * .76));
    if (drag.current.frequency) onDraftChange(drag.current.frequency, nextFrequency);
    if (drag.current.gain) onDraftChange(drag.current.gain, nextGain);
  };
  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const current = drag.current;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.frequency) onCommit(current.frequency, drafts[current.frequency.index] ?? current.frequency.normalizedValue ?? current.frequencyValue);
    if (current.gain) onCommit(current.gain, drafts[current.gain.index] ?? current.gain.normalizedValue ?? current.gainValue);
  };
  return <div className="eq-response-panel" style={{ "--eq-accent": accent } as CSSProperties}>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="EQ frequency response">
      <g className="eq-grid"><path d="M5 8V88M28 8V88M52 8V88M76 8V88M95 8V88"/><path d="M5 12H95M5 31H95M5 50H95M5 69H95M5 88H95"/></g>
      <polyline className="eq-live-curve" points={polyline} />
      <g className="eq-axis-labels"><text x="5" y="97">20</text><text x="28" y="97">100</text><text x="52" y="97">1k</text><text x="76" y="97">10k</text><text x="95" y="97" textAnchor="end">20k</text><text x="1" y="15">+12</text><text x="1" y="53">0</text><text x="1" y="90">-12</text></g>
    </svg>
    {points.map((point) => <button key={point.band.number} className={`eq-band-node${selectedBand === point.band.number ? " is-selected" : ""}${point.bypassed ? " is-bypassed" : ""}`} style={{ left: `${point.x}%`, top: `${point.y}%` }} disabled={disabled} aria-label={`Select EQ band ${point.band.number}`} aria-pressed={selectedBand === point.band.number} onClick={() => onSelectBand(point.band.number)} onPointerDown={(event) => {
      onSelectBand(point.band.number);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, frequency: point.band.frequency, gain: point.band.gain, frequencyValue: value(point.band.frequency, point.x / 100), frequencyGraphValue: (point.x - 5) / 90, gainValue: value(point.band.gain, .5) };
    }} onPointerMove={updateDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag}>{point.band.number}</button>)}
  </div>;
}

function EqBandBypassControl({ band, drafts, accent, disabled, onDraftChange, onCommit }: { band: EqBand; drafts: Record<number, number>; accent: string; disabled?: boolean } & ControlCallbacks) {
  const parameter = band.bypass;
  const bypassed = parameter ? (drafts[parameter.index] ?? parameter.normalizedValue ?? 0) >= .5 : false;
  return <div className="coros-parameter eq-bypass-control">
    <span className="parameter-name">BYPASS {band.number}</span>
    <button className={bypassed ? "" : "is-on"} disabled={disabled || !parameter?.writable} aria-label={`${bypassed ? "Enable" : "Bypass"} EQ band ${band.number}`} onClick={() => { if (!parameter) return; const next = bypassed ? 0 : 1; onDraftChange(parameter, next); onCommit(parameter, next); }}><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3v12M8.5 7.7a11 11 0 1 0 15 0" /></svg></button>
  </div>;
}

function ParametricEqEditorBody({ parameters, drafts, accent, disabled, selectedBand, outputSelected, onSelectBand, onSelectOutput, onDraftChange, onCommit }: {
  parameters: BlockParameter[];
  drafts: Record<number, number>;
  accent: string;
  disabled?: boolean;
  selectedBand: number;
  onSelectBand: (band: number) => void;
  outputSelected: boolean;
  onSelectOutput: () => void;
} & ControlCallbacks) {
  const bands = eqBands(parameters);
  const selected = bands.find((band) => band.number === selectedBand) ?? bands[0];
  const output = parameters.find((parameter) => /^OUTPUT$/i.test(parameter.name));
  const controls = [
    selected?.type && parameterWithName(selected.type, "TYPE", ["Peak", "Hi Pass", "Lo Pass", "Hi Shelf", "Lo Shelf"]),
    selected?.gain && parameterWithName(selected.gain, "GAIN"),
    selected?.frequency && parameterWithName(selected.frequency, "FREQ"),
    selected?.q && parameterWithName(selected.q, "Q")
  ].filter((parameter): parameter is BlockParameter => Boolean(parameter));
  return <div className="eq-editor-body is-parametric">
    <EqResponseGraph bands={bands} selectedBand={outputSelected ? -1 : selected?.number ?? 1} drafts={drafts} accent={accent} disabled={disabled} onSelectBand={onSelectBand} onDraftChange={onDraftChange} onCommit={onCommit} />
    <nav className="eq-band-tabs" aria-label="EQ bands">{bands.map((band) => {
      const bypassed = band.bypass ? (drafts[band.bypass.index] ?? band.bypass.normalizedValue ?? 0) >= .5 : false;
      const active = !outputSelected && selected?.number === band.number;
      return <button key={band.number} className={`${active ? "is-active" : ""}${bypassed ? " is-bypassed" : ""}`} aria-label={`Band ${band.number}${bypassed ? ", bypassed" : ""}`} aria-current={active ? "page" : undefined} onClick={() => onSelectBand(band.number)}>{band.number}</button>;
    })}<button className={outputSelected ? "is-active" : ""} aria-current={outputSelected ? "page" : undefined} onClick={onSelectOutput}>OUT</button></nav>
    {outputSelected ? <div className="eq-selected-controls is-output">{output && <ParameterControl parameter={output} value={drafts[output.index] ?? output.normalizedValue ?? 0} slot={0} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} />}</div> : <div className="eq-selected-controls">{controls.map((parameter, slot) => <ParameterControl key={parameter.index} parameter={parameter} value={drafts[parameter.index] ?? parameter.normalizedValue ?? 0} slot={slot} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} />)}{selected && <EqBandBypassControl band={selected} drafts={drafts} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} />}</div>}
  </div>;
}

function GraphicEqEditorBody({ parameters, drafts, accent, disabled, onDraftChange, onCommit }: {
  parameters: BlockParameter[];
  drafts: Record<number, number>;
  accent: string;
  disabled?: boolean;
} & ControlCallbacks) {
  const bands = parameters.filter((parameter) => /^(?:N)?(?:65|125|250|500|1K|2K|4K|8K|16K)\s*HZ$/i.test(parameter.name.replace(/\s/g, "")) || (parameter.type.toLowerCase() === "fader" && !/HPF|LPF|OUTPUT|\bQ\b/i.test(parameter.name))).slice(0, 9);
  const auxiliary = parameters.filter((parameter) => !bands.includes(parameter));
  return <div className="eq-editor-body is-graphic">
    <div className="graphic-eq-faders">{bands.map((parameter, slot) => <ParameterControl key={parameter.index} parameter={parameterWithName(parameter, parameter.name.replace(/^N/i, ""))} value={drafts[parameter.index] ?? parameter.normalizedValue ?? 0} slot={slot} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} />)}</div>
    <div className="graphic-eq-aux">{auxiliary.slice(0, 4).map((parameter, slot) => <ParameterControl key={parameter.index} parameter={parameter} value={drafts[parameter.index] ?? parameter.normalizedValue ?? 0} slot={slot} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} />)}</div>
  </div>;
}

function EqEditorBody(props: { parameters: BlockParameter[]; drafts: Record<number, number>; accent: string; disabled?: boolean; selectedBand: number; outputSelected: boolean; onSelectBand: (band: number) => void; onSelectOutput: () => void } & ControlCallbacks) {
  const graphicBandCount = props.parameters.filter((parameter) => /^(?:N)?(?:65|125|250|500|1K|2K|4K|8K|16K)\s*HZ$/i.test(parameter.name.replace(/\s/g, ""))).length;
  return eqBands(props.parameters).length
    ? <ParametricEqEditorBody {...props} />
    : graphicBandCount >= 5 || props.parameters.filter((parameter) => parameter.type.toLowerCase() === "fader").length >= 5
      ? <GraphicEqEditorBody {...props} />
      : <div className="parameter-controls eq-simple-controls">{props.parameters.slice(0, 10).map((parameter, slot) => <ParameterControl key={parameter.index} parameter={parameter} value={props.drafts[parameter.index] ?? parameter.normalizedValue ?? 0} slot={slot} accent={props.accent} disabled={props.disabled} onDraftChange={props.onDraftChange} onCommit={props.onCommit} />)}</div>;
}

function IrLoaderChannel({ base, allParameters, drafts, accent, disabled, onDraftChange, onCommit }: {
  base: 0 | 8;
  allParameters: BlockParameter[];
  drafts: Record<number, number>;
  accent: string;
  disabled?: boolean;
} & ControlCallbacks) {
  const byIndex = (index: number) => allParameters.find((parameter) => parameter.index === index);
  const mute = byIndex(base);
  const phase = byIndex(base + 1);
  const impulse = byIndex(base + 2);
  const controls = [3, 4, 5, 6, 7].map((offset) => byIndex(base + offset)).filter((parameter): parameter is BlockParameter => Boolean(parameter?.normalizedValue != null));
  const muteValue = mute ? drafts[mute.index] ?? mute.normalizedValue ?? 0 : 0;
  const phaseValue = phase ? drafts[phase.index] ?? phase.normalizedValue ?? 0 : 0;
  const impulseValue = impulse?.normalizedValue ?? 0;
  const impulseIndex = impulse?.options.length ? Math.round(impulseValue * (impulse.options.length - 1)) : 0;
  const impulseName = impulse?.options[impulseIndex] ?? impulse?.displayValue ?? "No IR loaded";
  const commitBinary = (parameter: BlockParameter | undefined, value: number) => {
    if (!parameter || disabled || !parameter.writable) return;
    onDraftChange(parameter, value);
    onCommit(parameter, value);
  };
  const selectImpulse = (offset: number) => {
    if (!impulse || disabled || !impulse.writable || impulse.options.length < 2) return;
    const nextIndex = (impulseIndex + offset + impulse.options.length) % impulse.options.length;
    const next = nextIndex / (impulse.options.length - 1);
    onDraftChange(impulse, next);
    onCommit(impulse, next);
  };
  return <section className={`ir-loader-channel${muteValue >= .5 ? " is-bypassed" : ""}`} style={{ "--ir-accent": accent } as CSSProperties}>
    <div className="ir-loader-selector">
      <div className="ir-loader-state">
        <button className={muteValue < .5 ? "is-active" : ""} disabled={disabled || !mute?.writable} aria-label={`${muteValue >= .5 ? "Enable" : "Disable"} impulse`} aria-pressed={muteValue < .5} onClick={() => commitBinary(mute, muteValue >= .5 ? 0 : 1)}>⏻</button>
        <button className={phaseValue >= .5 ? "is-active" : ""} disabled={disabled || !phase?.writable} aria-label="Invert impulse phase" aria-pressed={phaseValue >= .5} onClick={() => commitBinary(phase, phaseValue >= .5 ? 0 : 1)}>Ø</button>
      </div>
      <div className="ir-loader-name"><small>{base === 0 ? "ROTATE TOP RIGHT SWITCH" : "IMPULSE RESPONSE"}</small><strong title={impulseName}>{impulseName}</strong></div>
      <div className="ir-loader-arrows">
        <button disabled={disabled || !impulse?.writable || impulse.options.length < 2} aria-label="Previous impulse response" onClick={() => selectImpulse(-1)}>↑</button>
        <button disabled={disabled || !impulse?.writable || impulse.options.length < 2} aria-label="Next impulse response" onClick={() => selectImpulse(1)}>↓</button>
      </div>
    </div>
    <div className="ir-loader-controls">{controls.map((parameter, slot) => <ParameterControl key={parameter.index} parameter={parameter} value={drafts[parameter.index] ?? parameter.normalizedValue ?? 0} slot={slot} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} />)}</div>
  </section>;
}

function IrLoaderEditorBody({ name, parameters, page, drafts, accent, disabled, onDraftChange, onCommit }: {
  name: string;
  parameters: BlockParameter[];
  page: number;
  drafts: Record<number, number>;
  accent: string;
  disabled?: boolean;
} & ControlCallbacks) {
  if (page === 0) return <div className="ir-loader-body"><IrLoaderChannel base={0} allParameters={parameters} drafts={drafts} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} />{/dual/i.test(name) && <IrLoaderChannel base={8} allParameters={parameters} drafts={drafts} accent={QC_COLORS.category.pitch} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} />}</div>;
  const roomControls = parameters.filter((parameter) => parameter.index >= 16 && parameter.index <= 21 && parameter.normalizedValue != null);
  return <div className="parameter-controls ir-loader-room-controls">{roomControls.map((parameter, slot) => <ParameterControl key={parameter.index} parameter={parameter} value={drafts[parameter.index] ?? parameter.normalizedValue ?? 0} slot={slot} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} />)}</div>;
}

function FamilyWidget({ family, name, availableSlots }: { family: ParameterEditorFamily; name: string; availableSlots: number }) {
  if (family === "eq" && availableSlots >= 3) {
    return <div className="parameter-family-widget eq-response" style={{ "--widget-span": availableSlots } as CSSProperties} aria-label="EQ response graph">
      <span>RESPONSE</span><svg viewBox="0 0 300 80" preserveAspectRatio="none" aria-hidden="true"><path className="eq-zero" d="M0 40H300"/><path className="eq-curve" d="M0 43 C35 43 45 25 75 25 S110 55 145 48 S185 18 215 28 S255 43 300 39"/><circle cx="74" cy="25" r="4"/><circle cx="145" cy="48" r="4"/><circle cx="216" cy="28" r="4"/></svg>
    </div>;
  }
  if (family === "synth" && availableSlots >= 3) {
    return <div className="parameter-family-widget synth-sections" style={{ "--widget-span": availableSlots } as CSSProperties} aria-label="Synth signal sections">
      <span>ARPEGGIATOR</span><b>›</b><span>OSCILLATOR</span><b>›</b><span>FILTER</span><svg viewBox="0 0 80 32" aria-hidden="true"><path d="M2 16h11l7-12 14 24L48 4l7 12h23"/></svg>
    </div>;
  }
  return null;
}

type ControlCallbacks = Pick<CorOsParameterEditorProps, "onDraftChange" | "onCommit">;

function cabMicrophoneLabel(value: string) {
  return value.includes("_") ? value.slice(value.lastIndexOf("_") + 1) : value;
}

function CabChannel({ side, allParameters, drafts, accent, disabled, onDraftChange, onCommit, onCommitBatch }: {
  side: 0 | 1;
  allParameters: BlockParameter[];
  drafts: Record<number, number>;
  accent: string;
  disabled?: boolean;
} & ControlCallbacks & Pick<CorOsParameterEditorProps, "onCommitBatch">) {
  const base = side * 8;
  const byIndex = (index: number) => allParameters.find((parameter) => parameter.index === index);
  const bypass = byIndex(base);
  const microphone = byIndex(base + 1);
  const level = byIndex(base + 2);
  const pan = byIndex(base + 3);
  const distance = byIndex(base + 4);
  const position = byIndex(base + 5);
  const phase = byIndex(base + 6);
  const controls = [position, distance, level, pan].filter((parameter): parameter is BlockParameter => Boolean(parameter));
  const positionValue = position ? drafts[position.index] ?? position.normalizedValue ?? .5 : .5;
  const distanceValue = distance ? drafts[distance.index] ?? distance.normalizedValue ?? .5 : .5;
  const phaseValue = phase ? drafts[phase.index] ?? phase.normalizedValue ?? 0 : 0;
  const bypassValue = bypass ? drafts[bypass.index] ?? bypass.normalizedValue ?? 0 : 0;
  const microphoneValue = microphone ? drafts[microphone.index] ?? microphone.normalizedValue ?? 0 : 0;
  const microphoneIndex = microphone?.options.length ? Math.round(microphoneValue * (microphone.options.length - 1)) : 0;
  const microphoneName = microphone?.options[microphoneIndex] ?? microphone?.displayValue ?? "Microphone";
  const speakerDrag = useRef<{ pointerId: number; position: number; distance: number } | undefined>(undefined);
  const setBinary = (parameter: BlockParameter | undefined, value: number) => {
    if (!parameter || disabled || !parameter.writable) return;
    onDraftChange(parameter, value);
    onCommit(parameter, value);
  };
  const selectMicrophone = (offset: number) => {
    if (!microphone || disabled || !microphone.writable || microphone.options.length < 2) return;
    const nextIndex = (microphoneIndex + offset + microphone.options.length) % microphone.options.length;
    const next = nextIndex / (microphone.options.length - 1);
    onDraftChange(microphone, next);
    onCommit(microphone, next);
  };
  const updateSpeaker = (event: PointerEvent<HTMLButtonElement>) => {
    if (!speakerDrag.current || speakerDrag.current.pointerId !== event.pointerId || !position || !distance) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const nextPosition = clamp((event.clientX - bounds.left) / bounds.width);
    const nextDistance = clamp((event.clientY - bounds.top) / bounds.height);
    speakerDrag.current.position = nextPosition;
    speakerDrag.current.distance = nextDistance;
    onDraftChange(position, nextPosition);
    onDraftChange(distance, nextDistance);
  };
  const finishSpeaker = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = speakerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId || !position || !distance) return;
    speakerDrag.current = undefined;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (onCommitBatch) onCommitBatch([{ parameter: position, value: drag.position }, { parameter: distance, value: drag.distance }]);
    else onCommit(position, drag.position);
  };
  return <section className={`cab-channel${bypassValue >= .5 ? " is-bypassed" : ""}`} style={{ "--cab-accent": side ? QC_COLORS.category.pitch : accent, "--mic-x": `${10 + positionValue * 80}%`, "--mic-y": `${24 + distanceValue * 66}%` } as CSSProperties}>
    <div className="cab-channel-controls">
      {controls.map((parameter) => <ParameterControl key={parameter.index} parameter={parameter} value={drafts[parameter.index] ?? parameter.normalizedValue ?? 0} slot={allParameters.indexOf(parameter)} accent={side ? QC_COLORS.category.pitch : accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} />)}
    </div>
    <button className="cab-speaker" disabled={disabled || !position?.writable || !distance?.writable} aria-label={`Microphone ${side + 1} position ${position?.displayValue ?? ""}, distance ${distance?.displayValue ?? ""}`} onPointerDown={(event) => {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      speakerDrag.current = { pointerId: event.pointerId, position: positionValue, distance: distanceValue };
      updateSpeaker(event);
    }} onPointerMove={updateSpeaker} onPointerUp={finishSpeaker} onPointerCancel={finishSpeaker}><i /><i /><i /></button>
    <div className="cab-channel-footer">
      <button className={`cab-phase${phaseValue >= .5 ? " is-active" : ""}`} disabled={disabled || !phase?.writable} aria-label={`Invert microphone ${side + 1} phase`} aria-pressed={phaseValue >= .5} onClick={() => setBinary(phase, phaseValue >= .5 ? 0 : 1)}>Ø</button>
      <div className="cab-microphone-selector">
        <button disabled={disabled || !microphone?.writable || microphone.options.length < 2} aria-label={`Previous microphone for slot ${side + 1}`} onClick={() => selectMicrophone(-1)}>‹</button>
        <strong title={microphoneName}>{cabMicrophoneLabel(microphoneName)}</strong>
        <button disabled={disabled || !microphone?.writable || microphone.options.length < 2} aria-label={`Next microphone for slot ${side + 1}`} onClick={() => selectMicrophone(1)}>›</button>
      </div>
      <button className={`cab-channel-power${bypassValue < .5 ? " is-active" : ""}`} disabled={disabled || !bypass?.writable} aria-label={`${bypassValue >= .5 ? "Enable" : "Disable"} cab microphone ${side + 1}`} aria-pressed={bypassValue < .5} onClick={() => setBinary(bypass, bypassValue >= .5 ? 0 : 1)}>⏻</button>
    </div>
  </section>;
}

function CabEqBody({ parameters, drafts, accent, disabled, onDraftChange, onCommit }: {
  parameters: BlockParameter[];
  drafts: Record<number, number>;
  accent: string;
  disabled?: boolean;
} & ControlCallbacks) {
  const controls = [16, 18, 17].map((index) => parameters.find((parameter) => parameter.index === index)).filter((parameter): parameter is BlockParameter => Boolean(parameter));
  const value = (parameter: BlockParameter | undefined, fallback: number) => parameter ? drafts[parameter.index] ?? parameter.normalizedValue ?? fallback : fallback;
  const highPass = controls.find((parameter) => parameter.index === 16);
  const lowPass = controls.find((parameter) => parameter.index === 17);
  const highX = 6 + value(highPass, 0) * 42;
  const lowX = 52 + value(lowPass, 1) * 42;
  return <div className="cab-eq-body">
    <div className="cab-eq-graph" aria-label="Cab high-pass and low-pass response">
      <svg viewBox="0 0 100 50" preserveAspectRatio="none" aria-hidden="true"><path className="cab-eq-grid" d="M5 5V44M27 5V44M50 5V44M73 5V44M95 5V44M5 12H95M5 25H95M5 38H95"/><path className="cab-eq-curve" d={`M3 45 C${highX - 5} 45 ${highX - 3} 25 ${highX} 25 H${lowX} C${lowX + 3} 25 ${lowX + 5} 45 97 45`}/></svg>
      <span className="cab-eq-node is-high" style={{ left: `${highX}%` }}>H</span>
      <span className="cab-eq-node is-low" style={{ left: `${lowX}%` }}>L</span>
    </div>
    <div className="cab-eq-controls">{controls.map((parameter, slot) => <ParameterControl key={parameter.index} parameter={parameter} value={drafts[parameter.index] ?? parameter.normalizedValue ?? 0} slot={slot} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} />)}</div>
  </div>;
}

function CabEditorBody({ parameters, page, drafts, accent, disabled, onDraftChange, onCommit, onCommitBatch }: {
  parameters: BlockParameter[];
  page: number;
  drafts: Record<number, number>;
  accent: string;
  disabled?: boolean;
} & ControlCallbacks & Pick<CorOsParameterEditorProps, "onCommitBatch">) {
  if (page === 1) return <CabEqBody parameters={parameters} drafts={drafts} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} />;
  return <div className="cab-editor-body">
    <CabChannel side={0} allParameters={parameters} drafts={drafts} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} onCommitBatch={onCommitBatch} />
    <CabChannel side={1} allParameters={parameters} drafts={drafts} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} onCommitBatch={onCommitBatch} />
  </div>;
}

export function CorOsParameterEditor(props: CorOsParameterEditorProps) {
  const { details, drafts, accent: categoryAccent, activeScene, scenes, bypassed, footswitch, routingNode, disabled, page, onPageChange, onDraftChange, onCommit, onCommitBatch, onToggleBypass, onSceneSelect, footswitchAssignmentPending, onFootswitchAssignmentStart, onContextAction, clipboardModelId, contextActionEnabled, onClose } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedEqBand, setSelectedEqBand] = useState(1);
  const [eqOutputSelected, setEqOutputSelected] = useState(false);
  useEffect(() => { setSelectedEqBand(1); setEqOutputSelected(false); }, [details.modelId, details.name]);
  const accent = parameterEditorAccent(details.name, categoryAccent);
  const family = parameterEditorFamily(details.category);
  const writable = details.parameters.filter((parameter) => parameter.normalizedValue !== null || ((family === "cab" || family === "ir") && parameter.type.toLowerCase() === "string"));
  const pageSize = parameterEditorPageSize(details.category, details.parameters);
  const pageCount = family === "cab" ? 2 : family === "ir" ? (writable.some((parameter) => parameter.index >= 16 && parameter.index <= 21 && parameter.normalizedValue != null) ? 2 : 1) : parameterEditorPageCount(writable, pageSize);
  const safePage = Math.min(page, pageCount - 1);
  const screenSlots = parameterEditorPageSlots(writable, safePage, pageSize);
  const shown = family === "cab" || family === "ir" ? writable : screenSlots.filter((parameter): parameter is BlockParameter => parameter !== undefined);
  const tabs = family === "eq" ? [] : parameterEditorTabs(details.name, details.category, pageCount);
  const fullScreen = parameterEditorIsFullScreen(details.category);
  const availableSlots = Math.max(0, 10 - shown.length);
  const contextItems = parameterContextMenuItems(details, clipboardModelId);
  const runContextAction = (action: ParameterEditorContextAction) => { setMenuOpen(false); onContextAction(action); };
  return <section className={`coros-parameter-editor family-${family}${fullScreen ? " is-full-screen" : ""}${tabs.length ? " has-tabs" : ""}`} style={{ "--parameter-accent": accent } as CSSProperties} aria-label={`${details.name} parameter editor`}>
    <header className="parameter-editor-header">
      <button className="parameter-more" disabled={Boolean(routingNode)} aria-label={routingNode ? "Routing node options unavailable" : "Device contextual menu"} aria-expanded={routingNode ? false : menuOpen} onClick={() => { onFootswitchAssignmentStart(false); setMenuOpen((open) => !open); }}><i /><i /><i /></button>
      <button className="parameter-device-name"><small>{editorCategoryLabel(details.category)}</small><strong style={{ color: accent }}>{details.name}</strong></button>
      <button className={`parameter-footswitch${footswitch === undefined ? "" : " is-assigned"}${footswitchAssignmentPending ? " is-assigning" : ""}`} disabled={Boolean(routingNode)} aria-label={routingNode ? `${details.name} has no footswitch assignment` : footswitchAssignmentPending ? "Waiting for a footswitch assignment" : footswitch === undefined ? "Assign a footswitch" : `Assigned to footswitch ${sceneLetter(footswitch)}`} aria-pressed={footswitchAssignmentPending} onClick={() => { setMenuOpen(false); onFootswitchAssignmentStart(!footswitchAssignmentPending); }}><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 22h14M11 22l1.6-7h6.8l1.6 7M13.5 15l1-5h3l1 5" /></svg><span>{routingNode ? "–" : footswitchAssignmentPending ? "?" : footswitch === undefined ? "–" : sceneLetter(footswitch)}</span></button>
      <div className="parameter-scene" aria-label="Scene selector">
        <button aria-label="Previous scene" onClick={() => onSceneSelect((activeScene - 1 + Math.max(1, scenes.length)) % Math.max(1, scenes.length))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 3 12l8 8zM21 4l-8 8 8 8z" /></svg></button>
        <button aria-label={`Scene ${sceneLetter(activeScene)}${footswitch === undefined ? "" : `, footswitch ${sceneLetter(footswitch)}`}`} onClick={() => onSceneSelect((activeScene + 1) % Math.max(1, scenes.length))}><span>{sceneLetter(activeScene)}</span></button>
        <button aria-label="Next scene" onClick={() => onSceneSelect((activeScene + 1) % Math.max(1, scenes.length))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 4 8 8-8 8zM3 4l8 8-8 8z" /></svg></button>
      </div>
      <i className="parameter-header-divider" aria-hidden="true" />
      <button className={`parameter-bypass${bypassed ? " is-bypassed" : ""}`} disabled={Boolean(routingNode)} aria-label={routingNode ? `${details.name} bypass is controlled by routing` : bypassed ? "Activate device" : "Bypass device"} aria-pressed={routingNode ? undefined : bypassed} onClick={onToggleBypass}><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3v12M8.5 7.7a11 11 0 1 0 15 0" /></svg></button>
      <button className="parameter-close" aria-label="Close parameter editor" onClick={onClose}><svg viewBox="0 0 32 32" aria-hidden="true"><path d="m8 16.5 5.2 5.1L24.5 10" /></svg></button>
      {!routingNode && menuOpen && <div className="parameter-context-menu" role="menu" aria-label="Device contextual menu">
        {contextItems.map((item) => <button key={item.action} role="menuitem" className={`${item.action === "remove" ? "is-danger" : ""}${item.separatorBefore ? " has-separator" : ""}`} disabled={item.disabled || contextActionEnabled?.[item.action] === false} onClick={() => runContextAction(item.action)}><QcEditorIcon kind={item.icon}/><span>{item.label}</span></button>)}
      </div>}
    </header>
    {tabs.length > 0 && <nav className="parameter-tabs" aria-label="Parameter tabs">{tabs.map((label, index) => <button key={label} className={safePage === index ? "is-active" : ""} aria-current={safePage === index ? "page" : undefined} onClick={() => onPageChange(index)}>{label}</button>)}</nav>}
    {family === "eq" ? <EqEditorBody parameters={writable} drafts={drafts} accent={accent} disabled={disabled} selectedBand={selectedEqBand} outputSelected={eqOutputSelected} onSelectBand={(band) => { setSelectedEqBand(band); setEqOutputSelected(false); }} onSelectOutput={() => setEqOutputSelected(true)} onDraftChange={onDraftChange} onCommit={onCommit} /> : family === "cab" ? <CabEditorBody parameters={shown} page={safePage} drafts={drafts} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} onCommitBatch={onCommitBatch} /> : family === "ir" ? <IrLoaderEditorBody name={details.name} parameters={shown} page={safePage} drafts={drafts} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} /> : <div className="parameter-controls">
      {screenSlots.map((parameter, slot) => parameter
        ? <ParameterControl key={parameter.index} parameter={parameter} value={drafts[parameter.index] ?? parameter.normalizedValue ?? 0} slot={slot} accent={accent} disabled={disabled} onDraftChange={onDraftChange} onCommit={onCommit} />
        : pageSize === 10 ? <span key={`empty-${slot}`} className="parameter-empty-slot" aria-hidden="true" /> : null)}
      <FamilyWidget family={family} name={details.name} availableSlots={availableSlots} />
      {!shown.length && <p className="parameter-empty">This device exposes no adjustable catalog parameters.</p>}
    </div>}
  </section>;
}
