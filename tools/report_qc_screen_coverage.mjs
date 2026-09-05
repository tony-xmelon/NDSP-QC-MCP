import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const paths = {
  coverage: option("--coverage", "references/qc-ui-coverage/coros-4.1.0/coverage.json"),
  inventory: option("--inventory", "docs/qc-screen-inventory.md"),
  physicalWindows: option("--physical-windows"),
  physicalAndroid: option("--physical-android"),
  officialWindows: option("--official-windows"),
  officialAndroid: option("--official-android"),
  output: option("--output", ".artifacts/qc-screen-coverage-matrix.md"),
};

const readText = (path) => readFileSync(resolve(ROOT, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));
const coverage = readJson(paths.coverage);
const inventory = readText(paths.inventory);

const inventoryRows = new Map(
  [...inventory.matchAll(/^\| ((?:GL|IO|GR|DB|ED|DR|NC|ST|RC|OV)-\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => [match[1], {
      family: match[2].trim(),
      screen: match[3].trim(),
      reference: match[4].trim(),
      windows: match[5].trim(),
      android: match[6].trim(),
    }]),
);

const loadSummary = (path) => {
  if (!path) return undefined;
  const summary = readJson(path);
  return {
    ...summary,
    byId: new Map(summary.screens.map((screen) => [screen.id, screen])),
  };
};

const summaries = {
  physicalWindows: loadSummary(paths.physicalWindows),
  physicalAndroid: loadSummary(paths.physicalAndroid),
  officialWindows: loadSummary(paths.officialWindows),
  officialAndroid: loadSummary(paths.officialAndroid),
};

const percent = (value) => value == null ? "—" : `${(value * 100).toFixed(2)}%`;
const mean = (values) => values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
const score = (summary, ids) => {
  if (!summary || !ids?.length) return "—";
  const values = ids.map((id) => summary.byId.get(id)?.edge_f1_2px).filter((value) => value != null);
  return percent(mean(values));
};
const color = (summary, ids) => {
  if (!summary || !ids?.length) return "—";
  const values = ids.map((id) => summary.byId.get(id)?.mae).filter((value) => value != null);
  const meanMae = mean(values);
  return meanMae == null ? "—" : percent(1 - meanMae);
};

const evidenceTier = (state) => {
  const tiers = [];
  if (state.physical?.length) tiers.push("physical frame");
  if (state.official?.length) tiers.push("official frame");
  if (state.officialDetail?.length) tiers.push("official detail");
  return tiers.length ? tiers.join(" + ") : "smoke only";
};

const rows = coverage.states.map((state) => {
  const inventoryRow = inventoryRows.get(state.id);
  if (!inventoryRow) throw new Error(`Inventory row missing for ${state.id}`);
  return {
    ...state,
    ...inventoryRow,
    tier: evidenceTier(state),
    physicalWindows: score(summaries.physicalWindows, state.physical),
    physicalAndroid: score(summaries.physicalAndroid, state.physical),
    physicalWindowsColor: color(summaries.physicalWindows, state.physical),
    physicalAndroidColor: color(summaries.physicalAndroid, state.physical),
    officialWindows: score(summaries.officialWindows, state.official),
    officialAndroid: score(summaries.officialAndroid, state.official),
    officialWindowsColor: color(summaries.officialWindows, state.official),
    officialAndroidColor: color(summaries.officialAndroid, state.official),
  };
});

const fullFrame = rows.filter((row) => row.physical?.length || row.official?.length);
const detailed = rows.filter((row) => row.officialDetail?.length && !(row.physical?.length || row.official?.length));
const smokeOnly = rows.filter((row) => !(row.physical?.length || row.official?.length || row.officialDetail?.length));
const familyCounts = new Map();
for (const row of rows) {
  const value = familyCounts.get(row.family) ?? { total: 0, full: 0, detail: 0, smoke: 0 };
  value.total += 1;
  if (row.physical?.length || row.official?.length) value.full += 1;
  else if (row.officialDetail?.length) value.detail += 1;
  else value.smoke += 1;
  familyCounts.set(row.family, value);
}

const aggregateRow = (label, windows, android) => {
  if (!windows && !android) return `| ${label} | — | — | — | — |`;
  return `| ${label} | ${percent(windows?.meanEdgeF1_2px)} | ${percent(windows && 1 - windows.meanMae)} | ${percent(android?.meanEdgeF1_2px)} | ${percent(android && 1 - android.meanMae)} |`;
};

const lines = [
  "# Quad Cortex canonical screen coverage matrix",
  "",
  `Generated from the CorOS ${coverage.corosVersion} executable coverage ledger. This report distinguishes implemented render paths from authoritative visual evidence; a smoke-only row has no defensible visual-match percentage yet.`,
  "",
  "## Coverage summary",
  "",
  `- Canonical device states: **${rows.length}/${rows.length}** routed through the shared Windows/Android surface.`,
  `- Full-frame authoritative evidence: **${fullFrame.length}/${rows.length}** states.`,
  `- Official-detail-only evidence: **${detailed.length}/${rows.length}** states.`,
  `- Smoke-only evidence gaps: **${smokeOnly.length}/${rows.length}** states.`,
  `- Exact-size dual-host capture paths: **${rows.length}/${rows.length}** states.`,
  "",
  "| Corpus | Windows structural | Windows color | Android structural | Android color |",
  "| --- | ---: | ---: | ---: | ---: |",
  aggregateRow("Physical device", summaries.physicalWindows, summaries.physicalAndroid),
  aggregateRow("Official manual", summaries.officialWindows, summaries.officialAndroid),
  "",
  "Scores are edge-F1 structural match with a two-pixel tolerance and `1 - MAE` color similarity. A canonical state that references multiple frames reports their mean. Detail evidence is scoped and therefore never promoted into a full-frame score.",
  "",
  "## Evidence by family",
  "",
  "| Family | States | Full frame | Detail only | Smoke only |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...[...familyCounts].map(([family, counts]) => `| ${family} | ${counts.total} | ${counts.full} | ${counts.detail} | ${counts.smoke} |`),
  "",
  "## All canonical device states",
  "",
  "| ID | Family | Screen/state | Evidence | Windows | Android | Physical structural W/A | Physical color W/A | Official structural W/A | Official color W/A |",
  "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
  ...rows.map((row) => `| ${row.id} | ${row.family} | ${row.screen} | ${row.tier} | ${row.windows} | ${row.android} | ${row.physicalWindows} / ${row.physicalAndroid} | ${row.physicalWindowsColor} / ${row.physicalAndroidColor} | ${row.officialWindows} / ${row.officialAndroid} | ${row.officialWindowsColor} / ${row.officialAndroidColor} |`),
  "",
  "## Authoritative evidence gaps",
  "",
  "These states are implemented and captured on both hosts, but only against deterministic reconstruction fixtures. They require a physical framebuffer or an official visual before a visual-match percentage is meaningful.",
  "",
  "| ID | Family | Screen/state | Renderer | Dual-host smoke view |",
  "| --- | --- | --- | --- | --- |",
  ...smokeOnly.map((row) => `| ${row.id} | ${row.family} | ${row.screen} | \`${row.renderer}\` | \`${(row.smoke ?? []).join(", ")}\` |`),
  "",
  "## Score source files",
  "",
  ...Object.entries({
    "Physical Windows": paths.physicalWindows,
    "Physical Android": paths.physicalAndroid,
    "Official Windows": paths.officialWindows,
    "Official Android": paths.officialAndroid,
  }).map(([label, path]) => `- ${label}: ${path ? `\`${path}\`` : "not supplied"}`),
  "",
];

const outputPath = resolve(ROOT, paths.output);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${paths.output}: ${rows.length} states, ${fullFrame.length} full-frame, ${detailed.length} detail-only, ${smokeOnly.length} smoke-only`);
