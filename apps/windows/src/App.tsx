import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { demoSnapshot, type ConnectionState, type PresetSnapshot, type RuntimeStatus } from "@ndsp-qc/client";
import { formFactors, skins } from "@ndsp-qc/form-factors";
import { QuadCortexSurface, type HardwareAction } from "@ndsp-qc/ui";
import { tauriTransport } from "./tauri-transport";

type DialogName = "settings" | "about" | "connection" | null;

const initialConnection: ConnectionState = {
  phase: "disconnected",
  detail: "Device gateway is not connected",
  demo: true
};

const menus = [
  { name: "File", items: ["Open Workspace…", "Save Workspace", "Save Workspace As…", "Save Preset to Quad Cortex…", "Settings…", "Exit"] },
  { name: "Edit", items: ["Undo Last App Change", "Redo", "Copy Block Settings", "Paste Block Settings", "Keyboard Shortcuts…"] },
  { name: "View", items: ["Fit Hardware to Window", "Actual Size", "Full Screen", "Show/Hide Chat", "Connection Log"] },
  { name: "Device", items: ["Connect", "Reconnect", "Reset Communication Session", "Rescan USB Devices", "Refresh Complete State"] },
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
    <div className="window-title">Windows Client · Preview</div>
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
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const mediaStream = useRef<MediaStream | undefined>(undefined);

  const formFactor = useMemo(() => formFactors.find((item) => item.id === formFactorId) ?? formFactors[0], [formFactorId]);
  const skin = useMemo(() => skins.find((item) => item.id === skinId) ?? skins[0], [skinId]);

  useEffect(() => {
    void tauriTransport.runtimeStatus().then(setRuntime).catch((error: Error) => setNotice(error.message));
  }, []);

  const chooseScene = useCallback((index: number) => {
    setSnapshot((current) => ({ ...current, activeScene: index }));
    setNotice(`Demo: selected Scene ${String.fromCharCode(65 + index)} — ${snapshot.scenes[index]}. Hardware was not changed.`);
  }, [snapshot.scenes]);

  const handleHardwareAction = useCallback((action: HardwareAction) => {
    if (action.kind === "select-block") {
      setSelectedBlockId(action.blockId);
      const block = snapshot.blocks.find((candidate) => candidate.id === action.blockId);
      setNotice(`${block?.name ?? "Block"} selected. Parameter editing will be enabled by the gateway slice.`);
      return;
    }
    if (action.kind === "rotate") {
      if (action.role === "tempo") {
        setSnapshot((current) => ({ ...current, tempo: Math.max(30, Math.min(300, current.tempo + action.delta)) }));
      }
      setNotice(`Demo encoder: ${action.role} ${action.delta > 0 ? "+" : "−"}1.`);
      return;
    }
    if (action.phase === "release" && action.role.startsWith("footswitch:")) {
      chooseScene(action.role.charCodeAt(action.role.length - 1) - 65);
      return;
    }
    if (action.phase === "release") setNotice(`Demo switch: ${action.role}. Hardware was not changed.`);
  }, [chooseScene, snapshot.blocks]);

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
      if (/^[1-8]$/.test(event.key)) chooseScene(Number(event.key) - 1);
      if (event.key === "[") setNotice("Demo: Bank down requested.");
      if (event.key === "]") setNotice("Demo: Bank up requested.");
      if (event.key.toLowerCase() === "t") setNotice(event.shiftKey ? "Demo: Tuner requested." : "Demo: Tap tempo registered.");
      if (event.key.toLowerCase() === "b" && selectedBlockId) {
        setSnapshot((current) => ({ ...current, blocks: current.blocks.map((block) => block.id === selectedBlockId ? { ...block, bypassed: !block.bypassed } : block) }));
        setNotice("Demo: selected block bypass toggled locally.");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseScene, selectedBlockId]);

  const connect = async (mode: "reconnect" | "reset" = "reconnect") => {
    setConnection({ phase: "discovering", detail: "Looking for device gateway…", demo: true });
    try {
      const next = mode === "reset" ? await tauriTransport.resetSession() : await tauriTransport.reconnect();
      setConnection(next);
      setNotice(next.detail);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setConnection({ phase: "needs-attention", detail, demo: true });
      setNotice(detail);
      setDialog("connection");
    }
  };

  const menuSelect = (item: string) => {
    if (item === "Settings…") setDialog("settings");
    else if (item === "About") setDialog("about");
    else if (item === "Show/Hide Chat") setChatOpen((open) => !open);
    else if (item === "Connect" || item === "Reconnect") void connect();
    else if (item === "Reset Communication Session") void connect("reset");
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
        <button className="toolbar-button" onClick={() => void connect()}>↻ Reconnect</button>
        <button className="icon-button" title="Connection details" aria-label="Connection details" onClick={() => setDialog("connection")}>•••</button>
      </div>
    </header>

    <main className="workspace">
      <QuadCortexSurface formFactor={formFactor} snapshot={snapshot} selectedBlockId={selectedBlockId} skin={skin} onAction={handleHardwareAction} />
    </main>

    <div className="status-strip" role="status"><span className="status-symbol">i</span>{notice}<span className="shortcut-hint">1–8 scenes · B bypass · [ ] bank · T tempo · Ctrl+L chat</span></div>

    {chatOpen ? <section className="chat-dock" aria-label="QC assistant">
      {messages.length > 0 && <div className="conversation-preview">{messages.slice(-2).map((item, index) => <div className="user-message" key={`${item}-${index}`}>{item}</div>)}</div>}
      <div className="context-line"><span className="context-pill">DEMO</span><strong>{snapshot.presetLocation} · {snapshot.presetName}</strong><span>Scene {String.fromCharCode(65 + snapshot.activeScene)}</span><span>{selectedBlockId ? `Selected: ${snapshot.blocks.find((block) => block.id === selectedBlockId)?.name}` : "No block selected"}</span></div>
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
        {dialog === "connection" && <><div className="dialog-kicker">DEVICE CONNECTION</div><h2 id="dialog-title">Gateway not connected</h2><p>The visual client is running with deterministic demo state. The next backend slice will launch the Python device gateway and perform the QC handshake over private framed JSON-RPC.</p><dl><dt>Runtime</dt><dd>{runtime?.platform ?? "Unknown"}</dd><dt>Gateway</dt><dd>{runtime?.gatewayAvailable ? "Available" : "Not packaged"}</dd><dt>Safety</dt><dd>All hardware writes locked</dd></dl><div className="dialog-actions"><button onClick={() => void connect("reset")}>Reset session</button><button className="primary" onClick={() => void connect()}>Retry</button></div></>}
        {dialog === "settings" && <><div className="dialog-kicker">SETTINGS</div><h2 id="dialog-title">Desktop preferences</h2><label className="setting-row"><span>Form factor<small>Geometry and control placement</small></span><select value={formFactorId} onChange={(event) => setFormFactorId(event.target.value)}>{formFactors.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label><label className="setting-row"><span>Skin<small>Appearance only; commands never change</small></span><select value={skinId} onChange={(event) => setSkinId(event.target.value)}>{skins.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label><label className="setting-row"><span>Global push-to-talk<small>Disabled until explicitly configured</small></span><input type="checkbox" disabled /></label></>}
        {dialog === "about" && <><div className="dialog-kicker">ABOUT</div><h2 id="dialog-title">QC Voice Control <span>0.1.0</span></h2><p>An unofficial, hardware-familiar desktop controller built around a reusable QC core and standalone MCP service.</p><p className="legal-note">Not affiliated with or endorsed by Neural DSP. Product names are used only to describe compatibility.</p></>}
      </section>
    </div>}
  </div>;
}
