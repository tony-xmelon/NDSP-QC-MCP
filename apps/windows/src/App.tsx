import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { demoSnapshot, type BlockDetails, type BlockParameter, type ConnectionState, type DiagnosticsReport, type GridBlock, type PresetEntry, type PresetList, type PresetSlotList, type PresetSnapshot, type RuntimeStatus, type WorkspaceDocument } from "@ndsp-qc/client";
import { formFactors, skins } from "@ndsp-qc/form-factors";
import { QuadCortexSurface, type HardwareAction } from "@ndsp-qc/ui";
import { assistantHelp, formatSnapshotSummary, parseAssistantIntent } from "./assistant";
import { diagnosticsFiles, tauriTransport, workspaceFiles } from "./tauri-transport";
import { createSpeechRecognition, speechRecognitionErrorMessage, type SpeechRecognitionLike } from "./voice";

type DialogName = "settings" | "about" | "connection" | "connection-log" | "device-info" | "shortcuts" | "privacy" | "legal" | "notices" | "guide" | "feedback" | "presets" | "parameters" | "workspace" | "save-device" | null;
type ConversationEntry = { id: number; role: "user" | "assistant" | "tool"; text: string };
type ConnectionEvent = { at: string; event: "app-start" | "runtime-ready" | "connect-attempt" | "connected" | "connect-failed" | "disconnected" | "reset-attempt" | "diagnostics-exported" };
type PendingAssistantAction =
  | { kind: "bypass"; block: GridBlock; targetBypassed: boolean; label: string }
  | { kind: "parameter"; block: BlockDetails; parameter: BlockParameter; value: number; label: string };

const initialConnection: ConnectionState = {
  phase: "disconnected",
  detail: "Device gateway is not connected",
  demo: true
};

const voiceDisclosureKey = "qc.voice.azure-disclosure.v1";

const menus = [
  { name: "File", items: ["Open Workspace…", "Open Device Preset…", "Save Workspace", "Save Workspace As…", "Save Preset to Quad Cortex…", "Settings…", "Exit"] },
  { name: "Edit", items: ["Undo Last App Change", "Redo", "Copy Block Settings", "Paste Block Settings", "Keyboard Shortcuts…"] },
  { name: "View", items: ["Fit Hardware to Window", "Actual Size", "Full Screen", "Show/Hide Chat", "Connection Log"] },
  { name: "Device", items: ["Connect", "Disconnect", "Reconnect", "Reset Communication Session", "Rescan USB Devices", "Refresh Complete State", "Current Device Information", "Discard Unsaved Changes…", "Open Tuner", "Open Gig View", "Export Diagnostics…"] },
  { name: "Help", items: ["User Guide", "Keyboard and Mouse Reference", "Report a Problem…", "About", "Third-Party Notices", "Privacy", "Legal Notices"] }
];

function MenuBar({ onSelect }: { onSelect: (item: string) => void }) {
  return <nav className="menu-bar" aria-label="Application menu">
    <div className="app-wordmark"><span className="wordmark-dot" /> QC VOICE CONTROL</div>
    <div className="menus">
      {menus.map((menu) => <details key={menu.name} className="menu">
        <summary>{menu.name}</summary>
        <div className="menu-popover">
          {menu.items.map((item) => <button key={item} onClick={(event) => {
            onSelect(item);
            event.currentTarget.closest("details")?.removeAttribute("open");
          }}>{item}</button>)}
        </div>
      </details>)}
    </div>
    <div className="window-title">Windows Client</div>
  </nav>;
}

function ConnectionBadge({ connection }: { connection: ConnectionState }) {
  return <span className={`connection-badge phase-${connection.phase}`}>
    <span className="status-light" />
    {connection.demo ? "DEMO" : connection.phase.replace("-", " ").toUpperCase()}
  </span>;
}

export function App() {
  const [connection, setConnection] = useState(initialConnection);
  const [runtime, setRuntime] = useState<RuntimeStatus>();
  const [snapshot, setSnapshot] = useState<PresetSnapshot>(demoSnapshot);
  const [selectedBlockId, setSelectedBlockId] = useState("amp");
  const [skinId, setSkinId] = useState("official-svg");
  const [formFactorId, setFormFactorId] = useState("quad-cortex-large");
  const [notice, setNotice] = useState("Demo state loaded. Connect the device gateway to enable hardware commands.");
  const [dialog, setDialog] = useState<DialogName>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ConversationEntry[]>([]);
  const [pendingAssistantAction, setPendingAssistantAction] = useState<PendingAssistantAction>();
  const [listening, setListening] = useState(false);
  const [commandPending, setCommandPending] = useState(false);
  const [presetList, setPresetList] = useState<PresetList>();
  const [presetListLoading, setPresetListLoading] = useState(false);
  const [blockDetails, setBlockDetails] = useState<BlockDetails>();
  const [parameterDrafts, setParameterDrafts] = useState<Record<number, number>>({});
  const [blockDetailsLoading, setBlockDetailsLoading] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string>();
  const [workspaceName, setWorkspaceName] = useState<string>();
  const [loadedWorkspace, setLoadedWorkspace] = useState<WorkspaceDocument>();
  const [presetSlots, setPresetSlots] = useState<PresetSlotList>();
  const [savePresetName, setSavePresetName] = useState("");
  const [savePresetPosition, setSavePresetPosition] = useState<number>();
  const [presetSlotsLoading, setPresetSlotsLoading] = useState(false);
  const [connectionEvents, setConnectionEvents] = useState<ConnectionEvent[]>([{ at: new Date().toISOString(), event: "app-start" }]);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const speechRecognition = useRef<SpeechRecognitionLike | undefined>(undefined);
  const voiceTranscript = useRef("");
  const submitVoiceOnEnd = useRef(false);
  const voiceError = useRef("");
  const autoConnectStarted = useRef(false);
  const conversationSequence = useRef(0);
  const tempoCommitTimer = useRef<number | undefined>(undefined);
  const tempoExpected = useRef<number | undefined>(undefined);
  const tempoTarget = useRef<number | undefined>(undefined);
  const tapTimes = useRef<number[]>([]);

  const formFactor = useMemo(() => formFactors.find((item) => item.id === formFactorId) ?? formFactors[0], [formFactorId]);
  const skin = useMemo(() => skins.find((item) => item.id === skinId) ?? skins[0], [skinId]);

  useEffect(() => {
    void tauriTransport.runtimeStatus().then((status) => {
      setRuntime(status);
      setConnectionEvents((current) => [...current, { at: new Date().toISOString(), event: "runtime-ready" }]);
    }).catch((error: Error) => setNotice(error.message));
    return () => {
      speechRecognition.current?.abort();
      if (tempoCommitTimer.current !== undefined) window.clearTimeout(tempoCommitTimer.current);
    };
  }, []);

  const actionFailed = useCallback((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    setNotice(detail);
  }, []);

  const chooseScene = useCallback(async (index: number) => {
    if (connection.demo) {
      setSnapshot((current) => ({ ...current, activeScene: index }));
      setNotice(`Demo: selected Scene ${String.fromCharCode(65 + index)} — ${snapshot.scenes[index]}. Hardware was not changed.`);
      return;
    }
    if (commandPending) return;
    setCommandPending(true);
    setNotice(`Selecting Scene ${String.fromCharCode(65 + index)}…`);
    try {
      const result = await tauriTransport.selectScene(index, snapshot.presetName);
      if (result.snapshot) setSnapshot(result.snapshot);
      setNotice(result.detail);
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  }, [actionFailed, commandPending, connection.demo, snapshot.presetName, snapshot.scenes]);

  const toggleSelectedBypass = useCallback(async () => {
    const block = snapshot.blocks.find((candidate) => candidate.id === selectedBlockId);
    if (!block || commandPending) return;
    if (connection.demo) {
      setSnapshot((current) => ({ ...current, blocks: current.blocks.map((candidate) => candidate.id === block.id ? { ...candidate, bypassed: !candidate.bypassed } : candidate) }));
      setNotice("Demo: selected block bypass toggled locally.");
      return;
    }
    setCommandPending(true);
    setNotice(`${block.bypassed ? "Enabling" : "Bypassing"} ${block.name}…`);
    try {
      const result = await tauriTransport.toggleBypass(block.row, block.column, snapshot.activeScene, block.bypassed ?? false, !(block.bypassed ?? false), snapshot.presetName);
      if (result.snapshot) setSnapshot(result.snapshot);
      setNotice(result.detail);
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  }, [actionFailed, commandPending, connection.demo, selectedBlockId, snapshot]);

  const pressFootswitch = useCallback(async (index: number) => {
    const label = String.fromCharCode(65 + index);
    if (connection.demo) {
      setSnapshot((current) => ({ ...current, activeScene: index }));
      setNotice(`Demo: Footswitch ${label} activated locally; hardware was not changed.`);
      return;
    }
    if (commandPending) return;
    setCommandPending(true);
    setNotice(`Pressing Footswitch ${label} in ${snapshot.mode} mode…`);
    try {
      const result = await tauriTransport.pressFootswitch(index, snapshot.mode, snapshot.presetName);
      if (result.snapshot) {
        const presetChanged = result.snapshot.presetPosition !== snapshot.presetPosition;
        setSnapshot(result.snapshot);
        if (presetChanged) setSelectedBlockId(result.snapshot.blocks[0]?.id ?? "");
      }
      setNotice(result.detail);
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  }, [actionFailed, commandPending, connection.demo, snapshot.mode, snapshot.presetName, snapshot.presetPosition]);

  const showDeviceView = useCallback(async (view: "tuner" | "gig") => {
    if (connection.demo || commandPending) {
      setNotice(connection.demo ? `Connect the Quad Cortex before opening ${view === "tuner" ? "the tuner" : "Gig View"}.` : "A device command is already in progress.");
      return;
    }
    setCommandPending(true);
    try {
      const result = view === "tuner" ? await tauriTransport.showTuner() : await tauriTransport.showGigView();
      setNotice(result.detail);
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  }, [actionFailed, commandPending, connection.demo]);

  const navigateBank = useCallback(async (direction: -1 | 1) => {
    if (connection.demo || commandPending) {
      setNotice(connection.demo ? "Connect the Quad Cortex before navigating presets." : "A device command is already in progress.");
      return;
    }
    setCommandPending(true);
    setNotice(`${direction > 0 ? "Bank Up" : "Bank Down"}: recalling the matching preset slot…`);
    try {
      const result = await tauriTransport.navigateBank(direction, snapshot.presetName, snapshot.presetPosition);
      if (result.snapshot) {
        setSnapshot(result.snapshot);
        setSelectedBlockId(result.snapshot.blocks[0]?.id ?? "");
      }
      setNotice(result.detail);
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  }, [actionFailed, commandPending, connection.demo, snapshot.presetName, snapshot.presetPosition]);

  const openBlockEditor = useCallback(async (block: GridBlock) => {
    setSelectedBlockId(block.id);
    if (connection.demo || commandPending) {
      setNotice(connection.demo ? `${block.name} selected in demo mode.` : "A device command is already in progress.");
      return;
    }
    setDialog("parameters");
    setBlockDetails(undefined);
    setBlockDetailsLoading(true);
    setNotice(`Reading ${block.name} parameters…`);
    try {
      const details = await tauriTransport.blockDetails(block.row, block.column, snapshot.presetName);
      setBlockDetails(details);
      setParameterDrafts(Object.fromEntries(details.parameters.filter((parameter) => parameter.normalizedValue !== null).map((parameter) => [parameter.index, parameter.normalizedValue as number])));
      setNotice(`${details.name} parameters synchronized.`);
    } catch (error) {
      actionFailed(error);
    } finally {
      setBlockDetailsLoading(false);
    }
  }, [actionFailed, commandPending, connection.demo, snapshot.presetName]);

  const applyParameter = async (parameter: BlockParameter) => {
    if (!blockDetails || parameter.normalizedValue === null || commandPending) return;
    const value = parameterDrafts[parameter.index] ?? parameter.normalizedValue;
    if (Math.abs(value - parameter.normalizedValue) < 0.000001) return;
    setCommandPending(true);
    setNotice(`Applying ${parameter.name}…`);
    try {
      const result = await tauriTransport.setParameter(
        blockDetails.row,
        blockDetails.column,
        parameter.index,
        value,
        parameter.normalizedValue,
        snapshot.activeScene,
        snapshot.presetName
      );
      setBlockDetails(result.block);
      setParameterDrafts(Object.fromEntries(result.block.parameters.filter((candidate) => candidate.normalizedValue !== null).map((candidate) => [candidate.index, candidate.normalizedValue as number])));
      if (result.snapshot) setSnapshot(result.snapshot);
      setNotice(result.detail);
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  };

  const queueTempo = useCallback((requestedBpm: number, source: "Encoder" | "Tap") => {
    const bpm = Math.max(40, Math.min(240, Math.round(requestedBpm)));
    if (connection.demo) {
      setSnapshot((current) => ({ ...current, tempo: bpm }));
      setNotice(`Demo: ${source.toLowerCase()} tempo ${bpm} BPM.`);
      return;
    }
    if (tempoExpected.current === undefined) {
      tempoExpected.current = snapshot.tempo;
      setCommandPending(true);
    }
    tempoTarget.current = bpm;
    setSnapshot((current) => ({ ...current, tempo: bpm }));
    setNotice(`${source} tempo: ${bpm} BPM…`);
    if (tempoCommitTimer.current !== undefined) window.clearTimeout(tempoCommitTimer.current);
    tempoCommitTimer.current = window.setTimeout(async () => {
      const target = tempoTarget.current;
      const expected = tempoExpected.current;
      tempoCommitTimer.current = undefined;
      if (target === undefined || expected === undefined) return;
      try {
        const result = await tauriTransport.setTempo(target, expected, snapshot.presetName);
        if (result.snapshot) setSnapshot(result.snapshot);
        setNotice(result.detail);
      } catch (error) {
        actionFailed(error);
        try {
          setSnapshot(await tauriTransport.currentSnapshot());
        } catch {
          // Keep the original command error visible; a manual refresh remains available.
        }
      } finally {
        tempoExpected.current = undefined;
        tempoTarget.current = undefined;
        setCommandPending(false);
      }
    }, source === "Tap" ? 650 : 350);
  }, [actionFailed, connection.demo, snapshot.presetName, snapshot.tempo]);

  const adjustTempo = useCallback((delta: number) => {
    queueTempo((tempoTarget.current ?? snapshot.tempo) + delta, "Encoder");
  }, [queueTempo, snapshot.tempo]);

  const tapTempo = useCallback(() => {
    const now = performance.now();
    const previous = tapTimes.current.at(-1);
    if (previous === undefined || now - previous > 2500) tapTimes.current = [now];
    else tapTimes.current = [...tapTimes.current.slice(-4), now];
    if (tapTimes.current.length < 2) {
      setNotice("Tap again to set the tempo.");
      return;
    }
    const intervals = tapTimes.current.slice(1).map((time, index) => time - tapTimes.current[index]);
    const usable = intervals.filter((interval) => interval >= 250 && interval <= 1500);
    if (!usable.length) {
      tapTimes.current = [now];
      setNotice("Tap again at a steady rate between 40 and 240 BPM.");
      return;
    }
    queueTempo(60000 / (usable.reduce((sum, interval) => sum + interval, 0) / usable.length), "Tap");
  }, [queueTempo]);

  const handleHardwareAction = useCallback((action: HardwareAction) => {
    if (action.kind === "select-block") {
      const block = snapshot.blocks.find((candidate) => candidate.id === action.blockId);
      if (block) void openBlockEditor(block);
      return;
    }
    if (action.kind === "rotate") {
      if (action.role === "tempo") adjustTempo(action.delta);
      else setNotice(connection.demo ? `Demo encoder: ${action.role} ${action.delta > 0 ? "+" : "−"}1.` : `${action.role} encoder writes are not enabled yet.`);
      return;
    }
    if (action.phase === "release" && action.role.startsWith("footswitch:")) {
      void pressFootswitch(action.role.charCodeAt(action.role.length - 1) - 65);
      return;
    }
    if (action.phase === "release" && action.role === "bank:up") {
      void navigateBank(1);
      return;
    }
    if (action.phase === "release" && action.role === "bank:down") {
      void navigateBank(-1);
      return;
    }
    if (action.phase === "release" && action.role === "tempo") tapTempo();
    else if (action.phase === "release") setNotice(connection.demo ? `Demo switch: ${action.role}. Hardware was not changed.` : `${action.role} is not enabled in the live control slice yet.`);
  }, [adjustTempo, connection.demo, navigateBank, openBlockEditor, pressFootswitch, snapshot.blocks, tapTempo]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const textEntry = target?.matches("input, textarea, [contenteditable=true]");
      if (event.ctrlKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        setChatOpen(true);
        requestAnimationFrame(() => chatInput.current?.focus());
        return;
      }
      if (textEntry) return;
      if (/^[1-8]$/.test(event.key)) event.ctrlKey ? void chooseScene(Number(event.key) - 1) : void pressFootswitch(Number(event.key) - 1);
      if (event.key === "[") void navigateBank(-1);
      if (event.key === "]") void navigateBank(1);
      if (event.key.toLowerCase() === "t") event.shiftKey ? void showDeviceView("tuner") : tapTempo();
      if (event.key.toLowerCase() === "b" && selectedBlockId) void toggleSelectedBypass();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseScene, navigateBank, pressFootswitch, selectedBlockId, showDeviceView, tapTempo, toggleSelectedBypass]);

  const connect = async (mode: "reconnect" | "reset" = "reconnect") => {
    setConnectionEvents((current) => [...current, { at: new Date().toISOString(), event: mode === "reset" ? "reset-attempt" : "connect-attempt" }]);
    setConnection({ phase: "discovering", detail: "Looking for device gateway…", demo: true });
    try {
      const next = mode === "reset" ? await tauriTransport.resetSession() : await tauriTransport.reconnect();
      setConnection(next);
      if (next.phase === "ready") {
        const current = await tauriTransport.currentSnapshot();
        setSnapshot(current);
        setSelectedBlockId(current.blocks[0]?.id ?? "");
        setNotice(`${next.detail}. Live preset state synchronized.`);
        setConnectionEvents((events) => [...events, { at: new Date().toISOString(), event: "connected" }]);
      } else {
        setNotice(next.detail);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setConnection({ phase: "needs-attention", detail, demo: true });
      setNotice(detail);
      setDialog("connection");
      setConnectionEvents((events) => [...events, { at: new Date().toISOString(), event: "connect-failed" }]);
    }
  };

  const disconnectDevice = async () => {
    if (commandPending) {
      setNotice("Wait for the current device command to finish before disconnecting.");
      return;
    }
    setCommandPending(true);
    speechRecognition.current?.abort();
    setListening(false);
    try {
      const next = await tauriTransport.disconnect();
      setConnection(next);
      setNotice(next.detail);
      setConnectionEvents((events) => [...events, { at: new Date().toISOString(), event: "disconnected" }]);
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  };

  const exportDiagnostics = async () => {
    const report: DiagnosticsReport = {
      generatedAt: new Date().toISOString(),
      appVersion: "0.1.0",
      runtime: { platform: runtime?.platform ?? "unknown", gatewayAvailable: runtime?.gatewayAvailable ?? false },
      connection: { phase: connection.phase, demo: connection.demo },
      device: {
        presetLocation: snapshot.presetLocation,
        presetPosition: snapshot.presetPosition,
        mode: snapshot.mode,
        activeScene: snapshot.activeScene,
        tempo: snapshot.tempo,
        dirty: snapshot.dirty,
        blockCount: snapshot.blocks.length
      },
      events: connectionEvents
    };
    try {
      const result = await diagnosticsFiles.export(report);
      if (result.cancelled) {
        setNotice("Diagnostics export cancelled.");
        return;
      }
      setConnectionEvents((events) => [...events, { at: new Date().toISOString(), event: "diagnostics-exported" }]);
      setNotice(`Redacted diagnostics exported as ${result.name}.`);
    } catch (error) {
      actionFailed(error);
    }
  };

  useEffect(() => {
    if (autoConnectStarted.current) return;
    autoConnectStarted.current = true;
    void connect();
  }, []);

  const refreshSnapshot = async () => {
    if (connection.demo || commandPending) return;
    setCommandPending(true);
    setNotice("Refreshing complete device state…");
    try {
      const current = await tauriTransport.currentSnapshot();
      setSnapshot(current);
      setNotice("Live preset state refreshed.");
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  };

  const openPresetBrowser = async (refresh = false) => {
    if (connection.demo || commandPending) {
      setNotice(connection.demo ? "Connect the Quad Cortex before opening its preset browser." : "A device command is already in progress.");
      return;
    }
    setDialog("presets");
    setPresetListLoading(true);
    try {
      const list = await tauriTransport.listPresets(refresh);
      setPresetList(list);
    } catch (error) {
      actionFailed(error);
    } finally {
      setPresetListLoading(false);
    }
  };

  const recallPreset = async (entry: PresetEntry) => {
    if (!presetList || commandPending || entry.position === snapshot.presetPosition) return;
    setCommandPending(true);
    setNotice(`Recalling ${entry.location} · ${entry.name}…`);
    try {
      const result = await tauriTransport.recallPreset(presetList.setlistKey, entry.position, snapshot.presetName, snapshot.presetPosition);
      if (result.snapshot) {
        setSnapshot(result.snapshot);
        setSelectedBlockId(result.snapshot.blocks[0]?.id ?? "");
      }
      setNotice(result.detail);
      setDialog(null);
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  };

  const reloadPreset = async () => {
    if (connection.demo || commandPending) return;
    if (!window.confirm(`Discard all unsaved changes to ${snapshot.presetLocation} · ${snapshot.presetName} and reload it from the Quad Cortex?`)) return;
    setCommandPending(true);
    setNotice("Reloading the stored preset…");
    try {
      const result = await tauriTransport.reloadPreset(snapshot.presetName, snapshot.presetPosition);
      if (result.snapshot) {
        setSnapshot(result.snapshot);
        setSelectedBlockId(result.snapshot.blocks[0]?.id ?? "");
      }
      setNotice(result.detail);
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  };

  const createWorkspaceDocument = (): WorkspaceDocument => ({
    version: 1,
    savedAt: new Date().toISOString(),
    source: {
      deviceName: snapshot.deviceName,
      setlistKey: snapshot.setlistKey,
      setlistName: snapshot.setlistName,
      presetPosition: snapshot.presetPosition,
      presetLocation: snapshot.presetLocation,
      presetName: snapshot.presetName
    },
    snapshot,
    selectedBlock: blockDetails,
    ui: { selectedBlockId, formFactorId, skinId }
  });

  const saveWorkspace = async (saveAs = false) => {
    if (commandPending) return;
    setCommandPending(true);
    try {
      const document = createWorkspaceDocument();
      const result = !saveAs && workspacePath
        ? await workspaceFiles.save(workspacePath, document)
        : await workspaceFiles.saveAs(document, `${snapshot.presetLocation} ${snapshot.presetName}`);
      if (!result.cancelled && result.path) {
        setWorkspacePath(result.path);
        setWorkspaceName(result.name);
        setLoadedWorkspace(document);
        setNotice(`Workspace saved: ${result.name}`);
      }
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  };

  const openWorkspace = async () => {
    if (commandPending) return;
    setCommandPending(true);
    try {
      const result = await workspaceFiles.open();
      if (!result.cancelled && result.document && result.path) {
        setWorkspacePath(result.path);
        setWorkspaceName(result.name);
        setLoadedWorkspace(result.document);
        setDialog("workspace");
        setNotice(`Workspace opened: ${result.name}`);
      }
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  };

  const exitApp = async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  };

  const openDeviceSave = async () => {
    if (connection.demo || commandPending) {
      setNotice(connection.demo ? "Connect the Quad Cortex before saving a preset." : "A device command is already in progress.");
      return;
    }
    setDialog("save-device");
    setPresetSlotsLoading(true);
    setSavePresetName(`${snapshot.presetName} Copy`);
    try {
      const slots = await tauriTransport.listPresetSlots();
      setPresetSlots(slots);
      const empty = slots.slots.find((slot) => !slot.occupied && slot.position !== snapshot.presetPosition);
      setSavePresetPosition(empty?.position ?? snapshot.presetPosition);
    } catch (error) {
      actionFailed(error);
    } finally {
      setPresetSlotsLoading(false);
    }
  };

  const savePresetToDevice = async () => {
    if (!presetSlots || savePresetPosition === undefined || commandPending) return;
    const destination = presetSlots.slots[savePresetPosition];
    if (!destination || !savePresetName.trim()) return;
    const message = destination.occupied
      ? `Overwrite ${destination.location} · ${destination.name} with the current live Grid as “${savePresetName.trim()}”? This cannot be undone by the app.`
      : `Save the current live Grid to ${destination.location} as “${savePresetName.trim()}”?`;
    if (!window.confirm(message)) return;
    setCommandPending(true);
    setNotice(`Saving preset to ${destination.location}…`);
    try {
      const result = await tauriTransport.savePresetAs(
        presetSlots.setlistKey,
        destination.position,
        savePresetName.trim(),
        snapshot.presetName,
        snapshot.presetPosition,
        destination.occupied
      );
      if (result.snapshot) {
        setSnapshot(result.snapshot);
        setSelectedBlockId(result.snapshot.blocks[0]?.id ?? "");
      }
      setPresetList(undefined);
      setNotice(result.detail);
      setDialog(null);
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  };

  const menuSelect = (item: string) => {
    if (item === "Settings…") setDialog("settings");
    else if (item === "Open Workspace…") void openWorkspace();
    else if (item === "Save Workspace") void saveWorkspace();
    else if (item === "Save Workspace As…") void saveWorkspace(true);
    else if (item === "Save Preset to Quad Cortex…") void openDeviceSave();
    else if (item === "Open Device Preset…") void openPresetBrowser();
    else if (item === "About") setDialog("about");
    else if (item === "Connection Log") setDialog("connection-log");
    else if (item === "Current Device Information") setDialog("device-info");
    else if (item === "Keyboard Shortcuts…" || item === "Keyboard and Mouse Reference") setDialog("shortcuts");
    else if (item === "User Guide") setDialog("guide");
    else if (item === "Privacy") setDialog("privacy");
    else if (item === "Legal Notices") setDialog("legal");
    else if (item === "Third-Party Notices") setDialog("notices");
    else if (item === "Report a Problem…") setDialog("feedback");
    else if (item === "Show/Hide Chat") setChatOpen((open) => !open);
    else if (item === "Connect" || item === "Reconnect" || item === "Rescan USB Devices") void connect();
    else if (item === "Disconnect") void disconnectDevice();
    else if (item === "Reset Communication Session") void connect("reset");
    else if (item === "Refresh Complete State") void refreshSnapshot();
    else if (item === "Discard Unsaved Changes…") void reloadPreset();
    else if (item === "Open Tuner") void showDeviceView("tuner");
    else if (item === "Open Gig View") void showDeviceView("gig");
    else if (item === "Export Diagnostics…") void exportDiagnostics();
    else if (item === "Full Screen") void document.documentElement.requestFullscreen?.();
    else if (item === "Exit") void exitApp();
    else setNotice(`${item} is present in the shell and will be wired in its delivery phase.`);
  };

  const appendMessage = (role: ConversationEntry["role"], text: string) => {
    const entry = { id: ++conversationSequence.current, role, text };
    setMessages((current) => [...current, entry]);
  };

  const resolveParameterValue = (parameter: BlockParameter, rawValue: string) => {
    const value = rawValue.trim().replace(/^[“”"']|[“”"']$/g, "");
    if (parameter.options.length > 1) {
      const optionIndex = parameter.options.findIndex((option) => option.toLowerCase() === value.toLowerCase());
      if (optionIndex < 0) throw new Error(`Choose one of: ${parameter.options.join(", ")}.`);
      return { normalized: optionIndex / (parameter.options.length - 1), display: parameter.options[optionIndex] };
    }
    if (value.endsWith("%")) {
      const percentage = Number(value.slice(0, -1));
      if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw new Error("Use a percentage from 0% through 100%.");
      return { normalized: percentage / 100, display: `${percentage}%` };
    }
    const numeric = Number(value.replace(parameter.units, "").trim());
    if (!Number.isFinite(numeric)) throw new Error(`I could not interpret “${rawValue}” as a value for ${parameter.name}.`);
    if (numeric < parameter.minimum || numeric > parameter.maximum || parameter.maximum === parameter.minimum) {
      throw new Error(`${parameter.name} accepts ${parameter.minimum} through ${parameter.maximum}${parameter.units ? ` ${parameter.units}` : ""}, or a percentage.`);
    }
    return {
      normalized: (numeric - parameter.minimum) / (parameter.maximum - parameter.minimum),
      display: `${numeric}${parameter.units ? ` ${parameter.units}` : ""}`
    };
  };

  const executeImmediateAssistantIntent = async (intent: ReturnType<typeof parseAssistantIntent>) => {
    if (intent.kind === "inspect") {
      appendMessage("assistant", formatSnapshotSummary(snapshot));
      setNotice("Current QC context summarized locally.");
      return;
    }
    if (intent.kind === "help") {
      appendMessage("assistant", assistantHelp);
      setNotice("Typed QC command examples are shown in chat.");
      return;
    }
    if (intent.kind === "bypass") {
      const block = snapshot.blocks.find((candidate) => candidate.id === selectedBlockId);
      if (!block || block.bypassed === undefined) throw new Error("Select a bypass-capable block on the Grid first.");
      const targetBypassed = intent.desired === "toggle" ? !block.bypassed : intent.desired === "bypassed";
      if (block.bypassed === targetBypassed) {
        appendMessage("assistant", `${block.name} is already ${targetBypassed ? "bypassed" : "enabled"}.`);
        setNotice(`${block.name} already matches the requested bypass state.`);
        return;
      }
      const label = `${targetBypassed ? "Bypass" : "Enable"} ${block.name} in Scene ${String.fromCharCode(65 + snapshot.activeScene)}`;
      setPendingAssistantAction({ kind: "bypass", block, targetBypassed, label });
      appendMessage("assistant", "I prepared a temporary Grid edit. Review it below before applying.");
      setNotice("Temporary bypass edit is waiting for review.");
      return;
    }
    if (intent.kind === "parameter") {
      if (connection.demo) throw new Error("Connect the Quad Cortex before preparing a live parameter edit.");
      const selected = snapshot.blocks.find((candidate) => candidate.id === selectedBlockId);
      if (!selected) throw new Error("Select a block on the Grid first.");
      const details = await tauriTransport.blockDetails(selected.row, selected.column, snapshot.presetName);
      const needle = intent.parameter.toLowerCase().replace(/[^a-z0-9]/g, "");
      const matches = details.parameters.filter((parameter) => parameter.writable && parameter.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(needle));
      if (matches.length !== 1) {
        const choices = details.parameters.filter((parameter) => parameter.writable).map((parameter) => parameter.name).join(", ");
        throw new Error(matches.length > 1 ? `That matches more than one parameter. Be more specific: ${matches.map((item) => item.name).join(", ")}.` : `I could not find that writable parameter on ${details.name}. Available: ${choices || "none"}.`);
      }
      const parameter = matches[0];
      if (parameter.normalizedValue === null) throw new Error(`${parameter.name} has no readable live value, so I will not write it.`);
      const resolved = resolveParameterValue(parameter, intent.value);
      const label = `Set ${details.name} · ${parameter.name} from ${parameter.displayValue} to ${resolved.display} in Scene ${String.fromCharCode(65 + snapshot.activeScene)}`;
      setPendingAssistantAction({ kind: "parameter", block: details, parameter, value: resolved.normalized, label });
      appendMessage("assistant", "I prepared a temporary parameter edit. Review it below before applying.");
      setNotice("Temporary parameter edit is waiting for review.");
      return;
    }
    if (connection.demo) throw new Error("Connect the Quad Cortex before running that performance command.");
    if (intent.kind === "tempo") {
      if (!Number.isInteger(intent.bpm) || intent.bpm < 40 || intent.bpm > 240) throw new Error("Tempo must be from 40 through 240 BPM.");
      const result = await tauriTransport.setTempo(intent.bpm, snapshot.tempo, snapshot.presetName);
      if (result.snapshot) setSnapshot(result.snapshot);
      appendMessage("tool", result.detail);
      setNotice(result.detail);
      return;
    }
    if (intent.kind === "scene") {
      const result = await tauriTransport.selectScene(intent.index, snapshot.presetName);
      if (result.snapshot) setSnapshot(result.snapshot);
      appendMessage("tool", result.detail);
      setNotice(result.detail);
      return;
    }
    if (intent.kind === "bank") {
      const result = await tauriTransport.navigateBank(intent.direction, snapshot.presetName, snapshot.presetPosition);
      if (result.snapshot) {
        setSnapshot(result.snapshot);
        setSelectedBlockId(result.snapshot.blocks[0]?.id ?? "");
      }
      appendMessage("tool", result.detail);
      setNotice(result.detail);
      return;
    }
    if (intent.kind === "view") {
      const result = intent.view === "tuner" ? await tauriTransport.showTuner() : await tauriTransport.showGigView();
      appendMessage("tool", result.detail);
      setNotice(result.detail);
      return;
    }
    if (intent.kind === "recall") {
      const list = await tauriTransport.listPresets(false);
      const entry = list.presets.find((candidate) => candidate.location.toUpperCase() === intent.location);
      if (!entry) throw new Error(`${intent.location} is empty in ${list.setlistName}.`);
      if (entry.position === snapshot.presetPosition) {
        appendMessage("assistant", `${entry.location} · ${entry.name} is already active.`);
        setNotice(`${entry.location} is already active.`);
        return;
      }
      const result = await tauriTransport.recallPreset(list.setlistKey, entry.position, snapshot.presetName, snapshot.presetPosition);
      if (result.snapshot) {
        setSnapshot(result.snapshot);
        setSelectedBlockId(result.snapshot.blocks[0]?.id ?? "");
      }
      appendMessage("tool", result.detail);
      setNotice(result.detail);
    }
  };

  const submitAssistantText = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || commandPending) return;
    appendMessage("user", trimmed);
    setMessage("");
    setPendingAssistantAction(undefined);
    setCommandPending(true);
    setNotice("Interpreting the typed QC command…");
    try {
      await executeImmediateAssistantIntent(parseAssistantIntent(trimmed));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appendMessage("assistant", detail);
      setNotice(detail);
    } finally {
      setCommandPending(false);
    }
  };

  const sendMessage = async () => submitAssistantText(message);

  const applyPendingAssistantAction = async () => {
    const pending = pendingAssistantAction;
    if (!pending || commandPending) return;
    setCommandPending(true);
    setNotice(`Applying: ${pending.label}…`);
    try {
      if (pending.kind === "bypass") {
        const result = await tauriTransport.toggleBypass(pending.block.row, pending.block.column, snapshot.activeScene, pending.block.bypassed as boolean, pending.targetBypassed, snapshot.presetName);
        if (result.snapshot) setSnapshot(result.snapshot);
        appendMessage("tool", result.detail);
        setNotice(result.detail);
      } else {
        const result = await tauriTransport.setParameter(
          pending.block.row,
          pending.block.column,
          pending.parameter.index,
          pending.value,
          pending.parameter.normalizedValue as number,
          snapshot.activeScene,
          snapshot.presetName
        );
        if (result.snapshot) setSnapshot(result.snapshot);
        setBlockDetails(result.block);
        setParameterDrafts(Object.fromEntries(result.block.parameters.filter((parameter) => parameter.normalizedValue !== null).map((parameter) => [parameter.index, parameter.normalizedValue as number])));
        appendMessage("tool", result.detail);
        setNotice(result.detail);
      }
      setPendingAssistantAction(undefined);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appendMessage("assistant", detail);
      setNotice(detail);
    } finally {
      setCommandPending(false);
    }
  };

  const toggleMicrophone = async () => {
    if (listening) {
      submitVoiceOnEnd.current = true;
      speechRecognition.current?.stop();
      setNotice("Finishing the voice transcript…");
      return;
    }
    const recognition = createSpeechRecognition();
    if (!recognition) {
      setNotice("Speech recognition is unavailable in this WebView2 runtime. Typed QC commands remain available.");
      return;
    }
    if (localStorage.getItem(voiceDisclosureKey) !== "accepted") {
      const accepted = window.confirm("Voice transcription uses Microsoft Edge speech recognition. On this stable runtime, microphone audio may be sent to Microsoft Azure for transcription. Continue and remember this choice on this PC?");
      if (!accepted) {
        setNotice("Voice transcription was not enabled. No microphone audio was sent.");
        return;
      }
      localStorage.setItem(voiceDisclosureKey, "accepted");
    }
    voiceTranscript.current = "";
    submitVoiceOnEnd.current = false;
    voiceError.current = "";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onstart = () => {
      setListening(true);
      setNotice("Listening… click Stop to transcribe and run the command.");
    };
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += event.results[index][0]?.transcript ?? "";
      }
      voiceTranscript.current = transcript.trim();
      setMessage(voiceTranscript.current);
      setNotice(voiceTranscript.current ? `Heard: “${voiceTranscript.current}”` : "Listening…");
    };
    recognition.onerror = (event) => {
      submitVoiceOnEnd.current = false;
      voiceError.current = event.error;
      setListening(false);
      setNotice(speechRecognitionErrorMessage(event.error));
    };
    recognition.onend = () => {
      const transcript = voiceTranscript.current.trim();
      const shouldSubmit = submitVoiceOnEnd.current && Boolean(transcript);
      speechRecognition.current = undefined;
      submitVoiceOnEnd.current = false;
      setListening(false);
      if (voiceError.current) return;
      if (shouldSubmit) void submitAssistantText(transcript);
      else if (transcript) setNotice("Voice transcript is ready. Review it, then press Send.");
    };
    speechRecognition.current = recognition;
    try {
      setListening(true);
      recognition.start();
    } catch (error) {
      speechRecognition.current = undefined;
      setListening(false);
      actionFailed(error);
    }
  };

  return <div className="app-shell">
    <MenuBar onSelect={menuSelect} />

    <header className="device-toolbar">
      <div className="connection-cluster">
        <ConnectionBadge connection={connection} />
        <div><strong>{connection.detail}</strong><span>{runtime?.message ?? "Checking desktop runtime…"}</span></div>
      </div>
      <div className="toolbar-controls">
        <label>FORM FACTOR<select value={formFactorId} onChange={(event) => setFormFactorId(event.target.value)}>{formFactors.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label>
        <label>SKIN<select value={skinId} onChange={(event) => setSkinId(event.target.value)}>{skins.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label>
        <button className="toolbar-button" onClick={() => void connect()} disabled={commandPending}>↻ Reconnect</button>
        <button className="icon-button" title="Connection details" aria-label="Connection details" onClick={() => setDialog("connection")}>•••</button>
      </div>
    </header>

    <main className="workspace">
      <QuadCortexSurface formFactor={formFactor} snapshot={snapshot} selectedBlockId={selectedBlockId} skin={skin} onAction={handleHardwareAction} />
    </main>

    <div className="status-strip" role="status"><span className="status-symbol">i</span>{notice}<span className="shortcut-hint">1–8 switches · Ctrl+1–8 scenes · B bypass · [ ] bank · T tempo</span></div>

    {chatOpen ? <section className="chat-dock" aria-label="QC assistant">
      {messages.length > 0 && <div className="conversation-preview" aria-live="polite">{messages.slice(-4).map((item) => <div className={`${item.role}-message`} key={item.id}><span>{item.role === "tool" ? "QC RESULT" : item.role.toUpperCase()}</span>{item.text}</div>)}</div>}
      {pendingAssistantAction && <div className="assistant-action-card"><div><span>REVIEW TEMPORARY EDIT</span><strong>{pendingAssistantAction.label}</strong><small>This changes the live Grid but does not save the preset.</small></div><div><button onClick={() => setPendingAssistantAction(undefined)} disabled={commandPending}>Cancel</button><button className="primary" onClick={() => void applyPendingAssistantAction()} disabled={commandPending}>Apply temporarily</button></div></div>}
      <div className="context-line"><span className="context-pill">{connection.demo ? "DEMO" : "LIVE"}</span><strong>{snapshot.presetLocation} · {snapshot.presetName}</strong><span>Scene {String.fromCharCode(65 + snapshot.activeScene)}</span>{snapshot.dirty && <span className="dirty-state">UNSAVED DEVICE CHANGES</span>}{workspaceName && <span>Workspace: {workspaceName}</span>}<span>{selectedBlockId ? `Selected: ${snapshot.blocks.find((block) => block.id === selectedBlockId)?.name}` : "No block selected"}</span></div>
      <div className="composer">
        <button className="composer-tool" title="Attach QC context" aria-label="Attach QC context">＋</button>
        <textarea ref={chatInput} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
        }} placeholder="Ask about this preset or describe a change…" rows={1} />
        <button className={`mic-button${listening ? " is-listening" : ""}`} onClick={() => void toggleMicrophone()} aria-pressed={listening} title="Push to talk">{listening ? "■" : "●"}<span>{listening ? "STOP" : "VOICE"}</span></button>
        <button className="send-button" onClick={() => void sendMessage()} disabled={!message.trim() || commandPending} aria-label="Send message">↑</button>
      </div>
      <p className="safety-copy">Typed inspection and performance commands are available offline. Temporary edits show a preview; hardware save always requires confirmation.</p>
    </section> : <button className="restore-chat" onClick={() => setChatOpen(true)}>Open assistant <span>Ctrl+L</span></button>}

    {dialog && <div className="dialog-backdrop" role="presentation" onMouseDown={() => setDialog(null)}>
      <section className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="dialog-close" aria-label="Close" onClick={() => setDialog(null)}>×</button>
        {dialog === "connection" && <><div className="dialog-kicker">DEVICE CONNECTION</div><h2 id="dialog-title">{connection.phase === "ready" ? "Quad Cortex connected" : "Device needs attention"}</h2><p>{connection.detail}. The Python gateway owns the USB session and synchronizes state over private framed JSON-RPC.</p><dl><dt>Runtime</dt><dd>{runtime?.platform ?? "Unknown"}</dd><dt>Gateway</dt><dd>{runtime?.gatewayAvailable ? "Available" : "Unavailable"}</dd><dt>Controls</dt><dd>Scenes, tempo, block parameters/bypass, presets, tuner, and Gig View</dd></dl><div className="dialog-actions">{connection.phase === "ready" && <button onClick={() => void disconnectDevice()}>Disconnect</button>}<button onClick={() => void connect("reset")}>Reset session</button><button className="primary" onClick={() => void connect()}>Retry</button></div></>}
        {dialog === "connection-log" && <><div className="dialog-kicker">CONNECTION LOG</div><h2 id="dialog-title">Session lifecycle</h2><div className="connection-event-list">{connectionEvents.map((entry, index) => <div key={`${entry.at}-${index}`}><time>{new Date(entry.at).toLocaleTimeString()}</time><strong>{entry.event.replaceAll("-", " ")}</strong></div>)}</div><p>This log contains lifecycle event names only. Device identifiers, paths, preset names, and conversation text are not recorded.</p><div className="dialog-actions"><button onClick={() => setConnectionEvents([{ at: new Date().toISOString(), event: "app-start" }])}>Clear</button><button className="primary" onClick={() => void exportDiagnostics()}>Export redacted diagnostics…</button></div></>}
        {dialog === "device-info" && <><div className="dialog-kicker">CURRENT DEVICE</div><h2 id="dialog-title">{snapshot.deviceName}</h2><dl><dt>Connection</dt><dd>{connection.phase}</dd><dt>Setlist</dt><dd>{snapshot.setlistName}</dd><dt>Preset</dt><dd>{snapshot.presetLocation} · {snapshot.presetName}</dd><dt>Mode</dt><dd>{snapshot.mode}</dd><dt>Scene</dt><dd>{String.fromCharCode(65 + snapshot.activeScene)}</dd><dt>Tempo</dt><dd>{snapshot.tempo} BPM</dd><dt>Grid</dt><dd>{snapshot.blocks.length} blocks</dd><dt>State</dt><dd>{snapshot.dirty ? "Unsaved device changes" : "Clean"}</dd></dl><p>Hardware serial numbers and account identifiers are intentionally not read or displayed.</p></>}
        {dialog === "settings" && <><div className="dialog-kicker">SETTINGS</div><h2 id="dialog-title">Desktop preferences</h2><label className="setting-row"><span>Form factor<small>Geometry and control placement</small></span><select value={formFactorId} onChange={(event) => setFormFactorId(event.target.value)}>{formFactors.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label><label className="setting-row"><span>Skin<small>Appearance only; commands never change</small></span><select value={skinId} onChange={(event) => setSkinId(event.target.value)}>{skins.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label><div className="setting-row"><span>Push-to-talk transcription<small>Microsoft Edge speech recognition; cloud-audio disclosure appears before first use</small></span><button onClick={() => { localStorage.removeItem(voiceDisclosureKey); setNotice("Voice disclosure choice cleared. It will be shown again before the next recording."); }}>Review disclosure again</button></div></>}
        {dialog === "presets" && <><div className="dialog-kicker">DEVICE PRESETS</div><h2 id="dialog-title">{presetList?.setlistName ?? "Loading setlist…"}</h2><div className="preset-browser-toolbar"><span>{presetList ? `${presetList.presets.length} occupied slots` : "Reading from Quad Cortex"}</span><button onClick={() => void openPresetBrowser(true)} disabled={presetListLoading || commandPending}>Refresh</button></div><div className="preset-browser" role="listbox" aria-label="Device presets">{presetListLoading && !presetList ? <p>Loading preset directory…</p> : presetList?.presets.map((entry) => <button key={entry.position} role="option" aria-selected={entry.position === snapshot.presetPosition} className={entry.position === snapshot.presetPosition ? "is-current" : ""} disabled={commandPending} onClick={() => void recallPreset(entry)}><strong>{entry.location}</strong><span>{entry.name}</span></button>)}</div><p>Recalling a preset is blocked while the current preset has unsaved changes.</p></>}
        {dialog === "parameters" && <><div className="dialog-kicker">BLOCK PARAMETERS · SCENE {String.fromCharCode(65 + snapshot.activeScene)}</div><h2 id="dialog-title">{blockDetails?.name ?? "Loading block…"}</h2>{blockDetailsLoading ? <p>Reading parameter metadata and live values…</p> : blockDetails && <div className="parameter-editor">{blockDetails.parameters.length === 0 && <p>This block exposes no editable catalog parameters.</p>}{blockDetails.parameters.map((parameter) => {
          const draft = parameterDrafts[parameter.index] ?? parameter.normalizedValue ?? 0;
          const changed = parameter.normalizedValue !== null && Math.abs(draft - parameter.normalizedValue) >= 0.000001;
          const optionIndex = parameter.options.length > 1 ? Math.round(draft * (parameter.options.length - 1)) : 0;
          const numericDisplay = parameter.minimum === 0 && parameter.maximum === 1 ? draft : parameter.minimum + draft * (parameter.maximum - parameter.minimum);
          return <div className="parameter-row" key={parameter.index}><div className="parameter-heading"><strong>{parameter.name}</strong><span>{parameter.options.length ? parameter.options[optionIndex] : `${numericDisplay.toFixed(2).replace(/\.00$/, "")} ${parameter.units}`}</span></div>{parameter.options.length > 1 ? <select value={optionIndex} disabled={!parameter.writable || commandPending} onChange={(event) => setParameterDrafts((current) => ({ ...current, [parameter.index]: Number(event.target.value) / (parameter.options.length - 1) }))}>{parameter.options.map((option, index) => <option value={index} key={`${option}-${index}`}>{option}</option>)}</select> : <input type="range" min="0" max="1" step={parameter.steps && parameter.steps > 1 ? 1 / (parameter.steps - 1) : .001} value={draft} disabled={!parameter.writable || commandPending} onChange={(event) => setParameterDrafts((current) => ({ ...current, [parameter.index]: Number(event.target.value) }))} />}<div className="parameter-actions"><small>{parameter.sceneMode ? "Scene value" : "Global within preset"}</small><button disabled={!changed || !parameter.writable || commandPending} onClick={() => void applyParameter(parameter)}>Apply</button></div></div>;
        })}</div>}<p>Changes apply temporarily to the live Grid and require a separate preset save to persist.</p></>}
        {dialog === "workspace" && loadedWorkspace && <><div className="dialog-kicker">LOCAL WORKSPACE</div><h2 id="dialog-title">{workspaceName ?? "QC Workspace"}</h2><dl><dt>Saved</dt><dd>{new Date(loadedWorkspace.savedAt).toLocaleString()}</dd><dt>Source</dt><dd>{loadedWorkspace.source.setlistName} · {loadedWorkspace.source.presetLocation}</dd><dt>Preset</dt><dd>{loadedWorkspace.source.presetName}</dd><dt>Scene</dt><dd>{String.fromCharCode(65 + loadedWorkspace.snapshot.activeScene)}</dd><dt>Blocks</dt><dd>{loadedWorkspace.snapshot.blocks.length}</dd><dt>Device state</dt><dd>{loadedWorkspace.snapshot.dirty ? "Captured with unsaved changes" : "Clean at capture"}</dd></dl><p>The workspace is a local reference snapshot. Opening it never writes to the connected Quad Cortex.</p><div className="dialog-actions"><button onClick={() => setDialog(null)}>Keep Live Device</button><button className="primary" onClick={() => void saveWorkspace(true)}>Save Copy As…</button></div></>}
        {dialog === "save-device" && <><div className="dialog-kicker">PERSISTENT DEVICE SAVE</div><h2 id="dialog-title">Save Preset As…</h2>{presetSlotsLoading ? <p>Reading all destination slots from the Quad Cortex…</p> : presetSlots && <div className="device-save-form"><label><span>Setlist</span><strong>{presetSlots.setlistName}</strong></label><label><span>Preset name</span><input value={savePresetName} maxLength={80} onChange={(event) => setSavePresetName(event.target.value)} /></label><label><span>Destination</span><select value={savePresetPosition ?? ""} onChange={(event) => setSavePresetPosition(Number(event.target.value))}>{presetSlots.slots.map((slot) => <option key={slot.position} value={slot.position}>{slot.location} — {slot.occupied ? slot.name : "Empty"}</option>)}</select></label>{savePresetPosition !== undefined && presetSlots.slots[savePresetPosition]?.occupied && <p className="overwrite-warning">This destination is occupied. Saving will permanently overwrite “{presetSlots.slots[savePresetPosition].name}”.</p>}<div className="dialog-actions"><button onClick={() => setDialog(null)}>Cancel</button><button className="primary" disabled={!savePresetName.trim() || commandPending} onClick={() => void savePresetToDevice()}>Review & Save</button></div></div>}<p>Device save is separate from local workspace save and always requires final confirmation.</p></>}
        {dialog === "shortcuts" && <><div className="dialog-kicker">INPUT REFERENCE</div><h2 id="dialog-title">Keyboard and mouse</h2><dl><dt>1–8</dt><dd>Press Footswitches A–H in the current QC mode</dd><dt>Ctrl+1–8</dt><dd>Select Scenes A–H directly</dd><dt>[ / ]</dt><dd>Bank down / up</dd><dt>T / Shift+T</dt><dd>Tap tempo / open tuner</dd><dt>B</dt><dd>Toggle the selected block</dd><dt>Ctrl+L</dt><dd>Focus the assistant</dd><dt>Click block</dt><dd>Open live parameters</dd><dt>Tempo encoder</dt><dd>Turn to adjust; press repeatedly to tap</dd></dl><p>Shortcuts are suspended while an input or the chat composer has focus.</p></>}
        {dialog === "guide" && <><div className="dialog-kicker">USER GUIDE</div><h2 id="dialog-title">Safe QC control</h2><p>Connect the QC by USB and close Cortex Control, which otherwise owns the interface. Click Grid blocks to inspect and edit their live parameters; temporary edits mark the preset unsaved.</p><p>Use the preset browser or Bank controls only when the preset is clean. “Save Workspace” writes a local reference file. “Save Preset to Quad Cortex” is the separate persistent operation and always asks for a destination and confirmation.</p><p>Typed or spoken commands use the same guarded controls. Bypass and parameter edits show a preview before application.</p></>}
        {dialog === "privacy" && <><div className="dialog-kicker">PRIVACY</div><h2 id="dialog-title">Local by default</h2><p>Manual control, typed commands, workspaces, and diagnostics operate locally. The desktop configuration binds no network listener and does not collect analytics.</p><p>Push-to-talk uses Microsoft Edge speech recognition only after disclosure and consent; that service may send microphone audio to Microsoft Azure. Conversation text is never included in diagnostics.</p></>}
        {dialog === "legal" && <><div className="dialog-kicker">LEGAL</div><h2 id="dialog-title">Unofficial controller</h2><p>QC Voice Control is not affiliated with, endorsed by, or supported by Neural DSP Technologies. “Neural DSP” and “Quad Cortex” are trademarks of their respective owner and are used only to describe compatibility.</p><p>No project source license has been granted. Third-party components retain their own licenses.</p></>}
        {dialog === "notices" && <><div className="dialog-kicker">THIRD-PARTY NOTICES</div><h2 id="dialog-title">Runtime components</h2><p>This build includes Tauri, React, WebView2 integration, PyInstaller, hidapi, protobuf, and the community-maintained pyquadcortex library. Their respective licenses and notices remain with those projects.</p><p>pyquadcortex is unofficial and communicates with the QC over its existing USB protocol; it does not modify device firmware.</p></>}
        {dialog === "feedback" && <><div className="dialog-kicker">REPORT A PROBLEM</div><h2 id="dialog-title">Prepare a safe report</h2><p>Export the diagnostic report and attach it through your preferred support channel. The export contains app/runtime state and lifecycle event names while omitting serial numbers, MAC addresses, usernames, filesystem paths, preset/setlist names, and conversation content.</p><div className="dialog-actions"><button className="primary" onClick={() => void exportDiagnostics()}>Export redacted diagnostics…</button></div></>}
        {dialog === "about" && <><div className="dialog-kicker">ABOUT</div><h2 id="dialog-title">QC Voice Control <span>0.1.0</span></h2><p>An unofficial, hardware-familiar desktop controller built around a reusable QC core and standalone MCP service.</p><p className="legal-note">Not affiliated with or endorsed by Neural DSP. Product names are used only to describe compatibility.</p></>}
      </section>
    </div>}
  </div>;
}
