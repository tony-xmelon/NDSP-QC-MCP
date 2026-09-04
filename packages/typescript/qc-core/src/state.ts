import { QC_MAXIMUM_TEMPO_BPM, QC_MINIMUM_TEMPO_BPM, type GridBlock, type GridRoute, type PresetSnapshot, type QcStateUpdate } from "@ndsp-qc/client";
export type { QcStateUpdate } from "@ndsp-qc/client";

export type PendingBypassIntent = { bypassed: boolean; issuedAt: number; commandId?: number };
export type PendingBypassIntents = Map<string, PendingBypassIntent>;

export function bypassAddress(row: number, column: number): string {
  return `${row}:${column}`;
}

/** Record the latest optimistic state so an older device echo cannot undo it. */
export function markPendingBypass(pending: PendingBypassIntents, row: number, column: number, bypassed: boolean, issuedAt = Date.now()): void {
  pending.set(bypassAddress(row, column), { bypassed, issuedAt });
}

/** Record every bypass transition produced by one optimistic snapshot update. */
export function recordPendingBypassChanges(
  before: PresetSnapshot,
  after: PresetSnapshot,
  pending: PendingBypassIntents,
  issuedAt = Date.now()
): string[] {
  const beforeByAddress = new Map(before.blocks.map((block) => [bypassAddress(block.row, block.column), block]));
  const changed: string[] = [];
  for (const block of after.blocks) {
    const key = bypassAddress(block.row, block.column);
    const previous = beforeByAddress.get(key);
    if (previous && previous.bypassed !== block.bypassed && block.bypassed !== undefined) {
      markPendingBypass(pending, block.row, block.column, block.bypassed, issuedAt);
      changed.push(key);
    }
  }
  return changed;
}

/** Clear only the intents belonging to a failed command, preserving newer taps. */
export function clearPendingBypassChanges(pending: PendingBypassIntents, addresses: readonly string[], issuedAt: number): void {
  for (const address of addresses) {
    if (pending.get(address)?.issuedAt === issuedAt) pending.delete(address);
  }
}

/**
 * Acknowledges matching device state and suppresses contradictory state that
 * predates a newer local command. An expired contradiction is accepted so the
 * UI eventually converges if a hardware command truly failed.
 */
export function reconcilePendingBypass(
  state: QcStateUpdate,
  pending: PendingBypassIntents,
  now = Date.now(),
  graceMs = 3_000,
  observationStartedAt = state.observedAt ?? now
): QcStateUpdate | null {
  const accept = (row: number, column: number, bypassed: boolean): boolean => {
    const key = bypassAddress(row, column);
    const intent = pending.get(key);
    if (!intent) return true;
    // A slow full snapshot may have started before a newer local tap. Even if
    // its old value happens to equal the new target (the common double-toggle
    // ABA case), it cannot acknowledge an intent that did not yet exist.
    if (now - intent.issuedAt >= graceMs || (intent.bypassed === bypassed && observationStartedAt >= intent.issuedAt)) {
      pending.delete(key);
      return true;
    }
    return false;
  };

  if (state.kind === "bypass" && state.row !== undefined && state.column !== undefined && state.bypassed !== undefined) {
    return accept(state.row, state.column, state.bypassed) ? state : null;
  }
  if (state.kind === "preset" && state.blocks?.length && pending.size) {
    return {
      ...state,
      blocks: state.blocks.map((block) => {
        const key = bypassAddress(block.row, block.column);
        const intent = pending.get(key);
        if (!intent) return block;
        if (now - intent.issuedAt >= graceMs || (intent.bypassed === block.bypassed && observationStartedAt >= intent.issuedAt)) {
          pending.delete(key);
          return block;
        }
        return { ...block, bypassed: intent.bypassed };
      })
    };
  }
  if (state.kind !== "bypassBatch" || !state.bypassUpdates?.length) return state;
  const bypassUpdates = state.bypassUpdates.filter(({ row, column, bypassed }) => accept(row, column, bypassed));
  return bypassUpdates.length ? { ...state, bypassUpdates } : null;
}

/** Reconcile every state decoded from one native device frame in wire order. */
export function reconcileQcStateUpdates(
  states: readonly QcStateUpdate[],
  pending: PendingBypassIntents,
  now = Date.now(),
  graceMs = 3_000
): QcStateUpdate[] {
  const reconciled: QcStateUpdate[] = [];
  for (const state of states) {
    const update = reconcilePendingBypass(state, pending, now, graceMs);
    if (update) reconciled.push(update);
  }
  return reconciled;
}

/** Reconcile and reduce one timestamped native frame in one shared operation. */
export function reduceQcStateFrame(
  snapshot: PresetSnapshot,
  states: readonly QcStateUpdate[],
  pending: PendingBypassIntents,
  now = Date.now(),
  graceMs = 3_000
): { snapshot: PresetSnapshot; states: QcStateUpdate[] } {
  const reconciled = reconcileQcStateUpdates(states, pending, now, graceMs);
  return { snapshot: applyQcStateUpdates(snapshot, reconciled), states: reconciled };
}

/** Merge a slower complete read without allowing it to roll back newer taps. */
export function reconcilePresetSnapshot(
  incoming: PresetSnapshot,
  pending: PendingBypassIntents,
  observedAt = Date.now(),
  now = Date.now(),
  graceMs = 3_000
): PresetSnapshot {
  const update = reconcilePendingBypass(
    { kind: "preset", blocks: incoming.blocks, catalogRefresh: true, observedAt },
    pending,
    now,
    graceMs
  );
  return { ...incoming, blocks: update?.blocks ?? incoming.blocks };
}

export function sceneLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

export function selectSceneInSnapshot(snapshot: PresetSnapshot, index: number): PresetSnapshot {
  return { ...snapshot, activeScene: Math.max(0, Math.min(snapshot.scenes.length - 1, index)) };
}

export function movePresetInSnapshot(snapshot: PresetSnapshot, delta: -1 | 1, name?: string): PresetSnapshot {
  const presetPosition = Math.max(0, snapshot.presetPosition + delta);
  return {
    ...snapshot,
    presetPosition,
    presetLocation: `${Math.floor(presetPosition / 8) + 1}${sceneLetter(presetPosition % 8)}`,
    presetName: name ?? snapshot.presetName
  };
}

export function setBlockBypassInSnapshot(snapshot: PresetSnapshot, blockId: string, bypassed: boolean): PresetSnapshot {
  return {
    ...snapshot,
    blocks: snapshot.blocks.map((block) => block.id === blockId ? { ...block, bypassed } : block)
  };
}

export function setTempoInSnapshot(snapshot: PresetSnapshot, tempo: number): PresetSnapshot {
  return { ...snapshot, tempo: Math.max(QC_MINIMUM_TEMPO_BPM, Math.min(QC_MAXIMUM_TEMPO_BPM, Math.round(tempo))), tempoLedEnabled: true };
}

export function selectModeSlotInSnapshot(snapshot: PresetSnapshot, slot: 0 | 1 | 2): PresetSnapshot {
  const fallbackModes = ["PRESET", "SCENE", "STOMP"] as const;
  const selected = snapshot.modeSlots?.find((entry) => entry.slot === slot) ?? { slot, label: fallbackModes[slot], mode: fallbackModes[slot] };
  const rowMode = selected.mode === "HYBRID" ? "SCENE" : selected.mode;
  return { ...snapshot, mode: selected.mode, footswitchModes: [rowMode, rowMode] };
}

export function applyQcStateUpdate(snapshot: PresetSnapshot, state: QcStateUpdate): PresetSnapshot {
  if (state.kind === "scene" && state.activeScene !== undefined) return selectSceneInSnapshot(snapshot, state.activeScene);
  if (state.kind === "dirty" && state.dirty !== undefined) return { ...snapshot, dirty: state.dirty };
  if (state.kind === "master" && state.masterVolume !== undefined) {
    const volume = state.masterVolume <= 1 ? state.masterVolume * 100 : state.masterVolume;
    return { ...snapshot, masterVolume: Math.round(volume) };
  }
  if (state.kind === "mode" && state.mode) return {
    ...snapshot,
    mode: state.mode,
    modeSlots: state.modeSlots ?? snapshot.modeSlots,
    footswitchModes: state.footswitchModes ?? snapshot.footswitchModes
  };
  if (state.kind === "sceneLabel" && state.index !== undefined && state.label !== undefined) {
    return { ...snapshot, scenes: snapshot.scenes.map((label, index) => index === state.index ? state.label! : label) };
  }
  if (state.kind === "sceneColor" && state.index !== undefined && state.color) {
    const colors = [...(snapshot.sceneColors ?? [])];
    colors[state.index] = state.color;
    return { ...snapshot, sceneColors: colors };
  }
  if (state.kind === "bypass" && state.row !== undefined && state.column !== undefined && state.bypassed !== undefined) {
    return {
      ...snapshot,
      blocks: snapshot.blocks.map((block) => block.row === state.row && block.column === state.column ? { ...block, bypassed: state.bypassed } : block)
    };
  }
  if (state.kind === "bypassBatch" && state.bypassUpdates?.length) {
    const updates = new Map(state.bypassUpdates.map((update) => [bypassAddress(update.row, update.column), update.bypassed]));
    return {
      ...snapshot,
      blocks: snapshot.blocks.map((block) => updates.has(bypassAddress(block.row, block.column)) ? { ...block, bypassed: updates.get(bypassAddress(block.row, block.column))! } : block)
    };
  }
  if (state.kind === "tempo") return {
    ...snapshot,
    tempo: state.tempo ?? snapshot.tempo,
    tempoLedEnabled: state.tempoLedEnabled ?? snapshot.tempoLedEnabled
  };
  if (state.kind === "position" && state.position !== undefined) {
    const bank = Math.floor(state.position / 8) + 1;
    const setlistName = state.setlistKey?.split("/").filter(Boolean).at(-1) ?? snapshot.setlistName;
    return {
      ...snapshot,
      presetPosition: state.position,
      presetLocation: `${bank}${sceneLetter(state.position % 8)}`,
      setlistKey: state.setlistKey ?? snapshot.setlistKey,
      setlistName
    };
  }
  if (state.kind === "preset") return {
    ...snapshot,
    dirty: state.catalogRefresh ? snapshot.dirty : false,
    presetName: state.presetName ?? snapshot.presetName,
    tempo: state.tempo ?? snapshot.tempo,
    tempoLedEnabled: state.tempoLedEnabled ?? snapshot.tempoLedEnabled,
    scenes: state.scenes?.length ? state.scenes : snapshot.scenes,
    sceneColors: state.sceneColors?.length ? state.sceneColors : snapshot.sceneColors,
    blocks: state.blocks ?? snapshot.blocks,
    routes: state.routes ?? snapshot.routes
  };
  return snapshot;
}

/** Apply one native frame with a single immutable snapshot commit. */
export function applyQcStateUpdates(snapshot: PresetSnapshot, states: readonly QcStateUpdate[]): PresetSnapshot {
  return states.reduce(applyQcStateUpdate, snapshot);
}
