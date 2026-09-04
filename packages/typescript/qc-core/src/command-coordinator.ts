import type { PresetSnapshot } from "@ndsp-qc/client";
import { applyFootswitchPreview } from "./footswitch.ts";
import {
  applyQcStateUpdate,
  bypassAddress,
  movePresetInSnapshot,
  reconcilePresetSnapshot,
  reconcilePendingBypass,
  selectModeSlotInSnapshot,
  selectSceneInSnapshot,
  setBlockBypassInSnapshot,
  setTempoInSnapshot,
  type PendingBypassIntents,
  type QcStateUpdate
} from "./state.ts";

type ScalarKey = "scene" | "position" | "mode" | "tempo";

type ScalarValueByKey = {
  scene: number;
  position: number;
  mode: PresetSnapshot["mode"];
  tempo: number;
};

type ScalarIntent<K extends ScalarKey = ScalarKey> = {
  id: number;
  key: K;
  target: ScalarValueByKey[K];
  issuedAt: number;
};

type ScalarRollback = {
  key: ScalarKey;
  previous: number | PresetSnapshot["mode"];
  previousModeSlots?: PresetSnapshot["modeSlots"];
  previousFootswitchModes?: PresetSnapshot["footswitchModes"];
  previousTempoLedEnabled?: boolean;
};

type BypassRollback = {
  address: string;
  row: number;
  column: number;
  previous: boolean | undefined;
};

/** Opaque handle used to settle or safely roll back one optimistic command. */
export interface QcCommandToken {
  readonly id: number;
  readonly issuedAt: number;
  readonly scalarRollbacks: readonly ScalarRollback[];
  readonly bypassRollbacks: readonly BypassRollback[];
  readonly previousFootswitchStates?: PresetSnapshot["footswitchStates"];
}

export interface QcOptimisticCommand {
  snapshot: PresetSnapshot;
  token: QcCommandToken;
}

/**
 * Platform-neutral lifecycle for realtime QC commands.
 *
 * Native transports only send commands and timestamp device observations. This
 * coordinator owns instant UI previews, stale-echo suppression, acknowledgement,
 * and rollback without allowing an older failure to undo a newer command.
 */
export class QcCommandCoordinator {
  private readonly bypassIntents: PendingBypassIntents = new Map();
  private readonly scalarIntents = new Map<ScalarKey, ScalarIntent>();
  private nextId = 1;

  reset(): void {
    this.bypassIntents.clear();
    this.scalarIntents.clear();
  }

  get hasPendingCommands(): boolean {
    return this.bypassIntents.size > 0 || this.scalarIntents.size > 0;
  }

  beginScene(snapshot: PresetSnapshot, scene: number, issuedAt = Date.now()): QcOptimisticCommand {
    return this.beginScalar(snapshot, "scene", snapshot.activeScene, selectSceneInSnapshot(snapshot, scene), issuedAt);
  }

  beginPresetMove(snapshot: PresetSnapshot, delta: -1 | 1, name?: string, issuedAt = Date.now()): QcOptimisticCommand {
    return this.beginScalar(snapshot, "position", snapshot.presetPosition, movePresetInSnapshot(snapshot, delta, name), issuedAt);
  }

  beginModeSlot(snapshot: PresetSnapshot, slot: 0 | 1 | 2, issuedAt = Date.now()): QcOptimisticCommand {
    return this.beginScalar(snapshot, "mode", snapshot.mode, selectModeSlotInSnapshot(snapshot, slot), issuedAt);
  }

  beginTempo(snapshot: PresetSnapshot, tempo: number, issuedAt = Date.now()): QcOptimisticCommand {
    return this.beginScalar(snapshot, "tempo", snapshot.tempo, setTempoInSnapshot(snapshot, tempo), issuedAt);
  }

  beginBypass(snapshot: PresetSnapshot, blockId: string, bypassed: boolean, issuedAt = Date.now()): QcOptimisticCommand {
    return this.beginSnapshotMutation(snapshot, setBlockBypassInSnapshot(snapshot, blockId, bypassed), issuedAt);
  }

  beginFootswitch(snapshot: PresetSnapshot, index: number, issuedAt = Date.now()): QcOptimisticCommand {
    return this.beginSnapshotMutation(snapshot, applyFootswitchPreview(snapshot, index), issuedAt, snapshot.footswitchStates);
  }

  /** Forget a command that needs no device acknowledgement (for example demo mode). */
  settle(token: QcCommandToken): void {
    for (const rollback of token.scalarRollbacks) {
      if (this.scalarIntents.get(rollback.key)?.id === token.id) this.scalarIntents.delete(rollback.key);
    }
    for (const rollback of token.bypassRollbacks) {
      if (this.bypassIntents.get(rollback.address)?.commandId === token.id) this.bypassIntents.delete(rollback.address);
    }
  }

  /** Roll back only fields still owned by this command; newer user input wins. */
  fail(snapshot: PresetSnapshot, token: QcCommandToken): PresetSnapshot {
    let next = snapshot;
    for (const rollback of token.scalarRollbacks) {
      if (this.scalarIntents.get(rollback.key)?.id !== token.id) continue;
      this.scalarIntents.delete(rollback.key);
      next = restoreScalar(next, rollback);
    }

    let restoredBypass = false;
    for (const rollback of token.bypassRollbacks) {
      if (this.bypassIntents.get(rollback.address)?.commandId !== token.id) continue;
      this.bypassIntents.delete(rollback.address);
      restoredBypass = true;
      next = {
        ...next,
        blocks: next.blocks.map((block) => block.row === rollback.row && block.column === rollback.column
          ? { ...block, bypassed: rollback.previous }
          : block)
      };
    }
    if (restoredBypass && token.previousFootswitchStates) next = { ...next, footswitchStates: token.previousFootswitchStates };
    return next;
  }

  /** Reconcile and atomically apply one timestamped native device frame. */
  reconcileFrame(
    snapshot: PresetSnapshot,
    states: readonly QcStateUpdate[],
    now = Date.now(),
    graceMs = 3_000
  ): { snapshot: PresetSnapshot; states: QcStateUpdate[] } {
    const reconciled: QcStateUpdate[] = [];
    let next = snapshot;
    for (const state of states) {
      const scalar = this.reconcileScalarUpdate(state, now, graceMs);
      if (!scalar) continue;
      const bypass = reconcilePendingBypass(scalar, this.bypassIntents, now, graceMs);
      if (!bypass) continue;
      // Bypass addresses belong to a preset. Once a preset transition is
      // accepted, intents from the previous grid must never leak into it.
      if (bypass.kind === "position" && bypass.position !== undefined && bypass.position !== next.presetPosition) {
        this.bypassIntents.clear();
      }
      reconciled.push(bypass);
      next = applyQcStateUpdate(next, bypass);
    }
    return { snapshot: next, states: reconciled };
  }

  /** Merge a slower full read while preserving every newer optimistic command. */
  reconcileSnapshot(
    incoming: PresetSnapshot,
    observedAt = Date.now(),
    now = Date.now(),
    graceMs = 3_000
  ): PresetSnapshot {
    let next = reconcilePresetSnapshot(incoming, this.bypassIntents, observedAt, now, graceMs);
    for (const [key, intent] of this.scalarIntents) {
      const actual = scalarValue(next, key);
      if (now - intent.issuedAt >= graceMs || (actual === intent.target && observedAt >= intent.issuedAt)) {
        this.scalarIntents.delete(key);
      } else {
        next = setScalar(next, key, intent.target);
      }
    }
    return next;
  }

  private beginScalar<K extends ScalarKey>(
    before: PresetSnapshot,
    key: K,
    previous: ScalarValueByKey[K],
    after: PresetSnapshot,
    issuedAt: number
  ): QcOptimisticCommand {
    const rollback: ScalarRollback = {
      key,
      previous,
      previousModeSlots: key === "mode" ? before.modeSlots : undefined,
      previousFootswitchModes: key === "mode" ? before.footswitchModes : undefined,
      previousTempoLedEnabled: key === "tempo" ? before.tempoLedEnabled : undefined
    };
    const token = this.token(issuedAt, [rollback], []);
    this.scalarIntents.set(key, { id: token.id, key, target: scalarValue(after, key), issuedAt } as ScalarIntent);
    return { snapshot: after, token };
  }

  private beginSnapshotMutation(
    before: PresetSnapshot,
    after: PresetSnapshot,
    issuedAt: number,
    previousFootswitchStates?: PresetSnapshot["footswitchStates"]
  ): QcOptimisticCommand {
    const id = this.nextId++;
    const scalarRollbacks: ScalarRollback[] = [];
    for (const key of ["scene", "position", "mode", "tempo"] as const) {
      if (scalarValue(before, key) === scalarValue(after, key)) continue;
      scalarRollbacks.push({
        key,
        previous: scalarValue(before, key),
        previousModeSlots: key === "mode" ? before.modeSlots : undefined,
        previousFootswitchModes: key === "mode" ? before.footswitchModes : undefined,
        previousTempoLedEnabled: key === "tempo" ? before.tempoLedEnabled : undefined
      });
      this.scalarIntents.set(key, { id, key, target: scalarValue(after, key), issuedAt } as ScalarIntent);
    }

    const beforeBlocks = new Map(before.blocks.map((block) => [bypassAddress(block.row, block.column), block]));
    const bypassRollbacks: BypassRollback[] = [];
    for (const block of after.blocks) {
      const address = bypassAddress(block.row, block.column);
      const previous = beforeBlocks.get(address)?.bypassed;
      if (previous === block.bypassed || block.bypassed === undefined) continue;
      bypassRollbacks.push({ address, row: block.row, column: block.column, previous });
      this.bypassIntents.set(address, { bypassed: block.bypassed, issuedAt, commandId: id });
    }
    return {
      snapshot: after,
      token: { id, issuedAt, scalarRollbacks, bypassRollbacks, previousFootswitchStates }
    };
  }

  private token(issuedAt: number, scalarRollbacks: ScalarRollback[], bypassRollbacks: BypassRollback[]): QcCommandToken {
    return { id: this.nextId++, issuedAt, scalarRollbacks, bypassRollbacks };
  }

  private reconcileScalarUpdate(state: QcStateUpdate, now: number, graceMs: number): QcStateUpdate | null {
    let next = state;
    if (state.kind === "scene" && state.activeScene !== undefined && !this.acceptScalar("scene", state.activeScene, state, now, graceMs)) return null;
    if (state.kind === "position" && state.position !== undefined && !this.acceptScalar("position", state.position, state, now, graceMs)) return null;
    if (state.kind === "mode" && state.mode && !this.acceptScalar("mode", state.mode, state, now, graceMs)) return null;
    if ((state.kind === "tempo" || state.kind === "preset") && state.tempo !== undefined && !this.acceptScalar("tempo", state.tempo, state, now, graceMs)) {
      if (state.kind === "tempo") return null;
      next = { ...state, tempo: undefined, tempoLedEnabled: undefined };
    }
    return next;
  }

  private acceptScalar<K extends ScalarKey>(key: K, actual: ScalarValueByKey[K], state: QcStateUpdate, now: number, graceMs: number): boolean {
    const intent = this.scalarIntents.get(key) as ScalarIntent<K> | undefined;
    if (!intent) return true;
    const observedAt = state.observedAt ?? now;
    if (now - intent.issuedAt >= graceMs || (actual === intent.target && observedAt >= intent.issuedAt)) {
      this.scalarIntents.delete(key);
      return true;
    }
    return false;
  }
}

function scalarValue<K extends ScalarKey>(snapshot: PresetSnapshot, key: K): ScalarValueByKey[K] {
  if (key === "scene") return snapshot.activeScene as ScalarValueByKey[K];
  if (key === "position") return snapshot.presetPosition as ScalarValueByKey[K];
  if (key === "tempo") return snapshot.tempo as ScalarValueByKey[K];
  return snapshot.mode as ScalarValueByKey[K];
}

function setScalar<K extends ScalarKey>(snapshot: PresetSnapshot, key: K, value: ScalarValueByKey[K]): PresetSnapshot {
  if (key === "scene") return selectSceneInSnapshot(snapshot, value as number);
  if (key === "tempo") return setTempoInSnapshot(snapshot, value as number);
  if (key === "mode") {
    const mode = value as PresetSnapshot["mode"];
    const rowMode = mode === "HYBRID" ? "SCENE" : mode;
    return { ...snapshot, mode, footswitchModes: [rowMode, rowMode] };
  }
  const position = value as number;
  return {
    ...snapshot,
    presetPosition: position,
    presetLocation: `${Math.floor(position / 8) + 1}${String.fromCharCode(65 + (position % 8))}`
  };
}

function restoreScalar(snapshot: PresetSnapshot, rollback: ScalarRollback): PresetSnapshot {
  const restored = setScalar(snapshot, rollback.key, rollback.previous as never);
  if (rollback.key === "mode") return {
    ...restored,
    modeSlots: rollback.previousModeSlots,
    footswitchModes: rollback.previousFootswitchModes
  };
  if (rollback.key === "tempo") return { ...restored, tempoLedEnabled: rollback.previousTempoLedEnabled };
  return restored;
}
