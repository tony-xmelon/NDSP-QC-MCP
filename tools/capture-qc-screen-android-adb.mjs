import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [serial, outputArgument, portArgument = "9223", ...flags] = process.argv.slice(2);
if (!serial || !outputArgument) {
  throw new Error("Usage: capture-qc-screen-android-adb.mjs <adb-serial> <output.png> [local-port]");
}

const port = Number.parseInt(portArgument, 10);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("local-port must be between 1024 and 65535");
const output = resolve(outputArgument);

function adb(...args) {
  const result = spawnSync("adb", ["-s", serial, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `adb ${args.join(" ")} failed`);
  return result.stdout;
}

function cdp(socket, method, params = {}) {
  return new Promise((resolveReply, reject) => {
    const id = cdp.nextId++;
    const timer = setTimeout(() => {
      cdp.pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 20_000);
    cdp.pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolveReply(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
cdp.nextId = 1;
cdp.pending = new Map();

let forwarded = false;
let socket;
try {
  const unixSockets = adb("shell", "cat", "/proc/net/unix");
  const candidates = [...unixSockets.matchAll(/@(webview_devtools_remote_\d+)/g)].map((match) => match[1]);
  if (candidates.length !== 1) throw new Error(`expected one debuggable QC Control WebView, found ${candidates.length}`);

  adb("forward", `tcp:${port}`, `localabstract:${candidates[0]}`);
  forwarded = true;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((candidate) => candidate.type === "page" && candidate.title === "QC Control");
  if (!target?.webSocketDebuggerUrl) throw new Error("QC Control WebView target was not found");

  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      cdp.pending.get(message.id)?.(message);
      cdp.pending.delete(message.id);
    }
  });
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => reject(new Error("could not connect to the Android WebView debugger")), { once: true });
  });

  const evaluated = await cdp(socket, "Runtime.evaluate", {
    expression: `(async () => {
      const plugin = globalThis.Capacitor?.Plugins?.QcUsb;
      if (!plugin) throw new Error("QcUsb Capacitor plugin is unavailable");
      const before = await plugin.diagnostics();
      try {
        const reconnect = ${JSON.stringify(flags.includes("--reconnect"))}
          ? await plugin.gatewayInvoke({ method: "device.reconnect", params: {} })
          : null;
        const image = await plugin.gatewayInvoke({ method: "device.captureScreen", params: {} });
        return { image, reconnect, before, after: await plugin.diagnostics() };
      } catch (error) {
        return {
          error: { code: error?.code, message: error?.message ?? String(error) },
          before,
          after: await plugin.diagnostics(),
        };
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  const payload = evaluated.result?.value;
  if (payload?.error) throw new Error(`Android QC capture failed: ${JSON.stringify(payload)}`);
  const image = payload?.image;
  if (image?.width !== 800 || image?.height !== 480 || typeof image?.pngBase64 !== "string") {
    throw new Error(`Android returned an invalid framebuffer result: ${JSON.stringify(image)}`);
  }
  const png = Buffer.from(image.pngBase64, "base64");
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Android framebuffer has an invalid PNG signature");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, png);
  console.log(JSON.stringify({ output, width: image.width, height: image.height, bytes: png.length, transport: "android-adb-webview", diagnostics: payload.after }));
} finally {
  socket?.close();
  if (forwarded) {
    try { adb("forward", "--remove", `tcp:${port}`); } catch {}
  }
}
