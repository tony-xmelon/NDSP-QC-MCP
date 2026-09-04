import type { PresetSnapshot } from "@ndsp-qc/client";

export interface SceneEditorProps {
  snapshot: PresetSnapshot;
  pending: boolean;
  sourceScene: number;
  setSourceScene(scene: number): void;
  destinationScene: number;
  setDestinationScene(scene: number): void;
  swap: boolean;
  setSwap(swap: boolean): void;
  label: string;
  setLabel(label: string): void;
  color: number;
  setColor(color: number): void;
  colors: readonly string[];
  copy(): void;
  saveLabel(): void;
  saveColor(): void;
}

export function SceneEditor(props: SceneEditorProps) {
  const { snapshot, pending, sourceScene, setSourceScene, destinationScene, setDestinationScene, swap, setSwap, label, setLabel, color, setColor, colors, copy, saveLabel, saveColor } = props;
  const options = snapshot.scenes.map((name, index) => <option value={index} key={index}>Scene {String.fromCharCode(65 + index)} · {name}</option>);
  return <>
    <div className="dialog-kicker">SCENE WORKFLOW</div><h2 id="dialog-title">Copy, label, and color scenes</h2>
    <div className="scene-editor">
      <label><span>Edit scene</span><select value={sourceScene} disabled={pending} onChange={(event) => { const scene = Number(event.target.value); setSourceScene(scene); setLabel(snapshot.scenes[scene] ?? ""); const hex = snapshot.sceneColors?.[scene] ?? colors[scene]; setColor(Math.max(0, colors.indexOf(hex))); }}>{options}</select></label>
      <label><span>Scene label</span><input maxLength={32} value={label} disabled={pending} onChange={(event) => setLabel(event.target.value)} /><button disabled={pending || label.trim() === snapshot.scenes[sourceScene]} onClick={saveLabel}>Apply label</button></label>
      <label><span>Scene color</span><select value={color} disabled={pending} onChange={(event) => setColor(Number(event.target.value))}>{colors.map((hex, index) => <option value={index} key={hex}>Color {index + 1} · {hex}</option>)}</select><button disabled={pending} onClick={saveColor}>Apply color</button></label>
      <label><span>{swap ? "Swap with" : "Copy to"}</span><select value={destinationScene} disabled={pending} onChange={(event) => setDestinationScene(Number(event.target.value))}>{options}</select><button disabled={pending || destinationScene === sourceScene} onClick={copy}>Review…</button></label>
      <label><span>Copy mode</span><select value={swap ? "swap" : "copy"} disabled={pending} onChange={(event) => setSwap(event.target.value === "swap")}><option value="copy">Replace destination</option><option value="swap">Swap both scenes</option></select></label>
    </div>
    <p>Scene edits remain temporary until the preset is saved.</p>
  </>;
}
