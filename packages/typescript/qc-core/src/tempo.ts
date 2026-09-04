import { QC_MAXIMUM_TEMPO_BPM, QC_MINIMUM_TEMPO_BPM } from "@ndsp-qc/client";

export interface TapTempoResult {
  taps: number[];
  status: "need-more" | "invalid" | "ready";
  bpm?: number;
}

/**
 * Keep the visual beat origin stable while CorOS reports its 24 clock ticks.
 * Replacing the epoch on every tick restarts the browser animation and makes
 * the TEMPO lamp appear to flash at the MIDI-clock rate instead of once/beat.
 */
export function synchronizeTempoPulseEpoch(
  currentEpoch: number | undefined,
  observedAt: number,
  currentTick: number,
  bpm: number
): number {
  const safeBpm = Math.max(QC_MINIMUM_TEMPO_BPM, Math.min(QC_MAXIMUM_TEMPO_BPM, bpm));
  const period = 60_000 / safeBpm;
  const tick = ((Math.trunc(currentTick) % 24) + 24) % 24;
  const candidate = observedAt - tick * period / 24;
  if (currentEpoch === undefined || !Number.isFinite(currentEpoch)) return candidate;

  const rawDelta = candidate - currentEpoch;
  const phaseDelta = ((rawDelta + period / 2) % period + period) % period - period / 2;
  const clockJitterTolerance = Math.min(50, Math.max(12, period / 10));
  return Math.abs(phaseDelta) <= clockJitterTolerance ? currentEpoch : currentEpoch + phaseDelta;
}

export function recordTempoTap(previousTaps: readonly number[], now: number): TapTempoResult {
  const previous = previousTaps.at(-1);
  const taps = previous === undefined || now - previous > 2500
    ? [now]
    : [...previousTaps.slice(-4), now];
  if (taps.length < 2) return { taps, status: "need-more" };
  const intervals = taps.slice(1).map((time, index) => time - taps[index]);
  const usable = intervals.filter((interval) => interval >= 250 && interval <= 1500);
  if (!usable.length) return { taps: [now], status: "invalid" };
  const average = usable.reduce((sum, interval) => sum + interval, 0) / usable.length;
  return { taps, status: "ready", bpm: Math.round(Math.max(QC_MINIMUM_TEMPO_BPM, Math.min(QC_MAXIMUM_TEMPO_BPM, 60000 / average))) };
}
