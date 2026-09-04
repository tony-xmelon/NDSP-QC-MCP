import type { BlockDetails, ModelEntry, PresetSnapshot } from "@ndsp-qc/client";
import { sceneLetter } from "@ndsp-qc/core";

export interface GridManagementPanelProps {
  snapshot: PresetSnapshot;
  details?: BlockDetails;
  loading: boolean;
  pending: boolean;
  moveDestination?: number;
  setMoveDestination(value?: number): void;
  footswitchDraft: number | null;
  setFootswitchDraft(value: number | null): void;
  move(): void;
  assignFootswitch(): void;
  remove(): void;
}

export function GridManagementPanel(props: GridManagementPanelProps) {
  const { snapshot, details, loading, pending, moveDestination, setMoveDestination, footswitchDraft, setFootswitchDraft, move, assignFootswitch, remove } = props;
  return <>
    <div className="dialog-kicker">BLOCK EDITOR · SCENE {sceneLetter(snapshot.activeScene)}</div>
    <h2 id="dialog-title">{details?.name ?? "Loading block…"}</h2>
    {loading ? <p>Reading parameter metadata and live values…</p> : details && <div className="block-management">
      <label><span>Move within row {details.row + 1}<small>Only empty cells are offered; cross-row routing stays unchanged.</small></span>
        <select value={moveDestination ?? ""} disabled={pending} onChange={(event) => setMoveDestination(event.target.value === "" ? undefined : Number(event.target.value))}>
          <option value="">Choose empty column…</option>
          {Array.from({ length: 8 }, (_, column) => column).filter((column) => column !== details.column && !snapshot.blocks.some((block) => block.row === details.row && block.column === column)).map((column) => <option value={column} key={column}>Column {column + 1}</option>)}
        </select>
        <button disabled={moveDestination === undefined || pending} onClick={move}>Review move…</button>
      </label>
      <label><span>STOMP footswitch<small>Several blocks may share the same switch.</small></span>
        <select value={footswitchDraft ?? ""} disabled={pending} onChange={(event) => setFootswitchDraft(event.target.value === "" ? null : Number(event.target.value))}>
          <option value="">Unassigned</option>
          {Array.from({ length: 8 }, (_, index) => <option value={index} key={index}>Footswitch {sceneLetter(index)}</option>)}
        </select>
        <button disabled={footswitchDraft === (snapshot.blocks.find((block) => block.row === details.row && block.column === details.column)?.footswitch ?? null) || pending} onClick={assignFootswitch}>Review assignment…</button>
      </label>
      <div className="block-management-actions"><span>Remove this block<small>Discard Unsaved Changes restores the stored preset.</small></span><button className="danger" disabled={pending} onClick={remove}>Review removal…</button></div>
    </div>}
    <p>Changes apply temporarily to the live Grid and require a separate preset save to persist.</p>
  </>;
}

export interface AddBlockPanelProps {
  snapshot: PresetSnapshot;
  filteredModels: ModelEntry[];
  loading: boolean;
  pending: boolean;
  modelFilter: string;
  setModelFilter(value: string): void;
  addCell: string;
  setAddCell(value: string): void;
  addModelId?: number;
  setAddModelId(value: number): void;
  add(): void;
  cancel(): void;
}

export function AddBlockPanel(props: AddBlockPanelProps) {
  const { snapshot, filteredModels, loading, pending, modelFilter, setModelFilter, addCell, setAddCell, addModelId, setAddModelId, add, cancel } = props;
  return <>
    <div className="dialog-kicker">GRID BLOCK CATALOG</div><h2 id="dialog-title">Add a temporary block</h2>
    {loading ? <p>Reading installed models from the Quad Cortex…</p> : <div className="add-block-form">
      <label><span>Empty Grid cell</span><select value={addCell} onChange={(event) => setAddCell(event.target.value)}>{Array.from({ length: 32 }, (_, index) => ({ row: Math.floor(index / 8), column: index % 8 })).filter((cell) => !snapshot.blocks.some((block) => block.row === cell.row && block.column === cell.column)).map((cell) => <option value={`${cell.row}:${cell.column}`} key={`${cell.row}:${cell.column}`}>Row {cell.row + 1}, column {cell.column + 1}</option>)}</select></label>
      <label><span>Find model</span><input value={modelFilter} placeholder="Name, category, or based on…" onChange={(event) => setModelFilter(event.target.value)} /></label>
      <label><span>Installed model</span><select size={8} value={addModelId ?? ""} onChange={(event) => setAddModelId(Number(event.target.value))}>{filteredModels.map((model) => <option value={model.id} key={model.id}>{model.category} — {model.name}{model.basedOn ? ` (${model.basedOn})` : ""}</option>)}</select></label>
      <div className="dialog-actions"><button onClick={cancel}>Cancel</button><button className="primary" disabled={addModelId === undefined || !filteredModels.some((model) => model.id === addModelId) || !addCell || pending} onClick={add}>Review placement…</button></div>
    </div>}
    <p>The model list comes from this QC. Placement is verified and can be refused by the device when DSP capacity is exhausted.</p>
  </>;
}
