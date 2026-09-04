#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import {
  CASES,
  actionPlan,
  assertDisposableSlots,
  assertMutationAcknowledged,
  contractDigest,
  gatewayArguments,
  pngSignatureIsValid,
  redactEvidence,
  resultSnapshot,
  validateConfig,
  validateCoverage
} from "./hardware-conformance-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const contract = JSON.parse(await readFile(resolve(root, "contracts/qc-actions.v1.json"), "utf8"));
const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (name) => argv.includes(name);
const configPath = resolve(option("--config") ?? resolve(root, "tools/hardware-conformance.example.json"));
const execute = has("--execute");
const discover = has("--discover");
const prepare = has("--prepare");
const requireAll = has("--require-all");
const enabledHazards = new Set(["read"]);
if (has("--live")) enabledHazards.add("live");
if (has("--persistent")) enabledHazards.add("persistent");
if (has("--system")) enabledHazards.add("system");
if (has("--screen-tap")) enabledHazards.add("screen");
if (has("--all")) ["live", "persistent", "system", "screen"].forEach((value) => enabledHazards.add(value));

class FramedStdioTransport {
  constructor(config) {
    this.config = config;
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
  }

  async start() {
    const command = resolve(root, this.config.command);
    this.child = spawn(command, this.config.args ?? ["--stdio"], { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.once("exit", (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`Gateway exited with code ${code}.`));
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < length + 4) return;
      const response = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8"));
      this.buffer = this.buffer.subarray(length + 4);
      const waiter = this.pending.get(response.id);
      if (!waiter) continue;
      this.pending.delete(response.id);
      clearTimeout(waiter.timeout);
      response.error ? waiter.reject(new Error(`${response.error.code ?? "GATEWAY_ERROR"}: ${response.error.message}`)) : waiter.resolve(response.result);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    return new Promise((resolveRequest, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.config.timeoutMs ?? 60000} ms.`));
      }, this.config.timeoutMs ?? 60000);
      this.pending.set(id, { resolve: resolveRequest, reject, timeout });
      this.child.stdin.write(Buffer.concat([header, body]));
    });
  }

  status() { return this.request("system.status"); }
  call(name, args) {
    const action = contract.actions.find((candidate) => candidate.name === name);
    if (!action) throw new Error(`Unknown action ${name}.`);
    return this.request(action.rpc, gatewayArguments(name, args));
  }
  async close() {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
    child.stdin.end();
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2000))]);
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2000))]);
    }
    if (child.exitCode === null) throw new Error("Gateway process did not exit after transport close.");
  }
}

class McpHttpTransport {
  constructor(config) {
    this.config = config;
    this.nextId = 1;
  }

  async post(method, params, notification = false) {
    const id = notification ? undefined : this.nextId++;
    const bearer = process.env[this.config.bearerTokenEnv ?? "QC_MCP_BEARER_TOKEN"];
    if (!bearer) throw new Error(`Set ${this.config.bearerTokenEnv ?? "QC_MCP_BEARER_TOKEN"} for MCP HTTP testing.`);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": this.config.protocolVersion ?? "2025-03-26"
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const response = await fetch(this.config.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60000)
    });
    if (!response.ok) throw new Error(`MCP ${method} returned HTTP ${response.status}: ${await response.text()}`);
    this.sessionId ??= response.headers.get("mcp-session-id") ?? undefined;
    if (notification) return undefined;
    const text = await response.text();
    const messages = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()))
      : [JSON.parse(text)];
    const message = messages.find((candidate) => candidate.id === id) ?? messages.at(-1);
    if (message?.error) throw new Error(`${message.error.code}: ${message.error.message}`);
    return message?.result;
  }

  async start() {
    await this.post("initialize", {
      protocolVersion: this.config.protocolVersion ?? "2025-03-26",
      capabilities: {},
      clientInfo: { name: "qc-hardware-conformance", version: "1.0.0" }
    });
    await this.post("notifications/initialized", undefined, true);
  }

  async call(name, args) {
    const result = await this.post("tools/call", { name, arguments: args ?? {} });
    if (result?.isError) throw new Error(result.content?.map((item) => item.text).filter(Boolean).join("\n") || `${name} failed.`);
    if (result?.structuredContent !== undefined) return result.structuredContent;
    const text = result?.content?.find((item) => item.type === "text")?.text;
    try { return text ? JSON.parse(text) : result; } catch { return { detail: text ?? `${name} completed.` }; }
  }

  async status() {
    const result = await this.post("resources/read", { uri: "qc://status" });
    const text = result?.contents?.[0]?.text;
    return typeof text === "string" ? JSON.parse(text) : result;
  }

  async close() {
    if (!this.sessionId) return;
    const bearer = process.env[this.config.bearerTokenEnv ?? "QC_MCP_BEARER_TOKEN"];
    await fetch(this.config.endpoint, { method: "DELETE", headers: { Authorization: `Bearer ${bearer}`, "Mcp-Session-Id": this.sessionId } }).catch(() => {});
  }
}

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const timestamp = () => new Date().toISOString();
const uniqueName = (prefix, suffix) => `${prefix}-${Date.now().toString(36)}-${suffix}`.slice(0, 63);
function evidenceFor(name, value) {
  if (name === "get_current_preset") return redactEvidence({ presetName: value?.presetName, presetLocation: value?.presetLocation, presetPosition: value?.presetPosition, setlistKey: value?.setlistKey, activeScene: value?.activeScene, tempo: value?.tempo, masterVolume: value?.masterVolume, dirty: value?.dirty, blockCount: value?.blocks?.length, routeCount: value?.routes?.length });
  if (name === "get_state_events") return { native: value?.native, frameCount: value?.frames?.length ?? 0, latestSequence: value?.frames?.at(-1)?.sequence };
  if (name === "get_block_details") return { row: value?.row, column: value?.column, modelId: value?.modelId, name: value?.name, parameterCount: value?.parameters?.length ?? 0, writableParameterCount: value?.parameters?.filter((parameter) => parameter.writable)?.length ?? 0 };
  if (name === "list_models") return { modelCount: value?.models?.length ?? 0, audit: redactEvidence(value?.audit) };
  if (name === "list_presets") return { presetCount: value?.presets?.length ?? 0, setlistKey: value?.setlistKey };
  if (name === "list_preset_folders") return { folderCount: value?.folders?.length ?? 0 };
  if (name === "list_preset_slots") return { slotCount: value?.slots?.length ?? 0, emptyCount: value?.slots?.filter((slot) => slot.occupied === false)?.length ?? 0 };
  if (name === "capture_screen" || name === "get_preset_screenshot") return { width: value?.width, height: value?.height, pngSignatureValid: pngSignatureIsValid(value, value?.width, value?.height) };
  if (name === "create_device_backup") return { type: value?.type, creator: value?.creator, name: value?.name };
  return redactEvidence(value);
}

async function main() {
  validateCoverage(contract);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const missingFixtures = validateConfig(config, { requireAll });
  const plan = actionPlan(contract, enabledHazards);
  if (!execute) {
    console.log(JSON.stringify({ dryRun: true, contractActions: contract.actions.length, enabledHazards: [...enabledHazards], missingFixtures, plan }, null, 2));
    return;
  }
  if ([...enabledHazards].some((value) => value !== "read")) assertMutationAcknowledged();
  if ((enabledHazards.has("persistent") || enabledHazards.has("system") || enabledHazards.has("screen")) && !enabledHazards.has("live")) {
    throw new Error("Persistent, system, and screen cases require --live because safe scratch-preset entry and restoration use live actions.");
  }
  if (requireAll) {
    assert(enabledHazards.size === 5, "--require-all must be combined with --all.");
    assert(missingFixtures.length === 0, "Full execution requires every fixture.");
  }
  if (enabledHazards.has("persistent")) assertDisposableSlots(config, [config.persistent.slotA, config.persistent.slotB]);

  const transport = config.transport.kind === "gateway-stdio"
    ? new FramedStdioTransport(config.transport)
    : new McpHttpTransport(config.transport);
  if (prepare) {
    if (!execute) throw new Error("--prepare requires --execute.");
    if (discover || [...enabledHazards].some((value) => value !== "read")) throw new Error("--prepare cannot be combined with --discover or mutation-group flags.");
    assertMutationAcknowledged();
    for (const path of ["sourcePreset.setlistKey", "sourcePreset.position", "sourcePreset.expectedName", "scratchPreset.setlistKey", "scratchPreset.position", "scratchPreset.requiredNamePrefix"]) {
      if (path.split(".").reduce((value, key) => value?.[key], config) === undefined) throw new Error(`Fixture preparation requires ${path}.`);
    }
    let initial;
    try {
      await transport.start();
      let status = await transport.status();
      if (status?.phase !== "ready" && status?.connected !== true) await transport.call("reconnect_device", { confirm_risky_operation: true });
      const deadline = Date.now() + 30000;
      while (!initial && Date.now() < deadline) {
        try { initial = await transport.call("get_current_preset", {}); }
        catch { await sleep(250); }
      }
      if (!initial) throw new Error("The QC did not synchronize a starting preset.");
      const identity = await transport.call("get_device_identity", {});
      assert(typeof identity.serial === "string" && identity.serial.endsWith(config.safety.expectedSerialSuffix), "Connected QC serial does not match expectedSerialSuffix.");
      const slots = await transport.call("list_preset_slots", {});
      const target = (slots.slots ?? []).find((slot) => slot.position === config.scratchPreset.position);
      assert(target && (target.occupied === false || !target.name), "Configured scratch destination is not empty; preparation refuses to overwrite it.");
      await transport.call("recall_preset", {
        setlist_key: config.sourcePreset.setlistKey, position: config.sourcePreset.position,
        expected_preset_name: initial.presetName, expected_position: initial.presetPosition
      });
      const source = await transport.call("get_current_preset", {});
      assert(source.presetName === config.sourcePreset.expectedName, "Recalled source preset name does not match expectedName.");
      let selectedBlock;
      let selectedParameter;
      for (const block of source.blocks ?? []) {
        if (!Number.isInteger(block.modelId)) continue;
        const details = await transport.call("get_block_details", { row: block.row, column: block.column, expected_preset_name: source.presetName });
        const candidate = details.parameters?.find((parameter) => parameter.writable && parameter.enabled && Number.isFinite(parameter.normalizedValue));
        if (candidate) { selectedBlock = block; selectedParameter = candidate; break; }
      }
      assert(selectedBlock && selectedParameter, "Source preset has no writable parameter suitable for reversible testing.");
      const occupied = new Set((source.blocks ?? []).map((block) => `${block.row}:${block.column}`));
      let emptyPair;
      for (let row = 3; row >= 0 && !emptyPair; row -= 1) {
        const empty = Array.from({ length: 8 }, (_, column) => column).filter((column) => !occupied.has(`${row}:${column}`));
        if (empty.length >= 2) emptyPair = { row, addColumn: empty.at(-2), moveColumn: empty.at(-1) };
      }
      assert(emptyPair, "Source preset has no row with two empty cells for add/move/remove testing.");
      await transport.call("save_preset_as", {
        setlist_key: config.scratchPreset.setlistKey, position: config.scratchPreset.position,
        name: config.scratchPreset.requiredNamePrefix, expected_preset_name: source.presetName,
        expected_position: source.presetPosition, confirm_overwrite: false, confirm_persistent_write: true
      });
      const saved = await transport.call("get_current_preset", {});
      assert(saved.presetPosition === config.scratchPreset.position && saved.presetName.startsWith(config.scratchPreset.requiredNamePrefix), "Prepared scratch preset did not verify at its destination.");
      const route = saved.routes?.find((candidate) => candidate.inputId > 0 && candidate.outputId > 0)
        ?? saved.routes?.[0];
      assert(route, "Prepared scratch preset has no route suitable for reversible routing tests.");
      const modelCatalog = await transport.call("list_models", { query: null });
      const temporaryModel = modelCatalog.models?.find((model) => model.category === "Compressor")
        ?? modelCatalog.models?.find((model) => !["Utility", "Input", "Output", "Cab", "Bass Cab"].includes(model.category));
      assert(Number.isInteger(temporaryModel?.id), "Model catalog has no placement-safe temporary block candidate.");
      const originalValue = selectedParameter.normalizedValue;
      const testValue = Math.abs(originalValue - 0.55) >= 0.1 ? 0.55 : 0.35;
      console.log(JSON.stringify({
        prepared: true,
        target: config.target,
        scratchPreset: config.scratchPreset,
        suggestedFixtures: {
          presetScreenshot: { folderName: saved.setlistName, position: saved.presetPosition, isFactory: false },
          parameter: { row: selectedBlock.row, column: selectedBlock.column, index: selectedParameter.index, testValue },
          temporaryBlock: { modelId: temporaryModel.id, modelName: temporaryModel.name, ...emptyPair, footswitch: 7 },
          routing: { row: route.row, testInputId: route.inputId === 1 ? 2 : 1, testOutputId: route.outputId === 1 ? 2 : 1, testSplitColumn: 2, testMixColumn: 6 }
        }
      }, null, 2));
    } finally {
      if (initial) {
        try {
          const current = await transport.call("get_current_preset", {});
          if (current.setlistKey !== initial.setlistKey || current.presetPosition !== initial.presetPosition) {
            await transport.call("recall_preset", {
              setlist_key: initial.setlistKey, position: initial.presetPosition,
              expected_preset_name: current.presetName, expected_position: current.presetPosition
            });
          }
        } catch {}
      }
      await transport.close().catch(() => {});
    }
    return;
  }
  if (discover) {
    if (!execute) throw new Error("--discover requires --execute.");
    if ([...enabledHazards].some((value) => value !== "read")) throw new Error("--discover cannot be combined with mutation flags.");
    try {
      await transport.start();
      let status = await transport.status();
      if (status?.phase !== "ready" && status?.connected !== true) {
        await transport.call("reconnect_device", { confirm_risky_operation: true });
      }
      const deadline = Date.now() + 30000;
      let snapshot;
      while (!snapshot && Date.now() < deadline) {
        try { snapshot = await transport.call("get_current_preset", {}); }
        catch { await sleep(250); }
      }
      if (!snapshot) throw new Error("The QC did not publish a synchronized preset within 30 seconds.");
      status = await transport.status();
      const identity = await transport.call("get_device_identity", {});
      let folders = await transport.call("list_preset_folders", { refresh: true });
      const slots = await transport.call("list_preset_slots", {});
      const models = await transport.call("list_models", { query: null });
      let presets = await transport.call("list_presets", { refresh: false, setlist_key: snapshot.setlistKey });
      const screen = await transport.call("capture_screen", {});
      const libraryDeadline = Date.now() + 10000;
      while (((folders.folders?.length ?? 0) === 0 || (presets.presets?.length ?? 0) === 0) && Date.now() < libraryDeadline) {
        await sleep(500);
        if ((folders.folders?.length ?? 0) === 0) folders = await transport.call("list_preset_folders", { refresh: false });
        if ((presets.presets?.length ?? 0) === 0) presets = await transport.call("list_presets", { refresh: false, setlist_key: snapshot.setlistKey });
      }
      const emptySlots = (slots.slots ?? []).filter((slot) => slot.occupied === false || slot.name === "" || slot.name === "Unsaved").slice(0, 20);
      if (config.discoveryScreenPath && typeof screen.pngBase64 === "string") {
        const screenPath = resolve(root, config.discoveryScreenPath);
        await mkdir(dirname(screenPath), { recursive: true });
        await writeFile(screenPath, Buffer.from(screen.pngBase64, "base64"));
      }
      console.log(JSON.stringify({
        discovery: true,
        target: config.target,
        status: redactEvidence(status),
        identity: { ...redactEvidence(identity), serialSuffix: typeof identity.serial === "string" ? identity.serial.slice(-4) : undefined },
        activePreset: redactEvidence(snapshot),
        folders: redactEvidence(folders.folders ?? []),
        scratchPresetCandidates: redactEvidence((presets.presets ?? []).filter((preset) => preset.name && !/^Unsaved$/i.test(preset.name)).slice(0, 30)),
        candidateDisposableSlots: redactEvidence(emptySlots),
        modelCount: models.models?.length ?? 0
      }, null, 2));
    } finally {
      await transport.close().catch(() => {});
    }
    return;
  }
  const report = {
    schemaVersion: 1,
    startedAt: timestamp(),
    target: config.target,
    transport: config.transport.kind,
    contractVersion: contract.version,
    contractSha256: contractDigest(contract),
    contractActions: contract.actions.length,
    enabledHazards: [...enabledHazards],
    results: []
  };
  let currentSnapshot;
  let originalSnapshot;
  let identity;
  let parameter;
  let originalMasterVolume;
  let transportStarted = false;
  let deviceAuthorized = false;
  let firstScreenTapSent = false;
  const performed = new Set();

  const call = async (name, args = {}, verify) => {
    const metadata = CASES[name];
    if (!metadata) fail(`No physical case metadata for ${name}.`);
    if (!enabledHazards.has(metadata.hazard)) {
      report.results.push({ name, phase: metadata.phase, hazard: metadata.hazard, status: "skipped", reason: `Enable --${metadata.hazard}.` });
      return undefined;
    }
    const started = Date.now();
    process.stdout.write(`RUN ${name} ... `);
    try {
      const value = await transport.call(name, args);
      if (verify) await verify(value);
      performed.add(name);
      report.results.push({ name, phase: metadata.phase, hazard: metadata.hazard, status: "passed", durationMs: Date.now() - started, evidence: evidenceFor(name, value) });
      console.log("PASS");
      return value;
    } catch (error) {
      report.results.push({ name, phase: metadata.phase, hazard: metadata.hazard, status: "failed", durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      console.log("FAIL");
      throw error;
    }
  };
  const snapshot = async () => {
    const value = await transport.call("get_current_preset", {});
    assert(value && Array.isArray(value.blocks) && Array.isArray(value.routes), "Snapshot is missing blocks or routes.");
    currentSnapshot = value;
    return value;
  };
  const waitForSnapshot = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    let value;
    let consecutiveMatches = 0;
    do {
      value = await snapshot();
      consecutiveMatches = predicate(value) ? consecutiveMatches + 1 : 0;
      if (consecutiveMatches >= 2) return value;
      await sleep(100);
    } while (Date.now() < deadline);
    return value;
  };
  const waitForMasterVolume = async (expected, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    let value;
    let consecutiveMatches = 0;
    do {
      value = await transport.call("get_master_volume", {});
      consecutiveMatches = value?.value === expected ? consecutiveMatches + 1 : 0;
      if (consecutiveMatches >= 2) return value;
      await sleep(100);
    } while (Date.now() < deadline);
    return value;
  };
  const waitForBlockDetails = async (row, column, predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    let value;
    let consecutiveMatches = 0;
    do {
      value = await transport.call("get_block_details", {
        row,
        column,
        expected_preset_name: currentSnapshot.presetName
      });
      consecutiveMatches = predicate(value) ? consecutiveMatches + 1 : 0;
      if (consecutiveMatches >= 2) return value;
      await sleep(100);
    } while (Date.now() < deadline);
    return value;
  };
  const waitForLaneControlDetails = async (row, control, predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    let value;
    let consecutiveMatches = 0;
    do {
      value = await transport.call("get_lane_control_details", {
        row,
        control,
        expected_preset_name: currentSnapshot.presetName
      });
      consecutiveMatches = predicate(value) ? consecutiveMatches + 1 : 0;
      if (consecutiveMatches >= 2) return value;
      await sleep(100);
    } while (Date.now() < deadline);
    return value;
  };
  const recall = async (preset, expected = currentSnapshot) => {
    const result = await call("recall_preset", {
      setlist_key: preset.setlistKey,
      position: preset.position,
      expected_preset_name: expected.presetName,
      expected_position: expected.presetPosition
    });
    currentSnapshot = resultSnapshot(result) ?? await snapshot();
    return currentSnapshot;
  };
  const restoreScratch = async () => {
    if (currentSnapshot.dirty) {
      await transport.call("reload_preset", {
        expected_preset_name: currentSnapshot.presetName,
        expected_position: currentSnapshot.presetPosition,
        confirm_risky_operation: true
      });
      currentSnapshot = await waitForSnapshot((value) => !value.dirty);
      assert(!currentSnapshot.dirty, "Scratch preset did not revert before restoration.");
    }
    if (currentSnapshot.setlistKey !== config.scratchPreset.setlistKey || currentSnapshot.presetPosition !== config.scratchPreset.position) {
      await recall(config.scratchPreset);
    }
    assert(currentSnapshot.presetName.startsWith(config.scratchPreset.requiredNamePrefix), "Scratch preset name does not match requiredNamePrefix.");
  };

  try {
    await transport.start();
    transportStarted = true;
    const statusStarted = Date.now();
    const status = await transport.status();
    report.results.push({ name: "system.status", phase: "read", hazard: "read", status: "passed", durationMs: Date.now() - statusStarted, evidence: redactEvidence(status) });
    assert(status?.phase === "ready" || status?.connected === true || status?.gatewayAvailable === true, "Target is not connected and ready.");

    // A freshly spawned local broker reports process availability before its
    // USB session exists. Establishing that session is test setup, not the
    // separately recorded reconnect_device system case.
    if (status?.gatewayAvailable === true && status?.phase === undefined && status?.connected === undefined) {
      await transport.call("reconnect_device", { confirm_risky_operation: true });
    }

    originalSnapshot = await call("get_current_preset", {}, (value) => {
      assert(Array.isArray(value.blocks) && Array.isArray(value.routes), "Preset snapshot is incomplete.");
    });
    currentSnapshot = originalSnapshot;
    identity = await call("get_device_identity", {}, (value) => assert(typeof value.serial === "string" && value.serial.endsWith(config.safety.expectedSerialSuffix), "Connected QC serial does not match expectedSerialSuffix."));
    deviceAuthorized = true;
    await call("get_state_events", { after_sequence: 0, limit: 256 }, (value) => assert(Array.isArray(value.frames), "State event result has no frames array."));
    await call("get_tempo_clock", {}, (value) => assert(typeof value.available === "boolean", "Tempo clock availability is missing."));
    await call("get_inhibited_modules", {}, (value) => assert(typeof value.globalGate === "boolean" && typeof value.globalEq === "boolean", "Inhibited module state is invalid."));
    await call("get_tuner_settings", {}, (value) => assert(
      Number.isInteger(value.inputPortId) && Number.isFinite(value.referenceHz)
        && Number.isFinite(value.referenceOffsetHz) && typeof value.muted === "boolean",
      "Tuner settings are invalid."
    ));
    const capturedScreen = await call("capture_screen", {}, (value) => assert(pngSignatureIsValid(value, 800, 480), "Live screen PNG is invalid."));
    if (config.discoveryScreenPath && typeof capturedScreen?.pngBase64 === "string") {
      const screenPath = resolve(root, config.discoveryScreenPath);
      await mkdir(dirname(screenPath), { recursive: true });
      await writeFile(screenPath, Buffer.from(capturedScreen.pngBase64, "base64"));
    }
    await call("get_preset_screenshot", {
      folder_name: config.presetScreenshot.folderName,
      position: config.presetScreenshot.position,
      is_factory: Boolean(config.presetScreenshot.isFactory)
    }, (value) => assert(pngSignatureIsValid(value, 800, 384), "Preset screenshot PNG is invalid."));
    const folders = await call("list_preset_folders", { refresh: true }, (value) => assert(Array.isArray(value.folders), "Preset folder list is invalid."));
    await call("list_presets", { refresh: false, setlist_key: config.scratchPreset.setlistKey }, (value) => assert(Array.isArray(value.presets), "Preset list is invalid."));
    await call("list_preset_slots", {}, (value) => assert(Array.isArray(value.slots), "Preset slot list is invalid."));
    await call("list_models", { query: null }, (value) => assert(Array.isArray(value.models) && value.models.length > 0, "Model list is empty."));
    const masterState = await call("get_master_volume", {}, (value) => assert(Number.isFinite(value.value), "Master volume is invalid."));
    originalMasterVolume = masterState.value;

    if (enabledHazards.has("live") || enabledHazards.has("persistent") || enabledHazards.has("system") || enabledHazards.has("screen")) {
      await recall(config.scratchPreset);
      assert(currentSnapshot.presetName.startsWith(config.scratchPreset.requiredNamePrefix), "Refusing mutations: active preset is not the configured scratch preset.");
      const block = currentSnapshot.blocks.find((candidate) => candidate.row === config.parameter.row && candidate.column === config.parameter.column);
      assert(block, "Configured parameter block is not occupied in the scratch preset.");
      const details = await call("get_block_details", { row: block.row, column: block.column, expected_preset_name: currentSnapshot.presetName });
      parameter = details.parameters?.find((candidate) => candidate.index === config.parameter.index);
      assert(parameter?.writable && Number.isFinite(parameter.normalizedValue), "Configured test parameter is not writable or has no normalized value.");
      const laneDetails = await call("get_lane_control_details", { row: config.parameter.row, control: "inputGate", expected_preset_name: currentSnapshot.presetName });
      const laneParameter = laneDetails.parameters?.find((candidate) => candidate.writable && Number.isFinite(candidate.normalizedValue));
      assert(laneParameter, "Scratch preset Input Gate has no writable normalized parameter.");
      config.runtimeLaneParameter = { row: config.parameter.row, control: "inputGate", parameter: laneParameter };
    } else {
      const block = originalSnapshot.blocks.find((candidate) => candidate.modelId !== undefined);
      if (block) await call("get_block_details", { row: block.row, column: block.column, expected_preset_name: originalSnapshot.presetName }, (value) => assert(Array.isArray(value.parameters), "Block details are invalid."));
      else report.results.push({ name: "get_block_details", phase: "read", hazard: "read", status: "skipped", reason: "Active preset has no occupied model block." });
      await call("get_lane_control_details", { row: 0, control: "inputGate", expected_preset_name: originalSnapshot.presetName }, (value) => assert(Array.isArray(value.parameters), "Input Gate details are invalid."));
    }

    if (enabledHazards.has("live")) {
      const originalScene = currentSnapshot.activeScene;
      await call("select_scene", { scene: config.performance.scene, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await waitForSnapshot((value) => value.activeScene === config.performance.scene);
      assert(currentSnapshot.activeScene === config.performance.scene, "Scene selection did not persist to snapshot.");
      await transport.call("select_scene", { scene: originalScene, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await waitForSnapshot((value) => value.activeScene === originalScene);

      const sceneDestination = config.performance.sceneCopyDestination;
      assert(sceneDestination !== originalScene, "sceneCopyDestination must differ from the starting scene.");
      await call("copy_scene", { from_scene: originalScene, to_scene: sceneDestination, swap: true, expected_preset_name: currentSnapshot.presetName });
      await transport.call("copy_scene", { from_scene: originalScene, to_scene: sceneDestination, swap: true, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await snapshot();

      const originalSceneLabel = currentSnapshot.scenes[originalScene];
      await call("set_scene_label", { scene: originalScene, label: config.performance.sceneTestLabel, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await waitForSnapshot((value) => value.scenes?.[originalScene] === config.performance.sceneTestLabel);
      await transport.call("set_scene_label", { scene: originalScene, label: originalSceneLabel, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await waitForSnapshot((value) => value.scenes?.[originalScene] === originalSceneLabel);

      const originalSceneColor = currentSnapshot.sceneColors?.[originalScene];
      await call("set_scene_color", { scene: originalScene, color: config.performance.sceneTestColor, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await snapshot();
      if (originalSceneColor) {
        const colors = ["#ff2727", "#0a74e0", "#ffd236", "#ff02c2", "#45f862", "#ff7000", "#6954ff", "#00ffdd"];
        const restoreColor = Math.max(0, colors.indexOf(originalSceneColor));
        await transport.call("set_scene_color", { scene: originalScene, color: restoreColor, expected_preset_name: currentSnapshot.presetName });
        currentSnapshot = await snapshot();
      }

      await call("show_tuner", { shown: true });
      await transport.call("show_tuner", { shown: false });
      await call("show_gig_view", { shown: true });
      await transport.call("show_gig_view", { shown: false });

      const modeBySlot = ["PRESET", "SCENE", "STOMP"];
      await call("select_mode_slot", { slot: config.performance.modeSlot, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await waitForSnapshot((value) => value.mode === modeBySlot[config.performance.modeSlot]);
      assert(currentSnapshot.mode === modeBySlot[config.performance.modeSlot], "Mode-slot selection did not reach authoritative device state.");
      await transport.call("select_mode_slot", { slot: config.performance.restoreModeSlot, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await waitForSnapshot((value) => value.mode === modeBySlot[config.performance.restoreModeSlot]);
      assert(currentSnapshot.mode === modeBySlot[config.performance.restoreModeSlot], "Mode-slot restoration did not reach authoritative device state.");

      const originalVolume = originalMasterVolume;
      await call("set_master_volume", { value: config.performance.masterVolume, expected_value: originalVolume, confirm_risky_operation: true });
      const changedVolume = await waitForMasterVolume(config.performance.masterVolume);
      assert(changedVolume?.value === config.performance.masterVolume, "Master volume did not reach the configured test value.");
      await transport.call("set_master_volume", { value: originalVolume, expected_value: config.performance.masterVolume, confirm_risky_operation: true });
      const restoredVolume = await waitForMasterVolume(originalVolume);
      assert(restoredVolume?.value === originalVolume, "Master volume did not restore to its authoritative starting value.");

      const originalTempo = currentSnapshot.tempo;
      await call("set_tempo", { bpm: config.performance.tempo, expected_tempo: originalTempo, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await snapshot();
      await call("tap_tempo", { expected_mode: currentSnapshot.mode, expected_preset_name: currentSnapshot.presetName });
      await sleep(350);
      await transport.call("tap_tempo", { expected_mode: currentSnapshot.mode, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await snapshot();
      await transport.call("set_tempo", { bpm: originalTempo, expected_tempo: currentSnapshot.tempo, expected_preset_name: currentSnapshot.presetName });

      const originalBypass = Boolean(currentSnapshot.blocks.find((candidate) => candidate.row === config.parameter.row && candidate.column === config.parameter.column)?.bypassed);
      await call("set_bypass", {
        row: config.parameter.row, column: config.parameter.column, desired_bypassed: !originalBypass,
        expected_bypassed: originalBypass, expected_scene: currentSnapshot.activeScene, expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => value.blocks.some((block) => block.row === config.parameter.row && block.column === config.parameter.column && Boolean(block.bypassed) === !originalBypass));
      await transport.call("set_bypass", {
        row: config.parameter.row, column: config.parameter.column, desired_bypassed: originalBypass,
        expected_bypassed: !originalBypass, expected_scene: currentSnapshot.activeScene, expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => value.blocks.some((block) => block.row === config.parameter.row && block.column === config.parameter.column && Boolean(block.bypassed) === originalBypass));

      const originalValue = parameter.normalizedValue;
      await call("preview_parameter", {
        row: config.parameter.row, column: config.parameter.column, parameter_index: parameter.index,
        value: config.parameter.testValue, expected_value: originalValue, expected_scene: currentSnapshot.activeScene, expected_preset_name: currentSnapshot.presetName
      });
      await waitForBlockDetails(config.parameter.row, config.parameter.column, (value) => Math.abs(value.parameters?.find((candidate) => candidate.index === parameter.index)?.normalizedValue - config.parameter.testValue) < 0.002);
      await transport.call("set_parameter", {
        row: config.parameter.row, column: config.parameter.column, parameter_index: parameter.index,
        value: originalValue, expected_value: config.parameter.testValue, expected_scene: currentSnapshot.activeScene, expected_preset_name: currentSnapshot.presetName
      });
      await waitForBlockDetails(config.parameter.row, config.parameter.column, (value) => Math.abs(value.parameters?.find((candidate) => candidate.index === parameter.index)?.normalizedValue - originalValue) < 0.002);

      const lane = config.runtimeLaneParameter;
      const laneOriginalValue = lane.parameter.normalizedValue;
      const laneTestValue = Math.abs(laneOriginalValue - 0.55) >= 0.1 ? 0.55 : 0.35;
      await call("preview_lane_control_parameter", {
        row: lane.row, control: lane.control, parameter_index: lane.parameter.index,
        value: laneTestValue, expected_value: laneOriginalValue, expected_preset_name: currentSnapshot.presetName
      });
      await waitForLaneControlDetails(lane.row, lane.control, (value) => Math.abs(value.parameters?.find((candidate) => candidate.index === lane.parameter.index)?.normalizedValue - laneTestValue) < 0.002);
      await call("set_lane_control_parameter", {
        row: lane.row, control: lane.control, parameter_index: lane.parameter.index,
        value: laneOriginalValue, expected_value: laneTestValue, expected_preset_name: currentSnapshot.presetName
      });
      await waitForLaneControlDetails(lane.row, lane.control, (value) => Math.abs(value.parameters?.find((candidate) => candidate.index === lane.parameter.index)?.normalizedValue - laneOriginalValue) < 0.002);

      const laneOriginalSceneMode = Boolean(lane.parameter.sceneMode);
      await call("set_lane_control_scene_mode", {
        row: lane.row, control: lane.control, parameter_index: lane.parameter.index,
        enabled: !laneOriginalSceneMode, expected_preset_name: currentSnapshot.presetName
      });
      await waitForLaneControlDetails(lane.row, lane.control, (value) => value.parameters?.find((candidate) => candidate.index === lane.parameter.index)?.sceneMode === !laneOriginalSceneMode);
      await transport.call("set_lane_control_scene_mode", {
        row: lane.row, control: lane.control, parameter_index: lane.parameter.index,
        enabled: laneOriginalSceneMode, expected_preset_name: currentSnapshot.presetName
      });
      await waitForLaneControlDetails(lane.row, lane.control, (value) => value.parameters?.find((candidate) => candidate.index === lane.parameter.index)?.sceneMode === laneOriginalSceneMode);

      const originalSceneMode = Boolean(parameter.sceneMode);
      await call("set_parameter_scene_mode", {
        row: config.parameter.row, column: config.parameter.column, parameter_index: parameter.index,
        enabled: !originalSceneMode, expected_preset_name: currentSnapshot.presetName
      });
      await waitForBlockDetails(config.parameter.row, config.parameter.column, (value) => value.parameters?.find((candidate) => candidate.index === parameter.index)?.sceneMode === !originalSceneMode);
      await transport.call("set_parameter_scene_mode", {
        row: config.parameter.row, column: config.parameter.column, parameter_index: parameter.index,
        enabled: originalSceneMode, expected_preset_name: currentSnapshot.presetName
      });
      await waitForBlockDetails(config.parameter.row, config.parameter.column, (value) => value.parameters?.find((candidate) => candidate.index === parameter.index)?.sceneMode === originalSceneMode);

      assert(parameter.expressionAssignable, "Configured hardware-test parameter must support expression assignment.");
      const originalPedal = Number(parameter.expression ?? 0);
      const originalMinimum = Number(parameter.expressionMinimum ?? 0);
      const originalMaximum = Number(parameter.expressionMaximum ?? 1);
      await call("set_parameter_expression", {
        row: config.parameter.row, column: config.parameter.column, parameter_index: parameter.index,
        pedal: 1, minimum: 0.1, maximum: 0.9, expected_preset_name: currentSnapshot.presetName
      });
      await waitForBlockDetails(config.parameter.row, config.parameter.column, (value) => {
        const item = value.parameters?.find((candidate) => candidate.index === parameter.index);
        return item?.expression === 1 && Math.abs(item.expressionMinimum - 0.1) < 0.002 && Math.abs(item.expressionMaximum - 0.9) < 0.002;
      });
      await transport.call("set_parameter_expression", {
        row: config.parameter.row, column: config.parameter.column, parameter_index: parameter.index,
        pedal: originalPedal, minimum: originalMinimum, maximum: originalMaximum, expected_preset_name: currentSnapshot.presetName
      });
      await waitForBlockDetails(config.parameter.row, config.parameter.column, (value) => Number(value.parameters?.find((candidate) => candidate.index === parameter.index)?.expression ?? 0) === originalPedal);

      const midiSource = config.performance.footswitchIndex;
      const originalMidiOut = currentSnapshot.midiOut?.find((group) => group.source === midiSource)?.messages ?? [];
      const testMidiOut = [{ type: 1, channel: 16, param1: 119, param2: 1, param3: 0 }];
      await call("set_midi_out", {
        source: midiSource, messages: testMidiOut, expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => value.midiOut?.find((group) => group.source === midiSource)?.messages?.[0]?.param1 === 119);
      await transport.call("set_midi_out", {
        source: midiSource, messages: originalMidiOut, expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => JSON.stringify(value.midiOut?.find((group) => group.source === midiSource)?.messages ?? []) === JSON.stringify(originalMidiOut));

      const originalPresetLoadMidiOut = currentSnapshot.presetLoadMidiOut ?? [];
      await call("set_preset_load_midi_out", {
        messages: testMidiOut, expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => value.presetLoadMidiOut?.[0]?.param1 === 119);
      await transport.call("set_preset_load_midi_out", {
        messages: originalPresetLoadMidiOut, expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => JSON.stringify(value.presetLoadMidiOut ?? []) === JSON.stringify(originalPresetLoadMidiOut));

      const temp = config.temporaryBlock;
      assert(!currentSnapshot.blocks.some((block) => block.row === temp.row && (block.column === temp.addColumn || block.column === temp.moveColumn)), "Temporary block cells are not empty.");
      await call("add_block", { row: temp.row, column: temp.addColumn, model_id: temp.modelId, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await waitForSnapshot((value) => value.blocks.some((block) => block.row === temp.row && block.column === temp.addColumn && block.modelId === temp.modelId));
      await sleep(1000);
      currentSnapshot = await snapshot();
      assert(currentSnapshot.blocks.some((block) => block.row === temp.row && block.column === temp.addColumn && block.modelId === temp.modelId), "Configured temporary block model was rejected by the QC after its initial echo.");
      await call("set_expression_bypass", {
        row: temp.row, column: temp.addColumn, pedal: 1, mode: 1, invert: false,
        delay_ms: 250, latch_emulation: true, expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => {
        const block = value.blocks.find((candidate) => candidate.row === temp.row && candidate.column === temp.addColumn);
        return block?.bypassExpression?.pedal === 1 && block.bypassExpression.mode === 1
          && block.bypassExpression.delayMs === 250 && block.bypassExpression.latchEmulation === true;
      });
      await call("move_block", { row: temp.row, from_column: temp.addColumn, to_column: temp.moveColumn, expected_model_id: temp.modelId, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await waitForSnapshot((value) => value.blocks.some((block) => block.row === temp.row && block.column === temp.moveColumn && block.modelId === temp.modelId));
      await sleep(1000);
      currentSnapshot = await snapshot();
      assert(currentSnapshot.blocks.some((block) => block.row === temp.row && block.column === temp.moveColumn && block.modelId === temp.modelId), "Moved temporary block did not remain stable on the QC.");
      await call("set_block_footswitch", {
        row: temp.row, column: temp.moveColumn, footswitch: temp.footswitch, expected_footswitch: null,
        expected_model_id: temp.modelId, expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => value.blocks.some((block) => block.row === temp.row && block.column === temp.moveColumn && block.footswitch === temp.footswitch));
      await call("set_stomp_momentary", {
        footswitch: temp.footswitch, momentary: true, expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => value.footswitchStates?.some((state) => state.index === temp.footswitch && state.momentary === true));
      await transport.call("set_stomp_momentary", {
        footswitch: temp.footswitch, momentary: false, expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => value.footswitchStates?.some((state) => state.index === temp.footswitch && state.momentary === false));
      await call("set_stomp_label", {
        footswitch: temp.footswitch, label: "QC TEST", expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => value.footswitchStates?.some((state) => state.index === temp.footswitch && state.label === "QC TEST"));
      await transport.call("set_block_footswitch", {
        row: temp.row, column: temp.moveColumn, footswitch: null, expected_footswitch: temp.footswitch,
        expected_model_id: temp.modelId, expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => value.blocks.some((block) => block.row === temp.row && block.column === temp.moveColumn && block.footswitch == null));
      await call("remove_block", { row: temp.row, column: temp.moveColumn, expected_model_id: temp.modelId, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await waitForSnapshot((value) => !value.blocks.some((block) => block.row === temp.row && block.column === temp.moveColumn));

      const route = currentSnapshot.routes.find((candidate) => candidate.row === config.routing.row);
      assert(route && Number.isInteger(route.inputId) && Number.isInteger(route.outputId), "Configured route has no restorable input/output IDs.");
      await call("set_chain_input", { row: route.row, input_id: config.routing.testInputId, expected_input_id: route.inputId, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await waitForSnapshot((value) => value.routes.some((candidate) => candidate.row === route.row && candidate.inputId === config.routing.testInputId));
      await transport.call("set_chain_input", { row: route.row, input_id: route.inputId, expected_input_id: config.routing.testInputId, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await waitForSnapshot((value) => value.routes.some((candidate) => candidate.row === route.row && candidate.inputId === route.inputId));
      await call("set_chain_output", { row: route.row, output_id: config.routing.testOutputId, expected_output_id: route.outputId, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await waitForSnapshot((value) => value.routes.some((candidate) => candidate.row === route.row && candidate.outputId === config.routing.testOutputId));
      await transport.call("set_chain_output", { row: route.row, output_id: route.outputId, expected_output_id: config.routing.testOutputId, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await waitForSnapshot((value) => value.routes.some((candidate) => candidate.row === route.row && candidate.outputId === route.outputId));
      await call("set_chain_split", {
        row: route.row, split_column: config.routing.testSplitColumn, mix_column: config.routing.testMixColumn,
        expected_split_column: route.splitColumn ?? null, expected_mix_column: route.mixColumn ?? null, expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => value.routes.some((candidate) => candidate.row === route.row && candidate.splitColumn === config.routing.testSplitColumn && candidate.mixColumn === config.routing.testMixColumn));
      await transport.call("set_chain_split", {
        row: route.row, split_column: route.splitColumn ?? null, mix_column: route.mixColumn ?? null,
        expected_split_column: config.routing.testSplitColumn, expected_mix_column: config.routing.testMixColumn, expected_preset_name: currentSnapshot.presetName
      });
      currentSnapshot = await waitForSnapshot((value) => value.routes.some((candidate) => candidate.row === route.row && (candidate.splitColumn ?? null) === (route.splitColumn ?? null) && (candidate.mixColumn ?? null) === (route.mixColumn ?? null)));

      await call("set_parameter", {
        row: config.parameter.row, column: config.parameter.column, parameter_index: parameter.index,
        value: config.parameter.testValue, expected_value: originalValue, expected_scene: currentSnapshot.activeScene, expected_preset_name: currentSnapshot.presetName
      });
      await waitForBlockDetails(config.parameter.row, config.parameter.column, (value) => Math.abs(value.parameters?.find((candidate) => candidate.index === parameter.index)?.normalizedValue - config.parameter.testValue) < 0.002);
      await call("undo_device", { confirm_risky_operation: true });
      await waitForBlockDetails(config.parameter.row, config.parameter.column, (value) => Math.abs(value.parameters?.find((candidate) => candidate.index === parameter.index)?.normalizedValue - originalValue) < 0.002);
      await call("redo_device", { confirm_risky_operation: true });
      await waitForBlockDetails(config.parameter.row, config.parameter.column, (value) => Math.abs(value.parameters?.find((candidate) => candidate.index === parameter.index)?.normalizedValue - config.parameter.testValue) < 0.002);
      await transport.call("set_parameter", {
        row: config.parameter.row, column: config.parameter.column, parameter_index: parameter.index,
        value: originalValue, expected_value: config.parameter.testValue, expected_scene: currentSnapshot.activeScene, expected_preset_name: currentSnapshot.presetName
      });
      await waitForBlockDetails(config.parameter.row, config.parameter.column, (value) => Math.abs(value.parameters?.find((candidate) => candidate.index === parameter.index)?.normalizedValue - originalValue) < 0.002);

      await call("reload_preset", { expected_preset_name: currentSnapshot.presetName, expected_position: currentSnapshot.presetPosition, confirm_risky_operation: true });
      currentSnapshot = await snapshot();

      await call("press_footswitch", { index: config.performance.footswitchIndex, expected_mode: currentSnapshot.mode, expected_preset_name: currentSnapshot.presetName });
      currentSnapshot = await snapshot();
      await restoreScratch();

      await call("navigate_bank", { direction: 1, expected_preset_name: currentSnapshot.presetName, expected_position: currentSnapshot.presetPosition });
      currentSnapshot = await snapshot();
      await restoreScratch();
    }

    if (enabledHazards.has("persistent")) {
      await restoreScratch();
      const nameA = uniqueName(config.persistent.namePrefix, "A");
      const nameRenamed = uniqueName(config.persistent.namePrefix, "R");
      report.disposableSlotsModified = [config.persistent.slotA, config.persistent.slotB];
      await call("save_preset_as", {
        setlist_key: config.persistent.slotA.setlistKey, position: config.persistent.slotA.position, name: nameA,
        expected_preset_name: currentSnapshot.presetName, expected_position: currentSnapshot.presetPosition,
        confirm_overwrite: true, confirm_persistent_write: true
      });
      currentSnapshot = await snapshot();
      await call("rename_current_preset", {
        new_name: nameRenamed, expected_preset_name: currentSnapshot.presetName,
        expected_position: currentSnapshot.presetPosition, confirm_persistent_write: true
      });
      currentSnapshot = await snapshot();
      const copySource = {
        setlistKey: currentSnapshot.setlistKey,
        position: currentSnapshot.presetPosition,
        name: currentSnapshot.presetName
      };
      await recall({
        setlistKey: config.persistent.slotB.setlistKey,
        position: config.persistent.slotB.position
      });
      const copied = await call("copy_preset", {
        source_setlist_key: copySource.setlistKey, source_position: copySource.position, source_name: copySource.name,
        destination_setlist_key: config.persistent.slotB.setlistKey, destination_position: config.persistent.slotB.position,
        expected_preset_name: currentSnapshot.presetName, expected_position: currentSnapshot.presetPosition,
        confirm_overwrite: true, confirm_persistent_write: true
      });
      currentSnapshot = resultSnapshot(copied) ?? await snapshot();
    }

    if (enabledHazards.has("system")) {
      await restoreScratch();
      await call("set_device_name", { name: config.system.temporaryDeviceName, confirm_persistent_write: true });
      const originalDeviceName = identity.customName?.trim() || originalSnapshot.deviceName;
      assert(originalDeviceName && originalDeviceName !== config.system.temporaryDeviceName, "A distinct original device name is required for the restore check.");
      await transport.call("set_device_name", { name: originalDeviceName, confirm_persistent_write: true });
      await call("reset_device_session", { confirm_risky_operation: true });
      currentSnapshot = await snapshot();
      await call("disconnect_device", { confirm_risky_operation: true });
      await call("reconnect_device", { confirm_risky_operation: true });
      currentSnapshot = await snapshot();
    }

    if (enabledHazards.has("screen")) {
      await call("tap_screen", { x: config.screenTap.x, y: config.screenTap.y, confirm_risky_operation: true });
      firstScreenTapSent = true;
      await transport.call("tap_screen", { x: config.screenTap.restoreX, y: config.screenTap.restoreY, confirm_risky_operation: true });
      firstScreenTapSent = false;
    }

    // Backup is intentionally last: it is the longest operation and a bulk
    // transport failure must not hide evidence for the other 44 actions.
    if (enabledHazards.has("persistent")) {
      await call("create_device_backup", { name: uniqueName(config.persistent.namePrefix, "backup"), confirm_persistent_write: true });
    }

    if (currentSnapshot && originalSnapshot && (currentSnapshot.setlistKey !== originalSnapshot.setlistKey || currentSnapshot.presetPosition !== originalSnapshot.presetPosition)) {
      await recall({ setlistKey: originalSnapshot.setlistKey, position: originalSnapshot.presetPosition });
    }
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (transportStarted && deviceAuthorized && originalSnapshot && [...enabledHazards].some((value) => value !== "read")) {
      const restoration = [];
      const restoreAttempt = async (name, operation) => {
        try { await operation(); restoration.push({ name, status: "passed" }); }
        catch (error) { restoration.push({ name, status: "failed", error: error instanceof Error ? error.message : String(error) }); }
      };
      if (firstScreenTapSent) {
        await restoreAttempt("screen", () => transport.call("tap_screen", { x: config.screenTap.restoreX, y: config.screenTap.restoreY, confirm_risky_operation: true }));
      }
      if (enabledHazards.has("system")) {
        await restoreAttempt("connection", () => transport.call("reconnect_device", { confirm_risky_operation: true }));
        const originalDeviceName = identity?.customName?.trim() || originalSnapshot.deviceName;
        if (originalDeviceName) await restoreAttempt("device-name", () => transport.call("set_device_name", { name: originalDeviceName, confirm_persistent_write: true }));
      }
      if (enabledHazards.has("live") && Number.isFinite(originalMasterVolume)) {
        await restoreAttempt("master-volume", async () => {
          const current = await transport.call("get_master_volume", {});
          if (current.value !== originalMasterVolume) {
            await transport.call("set_master_volume", { value: originalMasterVolume, expected_value: current.value, confirm_risky_operation: true });
          }
        });
      }
      await restoreAttempt("starting-preset", async () => {
        let current = await transport.call("get_current_preset", {});
        if (current.dirty) {
          await transport.call("reload_preset", {
            expected_preset_name: current.presetName,
            expected_position: current.presetPosition,
            confirm_risky_operation: true
          });
          current = await waitForSnapshot((value) => !value.dirty);
          assert(!current.dirty, "Dirty preset did not revert during failure restoration.");
        }
        if (current.setlistKey !== originalSnapshot.setlistKey || current.presetPosition !== originalSnapshot.presetPosition) {
          await transport.call("recall_preset", {
            setlist_key: originalSnapshot.setlistKey,
            position: originalSnapshot.presetPosition,
            expected_preset_name: current.presetName,
            expected_position: current.presetPosition
          });
        }
      });
      report.restoration = restoration;
      if (restoration.some((item) => item.status === "failed")) report.failure ??= "One or more restoration checks failed.";
    }
    report.finishedAt = timestamp();
    for (const action of contract.actions) {
      if (!report.results.some((result) => result.name === action.name)) {
        const metadata = CASES[action.name];
        report.results.push({ name: action.name, phase: metadata.phase, hazard: metadata.hazard, status: "not-run", reason: report.failure ? "Suite stopped after failure." : "Scenario prerequisite was not enabled." });
      }
    }
    const passed = report.results.filter((result) => result.status === "passed").length;
    const actionFailures = report.results.filter((result) => result.status === "failed").length;
    const failed = actionFailures + (report.failure && actionFailures === 0 ? 1 : 0);
    const skipped = report.results.filter((result) => result.status === "skipped" || result.status === "not-run").length;
    report.summary = { passed, failed, skipped, complete: failed === 0 && contract.actions.every((action) => performed.has(action.name)) };
    const outputPath = resolve(option("--output") ?? resolve(root, "artifacts/hardware-conformance", `${new Date().toISOString().replace(/[:.]/g, "-")}-${config.target}.json`));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    await transport.close().catch(() => {});
    console.log(`Evidence: ${outputPath}`);
    console.log(JSON.stringify(report.summary));
    if (report.failure || (requireAll && !report.summary.complete)) process.exitCode = 1;
  }
}

await main();
