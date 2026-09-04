import { spawn } from "node:child_process";
import { resolve } from "node:path";

const executable = resolve(process.argv[2] ?? "services/device-broker/target/debug/qc-device-broker.exe");
const child = spawn(executable, ["--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 1;
let buffered = Buffer.alloc(0);
const pending = [];

child.stdout.on("data", chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (buffered.length < length + 4) return;
    const response = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
    buffered = buffered.subarray(length + 4);
    if (response.id !== undefined) pending.shift()?.(response);
  }
});

function call(method, params = {}) {
  return new Promise((resolveResponse, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 45_000);
    pending.push(response => {
      clearTimeout(timeout);
      if (response.id !== id) reject(new Error(`${method} returned a mismatched id`));
      else if (response.error) reject(new Error(`${method}: ${response.error.message}`));
      else resolveResponse(response.result);
    });
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    child.stdin.write(Buffer.concat([header, body]));
  });
}

try {
  const runtime = await call("system.status");
  const connection = await call("device.reconnect");
  if (connection.phase !== "ready") throw new Error(`device did not become ready: ${connection.detail}`);
  const snapshot = await call("device.snapshot");
  if (!snapshot.setlistKey || !Number.isInteger(snapshot.presetPosition) || !Number.isInteger(snapshot.activeScene)) {
    throw new Error(`native snapshot is missing synchronized preset or scene state: ${JSON.stringify(snapshot)}`);
  }
  let models = await call("device.listModels");
  const modelDeadline = Date.now() + 5_000;
  while ((!Array.isArray(models.models) || models.models.length === 0) && Date.now() < modelDeadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    models = await call("device.listModels");
  }
  if (!Array.isArray(models.models) || models.models.length === 0 || !(models.audit?.parameterCount > 0)) {
    throw new Error(`native model catalog is empty: ${JSON.stringify(models.audit ?? models)}`);
  }
  const identity = await call("device.identity");
  if (!identity.serial || typeof identity.serial !== "string") {
    throw new Error("native identity read did not return the full Version reply");
  }
  const inhibited = await call("device.inhibitedModules");
  if (typeof inhibited.globalGate !== "boolean" || typeof inhibited.globalEq !== "boolean") {
    throw new Error("native inhibited-module read omitted an explicit boolean");
  }
  const screen = await call("device.captureScreen");
  const screenPng = Buffer.from(screen.pngBase64, "base64");
  if (screen.width !== 800 || screen.height !== 480 || screenPng.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("native live-screen capture did not return the CorOS 800 x 480 PNG");
  }
  let folders = await call("device.listPresetFolders", { refresh: true });
  if (!folders.folders?.length) {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    folders = await call("device.listPresetFolders", { refresh: false });
  }
  const folder = folders.folders?.find(candidate => candidate.name && candidate.key);
  let presetScreenshotVerified = false;
  if (folder) {
    let listing = await call("device.listPresets", { refresh: false, setlistKey: folder.key });
    if (!listing.presets?.length) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      listing = await call("device.listPresets", { refresh: false, setlistKey: folder.key });
    }
    const preset = listing.presets?.find(candidate => candidate.name && Number.isInteger(candidate.position));
    if (preset) {
      const rendered = await call("device.presetScreenshot", {
        folderName: folder.name,
        position: preset.position,
        isFactory: Boolean(folder.isFactory),
      });
      const renderedPng = Buffer.from(rendered.pngBase64, "base64");
      if (rendered.width !== 800 || rendered.height !== 384 || renderedPng.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error("native preset screenshot did not return the expected 800 x 384 PNG");
      }
      presetScreenshotVerified = true;
    }
  }
  const first = snapshot.blocks.find(block => block.modelId !== undefined);
  const block = first
    ? await call("device.blockDetails", { row: first.row, column: first.column, expectedPresetName: snapshot.presetName })
    : null;
  if (first && (!Array.isArray(block?.parameters) || block.parameters.length === 0)) {
    throw new Error("native block details contain no parameter metadata");
  }
  console.log(JSON.stringify({
    verified: true,
    platform: runtime.platform,
    preset: snapshot.presetName,
    scene: snapshot.activeScene,
    blocks: snapshot.blocks.length,
    models: models.models.length,
    firstEditorParameters: block?.parameters?.length ?? 0,
    identity: true,
    inhibitedModules: true,
    liveScreen: `${screen.width}x${screen.height}`,
    presetScreenshot: presetScreenshotVerified,
  }));
} finally {
  try { await call("device.disconnect"); } catch {}
  child.stdin.end();
}
