import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usbProfile = JSON.parse(readFileSync(resolve(root, "contracts/qc-usb-profile.v1.json"), "utf8"));
const defaultBroker = resolve(
  root,
  "services/device-broker/target/debug",
  process.platform === "win32" ? "qc-device-broker.exe" : "qc-device-broker"
);
const broker = resolve(process.env.QC_NATIVE_BACKUP_BROKER || defaultBroker);
const args = process.argv.slice(2);
const runs = Number(args.find((argument) => /^\d+$/.test(argument)) ?? "1");
const expectedSuffix = process.env.QC_EXPECTED_SERIAL_SUFFIX;
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("Backup run count must be a positive integer.");
if (!expectedSuffix) throw new Error("QC_EXPECTED_SERIAL_SUFFIX is required for the physical safety check.");
if (!existsSync(broker)) throw new Error(`Native broker does not exist: ${broker}`);

const enabled = (flag) => args.includes(flag);
const flightPath = resolve(root, "tmp/native-backup-flight.json");
rmSync(flightPath, { force: true });

const child = spawn(broker, ["--stdio"], {
  cwd: root,
  env: { ...process.env, QC_FLIGHT_RECORDER_PATH: flightPath },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true
});

let input = Buffer.alloc(0);
let stderr = "";
let nextId = 1;
const pending = new Map();
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdout.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32BE(0);
    if (input.length < 4 + length) return;
    const body = input.subarray(4, 4 + length);
    input = input.subarray(4 + length);
    try {
      const response = JSON.parse(body.toString("utf8"));
      const waiter = pending.get(response.id);
      if (!waiter) continue;
      pending.delete(response.id);
      if (response.error) waiter.reject(new Error(response.error.message ?? JSON.stringify(response.error)));
      else waiter.resolve(response.result);
    } catch (error) {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    }
  }
});
const rejectPending = (detail) => {
  for (const waiter of pending.values()) waiter.reject(new Error(detail));
  pending.clear();
};
child.on("error", (error) => rejectPending(`Could not start native broker: ${error.message}`));
child.on("exit", (code) => rejectPending(`Native broker exited with code ${code}: ${stderr.trim()}`));

function exchange(method, params = {}) {
  const id = nextId++;
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return new Promise((resolveRequest, rejectRequest) => {
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    child.stdin.write(Buffer.concat([header, body]), (error) => {
      if (!error) return;
      pending.delete(id);
      rejectRequest(error);
    });
  });
}

let disconnected = false;
try {
  await exchange("device.reconnect");
  const identity = await exchange("device.identity");
  if (!String(identity.serial ?? "").endsWith(expectedSuffix)) {
    throw new Error("Connected QC does not match QC_EXPECTED_SERIAL_SUFFIX.");
  }

  if (enabled("--device-name-roundtrip")) {
    const originalName = String(identity.customName || "Quad Cortex").trim();
    const temporaryName = originalName === "QC MCP BACKUP TEST"
      ? "QC MCP BACKUP TEST 2"
      : "QC MCP BACKUP TEST";
    for (const name of [temporaryName, originalName]) {
      await exchange("device.setDeviceName", { name, confirmPersistentWrite: true });
    }
  }

  if (enabled("--reset-session")) {
    const reset = await exchange("device.resetSession", { confirmRiskyOperation: true });
    if (reset.phase !== "ready") throw new Error(`Session reset ended in ${JSON.stringify(reset.phase)}.`);
  }
  if (enabled("--disconnect-reconnect")) {
    await exchange("device.disconnect", { confirmRiskyOperation: true });
    const reconnect = await exchange("device.reconnect", { confirmRiskyOperation: true });
    if (reconnect.phase !== "ready") throw new Error(`Reconnect ended in ${JSON.stringify(reconnect.phase)}.`);
  }
  if (enabled("--screen-tap-roundtrip")) {
    for (let index = 0; index < 2; index += 1) {
      await exchange("device.tapScreen", { x: 400, y: 240, confirmRiskyOperation: true });
    }
  }

  const results = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    const backup = await exchange("device.createBackup", { name: "Rust transport verification" });
    const encoded = Buffer.from(JSON.stringify(backup));
    if (backup.type !== "backup" || backup.creator !== "quad") {
      throw new Error(`Run ${index + 1} returned an unsupported backup wrapper.`);
    }
    const after = await exchange("device.status");
    if (after.phase !== "ready") throw new Error(`Run ${index + 1} left the broker in ${JSON.stringify(after.phase)}.`);
    results.push({
      run: index + 1,
      seconds: Math.round((performance.now() - started) / 1000 * 1000) / 1000,
      bytes: encoded.length,
      sha256: createHash("sha256").update(encoded).digest("hex"),
      sessionReady: true
    });
  }

  await exchange("device.disconnect");
  disconnected = true;
  const flight = JSON.parse(readFileSync(flightPath, "utf8"));
  const backupFrames = (flight.entries ?? []).filter(
    (entry) => entry.event === "inbound" && entry.messageType === usbProfile.messageTypes.backup
  );
  if (backupFrames.length < runs * 12) {
    throw new Error(`Flight recorder contains ${backupFrames.length} backup frames; expected at least ${runs * 12}.`);
  }
  process.stdout.write(`${JSON.stringify({
    verified: true,
    broker,
    runs: results,
    backupFrames: backupFrames.length,
    minReportsPerChunk: Math.min(...backupFrames.map((entry) => entry.reportCount)),
    maxReportsPerChunk: Math.max(...backupFrames.map((entry) => entry.reportCount))
  })}\n`);
} finally {
  if (!disconnected && child.exitCode === null) {
    await exchange("device.disconnect").catch(() => undefined);
  }
  child.stdin.end();
  child.kill();
}
