import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

const [executable, output] = process.argv.slice(2);
if (!executable || !output) throw new Error("Usage: capture-qc-screen.mjs <broker.exe> <output.png>");

const child = spawn(executable, ["--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
let buffered = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();

child.stdout.on("data", chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (buffered.length < length + 4) return;
    const message = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
    buffered = buffered.subarray(length + 4);
    if (message.id !== undefined) pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});

function call(method, params = {}, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    pending.set(id, message => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    child.stdin.write(Buffer.concat([header, payload]));
  });
}

try {
  await call("device.reconnect", {}, 20_000);
  const readyDeadline = Date.now() + 10_000;
  let snapshot;
  while (true) {
    try {
      snapshot = await call("device.snapshot");
      break;
    } catch {}
    if (Date.now() >= readyDeadline) throw new Error("Quad Cortex did not synchronize before capture");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  let masterVolume;
  const volumeDeadline = Date.now() + 3_000;
  while (masterVolume === undefined && Date.now() < volumeDeadline) {
    try { masterVolume = await call("device.masterVolume"); }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  snapshot = await call("device.snapshot");
  const image = await call("device.captureScreen");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, Buffer.from(image.pngBase64, "base64"));
  console.log(JSON.stringify({ output, width: image.width, height: image.height, masterVolume, snapshot }));
} finally {
  try { await call("device.disconnect", {}, 2_000); } catch {}
  child.stdin.end();
}
