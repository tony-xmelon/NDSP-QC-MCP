export type CorOsContextAction = "create-new" | "edit-details" | "preset-midi-out" | "favorite" | "delete-preset" | "new-capture" | "tempo" | "cpu-monitor" | "settings";

/** Grid gaps before columns 0-7, followed by the gap after column 7. */
export const GRID_ROUTE_BOUNDARIES = [75, 141, 228.5, 317, 404.5, 488, 572, 659.5, 748] as const;

export const PRESET_TITLE_RIGHT_EDGE = 612;

export function presetTitlePresentation(name: string, dirty: boolean) {
  const normalizedName = name.trim() || "Unsaved";
  const unsaved = normalizedName.toLocaleLowerCase() === "unsaved";
  return {
    text: `${normalizedName}${dirty ? "*" : ""}`,
    dimmed: unsaved && !dirty,
    italic: dirty
  };
}

export function presetTitleLayout(locationWidth: number, titleWidthAtFullSize: number) {
  const start = 14 + Math.max(0, locationWidth) + 16;
  const maxWidth = Math.max(180, PRESET_TITLE_RIGHT_EDGE - start);
  const fontSize = Math.max(22, Math.min(68, 68 * maxWidth / Math.max(1, titleWidthAtFullSize)));
  return {
    start,
    maxWidth,
    fontSize,
    squeeze: titleWidthAtFullSize * fontSize / 68 > maxWidth,
    baseline: 75 - (68 - fontSize) * .28
  };
}

export function splitAnchorX(splitColumn: number): number {
  return GRID_ROUTE_BOUNDARIES[Math.max(0, Math.min(7, splitColumn))];
}

/** mixColumn is the last cell in the branch, so its marker sits after it. */
export function mixAnchorX(mixColumn: number): number {
  return GRID_ROUTE_BOUNDARIES[Math.max(0, Math.min(8, mixColumn + 1))];
}

export function openSplitPath(splitX: number, fromY: number, toY: number, rowStartX = 52): string {
  const middleY = (fromY + toY) / 2;
  const radius = 9;
  return `M${splitX} ${fromY}V${middleY - radius}Q${splitX} ${middleY} ${splitX - radius} ${middleY}H${rowStartX + radius}Q${rowStartX} ${middleY} ${rowStartX} ${middleY + radius}V${toY - radius}Q${rowStartX} ${toY} ${rowStartX + radius} ${toY}`;
}

/** Mirror of openSplitPath for the Mixer return shown in the QC Grid. */
export function rejoinSplitPath(mixX: number, fromY: number, toY: number, rowEndX = 748): string {
  const radius = 9;
  // A mixer on the final boundary has no horizontal space for the ordinary
  // outward loop. Drawing that loop would reverse over itself and produce a
  // visible pulse, so descend directly and round into the lower rail.
  if (mixX === rowEndX) {
    return `M${mixX} ${fromY}V${toY - radius}Q${rowEndX} ${toY} ${rowEndX - radius} ${toY}`;
  }
  const middleY = (fromY + toY) / 2;
  return `M${mixX} ${fromY}V${middleY - radius}Q${mixX} ${middleY} ${mixX + radius} ${middleY}H${rowEndX - radius}Q${rowEndX} ${middleY} ${rowEndX} ${middleY + radius}V${toY - radius}Q${rowEndX} ${toY} ${rowEndX - radius} ${toY}`;
}

export function gridBlocksByRow<T extends { row: number; column: number }>(blocks: T[], rowCount = 4): T[][] {
  return Array.from({ length: rowCount }, (_, row) => blocks
    .filter((block) => block.row === row)
    .sort((left, right) => left.column - right.column));
}

export function rowHasVisibleSignalRail(blockCount: number, route?: { input?: string; output?: string; splitColumn?: number; mixColumn?: number }): boolean {
  return blockCount > 0
    || Boolean(route?.input && route.input !== "Internal")
    || Boolean(route?.output && route.output !== "Internal")
    || route?.splitColumn !== undefined
    || route?.mixColumn !== undefined;
}

export function routedPortIsPlugged(
  side: "input" | "output",
  routeId: number | undefined,
  ports: readonly { kind: string; id: number; plugged: boolean }[] | undefined
): boolean | undefined {
  if (routeId === undefined || routeId === 0 || !ports?.length) return undefined;
  const members = side === "input"
    ? ({ 3: [1, 2], 6: [4, 5] } as Record<number, number[]>)[routeId] ?? [routeId]
    : ({ 1: [1, 4, 5], 2: [2, 6, 7], 3: [3, 8, 9], 19: [1, 2, 3, 4, 5, 6, 7, 8, 9] } as Record<number, number[]>)[routeId] ?? [routeId];
  const kind = side;
  const relevant = ports.filter((port) => port.kind === kind && members.includes(port.id));
  const usesUsb = side === "input" ? routeId >= 8 && routeId <= 13 : routeId >= 10 && routeId <= 22 && ![16, 17, 18, 19].includes(routeId);
  if (usesUsb || (side === "output" && routeId === 19)) relevant.push(...ports.filter((port) => port.kind === "usb"));
  return relevant.length ? relevant.some((port) => port.plugged) : undefined;
}

export const GRID_CONTEXT_MENU = [
  { label: "Create New", icon: "add", action: "create-new" },
  { label: "Save as…", icon: "save-as", action: "save-as" },
  { label: "Edit details", icon: "edit", action: "edit-details" },
  { label: "Preset MIDI Out", icon: "midi", action: "preset-midi-out" },
  { label: "Add to favorites", icon: "favorite", action: "favorite" },
  { label: "Delete preset", icon: "delete", action: "delete-preset", danger: true },
  { label: "New Neural Capture", icon: "capture", action: "new-capture" },
  { label: "Tempo", icon: "tempo", action: "tempo" },
  { label: "CPU monitor", icon: "cpu", action: "cpu-monitor" },
  { label: "Settings", icon: "settings", action: "settings" }
] as const;

export const DIRECTORY_PRESET_CONTEXT_MENU = [
  { label: "Edit", action: "edit", requiresPreset: true },
  { label: "Copy", action: "copy", requiresPreset: true },
  { label: "Cut", action: "cut", requiresPreset: true },
  { label: "Paste", action: "paste" },
  { label: "Delete", action: "delete", danger: true, requiresPreset: true }
] as const;
