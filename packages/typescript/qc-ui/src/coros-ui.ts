export type CorOsContextAction = "create-new" | "edit-details" | "preset-midi-out" | "favorite" | "delete-preset" | "new-capture" | "tempo" | "cpu-monitor" | "settings";

export function openSplitPath(splitX: number, fromY: number, toY: number, rowStartX = 52): string {
  const middleY = (fromY + toY) / 2;
  return `M${splitX} ${fromY} C${splitX} ${middleY - 9},${rowStartX} ${middleY + 9},${rowStartX} ${toY}`;
}

export const GRID_CONTEXT_MENU = [
  { label: "Create New", icon: "＋", action: "create-new" },
  { label: "Save as…", icon: "⇥", action: "save-as" },
  { label: "Edit details", icon: "✎", action: "edit-details" },
  { label: "Preset MIDI Out", icon: "M", action: "preset-midi-out" },
  { label: "Add to favorites", icon: "☆", action: "favorite" },
  { label: "Delete preset", icon: "⌫", action: "delete-preset", danger: true },
  { label: "New Neural Capture", icon: "◇", action: "new-capture" },
  { label: "Tempo", icon: "♩", action: "tempo" },
  { label: "CPU monitor", icon: "▥", action: "cpu-monitor" },
  { label: "Settings", icon: "⚙", action: "settings" }
] as const;
