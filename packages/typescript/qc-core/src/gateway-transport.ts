import type { GatewayTransport, PresetSnapshot } from "@ndsp-qc/client";
import type { QcDeviceTransport } from "./transport.ts";

/**
 * The single UI-to-gateway adapter used by both desktop and Android shells.
 * Native code is responsible only for carrying gateway calls to the device.
 */
export function createQcGatewayTransport(
  gateway: GatewayTransport,
  currentSnapshot: () => PresetSnapshot
): QcDeviceTransport {
  const expected = (snapshot?: PresetSnapshot) => snapshot ?? currentSnapshot();
  return {
    selectScene(scene, snapshot) {
      const state = expected(snapshot);
      return gateway.selectScene(scene, state.presetName);
    },
    selectModeSlot(slot, snapshot) {
      const state = expected(snapshot);
      return gateway.selectModeSlot(slot, state.presetName);
    },
    movePreset(delta, snapshot) {
      const state = expected(snapshot);
      const position = Math.max(0, Math.min(255, state.presetPosition + delta));
      // An empty expected name deliberately avoids comparing the new preset's
      // name while retaining the position guard that serializes rapid taps.
      return gateway.recallPreset(state.setlistKey, position, "", state.presetPosition);
    },
    pressFootswitch(index, snapshot) {
      const state = expected(snapshot);
      return gateway.pressFootswitch(index, state.mode, state.presetName);
    },
    setTempo(bpm, snapshot) {
      const state = expected(snapshot);
      return gateway.setTempo(bpm, state.tempo, state.presetName);
    },
    tapTempo(snapshot) {
      const state = expected(snapshot);
      return gateway.tapTempo(state.mode, state.presetName);
    },
    blockDetails(row, column, snapshot) {
      return gateway.blockDetails(row, column, expected(snapshot).presetName);
    },
    setParameter(row, column, parameterIndex, value, snapshot) {
      const state = expected(snapshot);
      return gateway.blockDetails(row, column, state.presetName).then((block) => {
        const parameter = block.parameters.find((candidate) => candidate.index === parameterIndex);
        if (!parameter || parameter.normalizedValue === null) throw new Error(`Parameter ${parameterIndex} is not writable.`);
        return gateway.setParameter(row, column, parameterIndex, value, parameter.normalizedValue, state.activeScene, state.presetName);
      });
    },
    setBypass(row, column, bypassed, snapshot) {
      const state = expected(snapshot);
      const block = state.blocks.find((candidate) => candidate.row === row && candidate.column === column);
      if (!block) return Promise.reject(new Error(`No block exists at row ${row + 1}, column ${column + 1}.`));
      return gateway.toggleBypass(row, column, state.activeScene, block.bypassed ?? false, bypassed, state.presetName);
    },
    setTuner(show) {
      return gateway.showTuner(show);
    },
    setGigView(show) {
      return gateway.showGigView(show);
    }
  };
}
