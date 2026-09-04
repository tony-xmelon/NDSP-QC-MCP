import nativeTheme from "./native-theme.json" with { type: "json" };
import colorTheme from "./colors.json" with { type: "json" };
import visualAssets from "./assets.json" with { type: "json" };
import brand from "./brand.json" with { type: "json" };

export { REFERENCE_BLOCK_ICONS } from "./reference-block-icons.ts";

/**
 * Shared visual contract for the Windows and Android QC Control apps.
 *
 * `captured` values are measured from the native 800×480 Quad Cortex PNGs in
 * artifacts/hardware-ui. Category colors come from the CorOS 4.1 device
 * taxonomy and are shared with physical LED fallback behavior.
 */
export const QC_COLORS = colorTheme;

export const QC_TYPOGRAPHY = {
  device: '"Arial Narrow", "Roboto Condensed", Arial, Helvetica, sans-serif',
  devicePlain: 'Arial, Helvetica, sans-serif',
  deviceRoute: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  control: '"IBM Plex Sans", Arial, sans-serif',
  app: 'Inter, "Segoe UI Variable", "Segoe UI", sans-serif',
  mono: '"DM Mono", "Cascadia Mono", Consolas, monospace'
} as const;

export const QC_GEOMETRY = {
  screen: { width: 800, height: 480, aspectRatio: 800 / 480 },
  chassis: { widthCm: 29, heightCm: 19.5, aspectRatio: 29 / 19.5 },
  grid: { rows: 4, columns: 6, routePillWidth: 44, routePillHeight: 78, blockSize: 64 },
  footswitches: { performance: 8, navigation: 2, tempo: 1 }
} as const;

export const QC_VISUAL_ASSETS = visualAssets;

export const QC_GLYPH_FAMILIES = {
  hardware: ["power", "undo", "redo", "save", "menu", "mode", "scenePrevious", "sceneNext", "bypass", "confirm"] as const,
  routing: ["input", "output", "internal", "usb", "return", "multiOut", "send", "xlr", "row"] as const,
  directory: ["grid", "download", "cloud", "folder", "newFolder", "sort", "upload", "search", "done"] as const,
  editing: ["save", "change", "copy", "paste", "reset", "defaults", "expression", "looper", "mute", "remove"] as const,
  communication: ["microphone", "attachment", "file", "send", "stop", "expand"] as const,
  interface: ["add", "subtract", "previous", "next", "up", "down", "more", "check", "close", "backspace", "saveAs", "edit", "midi", "favorite", "delete", "capture", "tempo", "cpu", "settings"] as const
} as const;

export const QC_NATIVE_THEME = nativeTheme;
export const QC_BRAND = brand;

export type QcCategoryColor = keyof typeof QC_COLORS.category;

export const QC_THEME = {
  colors: QC_COLORS,
  typography: QC_TYPOGRAPHY,
  geometry: QC_GEOMETRY,
  assets: QC_VISUAL_ASSETS,
  glyphs: QC_GLYPH_FAMILIES,
  native: QC_NATIVE_THEME,
  brand: QC_BRAND
} as const;
