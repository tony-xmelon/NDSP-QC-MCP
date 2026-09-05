import { useState, type CSSProperties, type ReactNode } from "react";
import type { GridBlock, PresetSnapshot } from "@ndsp-qc/client";
import { QC_VISUAL_ASSETS, REFERENCE_BLOCK_ICONS } from "@ndsp-qc/theme";
import { officialBlockVisual } from "./block-visuals";
import { openSplitPath } from "./coros-ui";
import { QcUiIcon } from "./theme-icons";
import "./fixture-live-surface.css";
import "./remaining-fixtures.css";
import "./remaining-fixtures-fixes.css";
import "./official-settings-midi.css";
import "./official-expression.css";
import "./official-empty-slot.css";
import "./official-plugin-folders.css";
import "./official-directory.css";
import "./official-device-browser.css";
import "./official-looper-eq.css";
import "./official-io.css";
import "./official-gig.css";
import "./official-modes.css";
import "./official-settings-device.css";
import "./official-tuner.css";

const officialBlockSprite = QC_VISUAL_ASSETS.blockSprite.url;
type OfficialGigMode = "preset" | "scene" | "stomp" | "hybrid";

function GigStompGlyph({ index }: { index: number }) {
  if (index === 6) return <svg viewBox="0 0 70 70" aria-hidden="true"><rect x="3" y="3" width="64" height="64" rx="14" fill="#050506" stroke="#4f765f" strokeWidth="2.4" /><g fill="none" stroke="#f2f2f2" strokeWidth="2" strokeLinejoin="round"><rect x="24" y="21" width="22" height="22" rx="2" /><rect x="17" y="28" width="22" height="22" rx="2" /><path d="M28 21v-5h22v22h-4" /></g></svg>;
  const tiles: Array<[[number, number], string]> = [
    [[320, 82], "#2df36a"], [[560, 0], "#6d3405"], [[400, 0], "#6d3405"], [[400, 0], "#6d3405"],
    [[320, 0], "#ff2727"], [[0, 82], "#8b8500"], [[400, 82], "#4f765f"], [[240, 82], "#050506"]
  ];
  const [tile, color] = tiles[index];
  return <svg viewBox={`${tile[0]} ${tile[1]} 70 70`} aria-hidden="true"><image href="/qc-block-samples.svg" x="0" y="0" width="710" height="152" /><rect x={tile[0] + 3} y={tile[1] + 3} width="64" height="64" rx="14" fill="none" stroke="#000" strokeWidth="5" /><rect x={tile[0] + 3} y={tile[1] + 3} width="64" height="64" rx="14" fill="none" stroke={color} strokeWidth="2.4" /></svg>;
}

function CorOsOfficialGig({ mode }: { mode: OfficialGigMode }) {
  const preset = [["1A", "Brit 2203"], ["1B", "Brit\nPlexi100\nNormal"], ["1C", "US TWN\nVibrato"], ["1D", "Rols Jazz\nCH120"], ["1E", "California\nTremo\nRed"], ["1F", "EV101III\nRed"], ["1G", "Freeman\n100\nRhythm"], ["1H", "D-Cell H4\nCh3"]];
  const scenes = ["British\n2203", "+MX OD\n+Doubler", "+Brit\nGovernor", "+Rodent\nDrive", "Dry\nDouble", "+MX &\nDlys", "Solo\nBoost", "Juicy Low\nGain"];
  const stomps = [["A", "Crying\nWah", "♧"], ["B", "MX\nClassicOD 4", "▥"], ["C", "Brit\nGovernor", "∿"], ["D", "Rodent\nDrive", "∿"], ["E", "Looper X", "♧"], ["F", "Transpose", "⌁"], ["G", "Multiple\ndevices (2)", "▣"], ["H", "Room", "◇"]];
  const sceneMode = mode === "scene";
  const stompMode = mode === "stomp";
  return <section className={`qc-screen gig-official is-${mode === "hybrid" ? "hybrid" : sceneMode ? "scene" : stompMode ? "stomp" : "preset"}`}><header><span>1A Brit 2203</span><button>{mode === "hybrid" ? "▦＋♞" : sceneMode ? <span className="gig-mode-matrix"><i>A</i><i>B</i><i>C</i><i>D</i></span> : stompMode ? "♞" : "▦"}</button><button><b>A</b></button><button>✓</button></header><i /><main className="gig-official-tiles">{mode === "preset" ? preset.map(([location, name]) => <article key={location}><small>{location}</small><strong>{name.split("\n").map((line, i) => <span key={i}>{line}<br /></span>)}</strong></article>) : sceneMode ? scenes.map((name, index) => <article key={name} data-letter={String.fromCharCode(65 + index)}><SceneTileTools /><strong>{name.split("\n").map((line, i) => <span key={i}>{line}<br /></span>)}</strong></article>) : mode === "hybrid" ? [...scenes.slice(0, 4).map((name, index) => ({ letter: String.fromCharCode(65 + index), name, scene: true })), ...stomps.slice(4).map(([letter, name]) => ({ letter, name, scene: false }))].map(({ letter, name, scene }, index) => <article key={letter} className={scene ? "hybrid-scene" : "hybrid-stomp"} data-letter={letter} style={{ background: ["#ff272d", "#0b2027", "#302f10", "#301021", "#ff272d", "#302f10", "#171b18", "#10ead5"][index] }}>{scene ? <SceneTileTools /> : <small>↙ {letter}</small>}{!scene && <b className="has-device-glyph"><GigStompGlyph index={index} /></b>}<strong>{name.split("\n").map((line, i) => <span key={i}>{line}<br /></span>)}</strong></article>) : stomps.map(([letter, name], index) => <article key={letter}><small>↙ {letter}</small><b className="has-device-glyph"><GigStompGlyph index={index} /></b><strong>{name.split("\n").map((line, i) => <span key={i}>{line}<br /></span>)}</strong></article>)}</main></section>;
}

export type { CorOsScreenView } from "./coros-screen-fixture-data";
import type { CorOsScreenView } from "./coros-screen-fixture-data";
function DeviceGlyph({ block, x, y, size = 64, selected = false }: { block: GridBlock; x: number; y: number; size?: number; selected?: boolean }) {
  const visual = officialBlockVisual(block);
  const [tileX, tileY] = visual.tile;
  if (visual.referenceAsset) return <image className="official-block-tile" x={x - size / 2} y={y - size / 2} width={size} height={size} href={REFERENCE_BLOCK_ICONS[visual.referenceAsset]} preserveAspectRatio="xMidYMid meet" aria-hidden="true" />;
  return <svg className="official-block-tile" x={x - size / 2} y={y - size / 2} width={size} height={size} viewBox={`${tileX} ${tileY} 70 70`} preserveAspectRatio="xMidYMid meet" overflow="hidden" aria-hidden="true">
    <image href={officialBlockSprite} x="0" y="0" width="710" height="152" />
    <rect x={tileX + 3} y={tileY + 3} width="64" height="64" rx="14" fill="none" stroke="#000" strokeWidth="5" />
    <rect x={tileX + 3} y={tileY + 3} width="64" height="64" rx="14" fill="none" stroke={visual.color} strokeWidth={selected ? 5.5 : 2.4} />
  </svg>;
}

function ModeGlyph({ mode }: { mode: PresetSnapshot["mode"] }) {
  if (mode === "PRESET") {
    return <g fill="#f0f0f0">
      {[0, 8, 16].map((y) => <g key={y} transform={`translate(0 ${y})`}>
        <rect x="0" y="1" width="6" height="6" rx=".8" /><rect x="9" y="1" width="6" height="6" rx=".8" /><rect x="18" y="1" width="6" height="6" rx=".8" />
        <rect x="5" y="3" width="5" height="2" /><rect x="14" y="3" width="5" height="2" />
      </g>)}
    </g>;
  }
  if (mode === "SCENE") {
    return <g fill="#f0f0f0" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="6.5" textAnchor="middle">
      <rect x="0" y="0" width="11" height="10" rx="1" /><rect x="13" y="0" width="11" height="10" rx="1" /><rect x="0" y="12" width="11" height="10" rx="1" /><rect x="13" y="12" width="11" height="10" rx="1" />
      <text x="5.5" y="7.2" fill="#111">A</text><text x="18.5" y="7.2" fill="#111">B</text><text x="5.5" y="19.2" fill="#111">C</text><text x="18.5" y="19.2" fill="#111">D</text>
    </g>;
  }
  if (mode === "HYBRID") {
    return <g><g transform="scale(.68)"><ModeGlyph mode="SCENE" /></g><g transform="translate(9 8) scale(.62)"><ModeGlyph mode="STOMP" /></g></g>;
  }
  return <g transform="translate(-525 -78)"><path d="M535.723 79.2008C532.977 81.2508 530.778 82.8924 529.127 84.1255L528.27 84.7656C527.385 85.4269 526.705 85.9358 526.228 86.2924C525.319 86.9726 524.915 87.9041 525.015 89.087L542.055 84.521C541.833 83.0083 542.929 81.2361 545.255 79.1766C544.988 78.8037 544.691 78.4115 544.363 78C542.639 80.0488 540.862 81.2219 539.031 81.5192C537.2 81.8165 536.097 81.0437 535.723 79.2008ZM543.102 84.2407L547.01 83.1933C547.096 82.4398 546.701 81.3799 545.825 80.0139C543.899 81.7499 543.016 83.1667 543.102 84.2407ZM547.559 85.3468L525.619 91.2257C525.399 90.7294 525.237 90.2624 525.135 89.8246L525.201 90.0724L547.243 84.1663L547.559 85.3468ZM529.966 92.3084L533.966 91.2257V94.675L536.966 94.675V98.675H526.966V94.675L529.966 94.675V92.3084Z" fill="#f0f0f0" /></g>;
}

function DirectoryIcon({ kind, number }: { kind: "grid" | "download" | "cloud" | "cloud-upload" | "folder" | "new-folder" | "sort" | "arrange" | "search" | "done" | "trash"; number?: number }) {
  if (kind === "grid") return <svg viewBox="0 0 24 24" aria-hidden="true">{[3, 10, 17].flatMap((x) => [3, 10, 17].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="5" height="5" rx=".6" />))}</svg>;
  if (kind === "download") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" /></svg>;
  if (kind === "cloud") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 19h11a4 4 0 0 0 .7-7.94A6.5 6.5 0 0 0 5.7 9.4 4.8 4.8 0 0 0 6.5 19Z" /></svg>;
  if (kind === "cloud-upload") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 20h11a4 4 0 0 0 .7-7.94A6.5 6.5 0 0 0 5.7 10.4 4.8 4.8 0 0 0 6.5 20Z" /><path className="cloud-upload-arrow" d="M12 16V7m0 0-3 3m3-3 3 3" fill="none" /></svg>;
  if (kind === "folder") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M0 0h10l2 3h12v21H0Z" />{number !== undefined && <text className="folder-number" x="12" y="16.5" textAnchor="middle" fontFamily="Arial, sans-serif" fontSize="7" fontWeight="700" fill="#202421">{number}</text>}</svg>;
  if (kind === "new-folder") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v11H3ZM7 2v8M3 6h8" /></svg>;
  if (kind === "sort") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h8m-8 6h6m-6 6h10M16 5l2 2 3-4m-5 10 2 2 3-4m-5 8 2 2 3-4" /></svg>;
  if (kind === "arrange") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h9M4 12h7M4 18h11M18 4v16m-3-3 3 3 3-3" /></svg>;
  if (kind === "search") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></svg>;
  if (kind === "trash") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12v14H6ZM4 7h16M9 4h6M9 11v6m6-6v6" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 13 5 5L20 6" /></svg>;
}

function CaptureLibraryIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 2v20M8 2v20M13 2l7 20M13 10h5M13 16h7" fill="none" /></svg>;
}

function CaptureHeaderIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h8M3 7h13M2 10h16M2 13h17M3 16h14M5 19h8" fill="none" /><path d="M12 2a10 10 0 1 1 0 20" fill="none" /></svg>;
}

type DirectoryFixtureView = "directory-presets" | "directory-categories" | "directory-captures" | "directory-irs" | "directory-plugins" | "directory-favorites" | "directory-search" | "directory-search-results" | "directory-sort" | "directory-filter" | "directory-arrange" | "directory-copy" | "directory-nested" | "directory-new-folder" | "directory-item-context" | "directory-cloud-upload";
type OfficialDirectoryView = "directory-presets" | "directory-captures" | "directory-irs" | "directory-plugins" | "directory-favorites" | "directory-search-results" | "directory-nested" | "directory-cloud-upload";

function CorOsOfficialDirectory({ view }: { view: OfficialDirectoryView }) {
  if (view === "directory-presets") {
    const rows = ["1A Brit 2203", "1B Brit Plexi100 Normal", "1C US TWN Vibrato", "1D Rols Jazz CH120", "1E California Tremo Red", "1F EV101III Red", "1G Freeman 100 Rhythm", "1H D-Cell H4 Ch3"];
    return <section className="qc-screen directory-official directory-presets-official"><header><button className="directory-official-category"><DirectoryIcon kind="grid" />Presets <b>▼</b></button><span /><button><DirectoryIcon kind="sort" /></button><button><DirectoryIcon kind="arrange" /></button><button><DirectoryIcon kind="search" /></button><button><DirectoryIcon kind="done" /></button></header><main><nav><button><b><DirectoryIcon kind="download" /></b><span>Downloads</span></button><button><b><DirectoryIcon kind="cloud" /></b><span>Cloud Presets</span></button><button className="is-active"><b><DirectoryIcon kind="folder" number={0} /></b><span>Factory Presets</span></button><button><b><DirectoryIcon kind="folder" number={1} /></b><span>My Presets</span><small>⋮</small></button><button className="is-muted"><b><DirectoryIcon kind="new-folder" /></b><span>New Setlist</span></button></nav><nav className="directory-preset-banks">{Array.from({ length: 14 }, (_, index) => <button key={index}>{index + 1}</button>)}</nav><section className="directory-official-list">{rows.map((name, index) => <button key={name} style={index === 0 ? { color: "#2df36a" } : undefined}><span>{name}</span><b>⋮</b></button>)}</section></main></section>;
  }
  if (view === "directory-cloud-upload") {
    const rows = ["1A My Main Rig", "1B Nano Cortex FX Loop", "1C 65' Deluxe Reverb", "1D Synth Arp", "1E Lofi Bass", "1F Jazz Solo", "1G Full Band Recording", "1H Parallax Chain"];
    return <section className="qc-screen directory-official directory-upload-official"><header><button className="directory-official-category"><DirectoryIcon kind="grid" />Presets <b>▼</b></button><button className="is-cloud"><DirectoryIcon kind="cloud-upload" /></button><span /><button><DirectoryIcon kind="arrange" /></button><button><DirectoryIcon kind="done" /></button></header><main><nav><button className="is-active"><b><DirectoryIcon kind="folder" number={1} /></b><span>My Presets</span><small>⋮</small></button></nav><nav className="directory-upload-banks">{Array.from({ length: 14 }, (_, index) => <button key={index}>{index + 1}</button>)}</nav><section className="directory-official-list">{rows.map(name => <button key={name}><span>{name}</span><b><DirectoryIcon kind="cloud-upload" /></b></button>)}</section></main></section>;
  }
  if (view === "directory-search-results") {
    const rows = ["Blasted Brit", "Bright Brit", "Brit 2203", "Brit Bass 50 Normal", "Brit Bass 50 Patch", "Brit Plexi 50 Patch"];
    return <section className="qc-screen directory-official directory-search-official"><header><button className="directory-search-field"><DirectoryIcon kind="search" /><span>Brit</span></button><button className="directory-search-tab is-active">▦ (15)</button><button className="directory-search-tab">◉ (50)</button><button className="directory-search-tab">≋ (0)</button><span /><button>↥</button><button>✓</button></header><main><section className="directory-official-list"><header>DEVICE DIRECTORIES <b>⌄</b></header>{rows.map(name => <button key={name}><span>{name}<small>Neural DSP</small></span><b>B　⋮</b></button>)}</section></main></section>;
  }
  if (view === "directory-nested") {
    const rows = ["4-Comp Custom 1", "4-Comp Custom 2", "4-Comp Custom 3", "4-Comp Custom 4", "4-Comp Custom 5", "4-Comp Custom 6", "4-Comp Custom 7"];
    return <section className="qc-screen directory-official directory-nested-official"><header><button className="directory-nested-back">←</button><button className="directory-official-category"><CaptureHeaderIcon /><span>Captures</span><b>▼</b></button><span /><button><DirectoryIcon kind="sort" /></button><button><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8Z" fill="none" /></svg></button><button><DirectoryIcon kind="arrange" /></button><button><DirectoryIcon kind="search" /></button><button><DirectoryIcon kind="done" /></button></header><main><nav><button className="directory-nested-root"><b><DirectoryIcon kind="folder" /></b><span><small>Captures Library</small>Factory Captures V2</span></button>{["Amp", "Combo Amp", "Compressor", "Fuzz", "Overdrive"].map(label => <button key={label} className="is-child"><b><DirectoryIcon kind="folder" /></b><span>{label}</span></button>)}</nav><section className="directory-official-list">{rows.map(name => <button key={name}><span>{name}<small>NeuralDSP</small></span><b>4　⋮</b></button>)}<aside className="directory-nested-index">{["#", "•", "A", "•", "I", "•", "R", "•", "Z"].map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</aside></section></main></section>;
  }
  const favorite = view === "directory-favorites";
  const captures = view === "directory-captures";
  const irs = view === "directory-irs";
  const category = favorite ? "Favorites and Recent" : captures ? "Neural Captures" : irs ? "Impulse Responses" : "Plugin Presets";
  const rows = favorite ? ["Deep Underground", "Elegance", "Helsinki Complex", "Miller Lite", "My Brit Sound", "Wild Buffalo", "You Have"] : captures ? ["4-Comp Custom 1", "4-Comp Custom 2", "4-Comp Custom 3", "4-Comp Custom 4", "4-Comp Custom 5", "4-Comp Custom 6", "4-Comp Custom 7"] : irs ? ["IR21", "IR20", "IR19", "IR18", "IR17", "IR16", "IR15"] : [];
  const nav = favorite ? [["▦", "Presets", "active"], ["◉", "Neural Captures", ""], ["≋", "Impulse Responses", ""]] : captures ? [["⇩", "Downloads", ""], ["☁", "Cloud Captures", ""], ["≋", "Captures Library", "active"], ["□", "Factory Captures V1", "child"], ["□", "Factory Captures V2", "child"], ["□", "My Captures", "child"], ["□", "New Folder", "child muted"]] : irs ? [["☁", "Cloud IRs", "active"], ["≋", "IRs Library", ""], ["□", "My IRs", "child"], ["□", "New Folder", "child muted"]] : [["□", "Archetype: Cory Wong X", ""], ["□", "Archetype: Gojira X", ""], ["□", "Archetype: Nolly X", ""], ["□", "Archetype: Plini X", ""], ["□", "Fortin Nameless Suite X", ""], ["□", "Parallax X", ""], ["□", "Soldano SLO-100 X", ""]];
  return <section className={`qc-screen directory-official${view === "directory-plugins" ? " is-plugins" : ""}${favorite ? " directory-favorites-official" : ""}${captures ? " directory-captures-official" : ""}${irs ? " directory-irs-official" : ""}`}><header><button className="directory-official-category">{view === "directory-plugins" ? <><DeviceCategoryGlyph label="Plugins" fallback="" /><span>{category}</span></> : captures ? <><CaptureHeaderIcon /><span>{category}</span></> : <>{favorite ? "♡" : "≋"}　{category}</>}<b>▼</b></button>{favorite ? <><button className="favorite-tab">♡</button><button className="favorite-tab">◷</button><button className="favorite-sort"><DirectoryIcon kind="sort" /></button><button><DirectoryIcon kind="arrange" /></button><button><DirectoryIcon kind="search" /></button><button><DirectoryIcon kind="done" /></button></> : view === "directory-plugins" ? <><button className="plugin-refresh"><GridToolbarIcon kind="refresh" /></button><span /><button><DirectoryIcon kind="search" /></button><button><DirectoryIcon kind="done" /></button></> : <>{irs ? <button>↻</button> : <button>☁</button>}<span /><button>☷</button><button>▽</button><button>↥</button><button>⌕</button><button>✓</button></>}</header><main><nav>{nav.map(([glyph, label, className]) => <button key={label} className={className?.split(" ").map(name => `is-${name}`).join(" ")}><b>{glyph === "□" ? <DirectoryIcon kind="folder" /> : captures && label === "Captures Library" ? <CaptureLibraryIcon /> : glyph}</b><span>{label}</span></button>)}</nav><section className="directory-official-list">{view === "directory-plugins" ? <svg className="plugin-directory-logo" viewBox="0 0 120 140" aria-hidden="true"><path d="M0 70H18L42 2 75 138 94 70H120" /></svg> : rows.map((name, index) => <button key={name}><span>{name}{!favorite && <small>{captures ? "NeuralDSP" : irs ? "✓ On device" : ""}</small>}</span>{favorite ? <i><b>♧</b><b>♥</b></i> : irs ? <i><b><span>✓</span></b><b><DirectoryIcon kind="trash" /></b></i> : <b>{captures ? "4　⋮" : "⋮"}</b>}</button>)}{favorite && <aside className="directory-favorite-index">{["#", "•", "A", "•", "I", "•", "R", "•", "Z"].map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</aside>}{captures && <aside className="directory-capture-index">{["#", "•", "A", "•", "I", "•", "R", "•", "Z"].map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</aside>}</section></main></section>;
}

function CorOsDirectoryFixture({ view }: { view: DirectoryFixtureView }) {
  const category = view === "directory-captures" ? "Neural Captures" : view === "directory-irs" ? "Impulse Responses" : view === "directory-plugins" ? "Plugin Presets" : "Presets";
  const icons: Record<string, string> = { Presets: "▦", "Neural Captures": "◉", "Impulse Responses": "≋", "Plugin Presets": "♜" };
  const categoryItems = [["Presets", "▦"], ["Neural Captures", "◉"], ["Impulse Responses", "≋"], ["Plugin Presets", "♜"]];
  const names = category === "Neural Captures" ? ["ALI Bass DI", "Brit Crunch 57", "Cali Recto Lead", "Chief OD Push", "Clean Twin 121", "German High Gain", "Vintage Fuzz"] : category === "Impulse Responses" ? ["1x12 Blue Alnico", "2x12 UK C30 65", "4x10 Bass Modern", "4x12 Green 25", "Room Ribbon 160", "Studio 121 Dark", "User IR 01"] : category === "Plugin Presets" ? ["Cory Wong - Clean", "Gojira - Rhythm", "Nolly - Lead", "Plini - Crystal", "Parallax - Modern", "SLO-100 - Crunch", "Nameless - Grind"] : ["pyquadcortex scratch", "Clean Platform", "Edge of Breakup", "Ambient Lead", "Modern Rhythm", "Bass Parallel", "Acoustic Live"];
  const search = view === "directory-search" || view === "directory-search-results";
  const results = view === "directory-search-results" ? names.filter((name) => /clean|crunch|scratch/i.test(name)) : names;
  return <section className="qc-screen coros-directory-fixture" aria-label={view.replaceAll("-", " ")}>
    <header><button className="directory-fixture-category"><span>{icons[category]}</span><strong>{category}</strong><b>⌄</b></button><button className={view === "directory-cloud-upload" ? "is-cloud" : ""}>☁</button><i /><button>☷</button><button>↕</button><button>⌕</button><em /><button>✓</button></header>
    <main>
      <nav className="directory-fixture-folders"><button>⇩ <span>Downloads</span></button><button>☁ <span>Cloud {category}</span></button><button>▰ <span>Factory {category}</span></button><button className="is-active">▰ <span>My {category}</span><b>⋮</b></button>{view === "directory-nested" ? <><button className="is-child">└ ▰ <span>ALI Live</span></button><button className="is-child is-active">　└ ▰ <span>Festival</span></button></> : <button className="is-child">└ ▰ <span>ALI Live</span></button>}<button className="is-new">▰＋ <span>New {category === "Presets" ? "Setlist" : "Folder"}</span></button></nav>
      <nav className="directory-fixture-banks">{[29, 30, 31, 32, 33, 34, 35].map((bank) => <button key={bank} className={bank === 32 ? "is-active" : ""}>{bank}</button>)}</nav>
      <section className="directory-fixture-items">{search && <div className="directory-search-field"><span>⌕</span><strong>{view === "directory-search-results" ? "Clean" : "Search Directory"}</strong><button>×</button></div>}{(search ? results : names).map((name, index) => <button key={name} className={index === 0 ? "is-current" : ""}><strong>{category === "Presets" ? `32${String.fromCharCode(65 + index)}` : icons[category]}</strong><span>{name}<small>{category === "Neural Captures" ? "GUITAR · AMP" : category === "Impulse Responses" ? "48 kHz · 1024 samples" : category === "Plugin Presets" ? "NEURAL DSP X" : "USER"}</small></span>{view === "directory-arrange" ? <i>☰</i> : <b>⋮</b>}</button>)}</section>
    </main>
    {view === "directory-categories" && <aside className="directory-category-menu">{categoryItems.map(([label, glyph]) => <button key={label}><span>{glyph}</span>{label}<b>›</b></button>)}</aside>}
    {view === "directory-favorites" && <aside className="directory-favorites-panel"><header><button className="is-active">FAVORITES</button><button>RECENT</button></header>{names.slice(0, 5).map((name) => <button key={name}><span>★</span>{name}<b>⋮</b></button>)}</aside>}
    {view === "directory-sort" && <aside className="directory-tool-menu"><strong>SORT BY</strong>{["Position", "Name A–Z", "Name Z–A", "Date created", "Recently used"].map((label, index) => <button key={label} className={index === 0 ? "is-active" : ""}>{label}<b>{index === 0 ? "✓" : ""}</b></button>)}</aside>}
    {view === "directory-filter" && <aside className="directory-tool-menu is-filter"><strong>FILTER</strong>{["All items", "Favorites", "Downloaded", "My items", "Factory"].map((label, index) => <button key={label} className={index === 0 ? "is-active" : ""}>{label}<b>{index === 0 ? "✓" : ""}</b></button>)}</aside>}
    {view === "directory-arrange" && <div className="directory-mode-bar"><strong>ARRANGE</strong><span>Drag items to reorder them</span><button>CANCEL</button><button>DONE</button></div>}
    {view === "directory-copy" && <aside className="directory-copy-dialog"><header>Copy 3 items to…</header>{["My Presets", "ALI Live", "Festival", "Studio"].map((label, index) => <button key={label} className={index === 2 ? "is-active" : ""}>▰　{label}<b>›</b></button>)}<footer><button>CANCEL</button><button>COPY HERE</button></footer></aside>}
    {view === "directory-new-folder" && <aside className="directory-name-dialog"><header>New Setlist</header><label>NAME<input readOnly value="New Setlist" /></label><footer><button>CANCEL</button><button>CREATE</button></footer></aside>}
    {view === "directory-item-context" && <aside className="directory-item-menu"><header><small>32A</small><strong>pyquadcortex scratch</strong></header>{["Favorite", "Edit details", "Copy", "Move", "Upload to Cortex Cloud", "Delete"].map((label, index) => <button key={label} className={index === 5 ? "is-danger" : ""}>{["★", "✎", "□", "↔", "☁", "⌫"][index]}　{label}</button>)}</aside>}
    {view === "directory-cloud-upload" && <div className="directory-mode-bar is-cloud"><strong>UPLOAD TO CORTEX CLOUD</strong><span>Select Presets, Neural Captures, or IRs</span><button>CANCEL</button><button>UPLOAD (2)</button></div>}
  </section>;
}

type RemainingFixtureView = "fixture-boot" | "fixture-shutdown" | "fixture-copy-scene" | "fixture-swap-scene" | "fixture-delete" | "fixture-input-gate" | "fixture-editor-pages" | "fixture-editor-cab" | "fixture-editor-eq" | "fixture-editor-capture" | "fixture-warning-clip" | "fixture-warning-dsp";

function CorOsRemainingFixture({ view }: { view: RemainingFixtureView }) {
  if (view === "fixture-boot") return <section className="qc-screen coros-boot"><b>◫</b><h1>QUAD CORTEX</h1><i><span /></i><small>STARTING COROS</small></section>;
  const dialog = view === "fixture-shutdown" ? ["POWER OFF?", "Any unsaved changes will be lost.", "POWER OFF"] : view === "fixture-delete" ? ["DELETE PRESET?", "This preset will be permanently removed.", "DELETE"] : view === "fixture-warning-clip" ? ["INPUT CLIPPING", "Reduce Input 1 gain to prevent unwanted distortion.", "OPEN I/O SETTINGS"] : view === "fixture-warning-dsp" ? ["DSP LIMIT REACHED", "There is not enough processing power to add this device.", "OK"] : undefined;
  if (dialog) return <section className="qc-screen coros-fixture-dialog"><div className="fixture-grid-ghost">{Array.from({length:7},(_,i)=><i key={i}/>)}</div><aside className={view.includes("warning") ? "is-warning" : ""}><b>{view.includes("warning") ? "!" : "?"}</b><h1>{dialog[0]}</h1><p>{dialog[1]}</p><footer><button>CANCEL</button><button>{dialog[2]}</button></footer></aside></section>;
  if (view === "fixture-copy-scene" || view === "fixture-swap-scene") return <section className="qc-screen coros-fixture-dialog is-scene-command"><div className="scene-command-grid"><header><strong><span>32</span>D</strong><span>Unsaved</span><b>A</b></header><span className="scene-command-mode"><svg viewBox="0 0 24 24" aria-hidden="true"><ModeGlyph mode="STOMP" /></svg><b>STOMP</b></span><main>{Array.from({ length: 8 }, (_, index) => <i key={index} />)}</main></div><aside><h1>{view === "fixture-copy-scene" ? "Copy Scene A" : "Swap Scene A"}</h1><p>Press Scene destination footswitch.</p><footer><button>CANCEL</button></footer></aside></section>;
  if (view === "fixture-input-gate") return <section className="qc-screen coros-input-gate"><header><button>‹</button><strong>Input 1</strong><button>✓</button></header><main><section><span>INPUT LEVEL</span><b>−12.0 dB</b><i><em /></i></section><section><span>INPUT GATE</span><label><i className="is-on"><b /></i> ENABLED</label><div><strong>THRESHOLD</strong><b>−54.0 dB</b></div><div><strong>RELEASE</strong><b>180 ms</b></div></section><section><span>GLOBAL BYPASS</span><label><i><b /></i> OFF</label><p>Bypass all input processing for this port.</p></section></main></section>;
  const editor = view === "fixture-editor-cab" ? ["2x12 UK C30 65 (M)","CABINET",["MIC 1 · 57","MIC 2 · 121","POSITION","DISTANCE","LEVEL","PAN"]] : view === "fixture-editor-eq" ? ["Parametric-8","EQUALIZER",["LOW CUT","BAND 1","BAND 2","BAND 3","HIGH CUT","LEVEL"]] : view === "fixture-editor-capture" ? ["ALI Bass DI","NEURAL CAPTURE",["GAIN","BASS","MIDDLE","TREBLE","LEVEL","MIX"]] : ["Ambience","REVERB · PAGE 2/2",["MOD RATE","MOD DEPTH","DUCKING","TRAILS","WIDTH","MIX"]];
  return <section className={`qc-screen coros-detail-editor ${view}`}><header><button>⋮</button><span><small>{editor[1] as string}</small><strong>{editor[0] as string}</strong></span><i>●</i><button>✓</button></header>{view === "fixture-editor-cab" && <div className="cab-stage"><span>57</span><b>▰</b><span>121</span></div>}{view === "fixture-editor-eq" && <svg viewBox="0 0 800 150" preserveAspectRatio="none"><path d="M0 120 C100 120 110 35 205 55 S335 115 410 70 S565 20 640 75 S735 105 800 60" /></svg>}<main>{(editor[2] as string[]).map((label,index)=><section key={label}><span>{label}</span><i><b style={{transform:`rotate(${index*23-35}deg)`}} /></i><strong>{index%2 ? "0.0 dB" : index===0 ? "80 Hz" : "5.0"}</strong></section>)}</main><footer><button>1</button><button className="is-active">2</button><span /><button>BYPASS</button></footer></section>;
}

type SystemFixtureView = "recovery-entry" | "recovery-options" | "overlay-keyboard" | "overlay-confirmation" | "overlay-error" | "overlay-busy";

function CorOsSystemFixture({ view }: { view: SystemFixtureView }) {
  const keys = [["Q","W","E","R","T","Y","U","I","O","P"],["A","S","D","F","G","H","J","K","L"],["⇧","Z","X","C","V","B","N","M","⌫"],["123","SPACE",".","DONE"]];
  if (view === "recovery-entry") return <section className="qc-screen coros-recovery"><div className="recovery-logo">◫</div><h1>Recovery Mode</h1><p>Keep footswitches A and H pressed while powering on Quad Cortex.</p><div className="recovery-switches"><b>A</b><span>HOLD</span><b>H</b></div><small>Release the switches when the recovery menu appears.</small></section>;
  if (view === "recovery-options") return <section className="qc-screen coros-recovery"><div className="recovery-logo">◫</div><h1>Recovery Mode</h1><p>Select an option to continue.</p><div className="recovery-options">{[["RESTART QUAD CORTEX","Boot CorOS normally"],["REINSTALL COROS","Install the latest available system image"],["FACTORY RESET","Erase user data and restore defaults"],["SHUT DOWN","Power off safely"]].map(([title,detail], index) => <button key={title} className={index === 0 ? "is-active" : index === 2 ? "is-danger" : ""}><strong>{title}</strong><small>{detail}</small><b>›</b></button>)}</div></section>;
  return <section className="qc-screen coros-system-overlay"><div className="overlay-underlay"><header><span>32H pyquadcortex scratch</span><b>A</b></header><main>{[1,2,3,4,5].map(item => <i key={item} />)}</main></div>
    {view === "overlay-keyboard" && <div className="system-keyboard"><header><button>×</button><strong>Edit name</strong><button>✓</button></header><div className="system-keyboard-value">UK C30 Crunch</div><section>{keys.map((row,index) => <div key={index}>{row.map(key => <button key={key} className={key === "SPACE" ? "is-space" : ""}>{key}</button>)}</div>)}</section></div>}
    {view === "overlay-confirmation" && <aside className="system-dialog"><b className="dialog-icon">?</b><h1>Delete preset?</h1><p>“pyquadcortex scratch” will be permanently removed from this device.</p><footer><button>CANCEL</button><button className="is-danger">DELETE</button></footer></aside>}
    {view === "overlay-error" && <aside className="system-dialog"><b className="dialog-icon is-error">!</b><h1>Action unavailable</h1><p>Quad Cortex could not complete the request. Check the connection and try again.</p><footer><button>OK</button></footer></aside>}
    {view === "overlay-busy" && <aside className="system-dialog is-busy"><b className="dialog-spinner" /><h1>Saving preset</h1><p>Please wait. Do not disconnect or power off Quad Cortex.</p></aside>}
  </section>;
}

type CaptureFixtureView = "capture-intro" | "capture-type" | "capture-routing" | "capture-calibration" | "capture-progress" | "capture-result" | "capture-save";

function CaptureTargetIcon() {
  return <span className="capture-target-icon"><i>⊙</i></span>;
}

function CaptureKindGlyph({ index }: { index: number }) {
  if (index === 0) return <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="19" /><path d="M11 16h26M8 20h32M6 24h36M8 28h32M11 32h26" /></svg>;
  if (index === 1) return <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="15" width="36" height="19" rx="1" /><path d="M10 19h28" /></svg>;
  if (index === 2) return <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="13" width="34" height="23" rx="1" /><path d="M10 17h28M31 22h6" /></svg>;
  if (index === 3) return <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="10" width="34" height="30" rx="1" /><path d="M12 6h24v7" /><circle cx="24" cy="25" r="9" /></svg>;
  if (index === 4) return <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="13" /><circle cx="9" cy="9" r="2" /><circle cx="39" cy="9" r="2" /><circle cx="9" cy="39" r="2" /><circle cx="39" cy="39" r="2" /><circle cx="24" cy="24" r="3" /></svg>;
  return <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="12" y="8" width="24" height="33" rx="3" /><circle cx="18" cy="15" r="2" /><circle cx="30" cy="15" r="2" /><circle cx="24" cy="27" r="5" /></svg>;
}

function CorOsOfficialCapture({ view }: { view: "capture-calibration" | "capture-progress" | "capture-result" | "capture-save" }) {
  if (view === "capture-progress") return <section className="qc-screen capture-official capture-official-progress"><header><span>Neural Capture</span><button>×</button></header><main><nav>{[["✓", "Calibration"], ["✓", "Recording Signals"], ["✓", "Sanity Check"], ["➜", "Training"]].map(([icon, label]) => <div key={label}><b>{icon}</b>{label}</div>)}</nav><section><h1>Neural Capture in progress</h1><p>The core of Neural Capture. Training a neural network to<br />emulate the sound of your favorite device.</p><strong>30%</strong><i className="capture-official-progress-bar"><b /></i><em>◔</em></section></main></section>;
  if (view === "capture-save") return <section className="qc-screen capture-official capture-official-save"><header><button><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button><button className="capture-folder"><DirectoryIcon kind="folder" /><span>My Captures</span></button><button>Name</button><button className="capture-note"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7Z" /><path d="M14 3v5h5M10 12h5m-5 3h5m-5 3h5" /></svg></button><button className="capture-save-now"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h12l3 3v15H4V3Z" /><path d="M8 3v6h8V3M8 21v-7h8v7" /></svg></button></header><main><small>TYPE OF CAPTURE</small><h1>Amp</h1><div className="capture-kinds">{Array.from({ length: 6 }, (_, index) => <button key={index} className={index === 1 ? "is-active" : ""}><CaptureKindGlyph index={index} />{index > 0 && <i />}</button>)}</div><small>PREFERRED INSTRUMENT</small><div className="capture-instruments">{["Guitar", "Bass", "Synth", "Vocal", "Other"].map((label, index) => <button key={label} className={index === 0 ? "is-active" : ""}>{label}</button>)}</div></main></section>;
  if (view === "capture-result") return <section className="qc-screen capture-official capture-official-result"><header><span>Neural Capture</span><button>×</button></header><p>Your Neural Capture is ready. Switch between the reference and Quad Cortex using<br />the buttons below.</p><div className="capture-result-actions"><button>BACK TO CALIBRATION</button><button>SAVE</button><CaptureTargetIcon /></div><main><section><button>CORTEX</button><label><span>♧ LEVEL</span><b className="capture-level-dial" /><small>0.0 dB</small></label></section><section><button>REFERENCE</button></section></main></section>;
  return <section className="qc-screen capture-official capture-official-settings"><header><span>Neural Capture</span><button>×</button></header><ul><li>Please verify your Quad Cortex is properly connected to the target device.</li><li>Reduce levels if any of the meters detect clipping.</li><li>The IN 2 GROUND LIFT can mitigate noise caused by ground loops between Quad<br />Cortex and the target device.</li></ul><div className="capture-setting-actions"><button>CONNECTION DIAGRAM</button><button>START CAPTURE</button><CaptureTargetIcon /><nav><button className="is-active">1</button><button>2</button></nav></div><main><section><span>IN 1 LEVEL</span><em className="capture-info">i</em><small>INST</small><b>0.0 dB</b><i className="capture-level-dial" /></section><section><span>IN 2 LEVEL</span><em className="capture-info">i</em><small>DEVICE</small><b>0.0 dB</b><i className="capture-level-dial" /></section><section className="capture-input-type"><span>IN 1 TYPE</span><label><i /><small>Mic</small><b>Instrument</b></label></section><section className="capture-input-type"><span>IN 2 TYPE</span><label><i /><small>Mic</small><b>Instrument</b></label></section><section><span>IN 1 LEVEL</span><b>-40.0 <small>dB</small></b><i className="capture-meter" /></section><section><span>IN 2 LEVEL</span><b>-40.0 <small>dB</small></b><i className="capture-meter" /></section><section><span>♧ LEVEL</span><i className="capture-level-dial" /><b>0.0 <small>dB</small></b></section></main></section>;
}

function CorOsCaptureFixture({ view }: { view: CaptureFixtureView }) {
  if (view === "capture-calibration" || view === "capture-progress" || view === "capture-result" || view === "capture-save") return <CorOsOfficialCapture view={view} />;
  const steps: Array<[string, CaptureFixtureView]> = [["TYPE", "capture-type"], ["CONNECTIONS", "capture-routing"], ["CALIBRATE", "capture-calibration"], ["CAPTURE", "capture-progress"], ["RESULT", "capture-result"], ["SAVE", "capture-save"]];
  const current = Math.max(0, steps.findIndex(([, step]) => step === view));
  return <section className="qc-screen coros-capture-fixture" aria-label={view.replaceAll("-", " ")}>
    <header><button>‹</button><strong>New Neural Capture</strong><button>×</button></header>
    {view === "capture-intro" ? <main className="capture-intro">
      <div className="capture-orbit"><i>◉</i><span /><span /><span /></div><h1>Neural Capture</h1><p>Create a digital replica of your amplifier, cabinet, or drive pedal.</p><aside><b>1</b><span>Connect your gear</span><b>2</b><span>Set levels and calibrate</span><b>3</b><span>Capture, compare, and save</span></aside><button>GET STARTED</button>
    </main> : <><nav className="capture-steps">{steps.map(([label, step], index) => <span key={step} className={index === current ? "is-active" : index < current ? "is-done" : ""}><b>{index < current ? "✓" : index + 1}</b>{label}</span>)}</nav><main className={`capture-workspace ${view}`}>
      {view === "capture-type" && <><h1>What would you like to capture?</h1><p>Select the device type for the most accurate result.</p><div className="capture-type-grid">{[["▰", "AMP + CAB", "A complete amplifier and cabinet"], ["◉", "AMP", "Amplifier or preamp only"], ["◇", "DRIVE", "Overdrive, distortion, or fuzz"], ["≋", "OTHER", "Compressors and other devices"]].map(([icon, title, text], index) => <button key={title} className={index === 0 ? "is-active" : ""}><b>{icon}</b><strong>{title}</strong><small>{text}</small></button>)}</div></>}
      {view === "capture-routing" && <><h1>Connect your equipment</h1><p>Follow the signal path below, then confirm that all cables are connected.</p><div className="capture-routing-map"><span><b>QC SEND 1</b><i>OUT</i></span><em>→</em><span className="capture-gear"><b>AMPLIFIER</b><i>INPUT</i></span><em>→</em><span className="capture-gear"><b>CAB / LOAD</b><i>OUTPUT</i></span><em>→</em><span><b>QC RETURN 1</b><i>IN</i></span></div><div className="capture-check"><i>✓</i><span><strong>Connections complete</strong><small>Use a load box when capturing an amplifier without a cabinet.</small></span></div></>}
      <button className="capture-next">NEXT</button>
    </main></>}
  </section>;
}

type SettingsFixtureView = "settings-account" | "settings-system" | "settings-device" | "settings-support" | "settings-wifi" | "settings-update" | "settings-storage" | "settings-midi" | "settings-info" | "settings-diagnostics";

function SettingsAccountGlyph({ kind }: { kind: "cloud" | "user" | "backup" }) {
  if (kind === "user") return <svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="9" r="5" /><path d="M7 29v-7a9 9 0 0 1 18 0v7" /></svg>;
  if (kind === "backup") return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 25h16a6 6 0 0 0 1-11.9A9 9 0 0 0 8 11a7 7 0 0 0 0 14Z" /><path d="m11 16-3 3 3 3m10-6 3 3-3 3M8 19h5m11 0h-5" /></svg>;
  return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 25h16a6 6 0 0 0 1-11.9A9 9 0 0 0 8 11a7 7 0 0 0 0 14Z" /></svg>;
}

function SettingsPowerIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v9M7.2 5.7a8 8 0 1 0 9.6 0" /></svg>;
}

function SettingsDeviceIcon({ label }: { label: string }) {
  if (label === "Global Bypass") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" /><path d="M4 5 2.5 3.5M20 5l1.5-1.5M4 19l-1.5 1.5M20 19l1.5 1.5" /></svg>;
  if (label === "Scene Bypass Behavior") return <SettingsPowerIcon />;
  if (label === "Stomp Mode Bypass") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 15.5 14.5 11l5.5 2.4-10.5 4.5L4 15.5Zm3.5-2.2 1.3-4.8 7.4-3 1.3 5.4M5 19h9M7 19v2h5v-2" /><circle cx="18.5" cy="18.5" r="1.5" /></svg>;
  if (label === "Swap Tempo and Tuner") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h16m0 0-3.5-3.5M19 8l-3.5 3.5M21 16H5m0 0 3.5-3.5M5 16l3.5 3.5" /></svg>;
  if (label === "Gig View Access") return <svg viewBox="0 0 24 24" aria-hidden="true"><g className="settings-scene-cells"><rect x="2" y="3" width="8" height="8" /><rect x="14" y="3" width="8" height="8" /><rect x="2" y="13" width="8" height="8" /><rect x="14" y="13" width="8" height="8" /></g><path d="M10 7h4M10 17h4" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 4v8l6 3" /></svg>;
}

function SettingsDeviceModelIcon({ kind }: { kind: string }) {
  if (kind === "ir") return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 12v8M10 9v14M13 13v6M16 6v20M19 11v10M22 14v4M25 10v12" /></svg>;
  return <svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="10" /><circle cx="16" cy="16" r="4" /><circle cx="7" cy="7" r="1" /><circle cx="25" cy="7" r="1" /><circle cx="7" cy="25" r="1" /><circle cx="25" cy="25" r="1" /></svg>;
}

function CorOsOfficialSettings({ view }: { view: "settings-account" | "settings-system" | "settings-device" | "settings-midi" }) {
  const data = view === "settings-midi"
    ? { title: "Device", icon: "▣", active: 5, rows: [["◉", "Global Bypass"], ["◴", "Scene Bypass Behavior"], ["♞", "Stomp Mode Bypass"], ["⇄", "Swap Tempo and Tuner"], ["◷", "Latency Compensation"], ["◉", "MIDI"]] }
    : view === "settings-account"
    ? { title: "Account", icon: "♧", active: 1, rows: [["♙", "My Account"], ["♻", "Backups"]] }
    : view === "settings-system"
      ? { title: "System", icon: "⚙", active: 2, rows: [["⌁", "Connection"], ["◔", "Updates"], ["☀", "Brightness"], ["ϟ", "Power Functions"], ["◔", "Master Volume Knob"], ["◕", "Device Storage"], ["▥", "Factory Reset"]] }
      : { title: "Device", icon: "▣", active: 0, rows: [["◉", "Global Bypass"], ["◴", "Scene Bypass Behavior"], ["♞", "Stomp Mode Bypass"], ["◴", "Hold Timing"], ["⇄", "Swap Tempo and Tuner"], ["▦", "Gig View Access"], ["◷", "Latency Compensation"]] };
  return <section className={`qc-screen coros-settings-official ${view}`} aria-label={`${data.title} Settings`}>
    <header><button className="settings-section"><b>{view === "settings-account" ? <SettingsAccountGlyph kind="cloud" /> : view === "settings-device" ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2" /><rect x="7" y="5" width="10" height="5" /><path d="M8 14h1m3 0h1m3 0h1M8 18h1m3 0h1m3 0h1" /></svg> : data.icon}</b>{data.title}<i /></button><button className="settings-done">{view === "settings-device" ? <QcUiIcon kind="check" /> : "✓"}</button></header>
    <main><nav>{data.rows.map(([icon, label], index) => <button key={label} className={index === data.active ? "is-active" : ""}><b>{view === "settings-account" ? <SettingsAccountGlyph kind={index === 0 ? "user" : "backup"} /> : view === "settings-device" ? <SettingsDeviceIcon label={label} /> : icon}</b>{label}</button>)}</nav>
      {view === "settings-account" ? <section className="settings-account-detail"><header><strong>Cloud Backups　<span>3/5</span></strong><small>All timestamps are UTC</small></header>{[["My Rig 001", "☁ August 29th, 2025, 17:06", "↧ August 29th, 2025, 17:11"], ["My Backup", "☁ November 15th, 2024, 19:22", ""], ["Tour 2025", "☁ August 16th, 2023, 15:38", ""]].map(([name, first, second]) => <div key={name}><strong>{name}</strong><small>{first}</small><small>{second}</small><b>⋮</b></div>)}<button>NEW CLOUD BACKUP</button></section>
        : view === "settings-system" ? <section className="settings-system-detail"><h1>Brightness</h1><p>Turn the ▲, ▼, and TEMPO footswitches to adjust the<br />brightness. Tap the Modes at the bottom to toggle dimmed<br />LED lights for each one individually.</p>{[["Screen", "16", 16], ["LEDs", "16", 16], ["Dimmed LEDs", "2", 2]].map(([label, value, bars]) => <div key={String(label)}><span>{label}</span><strong>{value}</strong><i>{Array.from({ length: 32 }, (_, index) => <b key={index} className={index < Number(bars) ? "is-on" : ""} />)}</i></div>)}<footer>▦　▣　♞</footer></section>
          : view === "settings-midi" ? <section className="settings-midi-detail"><h1>MIDI Settings</h1>{[["MIDI Channel", "select", "1"], ["MIDI Thru", "toggle", "Off"], ["MIDI Over USB", "toggle", "On"], ["Ignore Duplicate PC", "toggle", "Off"], ["MIDI Clock Out", "select", "OFF"], ["MIDI Clock In", "toggle", "Off"]].map(([label, kind, value]) => <div key={label}><b>i</b><span>{label}</span>{kind === "select" ? <button>{value}<i>▼</i></button> : <label><small>On</small><small>Off</small><i className={value === "On" ? "is-on" : ""} /></label>}</div>)}</section>
          : <section className="settings-device-detail"><h1>Global Bypass</h1><p>Globally bypass Cabs, IR Loaders, or Neural Captures of<br />cabs* on any row. Globally bypassed devices will have a<br />bypass icon <span className="inline-settings-power"><SettingsPowerIcon /></span> but will not appear bypassed on The Grid.</p><small>*Neural Captures need to have the Capture Type set to "Cab" to be<br />bypassed.</small>{["cab", "ir"].map((key) => <div key={key}><b><SettingsDeviceModelIcon kind={key} /></b>{[1,2,3,4].map(row => <label key={row}><span>ROW {row}</span><i><SettingsPowerIcon /></i></label>)}</div>)}</section>}
    </main>
  </section>;
}

function CorOsSettingsFixture({ view }: { view: SettingsFixtureView }) {
  if (view === "settings-account" || view === "settings-system" || view === "settings-device" || view === "settings-midi") return <CorOsOfficialSettings view={view} />;
  const section = ["settings-support", "settings-info", "settings-diagnostics"].includes(view) ? "SUPPORT" : "SYSTEM";
  const titles: Record<SettingsFixtureView, string> = { "settings-account": "Account Settings", "settings-system": "System Settings", "settings-device": "Device Settings", "settings-support": "Support Settings", "settings-wifi": "Connection", "settings-update": "Device Updates", "settings-storage": "Device Storage", "settings-midi": "MIDI Settings", "settings-info": "Device Information", "settings-diagnostics": "Diagnostics" };
  const standardRows: Record<string, Array<[string, string]>> = {
    "settings-account": [["MY ACCOUNT", "anton"], ["BACKUPS", "Cloud backups"], ["CORTEX CLOUD", "Connected"]],
    "settings-system": [["CONNECTION", "Wi-Fi"], ["UPDATES", "CorOS 4.1.0"], ["BRIGHTNESS", "80%"], ["POWER FUNCTIONS", "Normal"], ["MASTER VOLUME KNOB", "Global"], ["DEVICE STORAGE", "62% used"], ["FACTORY RESET", ""]],
    "settings-device": [["GLOBAL BYPASS", "Off"], ["SCENE BYPASS BEHAVIOR", "Always overwrite"], ["STOMP MODE BYPASS", "Auto assign"], ["HOLD TIMING", "750 ms"], ["SWAP TEMPO AND TUNER", "Off"], ["GIG VIEW ACCESS", "On"], ["LATENCY COMPENSATION", "Dynamic"], ["MIDI", "Channel 1"]],
    "settings-support": [["ABOUT AND CONTACT", "Neural DSP"], ["DEVICE INFORMATION", "Quad Cortex"], ["SEND REPORT", ""], ["DIAGNOSTICS", "DSP, footswitches, USB"], ["3RD PARTY LICENSES", ""]]
  };
  return <section className="qc-screen coros-settings-fixture" aria-label={titles[view]}><header><button>‹</button><strong>{titles[view]}</strong><button>✓</button></header><main><nav>{[["ACCOUNT", "♙"], ["SYSTEM", "⚙"], ["DEVICE", "▣"], ["SUPPORT", "?" ]].map(([label, icon]) => <button key={label} className={label === section ? "is-active" : ""}><b>{icon}</b><span>{label}</span></button>)}</nav><section className="settings-content">
    {standardRows[view]?.map(([label, value], index) => <button key={label} className={label === "FACTORY RESET" ? "is-danger" : ""}><span><strong>{label}</strong>{value && <small>{value}</small>}</span>{["Connected", "Off", "On"].includes(value) ? <i className={value === "Off" ? "" : "is-on"}><b /></i> : <em>›</em>}</button>)}
    {view === "settings-wifi" && <><div className="settings-status"><span>WI-FI</span><i className="is-on"><b /></i></div>{[["Studio 5G", "Connected"], ["NeuralDSP", "Secured"], ["Guest", "Secured"], ["Add Network…", ""]].map(([name, state]) => <button key={name}><span><strong>⌁　{name}</strong><small>{state}</small></span><em>›</em></button>)}</>}
    {view === "settings-update" && <div className="settings-update"><span>CURRENT VERSION</span><strong>CorOS 4.1.0</strong><i><b /></i><small>Your Quad Cortex is up to date</small><button>CHECK FOR UPDATES</button></div>}
    {view === "settings-storage" && <><div className="storage-summary"><strong>DEVICE STORAGE</strong><span>6.2 GB of 10 GB used</span><i><b /></i></div>{[["Presets", "1.8 GB"], ["Neural Captures", "2.4 GB"], ["Impulse Responses", "1.2 GB"], ["Other", "0.8 GB"]].map(([name, value]) => <button key={name}><span><strong>{name}</strong><small>{value}</small></span><em>›</em></button>)}<button className="is-danger"><span><strong>FACTORY RESET</strong><small>Restore settings or remove user data</small></span><em>›</em></button></>}
    {view === "settings-info" && <div className="device-info-card"><b>◫</b><strong>Quad Cortex</strong>{[["DEVICE NAME", "Neural DSP Quad Cortex"], ["SERIAL NUMBER", "QC-21-0410"], ["COROS VERSION", "4.1.0"], ["HARDWARE REVISION", "1"]].map(([name, value]) => <span key={name}><small>{name}</small>{value}</span>)}</div>}
    {view === "settings-diagnostics" && <div className="diagnostics-grid">{[["DSP 1", "26%"], ["DSP 2", "18%"], ["FOOTSWITCHES", "11 / 11"], ["USB AUDIO", "16 channels"], ["TEMPERATURE", "42 °C"], ["UPTIME", "03:18:42"]].map(([name, value]) => <span key={name}><small>{name}</small><strong>{value}</strong><i><b /></i></span>)}</div>}
  </section></main></section>;
}

function SceneTileTools() {
  return <span className="gig-scene-tools" aria-hidden="true">
    <svg viewBox="0 0 24 24"><path d="M4 9v11h11M8 16 19 5l-3-3L5 13l-1 5 5-1Z" /></svg>
    <svg viewBox="0 0 24 24"><path d="M3 8h16m0 0-4-4m4 4-4 4M21 16H5m0 0 4-4m-4 4 4 4" /></svg>
    <svg viewBox="0 0 24 24"><rect x="3" y="7" width="14" height="14" rx="2" /><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" /></svg>
  </span>;
}

function CorOsGigView({ snapshot, onClose, liveTuner = false }: { snapshot: PresetSnapshot; onClose: () => void; liveTuner?: boolean }) {
  const gridBlocks = snapshot.blocks.filter((block) => block.column >= 0 && block.column < 8);
  const assignments = Array.from({ length: 8 }, (_, index) => snapshot.blocks
    .filter((block) => block.footswitch === index)
    .sort((left, right) => (left.footswitchOrder ?? 0) - (right.footswitchOrder ?? 0))[0]);
  const sceneColors = ["#ff2421", "#101c21", "#292410", "#291021", "#102818", "#291810", "#181829", "#102821"];
  const sceneLetterColors = ["#e72018", "#082029", "#393408", "#390c29", "#083818", "#391c08", "#181c39", "#083c29"];
  const letterColors = ["#4df379", "#079dff", "#ff7d00", "#ff00b7", "#5beaff", "#7358ff", "#ffd333", "#f4f4f4"];
  const presetTiles = Array.from({ length: 8 }, (_, index) => {
    const active = index === snapshot.presetPosition % 8;
    const bank = Math.floor(snapshot.presetPosition / 8) + 1;
    return <button key={index} className={`gig-preset-tile${active ? " is-active" : ""}`}><span>{bank}<b style={{ color: letterColors[index] }}>{String.fromCharCode(65 + index)}</b></span><strong>{active ? snapshot.presetName : "Unsaved"}</strong></button>;
  });
  const sceneTiles = Array.from({ length: 8 }, (_, index) => <button key={index} className={`gig-scene-tile${index === snapshot.activeScene ? " is-active" : ""}`} style={{ "--gig-color": sceneColors[index], "--gig-letter": sceneLetterColors[index] } as CSSProperties}><SceneTileTools /><b>{String.fromCharCode(65 + index)}</b><strong>{snapshot.scenes[index] ?? `Scene ${String.fromCharCode(65 + index)}`}</strong></button>);
  const stompTiles = assignments.map((assigned, index) => {
    const block = assigned ?? gridBlocks[index];
    const color = !block ? "#292c29" : block.bypassed ? "#101c21" : block.name === "Simple Gate" ? "#949694" : block.name === "Chief DS1" ? "#ff7100" : block.name === "UK C30 TopBoost" ? "#ff2421" : block.name === "212 UK C30 65 (M)" ? "#6b55ff" : block.name === "Parametric-8" ? "#0875e7" : block.name === "Ambience" ? "#00ffde" : officialBlockVisual(block).color;
    return <button key={index} className={!block ? "is-empty" : ""} style={{ "--gig-color": color } as CSSProperties} aria-label={`Footswitch ${String.fromCharCode(65 + index)}${block ? `, ${block.name}` : ", empty"}`}>
      {block && <span className="gig-device-icon"><DeviceGlyph block={block} x={43} y={43} size={70} /></span>}
      {block && <span className="gig-edit" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 9v11h11M8 16 19 5l-3-3L5 13l-1 5 5-1Z" /></svg></span>}<b>{String.fromCharCode(65 + index)}</b>{block && <strong className={block.name === "Parametric-8" ? "is-compact" : ""}>{block.name}</strong>}
    </button>;
  });
  const tiles = snapshot.mode === "PRESET" ? presetTiles : snapshot.mode === "SCENE" ? sceneTiles : snapshot.mode === "HYBRID" ? [...sceneTiles.slice(0, 4), ...stompTiles.slice(4)] : stompTiles;
  return <section className={`coros-gig-view${liveTuner ? " has-live-tuner" : ""}`} aria-label={liveTuner ? "Gig View with Live Tuner" : "Gig View"}>
    <header><strong>{snapshot.presetLocation} {snapshot.presetName}</strong><span className="gig-mode"><svg viewBox="0 0 24 24" aria-hidden="true"><ModeGlyph mode={snapshot.mode} /></svg></span><span className="gig-scene">{String.fromCharCode(65 + snapshot.activeScene)}</span><button aria-label="Close Gig View" onClick={onClose}>✓</button></header>
    {liveTuner && <div className="live-tuner-strip" aria-label="Live Tuner dormant" />}
    <div className={`gig-tiles is-${snapshot.mode.toLowerCase()}`}>{tiles}</div>
  </section>;
}

function CorOsTuner({ onClose, liveTuner = false }: { onClose: () => void; liveTuner?: boolean }) {
  const official = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tunerState") === "official";
  return <section className={`coros-tuner${official ? " tuner-official" : ""}`} aria-label={liveTuner ? "Tuner with Live Tuner enabled" : "Tuner"}>
    <header><span>Tuner</span><button aria-label="Close Tuner" onClick={onClose}>✓</button></header>
    <div className="tuner-scale"><span>-50</span>{official && <><em className="tuner-flat">D#/Eb</em><em className="tuner-note">E</em><em className="tuner-sharp">F</em><strong className="tuner-reading">-1.4</strong><small className="tuner-left-arrow">›</small><small className="tuner-right-arrow">‹</small></>}<i /><b /><span>+50</span></div>
    <footer>
      <section><span>FREQ [Hz]</span><div className="tuner-frequency"><i /><strong>{official ? "440.0" : "422.0"}</strong></div></section>
      <section><button>INPUT 1 <b>▼</b></button></section>
      <section><button className="tuner-muted">MUTED</button></section>
      <section><span>LIVE TUNER</span><label><i className={liveTuner || official ? "is-active" : ""} /> <b>Yes</b></label><label><i className={liveTuner || official ? "" : "is-active"} /> <b>No</b></label></section>
    </footer>
  </section>;
}

function CorOsTempo({ bpm, onClose }: { bpm: number; onClose: () => void }) {
  return <section className="coros-tempo" aria-label="Tempo and Metronome">
    <header><span>Tempo</span><div className="tempo-scene"><b>◀</b><strong>A</strong><b>▶</b></div><button aria-label="Close Tempo and Metronome" onClick={onClose}>✓</button></header>
    <div className="tempo-display"><strong>{Math.round(bpm)}</strong><small>BPM = QUARTERS</small><div>{[0, 1, 2, 3].map((beat) => <i key={beat} className={beat === 0 ? "is-active" : ""} />)}</div></div>
    <div className="tempo-controls">
      <section className="tempo-control is-tempo"><span>TEMPO</span><div className="tempo-dial"><i /></div><strong>{Math.round(bpm)} BPM</strong></section>
      <section className="tempo-control is-radio"><span>MODE <b className="tempo-info">i</b></span><label><i />Global</label><label><i className="is-active" />Preset</label></section>
      <section className="tempo-control is-radio"><span>TEMPO LED</span><label><i className="is-active" />On</label><label><i />Off</label></section>
      <section className="tempo-control is-volume"><span>VOLUME</span><div className="tempo-dial"><i /></div><strong>0.0 dB</strong></section>
      <section className="tempo-control is-mute"><button>UNMUTE</button></section>
      <section className="tempo-control is-pan"><span>PAN</span><div className="tempo-dial"><i /></div><strong>C</strong></section>
      {[["T/SIGNATURE", "4/4"], ["SUBDIVISIONS", "1/4"], ["SOUND", "BLIP"], ["ROUTING", "MULTI"]].map(([label, value]) => <section className="tempo-control is-select" key={label}><span>{label}</span><button>{value}<b>⌄</b></button></section>)}
    </div>
  </section>;
}

function CorOsMidiOut({ onClose }: { onClose: () => void }) {
  return <section className="coros-midi-out" aria-label="Preset MIDI Out">
    <header><span>Preset MIDI Out settings</span><button className="midi-trash" aria-label="Clear MIDI assignments"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10l-1 13H8L7 7Zm-2 0h14M9 4h6l1 3H8l1-3Zm2 6v7m3-7v7" /></svg></button><button aria-label="Close Preset MIDI Out" onClick={onClose}>✓</button></header>
    <div className="midi-assignment-surface">
      <section className="midi-footswitches"><button className="midi-preset-load">ON PRESET LOAD<br />MESSAGE</button>{["A", "B", "C", "D", "E", "F", "G", "H"].map((label) => <button className="midi-switch" key={label}><i />{label}</button>)}</section>
      <section className="midi-expression"><label><span>EXP 1</span><div><i /></div></label><label><span>EXP 2</span><div><i /></div></label></section>
    </div>
  </section>;
}

function CorOsCpuMonitor({ snapshot, onClose }: { snapshot: PresetSnapshot; onClose: () => void }) {
  const loads = [3, 7, 5, 11, 4, 8, 6, 2];
  return <section className="coros-cpu-monitor" aria-label="CPU Monitor">
    <header><span>CPU Monitor</span><strong>CPU 26%</strong><button aria-label="Close CPU Monitor" onClick={onClose}>✓</button></header>
    <div className="cpu-summary"><span>PROCESSING LOAD</span><div><i style={{ width: "26%" }} /></div><strong>26%</strong></div>
    <div className="cpu-grid">{Array.from({ length: 32 }, (_, index) => {
      const row = Math.floor(index / 8), column = index % 8;
      const block = snapshot.blocks.find((candidate) => candidate.row === row && candidate.column === column);
      const load = block ? loads[index % loads.length] : 0;
      return <div key={index} className={block ? "has-block" : ""}>{block && <><span className="cpu-block-icon"><DeviceGlyph block={block} x={30} y={30} size={56} /></span><strong>{load}%</strong><small>{block.name}</small></>}</div>;
    })}</div>
    <footer><span><i className="cpu-legend-active" /> ACTIVE</span><span><i className="cpu-legend-bypassed" /> BYPASSED</span><span>GLOBAL EQ <b>ON</b></span><span>INPUT GATES <b>ON</b></span></footer>
  </section>;
}

type IoView = "overview" | "input" | "output" | "send-return" | "usb" | "headphones";
const IO_PORTS: Array<{ id: IoView; label: string; sub: string; kind?: "square" | "midi" | "input" | "combo"; paired?: boolean }> = [
  { id: "usb", label: "", sub: "USB", kind: "square" }, { id: "send-return", label: "EXP 2", sub: "EXP 1", paired: true },
  { id: "send-return", label: "MIDI OUT", sub: "", kind: "midi" }, { id: "send-return", label: "MIDI IN", sub: "", kind: "midi" },
  { id: "output", label: "", sub: "OUT 2/R", kind: "combo", paired: true }, { id: "output", label: "", sub: "OUT 1/L", kind: "combo", paired: true },
  { id: "headphones", label: "♧", sub: "CAPTURE OUT", paired: true }, { id: "output", label: "OUT 4/R", sub: "OUT 3/L", paired: true },
  { id: "send-return", label: "RET 2", sub: "RET 1", paired: true }, { id: "send-return", label: "SEND 2", sub: "SEND 1", paired: true },
  { id: "input", label: "INPUT 2", sub: "", kind: "input" }, { id: "input", label: "INPUT 1", sub: "", kind: "input" }
];

function IoDial({ value }: { value: string }) {
  return <span className="io-dial-wrap"><i className="io-dial"><b /></i><strong>{value}</strong></span>;
}

function IoPortGlyph({ kind = "jack", primary = false }: { kind?: "square" | "midi" | "input" | "combo" | "jack"; primary?: boolean }) {
  if (kind === "square") return <svg viewBox="0 0 48 48" aria-hidden="true"><rect className="usb-port-core" x="12" y="16" width="24" height="14" rx="1" /></svg>;
  if (kind === "midi") return <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="18" /><path d="M10 13a20 20 0 0 0 28 0" />{[[16,20],[24,17],[32,20],[18,29],[30,29]].map(([x,y]) => <circle key={`${x}-${y}`} className="port-hole" cx={x} cy={y} r="2.3" />)}</svg>;
  if (kind === "input" || kind === "combo") return <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="17" />{primary && <circle className="port-core" cx="24" cy="24" r="13" />}{[[17,18],[31,18],[24,29]].map(([x,y]) => <circle key={`${x}-${y}`} className="port-hole" cx={x} cy={y} r="3" />)}<path d="M13 35l4-4m18 4-4-4" /></svg>;
  return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M13 7h22l7 10v15L34 42H14L6 32V17Z" /><circle cx="24" cy="24" r="12" /><circle className="port-hole" cx="24" cy="24" r="4" /></svg>;
}

function IoHeadphonesGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13v-2a8 8 0 0 1 16 0v2M4 12H2v7h4v-7H4Zm16 0h2v7h-4v-7h2Z" /></svg>;
}

function CorOsIoSettings({ initialView, onClose }: { initialView: IoView; onClose: () => void }) {
  const [view, setView] = useState<IoView>(initialView === "overview" ? "input" : initialView);
  const [globalEqOpen, setGlobalEqOpen] = useState(false);
  if (globalEqOpen) return <CorOsGlobalEq onClose={() => setGlobalEqOpen(false)} />;
  const title = view === "input" ? "Input 1" : view === "output" ? "Output 1/L" : view === "send-return" ? "Return 1" : view === "usb" ? "USB" : "Headphones";
  const meters = view === "usb" ? ["IN 1/2", "IN 3/4", "IN 5/6", "IN 7/8", "OUT 1/2", "OUT 3/4", "OUT 5/6", "OUT 7/8"] : [];
  return <section className={`coros-io-settings is-${view}`} aria-label={`I/O Settings ${title}`}>
    <header><span>I/O Settings <strong>{title}</strong></span><button className="io-global-eq" onClick={() => setGlobalEqOpen(true)}>GLOBAL EQ</button><button aria-label="Close I/O Settings" onClick={onClose}>✓</button></header>
    <div className="io-ports">{IO_PORTS.map((port, index) => <button key={`${port.label}-${index}`} className={`${port.id === view && (view !== "input" || index === IO_PORTS.length - 1) ? "is-active" : ""} is-${port.kind ?? "jack"}${port.paired ? " is-paired" : ""}`} onClick={() => setView(port.id)}><span className={port.id === "headphones" ? "io-headphone-label" : undefined}>{port.id === "headphones" ? <IoHeadphonesGlyph /> : port.label}</span><i><IoPortGlyph kind={port.kind ?? "jack"} primary={index === IO_PORTS.length - 1} /></i>{port.paired && <i><IoPortGlyph /></i>}<small>{port.sub}</small></button>)}{view === "usb" && <div className="io-input-selectors"><button>1</button><button>2</button></div>}</div>
    {view === "usb" ? <div className="io-editor is-usb"><section><span>USB LEVEL</span><IoDial value="0.0 dB" /></section><section><span>HP SOURCE</span><IoDial value="BOTH" /></section><div className="io-meter-grid">{meters.map((meter) => <span key={meter}><b>{meter}</b><i>i</i><small>-40.0 dB　　　-40.0</small><em /><em /></span>)}</div></div>
      : <div className="io-editor is-analog">
        <section><span>{view === "input" ? "IN 1 LEVEL" : view === "output" ? "OUT 1 LEVEL" : view === "send-return" ? "RETURN 1 LEVEL" : "HP LEVEL"}</span><IoDial value="0.0 dB" /></section>
        {view === "input" && <><section><span>IMPEDANCE</span><IoDial value="1M Ω" /></section><section className="io-switch"><span>TYPE</span><label><i />Mic</label><label><i className="is-active" />Instrument</label></section><section className="io-switch is-disabled"><span>PHANTOM 48V</span><label><i />On</label><label><i className="is-active" />Off</label></section></>}
        {view === "headphones" && <section><span>HP SOURCE</span><button className="io-select">MULTI OUT　⌄</button></section>}
        <section className="io-switch"><span>GROUND LIFT</span><label><i />On</label><label><i className="is-active" />Off</label></section>
        {view !== "input" && <section className="io-switch"><span>MUTE</span><label><i />On</label><label><i className="is-active" />Off</label></section>}
        <div className="io-level-meter"><span>{view === "input" ? "IN 1 LEVEL" : `${title.toUpperCase()} LEVEL`}</span><strong>-40.0 dB</strong><i /></div>
      </div>}
  </section>;
}

function CorOsGlobalEq({ onClose }: { onClose: () => void }) {
  const verticals = [46, 79, 105, 125, 143, 158, 172, 184, 263, 343, 369, 389, 407, 422, 436, 448, 527, 574, 607, 633, 653, 671, 686, 700, 712, 791].map((pixel) => pixel / 8);
  return <section className="coros-global-eq" aria-label="Global EQ">
    <header><button className="global-eq-more">⋮</button><span><small>GLOBAL EQ</small><strong>Parametric-5</strong></span><button className="global-eq-power"><i /> ON</button><button aria-label="Close Global EQ" onClick={onClose}>✓</button></header>
    <div className="global-eq-graph"><div>{verticals.map((left) => <i key={left} style={{ left: `${left}%` }} />)}</div><svg viewBox="0 0 800 255" preserveAspectRatio="none"><g className="eq-axis-labels"><text x="208" y="13">100</text><text x="471" y="13">1k</text><text x="736" y="13">10k</text></g><path d="M25 252 C78 186 99 110 243 104 C400 125 513 115 513 146 C540 115 590 105 644 104 C700 95 750 82 800 80" /><g>{[[104,158],[243,105],[513,146],[607,126],[644,104]].map(([x,y], index) => <g key={index}><circle cx={x} cy={y} r="18" className={index === 0 ? "is-active" : ""} /><text x={x} y={y + 5}>{index + 1}</text></g>)}</g></svg></div>
    <div className="global-eq-tabs">{[1,2,3,4,5].map((tab) => <button key={tab} className={tab === 1 ? "is-active" : ""}>{tab}</button>)}<button>OUT</button></div>
    <div className="global-eq-controls"><section><span>TYPE</span><button>⌁　HI PASS　⌄</button></section>{[["GAIN","0.0 dB"],["FREQ","50 Hz"],["Q","0.10"]].map(([label,value]) => <section key={label}><span>{label}</span><IoDial value={value} /></section>)}<section className="global-eq-bypass"><span>BYPASS 1</span><button><ExpressionPowerIcon /></button></section></div>
  </section>;
}

function CorOsPowerOverlay({ onClose }: { onClose: () => void }) {
  return <section className="coros-power-overlay" aria-label="Power and Locking Functions">
    <div className="power-actions"><button className="power-lock"><svg viewBox="0 0 16 20" aria-hidden="true"><rect x="1" y="8" width="14" height="11" rx="2"/><path d="M4 8V5a4 4 0 0 1 8 0v3"/></svg><span>Lock Touchscreen and Master Volume knob</span></button><div><button onClick={onClose}>CANCEL</button><button>SHUT DOWN</button><button>REBOOT</button><button>BE RIGHT BACK</button></div></div>
  </section>;
}

function CorOsModesConfiguration({ onClose }: { onClose: () => void }) {
  const modes = ["PRESET", "SCENE", "STOMP"] as const;
  return <section className="coros-modes-configuration" aria-label="Modes Configuration">
    <header><span>Modes configuration</span><div><button aria-label="Modes Configuration information"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 10v7M12 7h.01" /></svg></button><button aria-label="Close Modes Configuration" onClick={onClose}>✓</button></div></header>
    <p>Drag a Mode on top of another to create a Hybrid<br />Mode. Use a long press to break a Hybrid Mode apart.</p>
    <div className="modes-cycle"><span>CYCLE</span><i /><i /><div>{modes.map((mode) => <button key={mode}><b><svg viewBox="0 0 24 24" aria-hidden="true"><ModeGlyph mode={mode} /></svg></b>{mode[0] + mode.slice(1).toLowerCase()}</button>)}</div></div>
  </section>;
}

function CorOsOfficialModes({ onClose }: { onClose: () => void }) {
  return <section className="coros-modes-configuration modes-official" aria-label="Modes Configuration">
    <header><span>Modes configuration</span><div><button aria-label="Modes Configuration information"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 10v7M12 7h.01" /></svg></button><button aria-label="Close Modes Configuration" onClick={onClose}>✓</button></div></header>
    <p>Drag a Mode on top of another to create a Hybrid<br />Mode. Use a long press to break a Hybrid Mode apart.</p>
    <div className="modes-cycle"><span>CYCLE</span><i /><div><button><b><svg viewBox="0 0 24 24" aria-hidden="true"><ModeGlyph mode="PRESET" /></svg></b>Preset</button><button className="hybrid-mode"><b><svg viewBox="0 0 24 24" aria-hidden="true"><ModeGlyph mode="SCENE" /></svg><svg viewBox="0 0 24 24" aria-hidden="true"><ModeGlyph mode="STOMP" /></svg></b><span>Scene<br />Stomp</span><em><i />↕<i /></em></button></div></div>
    <svg className="modes-device" viewBox="0 0 240 152" aria-hidden="true"><path d="M7 12 Q5 76 7 140 Q7 150 18 150 H222 Q233 150 233 140 Q235 76 233 12 Q233 2 222 2 H18 Q7 2 7 12 Z"/><rect x="67" y="10" width="106" height="62" rx="3"/><circle cx="38" cy="42" r="11"/><circle cx="203" cy="42" r="7"/>{[38,79,120,162,203].map((x)=><circle key={`a${x}`} cx={x} cy="98" r="6" className={x===203?"off":"yellow"}/>)}{[38,79,120,162,203].map((x)=><circle key={`b${x}`} cx={x} cy="132" r="6" className={x===203?"off":"purple"}/>)}</svg>
  </section>;
}

function CorOsSaveAs({ onClose }: { onClose: () => void }) {
  const folders = ["My Presets", "ALI Live", "ALI Rec", "ALI AcousticLive", "Downloaded", "Downloaded2"];
  const presets = ["2A ALI2023", "2B MiniVoicer", "2C No One Knows", "2D ALI Purification", "2E ALI Reach Outside Re_1", "2F Unsaved", "2G ALI The List", "2H Unsaved"];
  return <section className="coros-save-as" aria-label="Save As destination">
    <header><button className="save-as-type"><b><DirectoryIcon kind="grid" /></b>Presets <i>▼</i></button><span>Save to...</span><button className="save-as-close" aria-label="Close Save As" onClick={onClose}>×</button></header>
    <div className="save-as-content">
      <nav>{folders.map((folder, index) => <button key={folder} className={index === 0 ? "is-active" : ""}><b><DirectoryIcon kind="folder" number={index + 1} /></b><span>{folder}</span><i>⋮</i></button>)}<button className="save-as-new"><b><DirectoryIcon kind="new-folder" /></b><span>New Setlist</span></button></nav>
      <aside>{Array.from({ length: 14 }, (_, index) => <button key={index} className={index === 1 ? "is-active" : ""}>{index + 1}</button>)}</aside>
      <section>{presets.map((preset, index) => <button key={preset} className={index === 5 ? "is-active" : index === 7 ? "is-disabled" : ""}>{preset}<i>⋮</i></button>)}</section>
    </div>
  </section>;
}

function CorOsPresetNameEditor({ snapshot, onClose }: { snapshot: PresetSnapshot; onClose: () => void }) {
  const rows = [
    ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
    ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
    ["⇧", "Z", "X", "C", "V", "B", "N", "M", "⌫"]
  ];
  return <section className="coros-name-editor" aria-label="Preset name editor">
    <header>
      <button className="name-editor-close" aria-label="Close preset name editor" onClick={onClose}>×</button>
      <span className="name-editor-divider" />
      <button className="name-editor-folder">▰ <span>My Pre... / {snapshot.presetLocation}</span></button>
      <button className="name-editor-tab is-active">Name</button>
      <button className="name-editor-metadata" aria-label="Preset metadata">▤</button>
      <button className="name-editor-next" aria-label="Continue">→</button>
    </header>
    <div className="name-editor-value"><span>{snapshot.presetName}</span></div>
    <div className="name-editor-keyboard">
      {rows.map((row, rowIndex) => <div className={`name-key-row row-${rowIndex + 1}`} key={rowIndex}>{row.map((key, index) => <button key={`${key}-${index}`} className={key === "⇧" || key === "⌫" ? "is-wide" : ""}>{key}<small>{rowIndex === 0 ? (index + 1) % 10 : rowIndex === 1 && index > 6 ? index === 7 ? "(" : ")" : ""}</small></button>)}</div>)}
      <div className="name-key-row row-4"><button>123</button><button>,</button><button className="name-key-space">Space</button><button>.</button><button>Next</button></div>
    </div>
  </section>;
}

function RoutingToken({ kind, x, y, selected = false }: { kind: "S" | "M"; x: number; y: number; selected?: boolean }) {
  const color = kind === "S" ? "#087cea" : "#e73e60";
  return <g className={selected ? "routing-token is-selected" : "routing-token"}>
    {selected && <circle cx={x} cy={y} r="20" fill="none" stroke="#f5f5f5" strokeWidth="2" />}
    <circle cx={x} cy={y} r="15" fill="#050505" stroke="#202020" strokeWidth="2" />
    <circle cx={x} cy={y} r="12" fill={color} />
    <text x={x} y={y + 5} textAnchor="middle" fill="#fff" fontFamily="Arial" fontWeight="700" fontSize="15">{kind}</text>
  </g>;
}

function RoutingGridDiagram({ placement = false, selected }: { placement?: boolean; selected?: "S" | "M" }) {
  const cells = [112, 198, 284, 370, 456, 542, 628, 714];
  const blocks = [[112, "⌁", "#eeeeee"], [198, "∿", "#ff7900"], [284, "▭", "#ff424c"], [370, "⊙", "#7257ff"], [542, "≋", "#02d2bc"], [628, "◇", "#35b9ff"]] as const;
  return <svg className="routing-grid-diagram" viewBox="0 0 800 250" preserveAspectRatio="none" aria-label={placement ? "Empty Grid slots available for Splitter or Mixer placement" : "Parallel Grid signal paths"}>
    <rect width="800" height="250" fill="#030303" />
    <g fill="none" stroke="#8e8f91" strokeWidth="1.5"><path d="M52 92H748" /><path d="M284 92C284 118 284 143 284 168H628C628 143 628 118 628 92" /></g>
    <g fill="#171719" stroke="#050505" strokeWidth="2"><rect x="8" y="52" width="44" height="80" rx="15" /><rect x="748" y="52" width="44" height="80" rx="15" /></g>
    <g fill="#eee" fontFamily="Arial" fontSize="14" textAnchor="middle"><text x="30" y="86">In</text><text x="30" y="106">1</text><text x="770" y="84">Multi</text><text x="770" y="105">Out</text></g>
    {blocks.map(([x, glyph, color]) => <g key={x}><rect x={x - 31} y="61" width="62" height="62" rx="14" fill="#090909" stroke={color} strokeWidth="3" /><text x={x} y="102" fill="#eee" fontFamily="Arial" fontSize="25" textAnchor="middle">{glyph}</text></g>)}
    {!placement && <><RoutingToken kind="S" x={284} y={92} selected={selected === "S"} /><RoutingToken kind="M" x={628} y={92} selected={selected === "M"} /></>}
    {placement && cells.map((x, index) => <g key={x} className={index === 3 ? "placement-target is-active" : "placement-target"} transform={`translate(${x} 145)`}><path d="M-17 35v-24c0-5 7-6 8-1V-1c0-6 8-6 8 0v8-15c0-6 8-6 8 0V7-4c0-6 8-6 8 0v14c4-5 10-2 9 4l-2 17c-1 10-9 16-19 16H0c-7 0-12-4-17-12Z" fill="#3df269" stroke="#0d8e38" strokeWidth="2" /><circle cx="24" cy="31" r="13" fill="#fff" stroke="#168a40" strokeWidth="2" /><path d="M24 23v9l6 3" fill="none" stroke="#168a40" strokeWidth="2" strokeLinecap="round" /></g>)}
  </svg>;
}

function RoutingControl({ label, value, kind = "dial", accent = "#087cea" }: { label: string; value: string; kind?: "dial" | "toggle" | "select"; accent?: string }) {
  return <div className={`routing-control is-${kind}`}><strong>{label}</strong>{kind === "dial" ? <i className="routing-dial" style={{ "--routing-accent": accent } as CSSProperties}><b /></i> : kind === "toggle" ? <i className="routing-toggle"><b /></i> : <i className="routing-select">{value}<b>⌄</b></i>}<small>{kind === "dial" ? value : ""}</small></div>;
}

function ChoiceToken({ kind }: { kind: "S" | "M" }) {
  return <svg viewBox="0 0 48 48" aria-hidden="true"><RoutingToken kind={kind} x={24} y={24} /></svg>;
}

function PhysicalRoutingGrid({ snapshot, selected }: { snapshot: PresetSnapshot; selected: "S" | "M" }) {
  const mixerSelected = selected === "M";
  return <svg className="splitter-grid" viewBox="0 0 800 196" aria-hidden="true">
    <rect width="800" height="196" fill="#020202" />
    {[3, 97].flatMap((y, row) => [<g key={`l${row}`}><rect x="8" y={y} width="44" height="77" rx="14" fill="#171719" />{row === 0 ? <text x="30" y={y + 32} textAnchor="middle" fill="#eee" fontFamily="Arial" fontSize="14"><tspan x="30">In</tspan><tspan x="30" dy="20">1</tspan></text> : <path d={`M19 ${y + 38.5}h22M30 ${y + 27.5}v22`} stroke="#a8aaab" strokeWidth="1.5" />}</g>, <g key={`r${row}`}><rect x="750" y={y} width="44" height="77" rx="14" fill="#171719" />{row === 0 ? <text x="772" y={y + 30} textAnchor="middle" fill="#eee" fontFamily="Arial" fontSize="14"><tspan x="772">Multi</tspan><tspan x="772" dy="20">Out</tspan></text> : <path d={`M761 ${y + 38.5}h22M772 ${y + 27.5}v22`} stroke="#a8aaab" strokeWidth="1.5" />}</g>])}
    <path d="M60 41H740" stroke="#bfc1c0" strokeWidth="2" />
    {[60, 142, 228, 314, 400, 486, 572, 658, 740].map((x) => <circle key={x} cx={x} cy="41" r="5" fill="#020202" stroke="#f4f4f4" strokeWidth="2" />)}
    {snapshot.blocks.filter((block) => block.row === 0).map((block) => {
      const x = [101, 187, 273, 357, 443, 529, 615, 701][block.column] ?? 101;
      return <g key={block.id} opacity={block.bypassed ? .48 : 1}>
        <DeviceGlyph block={block} x={x} y={41} />
        {block.bypassed && <path d={`M${x - 32} 41H${x + 32}`} fill="none" stroke="#c9c9ca" strokeWidth="2" opacity=".9" />}
      </g>;
    })}
    <circle cx="60" cy="135" r="18" fill={mixerSelected ? "#020202" : "#087cea"} stroke={mixerSelected ? "#087cea" : "none"} strokeWidth="2" /><text x="60" y="141" textAnchor="middle" fill={mixerSelected ? "#087cea" : "#fff"} fontFamily="Arial" fontSize="18">S</text>
    <circle cx="740" cy="135" r="18" fill={mixerSelected ? "#f00063" : "#020202"} stroke={mixerSelected ? "none" : "#f00063"} strokeWidth="2" /><text x="740" y="141" textAnchor="middle" fill={mixerSelected ? "#fff" : "#f00063"} fontFamily="Arial" fontSize="18">M</text>
  </svg>;
}

function CorOsRoutingScreen({ view, snapshot }: { view: "splitter-placement" | "splitter-editor" | "mixer-editor" | "empty-slot"; snapshot: PresetSnapshot }) {
  if (view === "empty-slot") return <section className="qc-screen empty-slot-official" aria-label="Empty-slot device browser"><nav className="empty-slot-categories">{COROS_DEVICE_CATEGORIES.slice(0, 6).map(([label, glyph, color], index) => <button key={label} style={{ "--device-color": color } as CSSProperties}><i><DeviceCategoryGlyph label={label} fallback={glyph} /></i><span>{label}</span>{index === 0 && <b>New</b>}</button>)}</nav><section className="empty-slot-grid"><header><span className="empty-undo"><GridToolbarIcon kind="undo" /></span><b>A</b><span className="empty-save"><GridToolbarIcon kind="save" /></span><span className="empty-more"><GridToolbarIcon kind="more" /></span></header><div className="empty-mode"><GridToolbarIcon kind="mode" /><strong>PRESET</strong></div><main><i>＋</i><i>Multi<br />Out</i><i>＋</i><i>＋</i><i>＋</i></main></section></section>;
  const placement = view === "splitter-placement";
  const splitter = view === "splitter-editor" || placement;
  if (splitter) return <section className="qc-screen coros-splitter-physical" aria-label={placement ? "Splitter and Mixer placement handles" : "Splitter parameter editor"}>
    <PhysicalRoutingGrid snapshot={snapshot} selected="S" />
    <section className="splitter-panel">
      <header><button>⋮</button><span><strong>Splitter</strong></span><svg viewBox="0 0 230 44" aria-hidden="true"><circle cx="18" cy="12" r="6" fill="#087cea"/><path d="M18 18v12h87v-12M105 30v-12" fill="none" stroke="#eee" strokeWidth="2"/><circle cx="105" cy="30" r="6" fill="#f00063"/><circle cx="140" cy="12" r="6" fill="#087cea"/><path d="M140 18v12h87v-12M227 30v-12" fill="none" stroke="#eee" strokeWidth="2"/><circle cx="227" cy="12" r="6" fill="#f00063"/></svg><b className="splitter-scene"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 3 12l8 8zM21 4l-8 8 8 8z" /></svg></span><i>A</i><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 4 8 8-8 8zM3 4l8 8-8 8z" /></svg></span></b><em><svg viewBox="0 0 66 43" aria-hidden="true"><rect x="23" y="11" width="20" height="20" rx="3"/><path d="M27 27V15l6 7 6-7v12"/></svg></em><button>✓</button></header>
      <div className="splitter-controls">
        <label><strong>TYPE</strong><span className="splitter-toggle"><i/><b>Crossover<br/>A/B<br/><em>Balance</em></b></span></label>
        <label><strong>STEREO</strong><span className="splitter-toggle"><i/><b>Split<br/><em>Normal</em></b></span></label>
        <label><strong>BALANCE</strong><span className="splitter-knob"/><small>5.0</small></label>
        <label><strong>LEVEL TO A</strong><span className="splitter-knob angle-a"/><small>0.0 <em>dB</em></small></label>
        <label><strong>LEVEL TO B</strong><span className="splitter-knob angle-b"/><small>0.0 <em>dB</em></small></label>
        <label><strong>FREQUENCY</strong><span className="splitter-knob frequency"/><small>400 <em>Hz</em></small></label>
        <label><strong>MODE</strong><span className="splitter-toggle"><i/><b>Invert<br/><em>Regular</em></b></span></label>
        <span className="splitter-empty"/><span className="splitter-empty"/><span className="splitter-empty"/>
      </div>
    </section>
  </section>;
  return <section className="qc-screen coros-splitter-physical coros-mixer-physical" aria-label="Mixer parameter editor">
    <PhysicalRoutingGrid snapshot={snapshot} selected="M" />
    <section className="splitter-panel mixer-panel">
      <header><button>⋮</button><span><strong>Mixer</strong></span><svg viewBox="0 0 230 44" aria-hidden="true"><circle cx="18" cy="12" r="6" fill="#087cea"/><path d="M18 18v12h87v-12M105 30v-12" fill="none" stroke="#eee" strokeWidth="2"/><circle cx="105" cy="30" r="6" fill="#f00063"/><circle cx="140" cy="12" r="6" fill="#087cea"/><path d="M140 18v12h87v-12M227 30v-12" fill="none" stroke="#eee" strokeWidth="2"/><circle cx="227" cy="12" r="6" fill="#f00063"/></svg><b className="splitter-scene"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 3 12l8 8zM21 4l-8 8 8 8z" /></svg></span><i>A</i><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 4 8 8-8 8zM3 4l8 8-8 8z" /></svg></span></b><em><svg viewBox="0 0 66 43" aria-hidden="true"><rect x="23" y="11" width="20" height="20" rx="3"/><path d="M27 27V15l6 7 6-7v12"/></svg></em><button>✓</button></header>
      <div className="splitter-controls mixer-controls">
        <label><strong>LEVEL A</strong><span className="splitter-knob mixer-knob level-a"/><small>0.0 <em>dB</em></small></label>
        <label><strong>PAN A</strong><span className="splitter-knob mixer-knob pan"/><small>C</small></label>
        <label><strong>LEVEL B</strong><span className="splitter-knob mixer-knob level-b"/><small>0.0 <em>dB</em></small></label>
        <label><strong>PAN B</strong><span className="splitter-knob mixer-knob pan"/><small>C</small></label>
        <label><strong>PHASE</strong><span className="splitter-toggle mixer-toggle"><i/><b>On<br/><em>Off</em></b></span></label>
        <label><strong>MIXER LEVEL</strong><span className="splitter-knob mixer-knob level-a"/><small>0.0 <em>dB</em></small></label>
        <span className="splitter-empty"/><span className="splitter-empty"/><span className="splitter-empty"/><span className="splitter-empty"/>
      </div>
    </section>
  </section>;
}

const PLUGIN_LICENSES = [
  ["Archetype: Plini X", true], ["Archetype: Cory Wong X", false], ["Archetype: Gojira X", false],
  ["Archetype: John Mayer X", false], ["Archetype: Misha Mansoor X", false], ["Archetype: Nolly X", false],
  ["Archetype: Petrucci X", false], ["Archetype: Rabea X", false], ["Archetype: Tim Henson X", false],
  ["Fortin Nameless Suite X", false], ["Parallax X", false], ["Soldano SLO-100 X", false]
] as const;
const PLINI_MODELS = [["Plini Clean", "amp"], ["Plini Crunch", "amp"], ["Plini Lead", "amp"], ["Plini Cab (M)", "cab"], ["Plini Cab (ST)", "cab"], ["Plini Drive", "drive"]] as const;
const CORY_WONG_MODELS = [["Cory Wong D.I. Funk Console", "amp"], ["Cory Wong The Amp Snob", "amp"], ["Cory Wong The Clean Machine", "amp"], ["Cory Wong Cab 1 (M)", "cab"], ["Cory Wong Cab 2 (M)", "cab"], ["Cory Wong Wah", "drive"]] as const;

function PluginGridGlyph({ kind }: { kind: "gate" | "amp" | "capture" | "cab" | "wave" | "cube" | "dual" }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "gate") return <svg viewBox="0 0 48 48" aria-hidden="true"><path {...common} d="M10 33h28L31 15H17Z" /></svg>;
  if (kind === "amp") return <svg viewBox="0 0 48 48" aria-hidden="true"><g {...common}><rect x="9" y="15" width="30" height="19" /><path d="M12 18h24" /></g></svg>;
  if (kind === "capture") return <svg viewBox="0 0 48 48" aria-hidden="true"><g {...common}><path d="m24 6-4 15 10-11-5 14 13-7-11 11 15-3-14 8" /><path d="m24 24-13 14 10-16-15 8 14-10-15 1 16-5" /></g></svg>;
  if (kind === "cab") return <svg viewBox="0 0 48 48" aria-hidden="true"><g {...common}><circle cx="24" cy="24" r="12" /><circle cx="24" cy="24" r="3" />{[[10, 10], [38, 10], [10, 38], [38, 38]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />)}</g></svg>;
  if (kind === "wave") return <svg viewBox="0 0 48 48" aria-hidden="true"><path {...common} d="M7 27c5-15 8-15 13 0s8 15 13 0 8-15 10 0" /></svg>;
  if (kind === "cube") return <svg viewBox="0 0 48 48" aria-hidden="true"><g {...common}><path d="m24 7 14 8v17l-14 9-14-9V15Z" /><path d="m10 15 14 9 14-9M24 24v17M13 34l23-17" /></g></svg>;
  return <svg viewBox="0 0 48 48" aria-hidden="true"><g {...common}><circle cx="17" cy="24" r="8" /><circle cx="31" cy="24" r="8" /><circle cx="17" cy="24" r="3" /><circle cx="31" cy="24" r="3" /><path d="M17 13v3m0 16v3m-11-11h3m16 0h3m3-11v3m0 16v3m8-11h3" /></g></svg>;
}

function GridToolbarIcon({ kind }: { kind: "undo" | "export" | "save" | "more" | "mode" | "refresh" }) {
  if (kind === "undo") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h6a7 7 0 1 1-6.2 10.2M8 8l3-3M8 8l3 3" /></svg>;
  if (kind === "export") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h12l4 4v12H4Z" /><path d="M8 12h10m-4-4 4 4-4 4" /></svg>;
  if (kind === "save") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h13l3 3v15H4Z" /><path d="M8 3v6h8V3M8 21v-8h8v8" /></svg>;
  if (kind === "more") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg>;
  if (kind === "mode") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h5v5H3zm7 0h5v5h-5zm7 0h4v5h-4zM3 11h5v5H3zm7 0h5v5h-5zm7 0h4v5h-4zM3 18h5v3H3zm7 0h5v3h-5zm7 0h4v3h-4z" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8V3l-2 2a8 8 0 0 0-11 7m1 4v5l2-2a8 8 0 0 0 11-7" /><path d="m18 3 3 3m-15 15-3-3" /></svg>;
}

function CorOsOfficialDeviceBrowser({ plugins }: { plugins: boolean }) {
  const rows = plugins ? ["Archetype: Cory Wong X", "Archetype: Gojira X", "Archetype: Nolly X", "Archetype: Plini X", "Fortin Nameless Suite X", "Parallax X", "Soldano SLO-100 X"] : ["Bogna Uber Clean", "Bogna Uber Lead", "Bogna Vishnu 20th Clean", "Brit 2203", "Brit 900 Clean", "Brit 900 Lead", "Brit Plexi 100 Bright"];
  return <section className={`qc-screen device-browser-official${plugins ? " is-plugins" : ""}`}><main><nav>{COROS_DEVICE_CATEGORIES.slice(0, 6).map(([label, glyph], index) => <button key={label} className={index === (plugins ? 0 : 1) ? "is-active" : ""}><i><DeviceCategoryGlyph label={label} fallback={glyph} /></i></button>)}</nav><section className="device-browser-list"><header>{plugins ? <><b>Add device</b><i><GridToolbarIcon kind="refresh" /></i></> : <><button className="is-active">GUITAR</button><button>BASS</button></>}</header>{rows.map((name, index) => <button key={name}>{plugins && index !== 4 ? <b>●</b> : null}{name}</button>)}</section></main><section className="device-browser-grid"><header>{plugins ? <><em>3</em><span className="plugin-undo"><GridToolbarIcon kind="undo" /></span><b>A</b><span className="plugin-save"><GridToolbarIcon kind="export" /></span><span className="plugin-more"><GridToolbarIcon kind="more" /></span><strong className="plugin-mode"><span className="plugin-mode-matrix"><i>A</i><i>B</i><i>C</i><i>D</i></span><span>SCENE</span></strong></> : <><span className="amp-undo"><GridToolbarIcon kind="undo" /></span><b>A</b><span className="amp-save"><GridToolbarIcon kind="save" /></span><span className="amp-more">⋮</span><i className="amp-status" /></>}</header>{!plugins && <div className="amp-mode">▦　PRESET</div>}<main>{plugins && <>{(["gate", "amp", "capture", "cab", "wave", "cube", "dual"] as const).map((kind, index) => <span key={kind} className={`grid-block b${index + 1}`}><PluginGridGlyph kind={kind} /></span>)}</>}{plugins ? <><i>＋</i><i>Row<br />3</i><i>＋</i><i>Multi<br />Out</i><i>＋</i></> : <><i>＋</i><i>Multi<br />Out</i><i>＋</i><i>＋</i><i>＋</i></>}</main></section></section>;
}

function PluginModelGlyph({ name, kind }: { name: string; kind: "amp" | "cab" | "drive" }) {
  const category = kind === "cab" ? "CAB" : kind === "drive" ? "OVERDRIVE" : "AMP";
  const blockKind = kind === "drive" ? "utility" : kind;
  const block: GridBlock = { id: `plugin-${name}`, name, kind: blockKind, category, row: 0, column: 0, bypassed: false };
  return <svg viewBox="0 0 70 70" aria-hidden="true"><DeviceGlyph block={block} x={35} y={35} size={70} /></svg>;
}

function CorOsDeviceBrowserFixture({ view }: { view: "device-search" | "device-favorites" | "plugin-folders" | "plugin-list" | "plugin-models" | "plugin-locked" | "plugin-refresh" }) {
  if (view === "plugin-folders") return <section className="qc-screen plugin-folders-official" aria-label="Plugin folders"><header><button><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H4m0 0 6-6m-6 6 6 6" /></svg></button><button className="plugin-folder-category"><DeviceCategoryGlyph label="Plugins" fallback="" /><span>Plugins</span><small>▼</small></button><span /><button><DirectoryIcon kind="arrange" /></button><button><DirectoryIcon kind="search" /></button><button><DirectoryIcon kind="done" /></button></header><main><nav><button><b><DirectoryIcon kind="folder" /></b><span><small>Plugins</small>Parallax X</span></button>{["Artists", "Neural DSP", "User"].map(label => <button key={label}><b><DirectoryIcon kind="folder" /></b><span>{label}</span>{label === "User" && <i>⋮</i>}</button>)}</nav><section><button><span>Default<small>Bass</small></span><i>D</i><b><GridToolbarIcon kind="export" /></b></button></section></main></section>;
  const plugins = view.startsWith("plugin-");
  const pluginModels = view === "plugin-models" || view === "plugin-locked";
  const lockedPlugin = view === "plugin-locked";
  const pluginModelRows: ReadonlyArray<readonly [string, "amp" | "cab" | "drive"]> = lockedPlugin ? [
    ["Cory Wong D.I. Funk Console", "amp"], ["Cory Wong The Amp Snob", "amp"], ["Cory Wong The Clean Machine", "amp"], ["Cory Wong Cab 1 (M)", "cab"], ["Cory Wong Cab 2 (M)", "cab"]
  ] : [
    ["Plini Clean", "amp"], ["Plini Crunch", "amp"], ["Plini Lead", "amp"], ["Plini Cab (M)", "cab"], ["Plini Cab (ST)", "cab"], ["Plini Drive", "drive"]
  ];
  const rows = view === "device-favorites" ? [["Chief DS1", "OVERDRIVE", true], ["Brit 2203", "AMP", true], ["212 UK C30 65 (M)", "CAB", true], ["Digital Flanger", "MODULATION", true], ["Ambience", "REVERB", true]] as const : view === "device-search" ? [["Chief DS1", "OVERDRIVE", true], ["Chief SD1", "OVERDRIVE", true], ["Chief OD1", "OVERDRIVE", true]] as const : undefined;
  return <section className={`qc-screen coros-browser-fixture${view === "plugin-list" ? " is-physical-plugin-list" : pluginModels ? ` is-physical-plugin-models${lockedPlugin ? " is-physical-plugin-locked" : ""}` : ""}`} aria-label={view.replaceAll("-", " ")}>
    <div className="browser-fixture-panel">
      <nav>{COROS_DEVICE_CATEGORIES.slice(0, 8).map(([label, glyph, color], index) => <button key={label} className={(plugins ? index === 0 : index === 4) ? "is-active" : ""} style={{ "--device-color": color } as CSSProperties}><i><DeviceCategoryGlyph label={label} fallback={glyph} /></i></button>)}</nav>
      <main>
        <header><strong>{view === "plugin-list" ? "Add device" : plugins ? "Plugins" : view === "device-favorites" ? "Favorites & Recent" : "Search devices"}</strong><button className={view === "plugin-refresh" ? "is-refreshing" : ""}>↻</button></header>
        {view === "device-search" && <div className="browser-search"><span>⌕</span><b>Chief</b><button>×</button></div>}
        {view === "device-favorites" && <div className="browser-tabs"><button className="is-active">FAVORITES</button><button>RECENT</button></div>}
        {view === "plugin-refresh" ? <div className="plugin-refresh-state"><i>↻</i><strong>Refreshing plugin licenses…</strong><span>Checking your Neural DSP account</span></div> : pluginModels ? <div className="browser-result-list is-plugin-licenses">{PLUGIN_LICENSES.map(([name, available]) => { const selected = name === (lockedPlugin ? "Archetype: Cory Wong X" : "Archetype: Plini X"); return <button key={name} className={`${available ? "is-licensed" : "is-locked"}${selected ? " is-selected" : ""}`}>{!available && <i className="plugin-license-lock"><svg viewBox="0 0 20 24" aria-hidden="true"><path d="M4 10V7a6 6 0 0 1 12 0v3M2 10h16v13H2Z" /></svg></i>}<span><strong>{name}</strong></span>{selected && <em>›</em>}</button>; })}</div> : view === "plugin-list" ? <div className="browser-result-list is-plugin-licenses">{PLUGIN_LICENSES.map(([name, available]) => <button key={name} className={available ? "is-licensed" : "is-locked"}>{!available && <i className="plugin-license-lock"><svg viewBox="0 0 20 24" aria-hidden="true"><path d="M4 10V7a6 6 0 0 1 12 0v3M2 10h16v13H2Z" /></svg></i>}<span><strong>{name}</strong></span></button>)}</div> : <div className="browser-result-list">{rows?.map(([name, category]) => <button key={name}><i style={{ "--result-color": category === "AMP" ? "#ff424c" : category === "CAB" ? "#7257ff" : category === "MODULATION" ? "#a95cff" : category === "REVERB" ? "#35b9ff" : "#ff7900" } as CSSProperties}>{category === "AMP" ? "▭" : category === "CAB" ? "⊙" : "∿"}</i><span><strong>{name}</strong><small>{category}</small></span><b>★</b></button>)}</div>}
      </main>
      {pluginModels && <><header className="plugin-model-header"><strong>{lockedPlugin ? "Plugin license not found" : "Add device"}</strong><button><GridToolbarIcon kind="refresh" /></button><button>×</button></header><section className="plugin-model-list">{pluginModelRows.map(([name, kind]) => <button key={name}><i className={kind === "cab" ? "is-cab" : kind === "drive" ? "is-drive" : ""}><PluginModelGlyph name={name} kind={kind} /></i>{lockedPlugin && <i className="plugin-model-lock"><svg viewBox="0 0 20 24" aria-hidden="true"><path d="M4 10V7a6 6 0 0 1 12 0v3M2 10h16v13H2Z" /></svg></i>}<span>{name}</span><em><DevicePresetGlyph /></em></button>)}</section></>}
    </div>
    {view === "plugin-list" ? <div className="plugin-grid-underlay"><header><strong>32<span>G</span></strong><em>Unsaved*</em></header><main><i className="underlay-input">In<br />1</i><i className="underlay-plus">＋</i><i className="underlay-add">＋</i><i className="underlay-row-2">＋</i><i className="underlay-row-3">＋</i><i className="underlay-row-4">＋</i></main></div> : <div className="browser-grid-ghost"><b>3B</b><span>SCENE</span><i>＋</i><i>＋</i><i>＋</i></div>}
  </section>;
}

function CorOsLooperEditor() {
  const actions = [["DUPLICATE", "×1", "A"], ["ONE SHOT", "↻", "B"], ["HALF SPEED", "½", "C"], ["PUNCH IN", "▰", "D"], ["RECORD", "●", "E"], ["PLAY", "▶", "F"], ["REVERSE", "◀◀", "G"], ["UNDO", "↶", "H"]];
  return <section className="qc-screen coros-looper" aria-label="Looper X editor"><header><button>⋮</button><span><small>LOOPER</small><strong>Looper X</strong></span><i /><button>◴　Params</button><button>◀　<b>A</b>　▶</button><button>✓</button></header><div className="looper-timeline"><span>USE <b>●</b> TO START RECORDING</span><span>USE <b className="looper-close-caret">⌃</b> TO CLOSE THE LOOPER VIEW</span><em>AVAILABLE 4:38</em></div><div className="looper-actions">{actions.map(([label, glyph, key]) => <button key={label}><small>{label}</small><strong>{glyph}</strong><b>{key}</b></button>)}</div></section>;
}

function CorOsDevicePresetScreen({ save = false, view = "factory" }: { save?: boolean; view?: "factory" | "user" | "actions" | "official-actions" | "official-factory" }) {
  const officialActions = view === "official-actions";
  const officialFactory = view === "official-factory";
  const categories = officialActions ? COROS_DEVICE_CATEGORIES.slice(1, 7) : COROS_DEVICE_CATEGORIES.slice(0, 6);
  const devices = officialActions || officialFactory ? ["Bogna Uber Clean", "Bogna Uber Lead", "Bogna Vishnu 20th Clean", "Brit 2203", "Brit 900 Clean", "Brit 900 Lead", "Brit Plexi 100 Bright"] : ["Exotic Z Boost", "81 Creations Drive", "Brit Blues", "Brit Governor", "Chief BD2", "Chief DS1", "Chief MT"];
  const presets = officialActions ? ["Lead Tone", "Low Gain"] : officialFactory ? ["Neural DSP® Default", "Balanced Crunch", "Basic Clean", "Bass Clean", "Bass Punk Drive", "Bass Tube Drive", "Bass Verge Of OD"] : ["Neural DSP® Default", "Bass More Push", "Bass Push", "Bass Tube Drive", "Bass Tube OD", "Bigger Maker", "Bright Boost"];
  if (save) return <section className="qc-screen coros-device-preset-save" aria-label="Save Virtual Device preset"><header><button>×</button><strong>Save Current Parameters As…</strong><button>✓</button></header><label>PRESET NAME<input value="My Brit 2203" readOnly /></label><div><button className="is-active">USER</button><button>FACTORY</button></div><p>Virtual Device Preset names can contain up to 24 characters.</p><footer><button>CANCEL</button><button>SAVE</button></footer></section>;
  const user = view === "user" || officialActions;
  return <section className={`qc-screen coros-device-presets is-physical is-${officialActions ? "official-actions" : officialFactory ? "official-factory" : view}`} aria-label="Virtual Device preset browser"><nav>{categories.map(([label, glyph, color], index) => <button key={label} className={index === (officialActions ? 0 : officialFactory ? 1 : 4) ? "is-active" : ""} style={{ "--device-color": color } as CSSProperties}><i><DeviceCategoryGlyph label={label} fallback={glyph} /></i></button>)}</nav><main><section><header><button className="is-active">GUITAR</button><button>BASS</button></header>{devices.map((name, index) => <button key={name} className={index === (officialActions ? 1 : officialFactory ? 3 : 0) ? "is-active" : ""}>{!officialActions && !officialFactory && index === 0 && <i className="device-pin" />}<span>{name}</span><b><DevicePresetGlyph /></b></button>)}</section><section><header><button className={user ? "" : "is-active"}>FACTORY</button><button className={user ? "is-active" : ""}>USER</button><span /><button className="preset-close">×</button>{officialFactory && <button className="preset-confirm">✓</button>}</header>{(officialActions || !user) && presets.map((name, index) => <button key={name}><span className={officialFactory && index === 1 ? "is-italic" : ""}>{name}<small>{officialActions ? "" : index ? "" : "Default"}</small></span><b>⋮</b></button>)}</section></main>{(view === "actions" || officialActions) && <aside className="device-preset-actions"><button>Set as Default</button><button>Edit Name</button><button>Overwrite</button><button>Delete</button></aside>}</section>;
}

function ExpressionPowerIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v9M6.35 5.35a8 8 0 1 0 11.3 0" /></svg>;
}

function ExpressionLinkIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3H4v18h3M17 3h3v18h-3M9 12h6" /><rect x="7" y="9" width="2" height="6" /><rect x="15" y="9" width="2" height="6" /></svg>;
}

function CorOsAssignmentScreen({ view }: { view: "stomp-assignment" | "scene-assignment" | "expression-parameter" | "expression-bypass" }) {
  if (view === "expression-bypass") return <section className="qc-screen expression-bypass-official" aria-label="Expression bypass assignment"><header><button><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button><button>Expression 1</button><button>Expression 2</button><button><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h12l3 3v15H4V3Z" /><path d="M8 3v6h8V3M8 21v-7h8v7" /></svg></button></header><p>Please choose which parameters you wish to control.<br />You can assign multiple at once.</p><main className="expression-switch-panel"><section><button><ExpressionPowerIcon /></button></section><section><span>SWITCH ON</span><label><i /><b>Heel-Toe</b><small>Switch<br />Stop</small></label></section><section><span>INVERT RANGE</span><label><i /><b>On</b><small>Off</small></label></section><section className="switch-delay"><span>SWITCH DELAY</span><b>600 ms</b><i className="capture-level-dial" /></section><section className="switch-latch"><span>LATCH EMULATION</span><label><i /><b>On</b><small>Off</small></label></section></main><div className="expression-parameter-grid">{["GAIN", "BASS", "MID", "TREBLE", "LEVEL", "BYPASS"].map(label => <section key={label}><span>{label}<b><ExpressionLinkIcon /></b></span><button>ASSIGN</button></section>)}</div></section>;
  const stomp = view === "stomp-assignment";
  const scene = view === "scene-assignment";
  if (stomp || scene) return <section className={`qc-screen coros-assignment is-${stomp ? "stomp" : "scene"}`} aria-label={view.replaceAll("-", " ")}>
    <div className="assignment-grid-context"><span>In<br />1</span><i /><i /><i /><i /><strong>Multi<br />Out</strong></div>
    <div className="assignment-device-editor">
      <header><button className="assignment-more">⋮</button><span><small>GUITAR AMP</small><strong>Brit 2203</strong></span><div className="assignment-toolbar">{stomp && <button className="assignment-stomp"><svg viewBox="0 0 34 22" aria-hidden="true"><path d="M3 7l12 4-4 3 9 4-2 2-11-5-4 2z"/><circle cx="26" cy="9" r="2"/><circle cx="29" cy="16" r="2"/></svg></button>}<button className="assignment-scene-nav">◀ <b>{scene ? "A" : "B"}</b> ▶</button><i /><button className="assignment-power">◴</button><button className="assignment-confirm">✓</button></div></header>
      {scene ? <div className="assignment-parameters">{[["GAIN","5.0"],["BASS","5.0"],["MID","5.0"],["TREBLE","5.0"],["PRESENCE","1.5"],["MASTER","8.0"],["OUTPUT","0.0 dB"]].map(([label, value], index) => <section key={label} className={index === 2 ? "is-assigned" : ""}><span>{label}</span>{index === 2 && <em>A B<br />C D</em>}<i className="assignment-knob"><b /></i><strong>{value}</strong>{index === 2 && <i className="assignment-touch" />}</section>)}</div> : <div className="assignment-stomp-message"><strong>Footswitch B</strong><span>Press a footswitch to change this assignment.</span></div>}
    </div>
  </section>;
  return <section className="qc-screen coros-assignment is-expression" aria-label={view.replaceAll("-", " ")}><header><button>×</button><span><small>EXPRESSION PEDAL ASSIGNMENT</small><strong>DISTORTION</strong></span><button>✓</button></header><p>Move an expression pedal to assign its range</p><div className="expression-pedals"><button className="is-active"><b>EXP 1</b><i /><span>HEEL　0.0</span><span>TOE　10.0</span></button><button><b>EXP 2</b><i /><span>NOT ASSIGNED</span></button></div><footer><button>BYPASS ASSIGN</button><button>SWAP MIN / MAX</button><button>REMOVE</button></footer></section>;
}

function CorOsBlockContext() {
  return <section className="qc-screen coros-block-context" aria-label="Block contextual actions"><div className="context-grid"><RoutingGridDiagram /></div><aside><header><small>OVERDRIVE</small><strong>Chief DS1</strong></header>{["Footswitch Assignment", "Expression Pedal", "Copy", "Paste", "Set Parameters as Default", "Save Current Parameters As…", "Replace Device", "Remove Block"].map((label, index) => <button key={label} className={index === 7 ? "is-danger" : ""}><span>{["♞", "EXP", "□", "▣", "◇", "▱", "↔", "⌫"][index]}</span>{label}</button>)}</aside></section>;
}

const COROS_INPUT_MONO_ROUTES = ["Input 1", "Input 2", "Return 1", "Return 2", "USB input 5", "USB input 6", "USB input 7", "USB input 8"];
const COROS_INPUT_ROUTES = ["Input 1/2", "Return 1/2", "USB input 5/6", "USB input 7/8", "Not In Use"];
const COROS_OUTPUT_ROUTES = ["Multi Out", "Output 1/2", "Output 3/4", "Output 1", "Output 2", "Output 3", "Output 4", "Send 1", "Send 2", "Send 1/2", "USB Output 3", "USB Output 4", "USB Output 3/4", "USB Output 5", "USB Output 6", "USB Output 7", "USB Output 8", "OTHER", "Row 3", "Row 4", "Row 3/4", "Not In Use"];
const COROS_DEVICE_CATEGORIES = [
  ["Plugins", "♜", "#40ef78"], ["Amp", "▭", "#ff424c"], ["Neural Capture", "◉", "#e8e8e8"],
  ["Cab", "⊙", "#7257ff"], ["Overdrive", "∿", "#ff7900"], ["Delay", "〰", "#00e7d6"],
  ["Reverb", "◇", "#35b9ff"], ["Compressor", "↕", "#e7d329"], ["Pitch", "≋", "#ef55cb"],
  ["Modulation", "≈", "#a95cff"], ["Utility", "⌁", "#efefef"]
] as const;
const COROS_OVERDRIVE_MODELS = ["Exotic Z Boost", "81 Creations Drive", "Brit Blues", "Brit Governor", "Chief BD2", "Chief DS1", "Chief MT", "Chief OD1", "Chief SD1", "Exotic", "Facial Fuzz", "Freeman BOD"];

function DeviceCategoryGlyph({ label, fallback }: { label: string; fallback: string }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (label === "Plugins") return <svg viewBox="0 0 48 48" aria-hidden="true"><g {...common}><path d="M17 8v10m14-10v10M13 18h22v8a11 11 0 0 1-11 11 11 11 0 0 1-11-11Z" /><path d="M24 37v6" /></g></svg>;
  if (label === "Amp") return <svg viewBox="0 0 48 48" aria-hidden="true"><g {...common}><rect x="7" y="15" width="34" height="19" /><path d="M10 18h28" /></g></svg>;
  if (label === "Neural Capture") return <svg viewBox="0 0 48 48" aria-hidden="true"><g {...common}><circle cx="24" cy="24" r="15" />{[14, 18, 22, 26, 30, 34].map((y, index) => <path key={y} d={`M${index % 2 ? 10 : 14} ${y}h${index % 2 ? 28 : 20}`} />)}</g></svg>;
  if (label === "Cab") return <svg viewBox="0 0 48 48" aria-hidden="true"><g {...common}><circle cx="24" cy="24" r="13" /><circle cx="24" cy="24" r="4" fill="currentColor" />{[[9, 9], [39, 9], [9, 39], [39, 39]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.7" fill="currentColor" />)}</g></svg>;
  if (label === "Overdrive") return <svg viewBox="0 0 48 48" aria-hidden="true"><path {...common} d="m6 35 8-22h7l8 22h6l7-22" /></svg>;
  if (label === "Delay") return <svg viewBox="0 0 48 48" aria-hidden="true"><g {...common}><path d="M6 12c5 0 5 24 10 24s5-24 10-24 5 24 10 24 5-24 7-24" /><path d="M6 17c5 0 5 19 10 19s5-19 10-19 5 19 10 19 5-19 7-19" /></g></svg>;
  return <span>{fallback}</span>;
}

function DevicePresetGlyph() {
  return <svg viewBox="0 0 32 32" aria-hidden="true"><g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="m8 11 8-5 8 5-8 5Z" /><path d="m8 16 8 5 8-5M8 21l8 5 8-5" /></g></svg>;
}

function RouteSymbol({ label }: { label: string }) {
  if (label.startsWith("USB")) return <span className="route-symbol"><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 24V5m0 0-4 4m4-4 4 4M14 14H8m0 0-3-3m3 3-3 3m9 4h6m0 0v-4m0 4 3-3" /></svg></span>;
  if (label.startsWith("Return")) return <span className="route-symbol route-fx">FX</span>;
  if (label === "Not In Use") return <span className="route-symbol route-unused">＋</span>;
  if (label.startsWith("Input")) return <span className="route-symbol route-stereo-input"><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M2 9h22m0 0-5-5m5 5-5 5M2 19h22m0 0-5-5m5 5-5 5" /></svg></span>;
  if (label.startsWith("Row")) return <span className="route-symbol"><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M2 8h22l-4-4m4 4-4 4M26 20H4l4-4m-4 4 4 4" /></svg></span>;
  return <span className="route-symbol"><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M2 14h22m0 0-5-5m5 5-5 5" /></svg></span>;
}

const CORPUS_DEVICE_CATEGORIES = [
  ["Plugins", "♜", "#40ef78"], ["Amp", "▭", "#ff424c"], ["Neural Capture", "◉", "#e8e8e8"],
  ["Cab", "⊙", "#7257ff"], ["Overdrive", "∿", "#ff7900"], ["Delay", "〰", "#00e7d6"],
  ["Reverb", "◇", "#35b9ff"], ["Compressor", "↕", "#e7d329"], ["Pitch", "≋", "#ef55cb"],
  ["Modulation", "≈", "#a95cff"], ["Utility", "⌁", "#efefef"]
] as const;
const CORPUS_OVERDRIVE_MODELS = ["Exotic Z Boost", "81 Creations Drive", "Brit Blues", "Brit Governor", "Chief BD2", "Chief DS1", "Chief MT", "Chief OD1", "Chief SD1", "Exotic", "Facial Fuzz", "Freeman BOD"];

function CorOsOfficialGrid({ snapshot, children }: { snapshot: PresetSnapshot; children?: ReactNode }) {
  const columns = [101, 187, 272, 357, 443, 529, 615, 701];
  const rowY = [147, 241, 335, 429];
  const screenBlocks = snapshot.blocks.filter((block) => block.row >= 0 && block.row < 4 && block.column >= 0 && block.column < 8);
  const routes = rowY.map((_, row) => snapshot.routes.find((route) => route.row === row));
  const routeLines = (label: string | undefined) => {
    const value = label || "+";
    const words = value.split(" ");
    return words.length > 1 ? [words[0], words.slice(1).join(" ")] : [value];
  };
  const railLabel = (label: string | undefined, x: number, y: number) => {
    const lines = routeLines(label);
    if ((label || "+") === "+") return <g stroke="#dedede" strokeWidth="1.7" strokeLinecap="round"><path d={`M${x - 10} ${y}h20`} /><path d={`M${x} ${y - 10}v20`} /></g>;
    return <text x={x} y={y - (lines.length - 1) * 8.5} fill="#e6e6e6" stroke="none" fontFamily="Helvetica Neue, Helvetica, Arial, sans-serif" fontWeight="400" fontSize="14.5">{lines.map((line, index) => <tspan key={`${line}-${index}`} x={x} dy={index ? 17 : 0}>{line}</tspan>)}</text>;
  };
  return <div className="qc-screen coros-vector-screen" aria-label="CorOS Grid">
    <svg className="coros-vector-canvas" viewBox="0 0 800 480" preserveAspectRatio="none" role="img" aria-label={`${snapshot.presetLocation} ${snapshot.presetName}, ${snapshot.mode} mode`}>
      <rect width="800" height="480" fill="#020202" />
      <text x="14" y="76" fill="#f4f4f4" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="64"><tspan letterSpacing="-2">{snapshot.presetLocation.slice(0, -1)}</tspan><tspan fill="#2df36a" letterSpacing="-2">{snapshot.presetLocation.slice(-1)}</tspan><tspan dx="14" fill="#f4f4f4" letterSpacing="-2">{snapshot.presetName}</tspan></text>
      <g fill="none" stroke="#f0f0f0" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M620 13A13 13 0 1 1 607 26" /><path d="M613 15L621 9V20Z" fill="#f0f0f0" stroke="none" /></g>
      <g transform="translate(-7 0)" fill="#f0f0f0"><path d="M726 23H715V17H721V20H723V17H726V23Z" /><path d="M733 17.9863V23.7568C732.398 23.2743 731.726 22.8769 731 22.583V18.8047L727.252 15H714.001C713.448 15 713 15.4477 713 16V32C713 32.5523 713.448 33 714.001 33H720.584C720.878 33.7258 721.274 34.3984 721.757 35H714.002C712.344 34.9999 711 33.6568 711 32V16C711 14.3432 712.344 13.0001 714.002 13H728.09L733 17.9863Z" /></g>
      <g className="grid-scene-badge"><rect x="656" y="12" width="25" height="25" rx="3" fill="#f2cf32" /><text x="668.5" y="33" textAnchor="middle" fill="#141414" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="22">A</text></g>
      <g fill="#f2f2f2"><circle cx="766" cy="15" r="2.2" /><circle cx="766" cy="25" r="2.2" /><circle cx="766" cy="35" r="2.2" /></g>
      <g transform="translate(657 55)"><ModeGlyph mode={snapshot.mode} /></g><text x="693" y="78" fill="#f0f0f0" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="21.5">{snapshot.mode}</text>
      <g fill="#171719" stroke="#050505" strokeWidth="1.5" fontFamily="Helvetica Neue, Helvetica, Arial, sans-serif" textAnchor="middle">
        {rowY.flatMap((y, row) => [<rect key={`in-${row}`} x="8" y={y - 39} width="44" height="78" rx="15" />, <rect key={`out-${row}`} x="748" y={y - 39} width="44" height="78" rx="15" />])}
        {rowY.map((y, row) => <g key={`rails-${row}`}>{railLabel(routes[row]?.input, 30, y)}{railLabel(routes[row]?.output, 770, y)}</g>)}
      </g>
      <g fill="none" stroke="#8f9092" strokeWidth="1.4">{rowY.map((y, row) => screenBlocks.some((block) => block.row === row) ? <path key={row} d={`M52 ${y}H748`} /> : null)}</g>
      <g aria-hidden="true">
        {[[53, 147, false], [587, 147, false], [159, 335, true]].map(([x, y, dimmed]) => <g key={`${x}-${y}`} transform={`translate(${x} ${y})`} opacity={dimmed ? .42 : 1}><rect x="-8" y="-7" width="16" height="14" rx="5" fill="#f1f2f1" /><circle cx="-3" cy="0" r="2" fill="#171917" /><path d="M0-3 5 0 0 3Z" fill="#171917" /></g>)}
      </g>
      <g>{screenBlocks.map((block) => { const cx = columns[block.column]; const cy = rowY[block.row]; return <g key={block.id} opacity={block.bypassed ? .48 : 1}><DeviceGlyph block={block} x={cx} y={cy} />{block.bypassed && <path d={`M${cx - 32} ${cy}H${cx + 32}`} fill="none" stroke="#c9c9ca" strokeWidth="2" opacity=".9" />}</g>; })}</g>
    </svg>{children}
  </div>;
}

function CorOsCorpusDeviceBrowser({ snapshot, view }: { snapshot: PresetSnapshot; view: "corpus-device-browser-root" | "corpus-device-browser-models" | "corpus-device-browser-models-clean" }) {
  const models = view !== "corpus-device-browser-root";
  return <CorOsOfficialGrid snapshot={snapshot}>
    <button className="coros-device-dismiss" aria-label="Close device browser" />
    <section className="coros-device-browser" aria-label="Virtual Device browser">
      <nav>{CORPUS_DEVICE_CATEGORIES.map(([label, glyph, color]) => <button key={label} className={models && label === "Overdrive" ? "is-active" : ""} style={{ "--device-color": color } as CSSProperties}><i><DeviceCategoryGlyph label={label} fallback={glyph} /></i><span>{label}</span>{label === "Delay" && <b>New</b>}</button>)}</nav>
      {models && <div className="coros-device-models"><header><button className="is-active">GUITAR</button><button>BASS</button></header>{CORPUS_OVERDRIVE_MODELS.map((model, index) => <button key={model}><span>{index === 0 ? <b className="device-model-pin"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 2 8 8-4 1-4 4v4l-2 2-3-6-6-3 2-2h4l4-4Z" /></svg></b> : null}{model}</span><i><DevicePresetGlyph /></i></button>)}</div>}
    </section>
    {models && view !== "corpus-device-browser-models-clean" && <aside className="coros-device-preset-tip"><button aria-label="Dismiss Virtual Device Presets tip">×</button><strong>VIRTUAL DEVICE PRESETS</strong><span>Tap ▱ next to each virtual device to access its Factory and User Presets.</span></aside>}
  </CorOsOfficialGrid>;
}

export function CorOsScreenFixture({ view, snapshot, onClose = () => undefined }: { view: CorOsScreenView; snapshot: PresetSnapshot; onClose?: () => void }) {
  if (view === "grid-official-brit") return <CorOsOfficialGrid snapshot={snapshot} />;
  if (view === "corpus-device-browser-root" || view === "corpus-device-browser-models" || view === "corpus-device-browser-models-clean") return <CorOsCorpusDeviceBrowser snapshot={snapshot} view={view} />;
  if (view.startsWith("fixture-")) return <CorOsRemainingFixture view={view as RemainingFixtureView} />;
  if (view.startsWith("recovery-") || view.startsWith("overlay-")) return <CorOsSystemFixture view={view as SystemFixtureView} />;
  if (view === "tuner-live-enabled") return <CorOsTuner liveTuner onClose={onClose} />;
  if (view.startsWith("gig-official-")) return <CorOsOfficialGig mode={view.replace("gig-official-", "") as OfficialGigMode} />;
  if (view === "device-presets-official") return <CorOsDevicePresetScreen view="official-factory" />;
  if (view === "gig" || view === "gig-live-tuner") return <CorOsGigView snapshot={snapshot} liveTuner={view === "gig-live-tuner"} onClose={onClose} />;
  if (view === "tuner") return <CorOsTuner onClose={onClose} />;
  if (view === "tempo") return <CorOsTempo bpm={snapshot.tempo} onClose={onClose} />;
  if (view === "midi-out") return <CorOsMidiOut onClose={onClose} />;
  if (view === "cpu-monitor") return <CorOsCpuMonitor snapshot={snapshot} onClose={onClose} />;
  if (view === "global-eq") return <CorOsGlobalEq onClose={onClose} />;
  if (view.startsWith("io-")) return <CorOsIoSettings initialView={view.slice(3) as IoView} onClose={onClose} />;
  if (view === "power-overlay") return <CorOsPowerOverlay onClose={onClose} />;
  if (view === "device-browser-amp-official" || view === "plugin-devices-official") return <CorOsOfficialDeviceBrowser plugins={view === "plugin-devices-official"} />;
  if (view === "device-preset-actions-official") return <CorOsDevicePresetScreen view="official-actions" />;
  if (view === "modes-official") return <CorOsOfficialModes onClose={onClose} />;
  if (view === "splitter-placement" || view === "splitter-editor" || view === "mixer-editor" || view === "empty-slot") return <CorOsRoutingScreen view={view} snapshot={snapshot} />;
  if (view === "device-search" || view === "device-favorites" || view === "plugin-folders" || view === "plugin-list" || view === "plugin-models" || view === "plugin-locked" || view === "plugin-refresh") return <CorOsDeviceBrowserFixture view={view} />;
  if (view === "looper-editor") return <CorOsLooperEditor />;
  if (view === "device-presets" || view === "device-presets-user" || view === "device-preset-actions" || view === "device-preset-save") return <CorOsDevicePresetScreen save={view === "device-preset-save"} view={view === "device-presets-user" ? "user" : view === "device-preset-actions" ? "actions" : "factory"} />;
  if (view === "stomp-assignment" || view === "scene-assignment" || view === "expression-parameter" || view === "expression-bypass") return <CorOsAssignmentScreen view={view} />;
  if (view === "block-context") return <CorOsBlockContext />;
  if (view.startsWith("directory-")) return (["directory-presets", "directory-captures", "directory-irs", "directory-plugins", "directory-favorites", "directory-search-results", "directory-nested", "directory-cloud-upload"] as string[]).includes(view) ? <CorOsOfficialDirectory view={view as OfficialDirectoryView} /> : <CorOsDirectoryFixture view={view as DirectoryFixtureView} />;
  if (view.startsWith("capture-")) return <CorOsCaptureFixture view={view as CaptureFixtureView} />;
  if (view.startsWith("settings-")) return <CorOsSettingsFixture view={view as SettingsFixtureView} />;
  if (view === "modes") return <CorOsModesConfiguration onClose={onClose} />;
  if (view === "save-as") return <CorOsSaveAs onClose={onClose} />;
  if (view === "edit-details") return <CorOsPresetNameEditor snapshot={snapshot} onClose={onClose} />;
  return null;
}
