import { spawn } from "node:child_process";
import { resolve } from "node:path";

const executable = resolve(process.argv[2] ?? "");
const broker = resolve(process.argv[3] ?? "");
const child = spawn(executable, ["--stdio"], {
  env: { ...process.env, QC_USE_NATIVE_BROKER: "1", QC_NATIVE_BROKER_EXECUTABLE: broker },
  stdio: ["pipe", "pipe", "inherit"]
});

let nextId = 1;
let buffered = Buffer.alloc(0);
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (buffered.length < length + 4) return;
    const response = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
    buffered = buffered.subarray(length + 4);
    const waiter = pending.get(response.id);
    pending.delete(response.id);
    if (!waiter) continue;
    response.error ? waiter.reject(new Error(response.error.message)) : waiter.resolve(response.result);
  }
});

function request(method, params = {}) {
  const id = nextId++;
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return new Promise((resolveRequest, reject) => {
    pending.set(id, { resolve: resolveRequest, reject });
    child.stdin.write(Buffer.concat([header, body]));
  });
}

async function timedRequest(method, params = {}) {
  const started = performance.now();
  const result = await request(method, params);
  return { result, elapsedMs: Math.round((performance.now() - started) * 10) / 10 };
}

try {
  const connected = await timedRequest("device.reconnect");
  const synchronized = await timedRequest("device.snapshot");
  const connection = connected.result;
  const snapshot = synchronized.result;
  const block = snapshot.blocks.find((candidate) => candidate.modelId !== undefined && candidate.column >= 0);
  const inspected = block ? await timedRequest("device.blockDetails", {
    row: block.row,
    column: block.column,
    expectedPresetName: snapshot.presetName
  }) : undefined;
  const details = inspected?.result;
  const warmBlockDetailsMs = [];
  if (block) {
    for (let index = 0; index < 4; index += 1) {
      const warm = await timedRequest("device.blockDetails", {
        row: block.row,
        column: block.column,
        expectedPresetName: snapshot.presetName
      });
      warmBlockDetailsMs.push(warm.elapsedMs);
    }
  }
  console.log(JSON.stringify({
    connection,
    connectMs: connected.elapsedMs,
    snapshotMs: synchronized.elapsedMs,
    blockDetailsMs: inspected?.elapsedMs,
    warmBlockDetailsMs,
    preset: `${snapshot.presetLocation} · ${snapshot.presetName}`,
    blockCount: snapshot.blocks.length,
    inspectedBlock: details?.name,
    parameterCount: details?.parameters.length ?? 0,
    metadataVerified: details?.parameters.some((parameter) => parameter.displayPosition !== undefined && parameter.valueScale !== undefined) ?? false
  }));
} finally {
  child.stdin.end();
}
