/**
 * Shared visual contract for the Windows and Android QC Control apps.
 *
 * `captured` values are measured from the native 800×480 Quad Cortex PNGs in
 * artifacts/hardware-ui. Category colors come from the CorOS 4.1 device
 * taxonomy and are shared with physical LED fallback behavior.
 */
export const QC_COLORS = {
  captured: {
    screen: "#000000",
    routePill: "#101010",
    unsaved: "#313031",
    routeRail: "#c6c3c6",
    routeText: "#dedfde",
    utilityMark: "#949694",
    primaryText: "#ffffff",
    sceneBadge: "#ffd331"
  },
  category: {
    plugin: "#ff7000",
    amp: "#ff2727",
    capture: "#959595",
    cab: "#6954ff",
    overdrive: "#ffd236",
    delay: "#00ffdd",
    reverb: "#00ffdd",
    compressor: "#45f862",
    pitch: "#ffd236",
    modulation: "#3500f1",
    morph: "#87daff",
    synth: "#e44a5d",
    filter: "#87daff",
    equalizer: "#0a74e0",
    irLoader: "#6954ff",
    wah: "#959595",
    fxLoop: "#959595",
    looper: "#ff2727",
    utility: "#959595"
  },
  hardware: {
    whiteLed: "#f4f4f4",
    idleLed: "#626367",
    metalHighlight: "#c5c6c8",
    metalMid: "#8f9194",
    metalShadow: "#222327"
  },
  device: {
    panel: "#121212",
    panelRaised: "#1e1e1e",
    controlSurface: "#2e2e2e",
    divider: "#1a1a1b",
    disabled: "#77797c",
    contextMenu: "#292a2c",
    contextMenuHover: "#3a3b3e",
    blockLabel: "#111214",
    connectionMark: "#f28c22",
    splitPath: "#8f9092",
    bypassPath: "#c9c9ca",
    focusOverlay: "#f3f3f3",
    routeFocus: "#171719",
    presetSlotDefault: "#3ee77b",
    tempoLed: "#35ee76"
  },
  app: {
    canvas: "#08090b",
    canvasDeep: "#07080a",
    panel: "#111419",
    panelRaised: "#171b20",
    control: "#1a2026",
    border: "#343b43",
    text: "#f5f6f7",
    textMuted: "#8e969f",
    success: "#53de80",
    info: "#70d6ff",
    warning: "#e8b957",
    danger: "#f26d6d"
  }
} as const;

export const QC_TYPOGRAPHY = {
  device: '"Arial Narrow", "Roboto Condensed", Arial, Helvetica, sans-serif',
  app: 'Inter, "Segoe UI Variable", "Segoe UI", sans-serif',
  mono: '"DM Mono", "Cascadia Mono", Consolas, monospace'
} as const;

export const QC_GEOMETRY = {
  screen: { width: 800, height: 480, aspectRatio: 800 / 480 },
  chassis: { widthCm: 29, heightCm: 19.5, aspectRatio: 29 / 19.5 },
  grid: { rows: 4, columns: 6, routePillWidth: 44, routePillHeight: 78, blockSize: 64 },
  footswitches: { performance: 8, navigation: 2, tempo: 1 }
} as const;

export const QC_VISUAL_ASSETS = {
  blockSprite: {
    url: "/qc-block-samples.svg",
    sha256: "24198023488bada41bffd5fbfe8c59b5f144fc1e3c762c57037ff07890bbccea",
    source: "Verified Neural DSP block sample sheet"
  },
  chassisOverlay: {
    url: "/qc-overview-001.svg",
    sha256: "aa87572c76759925a2ff05676c8b47061b542bd8c5869a97d89f1da0af3519be",
    sourceWidth: 1202,
    sourceHeight: 2292,
    crop: { x: 0, y: 14, width: 1096.94, height: 719.079 },
    source: "Neural DSP Quad Cortex overview illustration"
  },
  appIcon: {
    url: "/app-icon.svg",
    sha256: "70033787ff1c83f1e8b80943c0c03fe5f655f34cdfe04cfe934dde49f92c4d82"
  }
} as const;

export const QC_GLYPH_FAMILIES = {
  hardware: ["power", "undo", "redo", "save", "menu", "mode", "scenePrevious", "sceneNext", "bypass", "confirm"] as const,
  routing: ["input", "output", "internal", "usb", "return", "multiOut", "send", "xlr", "row"] as const,
  directory: ["grid", "download", "cloud", "folder", "newFolder", "sort", "upload", "search", "done"] as const,
  editing: ["save", "change", "copy", "paste", "reset", "defaults", "expression", "looper", "mute", "remove"] as const,
  communication: ["microphone", "attachment", "send", "expand"] as const
} as const;

export type QcCategoryColor = keyof typeof QC_COLORS.category;

export const QC_THEME = {
  colors: QC_COLORS,
  typography: QC_TYPOGRAPHY,
  geometry: QC_GEOMETRY,
  assets: QC_VISUAL_ASSETS,
  glyphs: QC_GLYPH_FAMILIES
} as const;
