import { QC_MAXIMUM_TEMPO_BPM, QC_MINIMUM_TEMPO_BPM } from "@ndsp-qc/client";

export interface TapTempoResult {
  taps: number[];
  status: "need-more" | "invalid" | "ready";
  bpm?: number;
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
