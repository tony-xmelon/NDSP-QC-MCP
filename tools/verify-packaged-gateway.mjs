import { spawn } from "node:child_process";
import { resolve } from "node:path";

const expectedApiVersion = 2;
const requiredCapabilities = ["modelRepoParameterMetadata", "nativeBroker"];
const executable = resolve(process.argv[2] ?? "");

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

const child = spawn(executable, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
const chunks = [];
let length;
let settled = false;

const timeout = setTimeout(() => fail("Packaged gateway status timed out"), 15_000);
child.stderr.resume();
child.on("error", (error) => fail(error.message));
child.stdout.on("data", (chunk) => {
  chunks.push(Buffer.from(chunk));
  const data = Buffer.concat(chunks);
  if (length === undefined && data.length >= 4) length = data.readUInt32BE(0);
  if (length === undefined || data.length < length + 4) return;
  try {
    const response = JSON.parse(data.subarray(4, 4 + length).toString("utf8"));
    const result = response.result;
    if (result?.gatewayApiVersion !== expectedApiVersion) {
      fail(`Packaged gateway API mismatch: expected ${expectedApiVersion}, got ${JSON.stringify(result?.gatewayApiVersion)}`);
      return;
    }
    const capabilities = new Set(result.capabilities ?? []);
    const missing = requiredCapabilities.filter((capability) => !capabilities.has(capability));
    if (missing.length) {
      fail(`Packaged gateway is missing capabilities: ${missing.join(", ")}`);
      return;
    }
    settled = true;
    clearTimeout(timeout);
    child.stdin.end();
    console.log(`Packaged gateway API ${expectedApiVersion} verified: ${executable}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
});

function fail(message) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  child.kill();
  console.error(message);
  process.exitCode = 1;
}

child.stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "system.status", params: {} }));
