export interface HardwareControl {
  id: string;
  label: string;
  role: string;
  group: "scene" | "navigation" | "tempo";
}

export interface FormFactorManifest {
  id: string;
  displayName: string;
  chassisAspectRatio: number;
  controls: HardwareControl[];
  defaultSkinId: string;
}

export interface SkinManifest {
  id: string;
  displayName: string;
  className: string;
  svgAsset?: {
    url: string;
    sourceWidth: number;
    sourceHeight: number;
    crop: { x: number; y: number; width: number; height: number };
    sourceLabel: string;
  };
}

const sceneControls = "ABCDEFGH".split("").map((label) => ({
  id: `footswitch-${label.toLowerCase()}`,
  label,
  role: `footswitch:${label}`,
  group: "scene" as const
}));

export const largeQuadCortex: FormFactorManifest = {
  id: "quad-cortex-large",
  displayName: "Quad Cortex — Large",
  chassisAspectRatio: 29 / 19.5,
  defaultSkinId: "official-svg",
  controls: [
    ...sceneControls,
    { id: "bank-down", label: "BANK ▼", role: "bank:down", group: "navigation" },
    { id: "bank-up", label: "BANK ▲", role: "bank:up", group: "navigation" },
    { id: "tempo", label: "TEMPO", role: "tempo", group: "tempo" }
  ]
};

export const formFactors = [largeQuadCortex];

export const skins: SkinManifest[] = [
  {
    id: "official-svg",
    displayName: "Official SVG Overlay",
    className: "skin-official-svg",
    svgAsset: {
      url: "/qc-overview-001.svg",
      sourceWidth: 1202,
      sourceHeight: 2292,
      crop: { x: 0, y: 14, width: 1096.94, height: 719.079 },
      sourceLabel: "Neural DSP Quad Cortex overview illustration"
    }
  },
  { id: "obsidian", displayName: "Graphite Hardware", className: "skin-obsidian" },
  { id: "high-contrast", displayName: "High Contrast", className: "skin-high-contrast" }
];
