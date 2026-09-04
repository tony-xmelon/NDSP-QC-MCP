import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { demoSnapshot, QC_SCENE_COUNT } from "@ndsp-qc/client";
import { assistantAccessPermitsTool, assistantCommandDetail, assistantHelp, assistantIntentCommand, assistantIntentToolName, assistantToolActionPrompt, footswitchLeds, formatSnapshotSummary, parseAssistantIntent, parseAssistantReply, sceneLetter, validateAssistantToolCalls } from "@ndsp-qc/core";
import { formFactors, skins } from "@ndsp-qc/form-factors";
import { QC_VISUAL_ASSETS } from "@ndsp-qc/theme";
import { AddBlockPanel, executeQcAction, GridManagementPanel, MicrophoneIcon, qcParameterEditorBindings, QuadCortexSurface, resolveAssistantParameterEdit, RoutingEditor, SceneEditor, useAssistantConversation, useBlockEditorSession, useQcController, useQcLiveState, useQcSurfaceActions, useQcWorkflows } from "@ndsp-qc/ui";
import { androidGatewayTransport, createAndroidQcTransport, GeminiNative, QcRelayNative, QcUsbNative, VoiceInputNative, type ControlAccessMode, type RelayState } from "./native-services";
import { quotaSummary, recordGeminiUsage, type GeminiModelId, type GeminiQuotaLedger } from "./gemini-quota";

type UsbState = "searching" | "available" | "connecting" | "syncing" | "connected" | "absent" | "error";
type AndroidGeminiModel = GeminiModelId;
type AndroidAttachment = { name: string; mediaType: "image/png"; data: string };
type AssistantResponse = { text: string; attachments?: AndroidAttachment[] };

const formFactor = formFactors[0];
const skin = skins.find((entry) => entry.id === "official-svg") ?? skins[0];
const sceneFootswitches = Array.from({ length: QC_SCENE_COUNT }, (_, index) => ({ index, label: sceneLetter(index) }));
const androidGeminiModels: ReadonlyArray<{ id: AndroidGeminiModel; label: string }> = [
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" }
];
const androidModelStorageKey = "qc-control.android-gemini-model";
const androidQuotaStorageKey = "qc-control.android-gemini-quota-v1";
const controlAccessModeKey = "qc-control.device-access-mode-v1";
const storedControlAccessMode = (): ControlAccessMode => {
  const value = window.localStorage.getItem(controlAccessModeKey);
  return value === "read-only" || value === "performance" || value === "modify" ? value : "full";
};
function loadQuotaLedger(): GeminiQuotaLedger {
  try {
    const saved = JSON.parse(window.localStorage.getItem(androidQuotaStorageKey) ?? "{}");
    return saved && typeof saved === "object" ? saved as GeminiQuotaLedger : {};
  } catch { return {}; }
}

function AppMark() {
  return <span className="app-mark" aria-hidden="true"><img src={QC_VISUAL_ASSETS.appIcon.url} alt="" /></span>;
}

export function App() {
  const native = Capacitor.isNativePlatform();
  const qcController = useQcController(demoSnapshot);
  const {
    snapshot, snapshotRef, setSnapshot, updateSnapshot,
    resetCommands, reconcileFrame, runAssistantCommand
  } = qcController;
  const qcTransport = useMemo(() => createAndroidQcTransport(() => snapshotRef.current), [snapshotRef]);
  const [selectedBlockId, setSelectedBlockId] = useState("");
  const editor = useBlockEditorSession();
  const { details: blockDetails } = editor;
  const [devicePending, setDevicePending] = useState(false);
  const conversation = useAssistantConversation<AndroidAttachment>({
    initialMessages: [{ id: 1, role: "assistant", text: "Ready. Connect the Quad Cortex by USB, type a request, or use the microphone to speak." }],
    maximumInputLength: 2000
  });
  const { input: message, setInput: setMessage, messages, pending: busy } = conversation;
  const [usbState, setUsbState] = useState<UsbState>(native ? "searching" : "absent");
  const [selectedModel, setSelectedModel] = useState<AndroidGeminiModel>(() => {
    const saved = window.localStorage.getItem(androidModelStorageKey);
    return androidGeminiModels.some((model) => model.id === saved) ? saved as AndroidGeminiModel : "gemini-3.7-flash";
  });
  const [quotaLedger, setQuotaLedger] = useState<GeminiQuotaLedger>(loadQuotaLedger);
  const [quotaState, setQuotaState] = useState<"unreported" | "available" | "exhausted">("unreported");
  const [quotaNow, setQuotaNow] = useState(Date.now());
  const [voiceState, setVoiceState] = useState("idle");
  const [relayState, setRelayState] = useState<RelayState>("stopped");
  const [relayPaired, setRelayPaired] = useState(false);
  const [controlAccessMode, setControlAccessMode] = useState<ControlAccessMode>(storedControlAccessMode);
  const [workflowPanel, setWorkflowPanel] = useState<"block" | "add" | "routing" | "scene" | null>(null);
  const connectInFlight = useRef(false);
  const presetSynchronized = useRef(false);
  const usbSessionReady = useRef(false);
  const appendAssistant = useCallback((text: string, attachments?: AndroidAttachment[]) => conversation.append("assistant", text, attachments), [conversation.append]);
  const workflowPrompts = useMemo(() => ({
    confirm: (message: string) => window.confirm(message),
    prompt: (message: string, initialValue: string) => window.prompt(message, initialValue)
  }), []);
  const workflows = useQcWorkflows({
    controller: qcController,
    transport: qcTransport,
    gateway: androidGatewayTransport,
    editor,
    selectedBlockId,
    setSelectedBlockId,
    connected: usbState === "connected",
    demo: !native,
    pending: devicePending,
    setPending: setDevicePending,
    prompts: workflowPrompts,
    panels: {
      openRouting: () => setWorkflowPanel("routing"),
      openBlock: () => setWorkflowPanel("block"),
      openAddBlock: () => setWorkflowPanel("add"),
      openScenes: () => setWorkflowPanel("scene"),
      close: () => setWorkflowPanel(null)
    },
    notice: appendAssistant,
    fail: (error) => appendAssistant(error instanceof Error ? error.message : String(error)),
    performanceFail: (error) => {
      setUsbState("error");
      appendAssistant(error instanceof Error ? error.message : String(error));
    }
  });
  const {
    history: deviceHistory,
    preset: presetWorkflow,
    routing: routingWorkflow,
    grid: gridWorkflow,
    parameter: parameterWorkflow,
    scene: sceneWorkflow,
    performance: performanceWorkflow
  } = workflows;
  const selectedBlock = useMemo(() => snapshot.blocks.find((block) => block.id === selectedBlockId), [selectedBlockId, snapshot.blocks]);
  const parameterEditorBindings = qcParameterEditorBindings({
    snapshot,
    selectedBlockId,
    editor,
    grid: gridWorkflow,
    parameter: parameterWorkflow,
    performance: performanceWorkflow,
    connected: usbState === "connected",
    pending: devicePending,
    notice: appendAssistant,
    openExpression: () => setWorkflowPanel("block")
  });
  const selectedQuota = quotaSummary(selectedModel, quotaLedger[selectedModel], quotaNow);
  const switchLeds = useMemo(() => footswitchLeds(snapshot), [snapshot]);
  const consumeLiveState = useQcLiveState({
    reconcileFrame,
    editor,
    onStates: (states) => {
      if (states.some((state) => state.kind === "preset")) {
        presetSynchronized.current = true;
        if (usbSessionReady.current) setUsbState("connected");
      }
    }
  });

  useEffect(() => {
    const timer = window.setInterval(() => setQuotaNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const attemptUsbConnection = async (announce = false) => {
    if (!native || connectInFlight.current) return;
    connectInFlight.current = true;
    presetSynchronized.current = false;
    setUsbState("connecting");
    try {
      const result = await QcUsbNative.connect();
      usbSessionReady.current = true;
      if (result.synchronized) presetSynchronized.current = true;
      setUsbState(presetSynchronized.current ? "connected" : "syncing");
      if (announce) appendAssistant("Quad Cortex connected directly over USB.");
    } catch (error) {
      usbSessionReady.current = false;
      setUsbState("error");
      if (announce) {
        const primary = error instanceof Error ? error.message : "Could not connect to the Quad Cortex.";
        try { appendAssistant(`${primary} ${await usbDiagnostics()}`); }
        catch { appendAssistant(primary); }
      }
    } finally {
      connectInFlight.current = false;
    }
  };

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    const listenerPromises = [
      VoiceInputNative.addListener("partialResult", ({ transcript }) => setMessage(transcript)),
      VoiceInputNative.addListener("voiceState", ({ state }) => setVoiceState(state)),
      QcUsbNative.addListener("qcConnection", ({ state }) => {
        if (state === "available") {
          setUsbState("available");
          void attemptUsbConnection();
        } else {
          usbSessionReady.current = false;
          presetSynchronized.current = false;
          resetCommands();
          setUsbState("absent");
        }
      }),
      QcUsbNative.addListener("qcStateBatch", ({ states }) => {
        consumeLiveState(states);
      })
    ];
    // Register every native listener before scanning/handshaking so no initial
    // preset frame can beat the Capacitor bridge subscription.
    void Promise.all(listenerPromises).then(async () => {
      if (cancelled) return;
      const { devices, connected, synchronized } = await QcUsbNative.scan();
      if (cancelled) return;
      if (connected) {
        usbSessionReady.current = true;
        presetSynchronized.current = synchronized;
        setUsbState(synchronized ? "connected" : "syncing");
        return;
      }
      if (!devices.length) { setUsbState("absent"); return; }
      await attemptUsbConnection();
    }).catch(() => !cancelled && setUsbState("error"));
    return () => {
      cancelled = true;
      for (const promise of listenerPromises) void promise.then((listener) => listener.remove());
    };
  }, [native]);

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    const listener = QcRelayNative.addListener("relayState", ({ state }) => !cancelled && setRelayState(state));
    void QcRelayNative.status().then((status) => {
      if (cancelled) return;
      setRelayPaired(status.paired);
      setRelayState(status.state);
      setControlAccessMode(status.accessMode);
      window.localStorage.setItem(controlAccessModeKey, status.accessMode);
      if (status.paired && status.state === "stopped") void QcRelayNative.start();
    }).catch(() => {});
    return () => { cancelled = true; void listener.then((value) => value.remove()); };
  }, [native]);

  const openBlockEditor = gridWorkflow.openBlock;
  const closeBlockEditor = gridWorkflow.close;

  const usbDiagnostics = async () => {
    if (!native) return "USB diagnostics are available in the installed Android app.";
    const result = await QcUsbNative.diagnostics();
    const traffic = `${result.messagesReceived} received / ${result.messagesSent} sent`;
    const last = result.lastMessageType >= 0 ? `; last message type ${result.lastMessageType}` : "";
    const errors = result.decodeErrors ? `; ${result.decodeErrors} decode error${result.decodeErrors === 1 ? "" : "s"}` : "";
    const stalls = result.expectedWriteStalls ? `; ${result.expectedWriteStalls} expected QC write stalls` : "";
    const catalog = result.modelCount ? `; ${result.modelCount} models loaded` : "";
    const stateAge = result.lastStateAt ? `; latest state ${Math.max(0, Date.now() - result.lastStateAt)} ms ago` : "";
    const endpoint = result.interfaceId >= 0 ? ` Interface ${result.interfaceId}, input endpoint 0x${result.inputEndpointAddress.toString(16)}, max packet ${result.inputMaxPacketSize}; ${result.readAttempts} read polls (${result.negativeReads} negative); ${result.reportBytes}-byte output framing.` : "";
    const midi = result.midiAvailable ? ` USB-MIDI interface ${result.midiInterfaceId}, output endpoint 0x${result.midiOutputEndpointAddress.toString(16)}; MIDI queue ${result.lastMidiQueueDelayMs} ms (max ${result.maxMidiQueueDelayMs} ms).` : " USB-MIDI output unavailable.";
    const problem = result.lastError ? ` Last error: ${result.lastError}` : "";
    return `USB ${result.connected ? "connected" : "not connected"}: ${traffic}${last}${errors}${stalls}${catalog}${stateAge}.${endpoint}${midi}${problem}`;
  };

  const connectUsb = async () => {
    if (!native || usbState === "connecting" || usbState === "syncing") return;
    await attemptUsbConnection(true);
  };

  const selectScene = performanceWorkflow.selectScene;
  const movePreset = performanceWorkflow.movePreset;
  const pressFootswitch = async (index: number) => {
    if (gridWorkflow.footswitchAssignmentPending && selectedBlock) {
      gridWorkflow.setFootswitchAssignmentPending(false);
      await gridWorkflow.assignFootswitch(selectedBlock.footswitch === index ? null : index);
      return;
    }
    await performanceWorkflow.pressFootswitch(index);
  };

  const tapTempo = performanceWorkflow.tapTempo;
  const handleSurfaceAction = useQcSurfaceActions({
    snapshot,
    selectedBlockId,
    blockDetails,
    grid: gridWorkflow,
    performance: performanceWorkflow,
    openBlock: (block) => { void openBlockEditor(block); },
    closeBlock: closeBlockEditor
  });

  const localFallback = async (input: string): Promise<string> => {
    const intent = parseAssistantIntent(input);
    if (intent.kind === "inspect") return formatSnapshotSummary(snapshot);
    const intentTool = assistantIntentToolName(intent);
    if (intentTool && !assistantAccessPermitsTool(controlAccessMode, intentTool)) return `Assistant ${controlAccessMode} access does not permit that operation. Manual on-screen controls remain available.`;
    if (intent.kind === "scene" && usbState !== "connected") {
      await selectScene(intent.index, false);
      return `Scene ${sceneLetter(intent.index)} selected in the preview.`;
    }
    if (intent.kind === "parameter") {
      if (usbState !== "connected") return "Connect the Quad Cortex over USB first.";
      if (!selectedBlock) return "Select a block on the Grid first.";
      try {
        const details = await androidGatewayTransport.blockDetails(selectedBlock.row, selectedBlock.column, snapshot.presetName);
        const resolved = resolveAssistantParameterEdit(details, intent.parameter, intent.value);
        const label = `Set ${details.name} · ${resolved.parameter.name} from ${resolved.parameter.displayValue} to ${resolved.display} in Scene ${sceneLetter(snapshot.activeScene)}?`;
        if (!window.confirm(`${label}\n\nThis changes the live Grid but does not save the preset.`)) return "Temporary parameter edit cancelled.";
        const result = await androidGatewayTransport.setParameter(details.row, details.column, resolved.parameter.index, resolved.normalized, resolved.parameter.normalizedValue as number, snapshot.activeScene, snapshot.presetName);
        if (result.snapshot) workflows.reconcile(result.snapshot);
        if (blockDetails?.row === result.block.row && blockDetails.column === result.block.column) parameterWorkflow.updateDetails(result.block);
        deviceHistory.record({ label: `${details.name} ${resolved.parameter.name}`, execute: (current) => androidGatewayTransport.setParameter(details.row, details.column, resolved.parameter.index, resolved.parameter.normalizedValue as number, resolved.normalized, snapshot.activeScene, current.presetName), redo: (current) => androidGatewayTransport.setParameter(details.row, details.column, resolved.parameter.index, resolved.normalized, resolved.parameter.normalizedValue as number, snapshot.activeScene, current.presetName) });
        return result.detail;
      } catch (error) { return error instanceof Error ? error.message : "That QC parameter could not be changed."; }
    }
    if (intent.kind === "bypass" && selectedBlock?.bypassed !== undefined) {
      const target = intent.desired === "toggle" ? !selectedBlock.bypassed : intent.desired === "bypassed";
      if (target !== selectedBlock.bypassed && !window.confirm(`${target ? "Bypass" : "Enable"} ${selectedBlock.name} in Scene ${sceneLetter(snapshot.activeScene)}?\n\nThis changes the live Grid but does not save the preset.`)) return "Temporary bypass edit cancelled.";
    }
    if (intent.kind === "bank") {
      try { return await performanceWorkflow.navigateBank(intent.direction, true) ?? "Bank changed."; }
      catch (error) { return error instanceof Error ? error.message : "Bank navigation failed."; }
    }
    if (intent.kind === "recall") {
      try { return await presetWorkflow.recallLocation(intent.location); }
      catch (error) { return error instanceof Error ? error.message : "Preset recall failed."; }
    }
    let deviceCommand;
    try {
      deviceCommand = assistantIntentCommand(intent, selectedBlock);
    } catch (error) {
      return error instanceof Error ? error.message : "That QC command is not valid.";
    }
    if (deviceCommand) {
      if (usbState !== "connected") return "Connect the Quad Cortex over USB first.";
      const result = await runAssistantCommand(qcTransport, deviceCommand);
      return assistantCommandDetail(deviceCommand, result);
    }
    return native
      ? `Gemini is unavailable right now. ${assistantHelp}`
      : "Browser preview is offline. On Android, Gemini chat, voice input, and direct Quad Cortex USB are enabled.";
  };

  const askGemini = async (input: string): Promise<AssistantResponse> => {
    if (!native) return { text: await localFallback(input) };
    const prompt = assistantToolActionPrompt(snapshotRef.current, `USB ${usbState}`, selectedBlockId, input, controlAccessMode);
    let result: Awaited<ReturnType<typeof GeminiNative.generate>>;
    try {
      result = await GeminiNative.generate({ prompt, model: selectedModel });
      setQuotaState("available");
      setQuotaLedger((current) => {
        const next = { ...current, [selectedModel]: recordGeminiUsage(current[selectedModel], {
          input: result.inputTokens, output: result.outputTokens,
          thinking: result.thinkingTokens, total: result.totalTokens
        }) };
        window.localStorage.setItem(androidQuotaStorageKey, JSON.stringify(next));
        return next;
      });
      setQuotaNow(Date.now());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (/quota|429|resource.?exhausted/i.test(detail)) setQuotaState("exhausted");
      throw error;
    }
    const parsed = parseAssistantReply(result.text);
    if (!parsed) return { text: result.text };
    const notes: string[] = [];
    const attachments: AndroidAttachment[] = [];
    const proposedCount = Array.isArray(parsed.actions) ? parsed.actions.length : 0;
    const actions = validateAssistantToolCalls(parsed, controlAccessMode);
    if (actions.length !== proposedCount) notes.push(`Some proposed actions were invalid or blocked by ${controlAccessMode} access.`);
    for (const action of actions) {
      try {
        const connectionAction = action.name === "reconnect_device" || action.name === "reset_device_session" || action.name === "disconnect_device";
        if (usbState !== "connected" && !connectionAction) throw new Error("Connect the Quad Cortex first.");
        const outcome = await executeQcAction(action, {
          gateway: androidGatewayTransport,
          snapshot: snapshotRef.current,
          connected: usbState === "connected",
          accessMode: controlAccessMode,
          selectedBlockId
        });
        if (outcome.connection) {
          setUsbState(outcome.connection.phase === "ready" ? "connected" : outcome.connection.phase === "disconnected" ? "absent" : "error");
        }
        if (outcome.savedPreset) presetWorkflow.commitSavedPreset(outcome.savedPreset);
        else if (outcome.snapshot) workflows.reconcile(outcome.snapshot);
        if (outcome.block && blockDetails?.row === outcome.block.row && blockDetails.column === outcome.block.column) parameterWorkflow.updateDetails(outcome.block);
        if (outcome.clearSelection) closeBlockEditor();
        if (outcome.image) attachments.push({ name: `qc-screen-${Date.now()}.png`, mediaType: "image/png", data: outcome.image.pngBase64 });
        notes.push(outcome.detail);
      } catch (error) { notes.push(error instanceof Error ? error.message : "The QC command failed; reconnect and try again."); }
    }
    return { text: [parsed.reply?.trim() || "Done.", ...notes].join(" "), attachments: attachments.length ? attachments : undefined };
  };

  const sendInput = async (input: string) => {
    const submission = conversation.begin(input);
    if (!submission) return;
    try {
      if (/^(usb\s+)?(diagnostics?|status)$/i.test(submission.promptText)) appendAssistant(await usbDiagnostics());
      else {
        const response = await askGemini(submission.promptText);
        appendAssistant(response.text, response.attachments);
      }
    }
    catch { appendAssistant(await localFallback(submission.promptText)); }
    finally { conversation.finish(submission.token); }
  };

  const submit = (event: FormEvent) => { event.preventDefault(); void sendInput(message); };

  const toggleVoice = async () => {
    if (!native || busy) return;
    if (voiceState !== "idle") { await VoiceInputNative.stop(); return; }
    setVoiceState("starting");
    try {
      const { transcript } = await VoiceInputNative.start();
      setVoiceState("idle");
      await sendInput(transcript);
    } catch (error) {
      setVoiceState("idle");
      appendAssistant(error instanceof Error ? error.message : "Voice input failed.");
    }
  };

  const usbLabel = usbState === "connected" ? "USB" : usbState === "syncing" ? "SYNC" : usbState === "connecting" || usbState === "searching" ? "WAIT" : "CONNECT";

  const configureRelay = async () => {
    if (!native) return;
    if (relayPaired) {
      if (!window.confirm("Unpair this phone from the remote QC relay?")) return;
      await QcRelayNative.unpair(); setRelayPaired(false); setRelayState("stopped"); return;
    }
    const endpoint = window.prompt("Secure relay URL (https://…)", "https://")?.trim();
    if (!endpoint) return;
    const pairingCode = window.prompt("One-time pairing code")?.trim();
    if (!pairingCode) return;
    try {
      await QcRelayNative.pair({ endpoint, pairingCode });
      setRelayPaired(true); setRelayState("connecting");
      appendAssistant("Phone paired. The secure remote relay is connecting in the background.");
    } catch (error) { appendAssistant(error instanceof Error ? error.message : "Relay pairing failed."); }
  };

  const changeControlAccessMode = async (mode: ControlAccessMode) => {
    const previous = controlAccessMode;
    setControlAccessMode(mode);
    window.localStorage.setItem(controlAccessModeKey, mode);
    if (!native) return;
    try {
      await QcRelayNative.setAccessMode({ mode });
      appendAssistant(`Assistant and remote access changed to ${mode}. Guarded confirmations still apply; manual controls remain available.`);
    } catch (error) {
      setControlAccessMode(previous);
      window.localStorage.setItem(controlAccessModeKey, previous);
      appendAssistant(error instanceof Error ? error.message : "Could not change the remote access mode.");
    }
  };

  return <main className="android-app">
    <header className="mobile-header">
      <div className="mobile-brand"><AppMark /><span><strong>QC Control</strong><small>{snapshot.presetLocation} · {snapshot.presetName}</small></span></div>
      <div className="connection-pills">
        <button className={`connection-pill relay-${relayState}`} onClick={() => void configureRelay()} aria-label={relayPaired ? "Remote relay settings" : "Pair remote relay"}><i /> {relayState === "connected" ? "REMOTE" : relayPaired ? "RELAY" : "PAIR"}</button>
        <button className={`connection-pill ${usbState}`} onClick={() => void connectUsb()} aria-label="Connect Quad Cortex over USB"><i /> {usbLabel}</button>
      </div>
    </header>

    <section className="mobile-screen" aria-label="Quad Cortex display">
      <QuadCortexSurface formFactor={formFactor} snapshot={snapshot} selectedBlockId={selectedBlockId} skin={skin}
        onAction={handleSurfaceAction} onOpenPreset={() => void presetWorkflow.openDirectory()} onUndo={() => void deviceHistory.undo()} canUndo={Boolean(deviceHistory.undoEntry)} undoLabel={deviceHistory.undoEntry?.label}
        onSave={presetWorkflow.openSave} onOpenRouting={routingWorkflow.openPicker} onRefresh={() => void presetWorkflow.refresh()}
        savePreset={presetWorkflow.saveProps} presetDirectory={presetWorkflow.directoryProps} routingPicker={routingWorkflow.pickerProps}
        parameterEditor={parameterEditorBindings} />
    </section>

    <nav className="quick-controls" aria-label="Quick device controls">
      {sceneFootswitches.map(({ index, label }) => <button
        className={`footswitch-control${switchLeds[index].assigned ? " is-assigned" : ""}${switchLeds[index].active ? " is-active" : ""}`}
        style={{ "--switch-color": switchLeds[index].color, gridColumn: index % 4 + 1, gridRow: index < 4 ? 1 : 2 } as CSSProperties}
        onClick={() => void pressFootswitch(index)}
        aria-label={`Footswitch ${label}`}
        aria-pressed={switchLeds[index].active}
        key={label}
      ><i className="control-led" aria-hidden="true" /><span>{label}</span></button>)}
      <div className="navigation-controls" aria-label="Preset navigation">
        <button className="preset-control control-up" onClick={() => void movePreset(-1)} aria-label="Previous preset"><span>↑</span><small>UP</small></button>
        <button className="preset-control control-down" onClick={() => void movePreset(1)} aria-label="Next preset"><span>↓</span><small>DOWN</small></button>
      </div>
      <button className={`tempo-control${snapshot.tempoLedEnabled ? " is-active" : ""}`} style={{ "--tempo-bpm": snapshot.tempo } as CSSProperties} onClick={() => void tapTempo()} aria-label={`Tap tempo, ${snapshot.tempo} BPM`}><i className="control-led" aria-hidden="true" /><span>{snapshot.tempo}</span><small>TEMPO</small></button>
    </nav>

    <nav className="workflow-actions" aria-label="Preset editing workflows">
      <button disabled={usbState !== "connected" || devicePending} onClick={() => void gridWorkflow.openAdd()}>＋ BLOCK</button>
      <button disabled={!blockDetails || devicePending} onClick={() => setWorkflowPanel("block")}>EDIT BLOCK</button>
      <button disabled={usbState !== "connected" || devicePending} onClick={routingWorkflow.open}>ROUTING</button>
      <button disabled={usbState !== "connected" || devicePending} onClick={sceneWorkflow.open}>SCENES</button>
      <button disabled={!deviceHistory.redoEntry || devicePending} onClick={() => void deviceHistory.redo()}>REDO</button>
    </nav>

    <section className="mobile-chat" aria-label="QC assistant">
      <div className="chat-heading"><span><i /> {busy ? "GEMINI THINKING" : "QC ASSISTANT"}</span><small>{selectedBlock ? `${selectedBlock.name} selected` : usbState === "connected" ? "QC connected" : "USB not connected"}</small></div>
      <div className="message-list" aria-live="polite">
        {messages.map((entry) => <div key={entry.id} className={`message ${entry.role}`}><span>{entry.role === "assistant" ? "QC" : "YOU"}</span><div><p>{entry.text}</p>{entry.attachments?.map((attachment) => <img className="message-image" key={attachment.name} src={`data:${attachment.mediaType};base64,${attachment.data}`} alt={attachment.name} />)}</div></div>)}
        {busy && <div className="message assistant pending"><span>QC</span><p>•••</p></div>}
      </div>
      <div className="chat-model-bar">
        <select value={selectedModel} aria-label="Gemini model" disabled={busy} onChange={(event) => {
          const model = event.target.value as AndroidGeminiModel;
          setSelectedModel(model);
          setQuotaState("unreported");
          window.localStorage.setItem(androidModelStorageKey, model);
        }}>
          {androidGeminiModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
        <select value={controlAccessMode} aria-label="Assistant and remote device access" disabled={busy} onChange={(event) => void changeControlAccessMode(event.target.value as ControlAccessMode)}>
          <option value="read-only">Read-only</option>
          <option value="performance">Performance</option>
          <option value="modify">Modify</option>
          <option value="full">Full control</option>
        </select>
        <span title={`Device estimate for the current Pacific quota day. ${selectedQuota.dayRemaining} of ${selectedQuota.limits.requestsPerDay} daily requests left; ${selectedQuota.minuteRemaining} of ${selectedQuota.limits.requestsPerMinute} per-minute requests left; ${selectedQuota.minuteInputRemaining.toLocaleString()} of ${selectedQuota.limits.inputTokensPerMinute.toLocaleString()} input tokens/min left. Input ${selectedQuota.usage.input.toLocaleString()}, output ${selectedQuota.usage.output.toLocaleString()}, thinking ${selectedQuota.usage.thinking.toLocaleString()} tokens today.`}>
          {quotaState === "exhausted" ? "LIMIT · " : ""}{selectedQuota.dayRemaining}/{selectedQuota.limits.requestsPerDay} day · {selectedQuota.minuteRemaining}/{selectedQuota.limits.requestsPerMinute} min · {selectedQuota.usage.total.toLocaleString()} tok
        </span>
      </div>
      <form className="message-composer" onSubmit={submit}>
        <button className={`voice-button ${voiceState !== "idle" ? "is-listening" : ""}`} type="button" disabled={!native || busy} onClick={() => void toggleVoice()} aria-label="Speak a command"><MicrophoneIcon /></button>
        <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={voiceState !== "idle" ? "Listening…" : "Ask QC Control…"} aria-label="Message QC Control" />
        <button className="send-button" type="submit" disabled={!message.trim() || busy} aria-label="Send message">↑</button>
      </form>
    </section>

    {workflowPanel && <div className="mobile-workflow-backdrop" role="presentation" onClick={() => setWorkflowPanel(null)}>
      <section className="mobile-workflow-panel" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={(event) => event.stopPropagation()}>
        <button className="mobile-workflow-close" aria-label="Close" onClick={() => setWorkflowPanel(null)}>×</button>
        {workflowPanel === "routing" && <RoutingEditor snapshot={snapshot} drafts={routingWorkflow.drafts} pending={devicePending} setDrafts={routingWorkflow.setDrafts} applyRoute={(row, side) => void routingWorkflow.applyRoute(row, side)} applySplitRoute={(row) => void routingWorkflow.applySplit(row)} />}
        {workflowPanel === "block" && <GridManagementPanel snapshot={snapshot} details={blockDetails} loading={gridWorkflow.detailsLoading} pending={devicePending} moveDestination={gridWorkflow.moveDestination} setMoveDestination={gridWorkflow.setMoveDestination} footswitchDraft={gridWorkflow.footswitchDraft} setFootswitchDraft={gridWorkflow.setFootswitchDraft} move={() => void gridWorkflow.move()} assignFootswitch={() => void gridWorkflow.assignFootswitch()} remove={() => void gridWorkflow.remove()} />}
        {workflowPanel === "add" && <AddBlockPanel snapshot={snapshot} filteredModels={gridWorkflow.filteredModels} loading={gridWorkflow.modelsLoading} pending={devicePending} modelFilter={gridWorkflow.modelFilter} setModelFilter={gridWorkflow.setModelFilter} addCell={gridWorkflow.addCell} setAddCell={gridWorkflow.setAddCell} addModelId={gridWorkflow.addModelId} setAddModelId={gridWorkflow.setAddModelId} add={() => void gridWorkflow.add()} cancel={() => setWorkflowPanel(null)} />}
        {workflowPanel === "scene" && <SceneEditor snapshot={snapshot} pending={devicePending} sourceScene={sceneWorkflow.sourceScene} setSourceScene={sceneWorkflow.setSourceScene} destinationScene={sceneWorkflow.destinationScene} setDestinationScene={sceneWorkflow.setDestinationScene} swap={sceneWorkflow.swap} setSwap={sceneWorkflow.setSwap} label={sceneWorkflow.label} setLabel={sceneWorkflow.setLabel} color={sceneWorkflow.color} setColor={sceneWorkflow.setColor} colors={sceneWorkflow.colors} copy={() => void sceneWorkflow.copy()} saveLabel={() => void sceneWorkflow.saveLabel()} saveColor={() => void sceneWorkflow.saveColor()} />}
      </section>
    </div>}
  </main>;
}
