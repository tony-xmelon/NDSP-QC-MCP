import { spawnSync } from "node:child_process";

const [serial, method, paramsArgument = "{}", portArgument = "9225"] = process.argv.slice(2);
if (!serial || !method) {
  throw new Error("Usage: node tools/invoke-android-gateway-adb.mjs <adb-serial> <gateway-method> [params-json] [local-port]");
}
if (!/^(device|system)\.[A-Za-z0-9]+$/.test(method)) throw new Error("Invalid gateway method.");
const params = JSON.parse(paramsArgument);
const port = Number.parseInt(portArgument, 10);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("local-port must be between 1024 and 65535");

function adb(...args) {
  const result = spawnSync("adb", ["-s", serial, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `adb ${args.join(" ")} failed`);
  return result.stdout.trim();
}

let nextId = 1;
const pending = new Map();
function cdp(socket, cdpMethod, cdpParams = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${cdpMethod} timed out`));
    }, 180_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${cdpMethod}: ${message.error.message}`));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method: cdpMethod, params: cdpParams }));
  });
}

let forwarded = false;
let socket;
try {
  const pid = adb("shell", "pidof", "com.qccontrol.mobile").split(/\s+/)[0];
  if (!/^\d+$/.test(pid)) throw new Error("QC Control is not running on the Android device");
  adb("forward", `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
  forwarded = true;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((candidate) => candidate.type === "page" && candidate.title === "QC Control");
  if (!target?.webSocketDebuggerUrl) throw new Error("QC Control WebView target was not found");

  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("could not connect to the Android WebView debugger")), { once: true });
  });

  const evaluated = await cdp(socket, "Runtime.evaluate", {
    expression: `(async () => {
      const plugin = globalThis.Capacitor?.Plugins?.QcUsb;
      if (!plugin) throw new Error("QcUsb Capacitor plugin is unavailable");
      const before = await plugin.diagnostics();
      try {
        const result = await plugin.gatewayInvoke(${JSON.stringify({ method, params })});
        return { result, before, after: await plugin.diagnostics() };
      } catch (error) {
        return { error: { code: error?.code, message: error?.message ?? String(error) }, before, after: await plugin.diagnostics() };
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  const payload = evaluated.result?.value;
  if (payload?.error) throw new Error(`Android gateway call failed: ${JSON.stringify(payload)}`);
  console.log(JSON.stringify(payload));
} finally {
  socket?.close();
  if (forwarded) {
    try { adb("forward", "--remove", `tcp:${port}`); } catch {}
  }
}
