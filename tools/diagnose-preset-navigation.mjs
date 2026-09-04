import { execFileSync, spawn } from "node:child_process";

const executable = process.argv[2];
if (!executable) throw new Error("Pass the native broker executable path");
const child = spawn(executable, ["--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 1;
let buffered = Buffer.alloc(0);
const pending = new Map();
let onNotification;

function sendWindowsMidiPreset(position) {
  const script = `
$source = @'
using System;
using System.Runtime.InteropServices;
public static class QcMidiNavigation {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Caps { public ushort mid; public ushort pid; public uint version; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string name; public ushort technology; public ushort voices; public ushort notes; public ushort channelMask; public uint support; }
  [DllImport("winmm.dll")] public static extern uint midiOutGetNumDevs();
  [DllImport("winmm.dll", CharSet=CharSet.Unicode)] public static extern uint midiOutGetDevCapsW(UIntPtr id, out Caps caps, uint size);
  [DllImport("winmm.dll")] public static extern uint midiOutOpen(out IntPtr handle, uint id, UIntPtr callback, UIntPtr instance, uint flags);
  [DllImport("winmm.dll")] public static extern uint midiOutShortMsg(IntPtr handle, uint message);
  [DllImport("winmm.dll")] public static extern uint midiOutClose(IntPtr handle);
}
'@
Add-Type -TypeDefinition $source
$deviceId = $null
for ($id = 0; $id -lt [QcMidiNavigation]::midiOutGetNumDevs(); $id++) {
  $caps = New-Object QcMidiNavigation+Caps
  if ([QcMidiNavigation]::midiOutGetDevCapsW([UIntPtr]::new($id), [ref]$caps, [Runtime.InteropServices.Marshal]::SizeOf($caps)) -eq 0 -and $caps.name -like '*Quad Cortex*') { $deviceId = $id; break }
}
if ($null -eq $deviceId) { throw 'Quad Cortex MIDI output not found' }
$handle = [IntPtr]::Zero
$opened = [QcMidiNavigation]::midiOutOpen([ref]$handle, $deviceId, [UIntPtr]::Zero, [UIntPtr]::Zero, 0)
if ($opened -ne 0) { throw "midiOutOpen failed: $opened" }
try {
  $position = ${position}
  $bank = [uint32](0xB0 -bor ([uint32]([math]::Floor($position / 128)) -shl 16))
  $program = [uint32](0xC0 -bor ([uint32]($position % 128) -shl 8))
  $sent = [QcMidiNavigation]::midiOutShortMsg($handle, $bank)
  if ($sent -ne 0) { throw "bank select failed: $sent" }
  Start-Sleep -Milliseconds 80
  $sent = [QcMidiNavigation]::midiOutShortMsg($handle, $program)
  if ($sent -ne 0) { throw "program change failed: $sent" }
} finally { [void][QcMidiNavigation]::midiOutClose($handle) }
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "pipe" });
}

child.stdout.on("data", chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (buffered.length < length + 4) return;
    const response = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
    buffered = buffered.subarray(length + 4);
    if (response.method === "device.stateFrame") {
      onNotification?.(response.params);
      continue;
    }
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  }
});

function call(method, params = {}, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, response => {
      clearTimeout(timeout);
      if (response.error) reject(new Error(`${method}: ${response.error.message}`));
      else resolve(response.result);
    });
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    child.stdin.write(Buffer.concat([header, body]));
  });
}

try {
  if (process.argv.includes("--app-sequence")) {
    console.log(JSON.stringify({ stage: "runtime-status", result: await call("system.status") }));
  }
  const connection = await call("device.reconnect", {}, 45_000);
  let before;
  const snapshotDeadline = performance.now() + 5_000;
  while (!before && performance.now() < snapshotDeadline) {
    try { before = await call("device.snapshot"); }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  if (!before) throw new Error("The connected QC did not publish its active preset");
  if (process.argv.includes("--app-sequence")) {
    try {
      console.log(JSON.stringify({ stage: "master-volume", result: await call("device.masterVolume") }));
    } catch (error) {
      console.log(JSON.stringify({ stage: "master-volume-pending", error: String(error) }));
    }
  }
  if (before.dirty) throw new Error("Refusing to navigate away from a dirty preset");
  let target = before.presetPosition > 1 ? before.presetPosition - 1 : before.presetPosition + 1;
  console.log(JSON.stringify({ stage: "before", connection, before, target }));
  try {
    if (!process.argv.includes("--skip-catalog")) {
      const catalogStarted = performance.now();
      const catalog = await call("device.listPresets", { setlistKey: before.setlistKey });
      console.log(JSON.stringify({
        stage: "catalog",
        elapsedMs: Math.round(performance.now() - catalogStarted),
        loading: catalog.loading,
        presetCount: catalog.presets.length,
      }));
    }
    const recallStarted = performance.now();
    let firstPositionEventMs;
    onNotification = frame => {
      if (firstPositionEventMs !== undefined) return;
      if (frame.states?.some(state => state.kind === "position" && state.position === target)) {
        firstPositionEventMs = Math.round(performance.now() - recallStarted);
        console.log(JSON.stringify({ stage: "position-event", elapsedMs: firstPositionEventMs, sequence: frame.sequence }));
      }
    };
    const result = process.argv.includes("--midi")
      ? await (async () => {
          sendWindowsMidiPreset(target);
          const deadline = performance.now() + 5_000;
          while (firstPositionEventMs === undefined && performance.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          if (firstPositionEventMs === undefined) throw new Error("MIDI preset change was not confirmed by pushed USB state");
          return { detail: "Windows MIDI program change confirmed by pushed USB state", snapshot: await call("device.snapshot") };
        })()
      : await call("device.recallPreset", {
          setlistKey: before.setlistKey,
          position: target,
          expectedPresetName: before.presetName,
          expectedPosition: before.presetPosition,
        }, 25_000);
    console.log(JSON.stringify({ stage: "result", elapsedMs: Math.round(performance.now() - recallStarted), firstPositionEventMs, result }));
    let moved = result.snapshot;
    if (moved && process.argv.includes("--double")) {
      const delayArgument = process.argv.find(argument => argument.startsWith("--between-ms="));
      const betweenMs = delayArgument ? Number(delayArgument.split("=")[1]) : 0;
      if (Number.isFinite(betweenMs) && betweenMs > 0) {
        await new Promise(resolve => setTimeout(resolve, betweenMs));
      }
      target = moved.presetPosition > 0 ? moved.presetPosition - 1 : moved.presetPosition + 1;
      const secondStarted = performance.now();
      firstPositionEventMs = undefined;
      const second = await call("device.recallPreset", {
        setlistKey: moved.setlistKey,
        position: target,
        expectedPresetName: moved.presetName,
        expectedPosition: moved.presetPosition,
      }, 25_000);
      console.log(JSON.stringify({ stage: "second-result", elapsedMs: Math.round(performance.now() - secondStarted), firstPositionEventMs, second }));
      moved = second.snapshot;
    }
    if (moved) {
      const restored = process.argv.includes("--midi")
        ? await (async () => {
            sendWindowsMidiPreset(before.presetPosition);
            const deadline = performance.now() + 5_000;
            let snapshot;
            do {
              await new Promise(resolve => setTimeout(resolve, 20));
              snapshot = await call("device.snapshot");
            } while (snapshot.presetPosition !== before.presetPosition && performance.now() < deadline);
            if (snapshot.presetPosition !== before.presetPosition) throw new Error("Could not restore the starting preset through MIDI");
            return snapshot;
          })()
        : await call("device.recallPreset", {
            setlistKey: before.setlistKey,
            position: before.presetPosition,
            expectedPresetName: moved.presetName,
            expectedPosition: moved.presetPosition,
          }, 25_000);
      console.log(JSON.stringify({ stage: "restored", restored }));
    }
  } catch (error) {
    const after = await call("device.snapshot");
    console.log(JSON.stringify({ stage: "failure", error: String(error), after }));
    process.exitCode = 1;
  }
} finally {
  try { await call("device.disconnect"); } catch {}
  child.stdin.end();
}
