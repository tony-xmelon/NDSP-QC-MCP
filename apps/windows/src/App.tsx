import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { demoSnapshot, type BlockDetails, type BlockParameter, type ConnectionState, type GridBlock, type PresetEntry, type PresetList, type PresetSnapshot, type RuntimeStatus } from "@ndsp-qc/client";
import { formFactors, skins } from "@ndsp-qc/form-factors";
import { QuadCortexSurface, type HardwareAction } from "@ndsp-qc/ui";
import { tauriTransport } from "./tauri-transport";

type DialogName = "settings" | "about" | "connection" | "presets" | "parameters" | null;

const initialConnection: ConnectionState = {
  phase: "disconnected",
  detail: "Device gateway is not connected",
  demo: true
};

const menus = [
  { name: "File", items: ["Open Workspace…", "Save Workspace", "Save Workspace As…", "Save Preset to Quad Cortex…", "Settings…", "Exit"] },
  { name: "Edit", items: ["Undo Last App Change", "Redo", "Copy Block Settings", "Paste Block Settings", "Keyboard Shortcuts…"] },
  { name: "View", items: ["Fit Hardware to Window", "Actual Size", "Full Screen", "Show/Hide Chat", "Connection Log"] },
  { name: "Device", items: ["Connect", "Reconnect", "Reset Communication Session", "Rescan USB Devices", "Refresh Complete State", "Discard Unsaved Changes…", "Open Tuner", "Open Gig View"] },
  { name: "Help", items: ["User Guide", "Send Feedback…", "About", "Third-Party Notices", "Privacy", "Legal Notices"] }
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
  const [messages, setMessages] = useState<string[]>([]);
  const [listening, setListening] = useState(false);
  const [commandPending, setCommandPending] = useState(false);
  const [presetList, setPresetList] = useState<PresetList>();
  const [presetListLoading, setPresetListLoading] = useState(false);
  const [blockDetails, setBlockDetails] = useState<BlockDetails>();
  const [parameterDrafts, setParameterDrafts] = useState<Record<number, number>>({});
  const [blockDetailsLoading, setBlockDetailsLoading] = useState(false);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const mediaStream = useRef<MediaStream | undefined>(undefined);
  const autoConnectStarted = useRef(false);

  const formFactor = useMemo(() => formFactors.find((item) => item.id === formFactorId) ?? formFactors[0], [formFactorId]);
  const skin = useMemo(() => skins.find((item) => item.id === skinId) ?? skins[0], [skinId]);

  useEffect(() => {
    void tauriTransport.runtimeStatus().then(setRuntime).catch((error: Error) => setNotice(error.message));
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
      const result = await tauriTransport.toggleBypass(block.row, block.column, snapshot.activeScene, snapshot.presetName);
      if (result.snapshot) setSnapshot(result.snapshot);
      setNotice(result.detail);
    } catch (error) {
      actionFailed(error);
    } finally {
      setCommandPending(false);
    }
  }, [actionFailed, commandPending, connection.demo, selectedBlockId, snapshot]);

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

  const handleHardwareAction = useCallback((action: HardwareAction) => {
    if (action.kind === "select-block") {
      const block = snapshot.blocks.find((candidate) => candidate.id === action.blockId);
      if (block) void openBlockEditor(block);
      return;
    }
    if (action.kind === "rotate") {
      if (connection.demo && action.role === "tempo") {
        setSnapshot((current) => ({ ...current, tempo: Math.max(30, Math.min(300, current.tempo + action.delta)) }));
      }
      setNotice(connection.demo ? `Demo encoder: ${action.role} ${action.delta > 0 ? "+" : "−"}1.` : `${action.role} encoder writes are not enabled yet.`);
      return;
    }
    if (action.phase === "release" && action.role.startsWith("footswitch:")) {
      void chooseScene(action.role.charCodeAt(action.role.length - 1) - 65);
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
    if (action.phase === "release" && action.role === "tempo") setNotice(connection.demo ? "Demo: Tap tempo registered." : "Tap tempo control is not enabled yet; use the QC tempo screen.");
    else if (action.phase === "release") setNotice(connection.demo ? `Demo switch: ${action.role}. Hardware was not changed.` : `${action.role} is not enabled in the live control slice yet.`);
  }, [chooseScene, connection.demo, navigateBank, openBlockEditor, snapshot.blocks]);

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
      if (/^[1-8]$/.test(event.key)) void chooseScene(Number(event.key) - 1);
      if (event.key === "[") void navigateBank(-1);
      if (event.key === "]") void navigateBank(1);
      if (event.key.toLowerCase() === "t") event.shiftKey ? void showDeviceView("tuner") : setNotice("Tap tempo control is not enabled yet; use the QC tempo screen.");
      if (event.key.toLowerCase() === "b" && selectedBlockId) void toggleSelectedBypass();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseScene, navigateBank, selectedBlockId, showDeviceView, toggleSelectedBypass]);

  const connect = async (mode: "reconnect" | "reset" = "reconnect") => {
    setConnection({ phase: "discovering", detail: "Looking for device gateway…", demo: true });
    try {
      const next = mode === "reset" ? await tauriTransport.resetSession() : await tauriTransport.reconnect();
      setConnection(next);
      if (next.phase === "ready") {
        const current = await tauriTransport.currentSnapshot();
        setSnapshot(current);
        setSelectedBlockId(current.blocks[0]?.id ?? "");
        setNotice(`${next.detail}. Live preset state synchronized.`);
      } else {
        setNotice(next.detail);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setConnection({ phase: "needs-attention", detail, demo: true });
      setNotice(detail);
      setDialog("connection");
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

  const menuSelect = (item: string) => {
    if (item === "Settings…") setDialog("settings");
    else if (item === "Open Device Preset…") void openPresetBrowser();
    else if (item === "About") setDialog("about");
    else if (item === "Show/Hide Chat") setChatOpen((open) => !open);
    else if (item === "Connect" || item === "Reconnect") void connect();
    else if (item === "Reset Communication Session") void connect("reset");
    else if (item === "Refresh Complete State") void refreshSnapshot();
    else if (item === "Discard Unsaved Changes…") void reloadPreset();
    else if (item === "Open Tuner") void showDeviceView("tuner");
    else if (item === "Open Gig View") void showDeviceView("gig");
    else if (item === "Full Screen") void document.documentElement.requestFullscreen?.();
    else setNotice(`${item} is present in the shell and will be wired in its delivery phase.`);
  };

  const sendMessage = () => {
    const trimmed = message.trim();
    if (!trimmed) return;
    setMessages((current) => [...current, trimmed]);
    setMessage("");
    setNotice("Chat transport is not configured. The command was kept locally and nothing was sent to the QC.");
  };

  const toggleMicrophone = async () => {
    if (listening) {
      mediaStream.current?.getTracks().forEach((track) => track.stop());
      mediaStream.current = undefined;
      setListening(false);
      setNotice("Voice capture stopped. No recording was retained.");
      return;
    }
    try {
      mediaStream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      setListening(true);
      setNotice("Microphone is live for push-to-talk preview. Transcription is not configured yet.");
    } catch {
      setNotice("Microphone access was not granted. Check Windows privacy settings and app permissions.");
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

    <div className="status-strip" role="status"><span className="status-symbol">i</span>{notice}<span className="shortcut-hint">1–8 scenes · B bypass · [ ] bank · T tempo · Ctrl+L chat</span></div>

    {chatOpen ? <section className="chat-dock" aria-label="QC assistant">
      {messages.length > 0 && <div className="conversation-preview">{messages.slice(-2).map((item, index) => <div className="user-message" key={`${item}-${index}`}>{item}</div>)}</div>}
      <div className="context-line"><span className="context-pill">{connection.demo ? "DEMO" : "LIVE"}</span><strong>{snapshot.presetLocation} · {snapshot.presetName}</strong><span>Scene {String.fromCharCode(65 + snapshot.activeScene)}</span>{snapshot.dirty && <span className="dirty-state">UNSAVED DEVICE CHANGES</span>}<span>{selectedBlockId ? `Selected: ${snapshot.blocks.find((block) => block.id === selectedBlockId)?.name}` : "No block selected"}</span></div>
      <div className="composer">
        <button className="composer-tool" title="Attach QC context" aria-label="Attach QC context">＋</button>
        <textarea ref={chatInput} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); }
        }} placeholder="Ask about this preset or describe a change…" rows={1} />
        <button className={`mic-button${listening ? " is-listening" : ""}`} onClick={() => void toggleMicrophone()} aria-pressed={listening} title="Push to talk">{listening ? "■" : "●"}<span>{listening ? "STOP" : "VOICE"}</span></button>
        <button className="send-button" onClick={sendMessage} disabled={!message.trim()} aria-label="Send message">↑</button>
      </div>
      <p className="safety-copy">AI actions will show a preview before device edits. Hardware save always requires confirmation.</p>
    </section> : <button className="restore-chat" onClick={() => setChatOpen(true)}>Open assistant <span>Ctrl+L</span></button>}

    {dialog && <div className="dialog-backdrop" role="presentation" onMouseDown={() => setDialog(null)}>
      <section className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="dialog-close" aria-label="Close" onClick={() => setDialog(null)}>×</button>
        {dialog === "connection" && <><div className="dialog-kicker">DEVICE CONNECTION</div><h2 id="dialog-title">{connection.phase === "ready" ? "Quad Cortex connected" : "Device needs attention"}</h2><p>{connection.detail}. The Python gateway owns the USB session and synchronizes state over private framed JSON-RPC.</p><dl><dt>Runtime</dt><dd>{runtime?.platform ?? "Unknown"}</dd><dt>Gateway</dt><dd>{runtime?.gatewayAvailable ? "Available" : "Unavailable"}</dd><dt>Controls</dt><dd>Scenes, block bypass, tuner, and Gig View enabled with validation</dd></dl><div className="dialog-actions"><button onClick={() => void connect("reset")}>Reset session</button><button className="primary" onClick={() => void connect()}>Retry</button></div></>}
        {dialog === "settings" && <><div className="dialog-kicker">SETTINGS</div><h2 id="dialog-title">Desktop preferences</h2><label className="setting-row"><span>Form factor<small>Geometry and control placement</small></span><select value={formFactorId} onChange={(event) => setFormFactorId(event.target.value)}>{formFactors.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label><label className="setting-row"><span>Skin<small>Appearance only; commands never change</small></span><select value={skinId} onChange={(event) => setSkinId(event.target.value)}>{skins.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label><label className="setting-row"><span>Global push-to-talk<small>Disabled until explicitly configured</small></span><input type="checkbox" disabled /></label></>}
        {dialog === "presets" && <><div className="dialog-kicker">DEVICE PRESETS</div><h2 id="dialog-title">{presetList?.setlistName ?? "Loading setlist…"}</h2><div className="preset-browser-toolbar"><span>{presetList ? `${presetList.presets.length} occupied slots` : "Reading from Quad Cortex"}</span><button onClick={() => void openPresetBrowser(true)} disabled={presetListLoading || commandPending}>Refresh</button></div><div className="preset-browser" role="listbox" aria-label="Device presets">{presetListLoading && !presetList ? <p>Loading preset directory…</p> : presetList?.presets.map((entry) => <button key={entry.position} role="option" aria-selected={entry.position === snapshot.presetPosition} className={entry.position === snapshot.presetPosition ? "is-current" : ""} disabled={commandPending} onClick={() => void recallPreset(entry)}><strong>{entry.location}</strong><span>{entry.name}</span></button>)}</div><p>Recalling a preset is blocked while the current preset has unsaved changes.</p></>}
        {dialog === "parameters" && <><div className="dialog-kicker">BLOCK PARAMETERS · SCENE {String.fromCharCode(65 + snapshot.activeScene)}</div><h2 id="dialog-title">{blockDetails?.name ?? "Loading block…"}</h2>{blockDetailsLoading ? <p>Reading parameter metadata and live values…</p> : blockDetails && <div className="parameter-editor">{blockDetails.parameters.length === 0 && <p>This block exposes no editable catalog parameters.</p>}{blockDetails.parameters.map((parameter) => {
          const draft = parameterDrafts[parameter.index] ?? parameter.normalizedValue ?? 0;
          const changed = parameter.normalizedValue !== null && Math.abs(draft - parameter.normalizedValue) >= 0.000001;
          const optionIndex = parameter.options.length > 1 ? Math.round(draft * (parameter.options.length - 1)) : 0;
          const numericDisplay = parameter.minimum === 0 && parameter.maximum === 1 ? draft : parameter.minimum + draft * (parameter.maximum - parameter.minimum);
          return <div className="parameter-row" key={parameter.index}><div className="parameter-heading"><strong>{parameter.name}</strong><span>{parameter.options.length ? parameter.options[optionIndex] : `${numericDisplay.toFixed(2).replace(/\.00$/, "")} ${parameter.units}`}</span></div>{parameter.options.length > 1 ? <select value={optionIndex} disabled={!parameter.writable || commandPending} onChange={(event) => setParameterDrafts((current) => ({ ...current, [parameter.index]: Number(event.target.value) / (parameter.options.length - 1) }))}>{parameter.options.map((option, index) => <option value={index} key={`${option}-${index}`}>{option}</option>)}</select> : <input type="range" min="0" max="1" step={parameter.steps && parameter.steps > 1 ? 1 / (parameter.steps - 1) : .001} value={draft} disabled={!parameter.writable || commandPending} onChange={(event) => setParameterDrafts((current) => ({ ...current, [parameter.index]: Number(event.target.value) }))} />}<div className="parameter-actions"><small>{parameter.sceneMode ? "Scene value" : "Global within preset"}</small><button disabled={!changed || !parameter.writable || commandPending} onClick={() => void applyParameter(parameter)}>Apply</button></div></div>;
        })}</div>}<p>Changes apply temporarily to the live Grid and require a separate preset save to persist.</p></>}
        {dialog === "about" && <><div className="dialog-kicker">ABOUT</div><h2 id="dialog-title">QC Voice Control <span>0.1.0</span></h2><p>An unofficial, hardware-familiar desktop controller built around a reusable QC core and standalone MCP service.</p><p className="legal-note">Not affiliated with or endorsed by Neural DSP. Product names are used only to describe compatibility.</p></>}
      </section>
    </div>}
  </div>;
}
