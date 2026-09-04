import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { BlockParameter } from "../packages/typescript/qc-client/src/index.ts";
import { parameterControlKind, parameterDisplay, parameterEditorAccent, parameterEditorFamily, parameterEditorPageCount, parameterEditorPageSize, parameterEditorPageSlots, parameterEditorTabs, parameterStep } from "../packages/typescript/qc-ui/src/parameter-model.ts";

type CatalogParameter = { index: number; name: string; kind: string; unit: string };
type CatalogModel = { id: number; name: string; category: string; parameterSet: string; constants: string[]; parameters: CatalogParameter[] };
type CatalogAudit = {
  provenance: { source: string; commit: string };
  summary: { mappedModels: number; parameterSets: number; parameters: number; kinds: string[] };
  exceptions: { unknownKinds: unknown[]; duplicateParameterIndexes: unknown[]; unnamedParameters: unknown[]; modelsWithoutConstants: unknown[] };
  models: CatalogModel[];
};

const audit = JSON.parse(readFileSync(new URL("../docs/reference/qc-parameter-catalog.json", import.meta.url), "utf8")) as CatalogAudit;
const liveAudit = JSON.parse(readFileSync(new URL("../docs/reference/qc-live-parameter-scales.json", import.meta.url), "utf8")) as {
  audit: { modelCount: number; parameterCount: number; visibleModelCount: number; visibleParameterCount: number; unresolved: unknown[] };
  models: Array<{ id: number; name: string; category: string; hidden: boolean; parameters: Array<{ index: number; name: string; type: string; options: string[]; screenVisible: boolean; displayPosition: number; displayPositionSource: "device" | "declared-order" | "coros-4.1-erratum"; enableWhenOn: number | null; enableWhenOff: number | null; enableWhenSteps: number[]; expressionAssignable: boolean; linkedSceneMode: number | null }> }>;
};
const selectableKinds = new Set(["comboBox", "empty", "rotarySwitch", "string"]);
const binaryKinds = new Set(["switch", "toggleButton"]);

function synthetic(parameter: CatalogParameter): BlockParameter {
  const options = binaryKinds.has(parameter.kind) ? ["OFF", "ON"] : selectableKinds.has(parameter.kind) ? ["A", "B", "C"] : [];
  const units = ({ Db: "dB", Percent: "%", Hertz: "Hz", Milliseconds: "ms", Seconds: "s", Semitones: "st", Cents: "cents" } as Record<string, string>)[parameter.unit] ?? "";
  return {
    index: parameter.index,
    name: parameter.name,
    normalizedValue: .5,
    displayValue: "",
    units,
    type: parameter.kind,
    minimum: units === "dB" ? -60 : 0,
    maximum: units === "Hz" ? 20000 : units === "ms" ? 5000 : units === "st" ? 24 : 100,
    steps: options.length || null,
    sceneMode: false,
    options,
    writable: parameter.kind !== "grMeter",
    expression: null,
    expressionMinimum: null,
    expressionMaximum: null,
  };
}

test("the generated QC reference has no structural catalog exceptions", () => {
  assert.match(audit.provenance.source, /stokes-audio\/pyquadcortex/);
  assert.match(audit.provenance.commit, /^[0-9a-f]{40}$/);
  assert.equal(audit.summary.mappedModels, 272);
  assert.equal(audit.summary.parameterSets, 279);
  assert.equal(audit.summary.parameters, 2376);
  assert.deepEqual(audit.exceptions, {
    unknownKinds: [], duplicateParameterIndexes: [], unnamedParameters: [], modelsWithoutConstants: []
  });
});

test("every catalog model produces a complete, bounded editor and encoder-page plan", () => {
  let auditedParameters = 0;
  for (const model of audit.models) {
    assert.ok(model.name.trim(), `model ${model.id} has a display name`);
    assert.notEqual(parameterEditorFamily(model.category), undefined);
    assert.deepEqual(model.parameters.map((parameter) => parameter.index), [...model.parameters].sort((left, right) => left.index - right.index).map((parameter) => parameter.index), `${model.name} parameter order`);

    const parameters = model.parameters.map(synthetic);
    const pageSize = parameterEditorPageSize(model.category, parameters);
    assert.ok(pageSize > 0 && pageSize <= 10, `${model.name} uses at most ten physical encoders per page`);
    const pageCount = Math.max(1, Math.ceil(parameters.length / pageSize));
    const tabs = parameterEditorTabs(model.name, model.category, pageCount);
    assert.equal(tabs.length, pageCount > 1 ? pageCount : 0, `${model.name} tab count`);
    const paged = Array.from({ length: pageCount }, (_, page) => parameters.slice(page * pageSize, page * pageSize + pageSize)).flat();
    assert.deepEqual(paged.map((parameter) => parameter.index), parameters.map((parameter) => parameter.index), `${model.name} pages neither drop nor duplicate parameters`);

    for (const parameter of parameters) {
      assert.ok(audit.summary.kinds.includes(parameter.type), `${model.name} ${parameter.name} has a known catalog type`);
      assert.ok(["knob", "select", "switch", "button", "fader", "meter"].includes(parameterControlKind(parameter)), `${model.name} ${parameter.name} has a renderer`);
      assert.ok(Number.isFinite(parameterStep(parameter)) && parameterStep(parameter) > 0, `${model.name} ${parameter.name} has a usable increment`);
      assert.ok(parameterDisplay(parameter, .5).length > 0, `${model.name} ${parameter.name} has a display value`);
      auditedParameters += 1;
    }
  }
  assert.equal(auditedParameters, audit.summary.parameters);
});

test("all specialized catalog primitives map to their dedicated controls", () => {
  const byKind = new Map(audit.models.flatMap((model) => model.parameters).map((parameter) => [parameter.kind, synthetic(parameter)]));
  assert.equal(parameterControlKind(byKind.get("fader")!), "fader");
  assert.equal(parameterControlKind(byKind.get("grMeter")!), "meter");
  assert.equal(parameterControlKind(byKind.get("toggleButton")!), "button");
  assert.equal(parameterControlKind(byKind.get("floatWithLed")!), "knob");
  assert.equal(parameterEditorPageSize("Equalizer", [byKind.get("fader")!]), 10);
  assert.equal(parameterEditorAccent("Adaptive Gate", "#ffd236"), "#f4f4f4");
});

test("every connected-device model uses its ModelRepo main-screen position", () => {
  assert.equal(liveAudit.models.length, 633);
  assert.equal(liveAudit.models.flatMap((model) => model.parameters).length, 8851);
  assert.deepEqual(liveAudit.audit, {
    modelCount: 633, parameterCount: 8851, visibleModelCount: 598,
    visibleParameterCount: 6903, mainScreenParameterCount: 4570,
    explicitDisplayPositionCount: 3447, knownScaleCount: 8851, unresolved: []
  });
  assert.deepEqual(liveAudit.audit.unresolved, []);
  const duplicateLayouts: string[] = [];
  const controlTypes = new Map<string, number>();
  const expectedControl = new Map<string, ReturnType<typeof parameterControlKind>>([
    ["float", "knob"], ["floatWithLed", "knob"], ["rotarySwitch", "knob"],
    ["comboBox", "select"], ["string", "select"], ["switch", "switch"],
    ["toggleButton", "button"], ["fader", "fader"], ["grMeter", "meter"],
  ]);
  for (const model of liveAudit.models) {
    assert.ok(model.name.trim(), `model ${model.id} has a display name`);
    assert.equal(new Set(model.parameters.map((parameter) => parameter.index)).size, model.parameters.length, `${model.name} has unique indexes`);
    const mainScreen = model.parameters.filter((parameter) => parameter.screenVisible);
    const positions = new Set<number>();
    for (const parameter of mainScreen) {
      controlTypes.set(parameter.type, (controlTypes.get(parameter.type) ?? 0) + 1);
      assert.equal(parameterControlKind(parameter), expectedControl.get(parameter.type), `${model.name} ${parameter.name} preserves ModelRepo type ${parameter.type}`);
      if (positions.has(parameter.displayPosition)) duplicateLayouts.push(`${model.id}:${model.name}:${parameter.displayPosition}`);
      positions.add(parameter.displayPosition);
      assert.ok(parameter.displayPosition >= 0, `${model.name} ${parameter.name} has a nonnegative display position`);
    }
    const pageCount = parameterEditorPageCount(mainScreen, 10);
    for (let page = 0; page < pageCount; page += 1) {
      const pageParameters = mainScreen.filter((parameter) => Math.floor(parameter.displayPosition / 10) === page);
      const screenSlots = parameterEditorPageSlots(mainScreen, page, 10);
      assert.equal(screenSlots.length, 10, `${model.name} page ${page + 1} has ten physical positions`);
      pageParameters.forEach((parameter) => {
        const collision = pageParameters.filter((candidate) => candidate.displayPosition === parameter.displayPosition).length > 1;
        if (!collision) assert.equal(screenSlots[parameter.displayPosition % 10], parameter, `${model.name} ${parameter.name} uses displayPos ${parameter.displayPosition}`);
      });
    }
  }
  assert.deepEqual(duplicateLayouts, [
    "18007:Minivoicer:3",
    "18007:Minivoicer:8",
    "32089:Petrucci Cab (ST):3",
  ]);
  assert.deepEqual(Object.fromEntries([...controlTypes].sort()), {
    comboBox: 45, fader: 48, float: 3932, floatWithLed: 2, grMeter: 27,
    rotarySwitch: 152, switch: 360, toggleButton: 4,
  });
});

test("all ModelRepo expression and linked scene-state declarations are retained", () => {
  const parameters = liveAudit.models.flatMap((model) => model.parameters);
  assert.equal(parameters.filter((parameter) => parameter.expressionAssignable === false).length, 37);
  assert.equal(parameters.filter((parameter) => parameter.linkedSceneMode != null).length, 44);
  for (const model of liveAudit.models) {
    const indexes = new Set(model.parameters.map((parameter) => parameter.index));
    for (const parameter of model.parameters) {
      if (parameter.linkedSceneMode != null) assert.ok(indexes.has(parameter.linkedSceneMode), `${model.name} ${parameter.name} linked scene-mode parameter exists`);
    }
  }
});

test("every dedicated full-screen editor covers all QC-visible parameter indexes", () => {
  const cabIndexes = new Set([2, 3, 4, 5, 10, 11, 12, 13]);
  const irIndexes = new Set([3, 4, 5, 6, 7, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  for (const model of liveAudit.models.filter((candidate) => !candidate.hidden)) {
    const visible = model.parameters.filter((parameter) => parameter.screenVisible);
    if (/cabsim/i.test(model.category)) {
      visible.forEach((parameter) => assert.ok(cabIndexes.has(parameter.index), `${model.name} ${parameter.name} is represented by the Cab screen`));
    } else if (/irloaders/i.test(model.category)) {
      visible.forEach((parameter) => assert.ok(irIndexes.has(parameter.index), `${model.name} ${parameter.name} is represented by the IR Loader screen`));
    } else if (/equalizer/i.test(model.category)) {
      const numberedBands = visible.filter((parameter) => /^\d+\s+(?:GAIN|FREQ|Q|TYPE|BYPASS)$/i.test(parameter.name));
      const graphicBands = visible.filter((parameter) => /^(?:65|125|250|500|1K|2K|4K|8K|16K)HZ$/i.test(parameter.name.replace(/\s/g, "")));
      if (numberedBands.length) {
        assert.ok(visible.every((parameter) => numberedBands.includes(parameter) || /^OUTPUT$/i.test(parameter.name)), `${model.name} uses selected-band controls plus Output`);
      } else if (graphicBands.length >= 5) {
        assert.ok(visible.length - graphicBands.length <= 4, `${model.name} auxiliary pane holds every non-band control`);
      } else {
        assert.ok(visible.length <= 10, `${model.name} full-screen fallback holds every control`);
      }
    }
  }
});

test("every ModelRepo parameter dependency references a controller in the same model", () => {
  let onDependencies = 0;
  let offDependencies = 0;
  let steppedDependencies = 0;
  for (const model of liveAudit.models) {
    const indexes = new Set(model.parameters.map((parameter) => parameter.index));
    for (const parameter of model.parameters) {
      for (const controller of [parameter.enableWhenOn, parameter.enableWhenOff]) {
        if (controller != null) assert.ok(indexes.has(controller), `${model.name} ${parameter.name} dependency controller ${controller} exists`);
      }
      if (parameter.enableWhenOn != null) onDependencies += 1;
      if (parameter.enableWhenOff != null) offDependencies += 1;
      if (parameter.enableWhenSteps.length) {
        steppedDependencies += 1;
        assert.ok(parameter.enableWhenOn != null || parameter.enableWhenOff != null, `${model.name} ${parameter.name} stepped dependency has a controller`);
      }
    }
  }
  assert.deepEqual({ onDependencies, offDependencies, steppedDependencies }, { onDependencies: 164, offDependencies: 122, steppedDependencies: 14 });

  const flangerish = liveAudit.models.find((model) => model.id === 7003)!;
  const rate = flangerish.parameters.find((parameter) => parameter.name === "RATE")!;
  const syncNote = flangerish.parameters.find((parameter) => parameter.name === "SYNC NOTE")!;
  assert.equal(rate.enableWhenOff, 6);
  assert.equal(syncNote.enableWhenOn, 6);
  assert.deepEqual(syncNote.enableWhenSteps, []);
});
