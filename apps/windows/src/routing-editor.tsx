import { QC_GRID_COLUMNS, type PresetSnapshot } from "@ndsp-qc/client";
import { inputRouteOptions, outputRouteOptions, updateRouteDraft, type RouteDrafts } from "@ndsp-qc/core";
import type { Dispatch, SetStateAction } from "react";

type RoutingEditorProps = {
  snapshot: PresetSnapshot;
  drafts: RouteDrafts;
  pending: boolean;
  setDrafts: Dispatch<SetStateAction<RouteDrafts>>;
  applyRoute: (row: number, kind: "input" | "output") => void;
  applySplitRoute: (row: number) => void;
};

export function RoutingEditor({ snapshot, drafts, pending, setDrafts, applyRoute, applySplitRoute }: RoutingEditorProps) {
  return <>
    <div className="dialog-kicker">SIGNAL ROUTING</div>
    <h2 id="dialog-title">Inputs, outputs, and branches</h2>
    <div className="routing-editor">
      {snapshot.routes.map((route) => {
        const draft = drafts[route.row];
        const expectedSplit = route.splitColumn ?? null;
        const expectedMix = route.splitColumn === undefined ? null : route.mixColumn ?? -1;
        return <section key={route.row}>
          <strong>Row {route.row + 1}</strong>
          <label><span>Input</span>
            <select value={draft?.inputId ?? route.inputId ?? 0} disabled={pending} onChange={(event) => setDrafts((current) => updateRouteDraft(current, route, { inputId: Number(event.target.value) }))}>
              {inputRouteOptions.map(([id, label]) => <option value={id} key={id}>{label}</option>)}
            </select>
            <button disabled={!draft || draft.inputId === route.inputId || pending} onClick={() => applyRoute(route.row, "input")}>Review…</button>
          </label>
          <label><span>Output</span>
            <select value={draft?.outputId ?? route.outputId ?? 0} disabled={pending} onChange={(event) => setDrafts((current) => updateRouteDraft(current, route, { outputId: Number(event.target.value) }))}>
              {outputRouteOptions.map(([id, label]) => <option value={id} key={id}>{label}</option>)}
            </select>
            <button disabled={!draft || draft.outputId === route.outputId || pending} onClick={() => applyRoute(route.row, "output")}>Review…</button>
          </label>
          {route.row % 2 === 0 && draft && <label className="split-controls"><span>Branch</span>
            <select value={draft.splitColumn ?? ""} disabled={pending} onChange={(event) => {
              const splitColumn = event.target.value === "" ? null : Number(event.target.value);
              setDrafts((current) => updateRouteDraft(current, route, { splitColumn, mixColumn: splitColumn === null ? null : -1 }));
            }}>
              <option value="">Serial path</option>
              {Array.from({ length: QC_GRID_COLUMNS }, (_, column) => <option value={column} key={column}>Split at {column + 1}</option>)}
            </select>
            <select aria-label={`Row ${route.row + 1} rejoin column`} value={draft.mixColumn ?? ""} disabled={pending || draft.splitColumn === null} onChange={(event) => setDrafts((current) => updateRouteDraft(current, route, { mixColumn: Number(event.target.value) }))}>
              <option value={-1}>No rejoin</option>
              {Array.from({ length: QC_GRID_COLUMNS }, (_, column) => column).filter((column) => draft.splitColumn !== null && column > draft.splitColumn).map((column) => <option value={column} key={column}>Rejoin at {column + 1}</option>)}
            </select>
            <button disabled={(draft.splitColumn === expectedSplit && draft.mixColumn === expectedMix) || pending} onClick={() => applySplitRoute(route.row)}>Review…</button>
          </label>}
        </section>;
      })}
    </div>
    <p>Each change is checked against the current preset and existing route, then verified by readback. Audio may be interrupted; saving remains a separate action.</p>
  </>;
}
