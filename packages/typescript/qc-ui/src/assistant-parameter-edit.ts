import type { BlockDetails, BlockParameter } from "@ndsp-qc/client";
import { parameterNormalizedValue } from "./parameter-model.ts";

export interface AssistantParameterEdit {
  parameter: BlockParameter;
  normalized: number;
  display: string;
}

/** Resolve an offline assistant parameter phrase identically on every host. */
export function resolveAssistantParameterEdit(details: BlockDetails, parameterName: string, rawValue: string): AssistantParameterEdit {
  const needle = parameterName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const matches = details.parameters.filter((parameter) => parameter.writable && parameter.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(needle));
  if (matches.length !== 1) {
    const choices = details.parameters.filter((parameter) => parameter.writable).map((parameter) => parameter.name).join(", ");
    throw new Error(matches.length > 1
      ? `That matches more than one parameter. Be more specific: ${matches.map((item) => item.name).join(", ")}.`
      : `I could not find that writable parameter on ${details.name}. Available: ${choices || "none"}.`);
  }
  const parameter = matches[0];
  if (parameter.normalizedValue === null) throw new Error(`${parameter.name} has no readable live value, so I will not write it.`);
  const value = rawValue.trim().replace(/^[“”"']|[“”"']$/g, "");
  if (parameter.options.length > 1) {
    const optionIndex = parameter.options.findIndex((option) => option.toLowerCase() === value.toLowerCase());
    if (optionIndex < 0) throw new Error(`Choose one of: ${parameter.options.join(", ")}.`);
    return { parameter, normalized: optionIndex / (parameter.options.length - 1), display: parameter.options[optionIndex] };
  }
  if (value.endsWith("%")) {
    const percentage = Number(value.slice(0, -1));
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw new Error("Use a percentage from 0% through 100%.");
    return { parameter, normalized: percentage / 100, display: `${percentage}%` };
  }
  const numeric = Number(value.replace(parameter.units, "").trim());
  if (!Number.isFinite(numeric)) throw new Error(`I could not interpret “${rawValue}” as a value for ${parameter.name}.`);
  if (parameter.scaleKnown === false) throw new Error(`${parameter.name} does not yet have a verified Quad Cortex display scale. It was not changed.`);
  return { parameter, normalized: parameterNormalizedValue(parameter, numeric), display: `${numeric}${parameter.units ? ` ${parameter.units}` : ""}` };
}
