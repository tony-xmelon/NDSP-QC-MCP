import type { BlockParameter } from "@ndsp-qc/client";

export const PARAMETER_ENCODER_ROLES = [
  "footswitch:A", "footswitch:B", "footswitch:C", "footswitch:D", "footswitch:E",
  "bank:down", "footswitch:F", "footswitch:G", "footswitch:H", "tempo"
] as const;

export function parameterEditorPageSlots<T extends { displayPosition?: number }>(parameters: ReadonlyArray<T>, page: number, pageSize: number): Array<T | undefined> {
  const slots = Array<T | undefined>(pageSize).fill(undefined);
  parameters.forEach((parameter, index) => {
    const position = parameter.displayPosition ?? index;
    if (Math.floor(position / pageSize) === page) slots[position % pageSize] = parameter;
  });
  return slots;
}

export function parameterEditorPageCount(parameters: ReadonlyArray<{ displayPosition?: number }>, pageSize: number): number {
  const lastPosition = parameters.reduce((maximum, parameter, index) => Math.max(maximum, parameter.displayPosition ?? index), -1);
  return Math.max(1, Math.floor(lastPosition / pageSize) + 1);
}

export function parameterEditorControlSlots<T extends { index: number; displayPosition?: number }>(parameters: ReadonlyArray<T>, category: string, page: number, pageSize: number): Array<T | undefined> {
  if (parameterEditorFamily(category) !== "cab") return parameterEditorPageSlots(parameters, page, pageSize);
  const indexes = page === 0
    ? [5, 4, 2, 3, undefined, 13, 12, 10, 11, undefined]
    : [16, 18, 17, undefined, undefined, undefined, undefined, undefined, undefined, undefined];
  return indexes.map((index) => index === undefined ? undefined : parameters.find((parameter) => parameter.index === index));
}

export type ParameterEditorFamily =
  | "standard" | "compressor" | "delay" | "eq" | "modulation"
  | "pitch" | "reverb" | "synth" | "cab" | "ir" | "looper";

export type ParameterControlKind = "knob" | "select" | "switch" | "button" | "fader" | "meter";

export function parameterControlKind(parameter: Pick<BlockParameter, "type" | "options">): ParameterControlKind {
  const kind = parameter.type.trim().toLowerCase();
  if (kind === "grmeter") return "meter";
  if (kind === "fader") return "fader";
  if (kind === "rotaryswitch") return "knob";
  if (kind === "togglebutton") return "button";
  if (kind === "switch") return "switch";
  if (kind === "combobox" || kind === "string" || kind === "enum") return "select";
  if (parameter.options.length === 2) return "switch";
  if (parameter.options.length > 2) return "select";
  return "knob";
}

export function parameterEditorFamily(category: string): ParameterEditorFamily {
  const key = category.trim().toLowerCase();
  if (/compress/.test(key)) return "compressor";
  if (/delay/.test(key)) return "delay";
  if (/\beq\b|equalizer/.test(key)) return "eq";
  if (/modulation/.test(key)) return "modulation";
  if (/pitch/.test(key)) return "pitch";
  if (/reverb/.test(key)) return "reverb";
  if (/synth/.test(key)) return "synth";
  if (/\bcab\b/.test(key)) return "cab";
  if (/\bir\b|irloader|impulse/.test(key)) return "ir";
  if (/looper/.test(key)) return "looper";
  return "standard";
}

export function parameterEditorIsFullScreen(category: string): boolean {
  return ["eq", "cab", "ir", "looper"].includes(parameterEditorFamily(category));
}

export function parameterEditorPageSize(category: string, parameters: ReadonlyArray<Pick<BlockParameter, "type">> = []): number {
  const family = parameterEditorFamily(category);
  // Looper X Params mode is three hardware pages of five controls.
  if (family === "looper") return 5;
  if (family === "eq" && parameters.some((parameter) => parameter.type.toLowerCase() === "fader")) return 10;
  if (family === "eq") return 5;
  return 10;
}

/** Grid category color and editor control color are not always the same on CorOS. */
export function parameterEditorAccent(name: string, fallback: string): string {
  return /adaptive\s+gate/i.test(name) ? "#f4f4f4" : fallback;
}

export function parameterEditorTabs(name: string, category: string, pageCount: number): string[] {
  if (pageCount <= 1) return [];
  const family = parameterEditorFamily(category);
  if (family === "cab") return ["CAB", "EQ"];
  if (family === "ir" || family === "looper") return Array.from({ length: pageCount }, (_, index) => String(index + 1));
  if (family === "eq") return Array.from({ length: pageCount }, (_, index) => index === pageCount - 1 ? "OUT" : `BAND ${index + 1}`);
  if (/synth|overlord/i.test(`${category} ${name}`)) {
    const labels = ["MAIN", "ARPEGGIATOR", "OSCILLATOR", "FILTER", "ENVELOPE"];
    return Array.from({ length: pageCount }, (_, index) => labels[index] ?? `PAGE ${index + 1}`);
  }
  return Array.from({ length: pageCount }, (_, index) => index === 0 ? "MAIN" : `PAGE ${index + 1}`);
}

function clamp(value: number) { return Math.max(0, Math.min(1, value)); }

export function parameterRealValue(parameter: BlockParameter, normalized: number): number {
  const clamped = clamp(normalized);
  if (parameter.valueScale === "lookup" && parameter.scalePoints?.length) {
    for (let index = 1; index < parameter.scalePoints.length; index += 1) {
      const left = parameter.scalePoints[index - 1];
      const right = parameter.scalePoints[index];
      if (clamped <= right.normalized) {
        const span = right.normalized - left.normalized;
        const ratio = span === 0 ? 0 : (clamped - left.normalized) / span;
        return left.real + ratio * (right.real - left.real);
      }
    }
    return parameter.scalePoints.at(-1)!.real;
  }
  if (parameter.valueScale === "logarithmic" && parameter.minimum > 0 && parameter.maximum > parameter.minimum) {
    return parameter.minimum * Math.pow(parameter.maximum / parameter.minimum, clamped);
  }
  const amount = parameter.valueScale === "power"
    ? Math.pow(clamped, parameter.scaleExponent ?? 1)
    : clamped;
  return parameter.minimum + amount * (parameter.maximum - parameter.minimum);
}

export function parameterNormalizedValue(parameter: BlockParameter, real: number): number {
  if (!Number.isFinite(real)) throw new Error(`${parameter.name} must be a number.`);
  if (real < parameter.minimum || real > parameter.maximum) {
    throw new Error(`${parameter.name} must be from ${parameter.minimum} through ${parameter.maximum}${parameter.units ? ` ${parameter.units}` : ""}.`);
  }
  if (parameter.valueScale === "lookup" && parameter.scalePoints?.length) {
    const ascending = parameter.scalePoints.at(-1)!.real >= parameter.scalePoints[0].real;
    for (let index = 1; index < parameter.scalePoints.length; index += 1) {
      const left = parameter.scalePoints[index - 1];
      const right = parameter.scalePoints[index];
      if ((ascending && real <= right.real) || (!ascending && real >= right.real)) {
        const span = right.real - left.real;
        const ratio = span === 0 ? 0 : (real - left.real) / span;
        return clamp(left.normalized + ratio * (right.normalized - left.normalized));
      }
    }
    return clamp(parameter.scalePoints.at(-1)!.normalized);
  }
  const span = parameter.maximum - parameter.minimum;
  if (span <= 0) return 0;
  if (parameter.valueScale === "logarithmic") {
    if (parameter.minimum <= 0 || real <= 0) throw new Error(`${parameter.name} has an invalid logarithmic range.`);
    return clamp(Math.log(real / parameter.minimum) / Math.log(parameter.maximum / parameter.minimum));
  }
  const amount = clamp((real - parameter.minimum) / span);
  return parameter.valueScale === "power"
    ? Math.pow(amount, 1 / (parameter.scaleExponent ?? 1))
    : amount;
}

export function parameterStep(parameter: BlockParameter): number {
  if (parameter.options.length > 1) return 1 / (parameter.options.length - 1);
  if (parameter.steps && parameter.steps > 1) return 1 / (parameter.steps - 1);
  return .01;
}

export function parameterDisplay(parameter: BlockParameter, normalized: number): string {
  if (parameter.options.length > 1) {
    return parameter.options[Math.round(clamp(normalized) * (parameter.options.length - 1))] ?? parameter.displayValue;
  }
  if (parameter.type.toLowerCase() === "togglebutton") return normalized >= .5 ? "ON" : "OFF";
  if (normalized <= .000001 && parameter.minimumLabel) return parameter.minimumLabel;
  if (Math.abs(normalized - .5) <= .000001 && parameter.midpointLabel) return parameter.midpointLabel;
  if (normalized >= .999999 && parameter.maximumLabel) return parameter.maximumLabel;
  const real = parameterRealValue(parameter, normalized);
  // CorOS normally keeps one decimal on continuous knobs (for example 5.0).
  // Explicit device metadata remains authoritative for integer and finer values.
  const ordinaryHertz = parameter.units.trim().toLowerCase() === "hz" && parameter.maximum > 20;
  const precision = parameter.displayPrecision ?? (ordinaryHertz ? 0 : 1);
  const rendered = real.toFixed(precision);
  const value = Number(rendered) === 0 ? (0).toFixed(precision) : rendered;
  return `${value}${parameter.units ? ` ${parameter.units}` : ""}`;
}
