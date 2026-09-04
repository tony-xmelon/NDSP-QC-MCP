import { Capacitor } from "@capacitor/core";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { demoSnapshot, QC_SCENE_COUNT, type BlockParameter, type GridBlock } from "@ndsp-qc/client";
import { appendConversationMessage, assistantAccessPermitsTool, assistantActionCommand, assistantActionPrompt, assistantCommandDetail, assistantHelp, assistantIntentCommand, blockSelectionIntent, demoBlockDetails, dispatchSurfaceCommand, footswitchLeds, formatSnapshotSummary, parseAssistantIntent, parseAssistantReply, recordTempoTap, sceneLetter, surfaceCommand, validateAssistantActions, type ConversationMessage, type ValidatedAssistantAction } from "@ndsp-qc/core";
import { formFactors, skins } from "@ndsp-qc/form-factors";
import { MicrophoneIcon, officialBlockVisual, QuadCortexSurface, useBlockEditorSession, useQcController, type HardwareAction } from "@ndsp-qc/ui";
import { createAndroidQcTransport, GeminiNative, QcRelayNative, QcUsbNative, VoiceInputNative, type ControlAccessMode, type RelayState } from "./native-services";
import { quotaSummary, recordGeminiUsage, type GeminiModelId, type GeminiQuotaLedger } from "./gemini-quota";

type UsbState = "searching" | "available" | "connecting" | "syncing" | "connected" | "absent" | "error";
type AndroidGeminiModel = GeminiModelId;

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
const assistantActionTool = (action: ValidatedAssistantAction): string => {
  if (action.name === "next_preset" || action.name === "previous_preset") return "navigate_bank";
  if (action.name === "set_selected_block_bypass") return "set_bypass";
  return action.name;
};

function loadQuotaLedger(): GeminiQuotaLedger {
  try {
    const saved = JSON.parse(window.localStorage.getItem(androidQuotaStorageKey) ?? "{}");
    return saved && typeof saved === "object" ? saved as GeminiQuotaLedger : {};
  } catch { return {}; }
}

function AppMark() {
  return <span className="app-mark" aria-hidden="true"><img src="./app-icon.svg" alt="" /></span>;
}

export function App() {
  const native = Capacitor.isNativePlatform();
  const {
    snapshot, snapshotRef, setSnapshot, updateSnapshot,
    beginScene, beginPresetMove, beginModeSlot, beginFootswitch, beginTempo,
    failCommand, settleCommand, resetCommands, reconcileFrame,
    runScene, runPresetMove, runModeSlot, runTempo, runBypass, runFootswitch, runAssistantCommand
  } = useQcController(demoSnapshot);
  const qcTransport = useMemo(() => createAndroidQcTransport(() => snapshotRef.current), [snapshotRef]);
  const [selectedBlockId, setSelectedBlockId] = useState("");
  const editor = useBlockEditorSession();
  const { details: blockDetails, drafts: parameterDrafts, page: parameterPage } = editor;
  const [parameterBusy, setParameterBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ConversationMessage[]>([
    { id: 1, role: "assistant", text: "Ready. Connect the Quad Cortex by USB, type a request, or use the microphone to speak." }
  ]);
  const [usbState, setUsbState] = useState<UsbState>(native ? "searching" : "absent");
  const [busy, setBusy] = useState(false);
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
  const nextMessageId = useRef(2);
  const tapTimes = useRef<number[]>([]);
  const connectInFlight = useRef(false);
  const presetSynchronized = useRef(false);
  const usbSessionReady = useRef(false);
  const openBlockAddress = useRef<{ row: number; column: number } | undefined>(undefined);

  const selectedBlock = useMemo(() => snapshot.blocks.find((block) => block.id === selectedBlockId), [selectedBlockId, snapshot.blocks]);
  const selectedQuota = quotaSummary(selectedModel, quotaLedger[selectedModel], quotaNow);
  const switchLeds = useMemo(() => footswitchLeds(snapshot), [snapshot]);
  openBlockAddress.current = blockDetails ? { row: blockDetails.row, column: blockDetails.column } : undefined;

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
        for (const state of states) {
          if (state.kind === "preset") {
            presetSynchronized.current = true;
            if (usbSessionReady.current) setUsbState("connected");
          }
        }
        const reduced = reconcileFrame(states);
        const reconciled = reduced.states;
        for (const state of reconciled) {
          if (state.kind === "parameter" && state.parameterIndex !== undefined && state.normalizedValue !== undefined &&
              openBlockAddress.current?.row === state.row && openBlockAddress.current?.column === state.column) {
            editor.updateParameter({ index: state.parameterIndex }, state.normalizedValue);
          }
        }
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

  useEffect(() => {
    if (!native || !blockDetails) return;
    let cancelled = false;
    void qcTransport.blockDetails(blockDetails.row, blockDetails.column, snapshotRef.current).then((details) => {
      if (cancelled) return;
      editor.load(details);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [native, snapshot.activeScene, blockDetails?.row, blockDetails?.column]);

  const appendAssistant = (text: string) => setMessages((current) => appendConversationMessage(current, nextMessageId.current++, "assistant", text));

  const openBlockEditor = async (block: GridBlock) => {
    setSelectedBlockId(block.id);
    setParameterBusy(true);
    try {
      const details = native
        ? await qcTransport.blockDetails(block.row, block.column, snapshotRef.current)
        : demoBlockDetails(block, snapshot.activeScene);
      editor.load(details, true);
    } catch (error) {
      setSelectedBlockId("");
      editor.close();
      appendAssistant(error instanceof Error ? error.message : `Could not read ${block.name} parameters.`);
    } finally { setParameterBusy(false); }
  };

  const closeBlockEditor = () => {
    setSelectedBlockId("");
    editor.close();
  };

  const commitParameter = async (parameter: BlockParameter, value: number) => {
    if (!blockDetails || parameter.normalizedValue === null || parameterBusy) return;
    editor.updateParameter(parameter, value);
    setParameterBusy(true);
    try {
      await qcTransport.setParameter(blockDetails.row, blockDetails.column, parameter.index, value, snapshotRef.current);
      setSnapshot((current) => ({ ...current, dirty: true }));
    } catch (error) {
      editor.updateParameter(parameter, parameter.normalizedValue as number);
      appendAssistant(error instanceof Error ? error.message : `Could not change ${parameter.name}.`);
    } finally { setParameterBusy(false); }
  };

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

  const setBlockBypass = async (block: GridBlock, bypassed: boolean) => {
    await runBypass(qcTransport, block.id, block.row, block.column, bypassed);
  };

  const selectScene = async (index: number, reportFailure = false) => {
    const scene = Math.max(0, Math.min(snapshot.scenes.length - 1, index));
    if (reportFailure && usbState !== "connected") throw new Error("Connect the Quad Cortex over USB first.");
    if (usbState === "connected") {
      try { await runScene(qcTransport, scene); }
      catch (error) {
        setUsbState("error");
        if (reportFailure) throw error;
      }
    } else settleCommand(beginScene(scene));
  };

  const movePreset = async (delta: -1 | 1, reportFailure = false) => {
    if (reportFailure && usbState !== "connected") throw new Error("Connect the Quad Cortex over USB first.");
    if (usbState === "connected") {
      try { await runPresetMove(qcTransport, delta); return; }
      catch (error) {
        if (reportFailure) throw error;
        setUsbState("error");
        return;
      }
    }
    settleCommand(beginPresetMove(delta, delta > 0 ? "Next preset" : "Previous preset"));
  };

  const selectModeSlot = async (slot: 0 | 1 | 2) => {
    if (usbState !== "connected") { settleCommand(beginModeSlot(slot)); return; }
    try { await runModeSlot(qcTransport, slot); }
    catch (error) {
      setUsbState("error");
      appendAssistant(error instanceof Error ? error.message : `Could not select Mode Slot ${sceneLetter(slot)}.`);
    }
  };

  const pressFootswitch = async (index: number) => {
    if (usbState === "connected") {
      try { await runFootswitch(qcTransport, index); }
      catch (error) {
        setUsbState("error");
        appendAssistant(error instanceof Error ? error.message : `Could not press Footswitch ${sceneLetter(index)}.`);
      }
      return;
    }
    settleCommand(beginFootswitch(index));
  };

  const handleSurfaceAction = (action: HardwareAction) => {
    dispatchSurfaceCommand(surfaceCommand(action), {
      selectScene: (scene) => void selectScene(scene),
      toggleBlockEditor: (blockId) => {
        const block = snapshot.blocks.find((candidate) => candidate.id === blockId);
        if (blockSelectionIntent(selectedBlockId, blockId) === "close") closeBlockEditor();
        else if (block) void openBlockEditor(block);
      },
      selectModeSlot: (slot) => void selectModeSlot(slot),
      pressFootswitch: (index) => void pressFootswitch(index),
      movePreset: (delta) => void movePreset(delta),
      tapTempo: () => void tapTempo()
    });
  };

  const tapTempo = async () => {
    const now = Date.now();
    const result = recordTempoTap(tapTimes.current, now);
    tapTimes.current = result.taps;
    const token = result.bpm === undefined
      ? undefined
      : beginTempo(result.bpm);
    if (usbState === "connected") {
      try { await qcTransport.tapTempo(snapshotRef.current); }
      catch (error) {
        if (token) failCommand(token);
        setUsbState("error");
        appendAssistant(error instanceof Error ? error.message : "Could not send Tap Tempo.");
      }
    }
    if (token && usbState !== "connected") settleCommand(token);
  };

  const localFallback = async (input: string): Promise<string> => {
    const intent = parseAssistantIntent(input);
    if (intent.kind === "inspect") return formatSnapshotSummary(snapshot);
    const intentTool = intent.kind === "bypass" ? "set_bypass"
      : intent.kind === "parameter" ? "set_parameter"
        : intent.kind === "scene" ? "select_scene"
          : intent.kind === "preset-step" || intent.kind === "bank" ? "navigate_bank"
            : intent.kind === "recall" ? "recall_preset"
              : intent.kind === "tempo" ? "set_tempo"
                : intent.kind === "view" ? (intent.view === "tuner" ? "show_tuner" : "show_gig_view")
                  : undefined;
    if (intentTool && !assistantAccessPermitsTool(controlAccessMode, intentTool)) return `Assistant ${controlAccessMode} access does not permit that operation. Manual on-screen controls remain available.`;
    if (intent.kind === "scene" && usbState !== "connected") {
      await selectScene(intent.index, false);
      return `Scene ${sceneLetter(intent.index)} selected in the preview.`;
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

  const askGemini = async (input: string): Promise<string> => {
    if (!native) return localFallback(input);
    const prompt = assistantActionPrompt(snapshot, `USB ${usbState}`, selectedBlock?.name, input, controlAccessMode);
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
    if (!parsed) return result.text;
    const notes: string[] = [];
    const proposed = validateAssistantActions(parsed);
    const actions = proposed.filter((action) => assistantAccessPermitsTool(controlAccessMode, assistantActionTool(action)));
    if (actions.length !== proposed.length) notes.push(`Some proposed actions were blocked by ${controlAccessMode} access.`);
    for (const action of actions) {
      try {
        if (usbState !== "connected") throw new Error("Connect the Quad Cortex first.");
        const liveSelected = snapshotRef.current.blocks.find((block) => block.id === selectedBlockId);
        await runAssistantCommand(qcTransport, assistantActionCommand(action, liveSelected));
      } catch (error) { notes.push(error instanceof Error ? error.message : "The QC command failed; reconnect and try again."); }
    }
    return [parsed.reply?.trim() || "Done.", ...notes].join(" ");
  };

  const sendInput = async (input: string) => {
    const trimmed = input.trim().slice(0, 2000);
    if (!trimmed || busy) return;
    setMessage("");
    setMessages((current) => appendConversationMessage(current, nextMessageId.current++, "user", trimmed));
    setBusy(true);
    try {
      if (/^(usb\s+)?(diagnostics?|status)$/i.test(trimmed)) appendAssistant(await usbDiagnostics());
      else appendAssistant(await askGemini(trimmed));
    }
    catch { appendAssistant(await localFallback(trimmed)); }
    finally { setBusy(false); }
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
        onAction={handleSurfaceAction} onOpenPreset={() => {}} onUndo={() => {}} canUndo={false}
        onSave={() => {}} onOpenRouting={() => {}} onRefresh={() => {}}
        parameterEditor={blockDetails ? {
          details: blockDetails,
          drafts: parameterDrafts,
          accent: officialBlockVisual(selectedBlock ?? { id: "editor", name: blockDetails.name, kind: "utility", category: blockDetails.category, row: blockDetails.row, column: blockDetails.column }).color,
          activeScene: snapshot.activeScene,
          scenes: snapshot.scenes,
          bypassed: Boolean(selectedBlock?.bypassed),
          footswitch: selectedBlock?.footswitch,
          disabled: parameterBusy,
          page: parameterPage,
          onPageChange: editor.setPage,
          onDraftChange: editor.draft,
          onCommit: (parameter, value) => void commitParameter(parameter, value),
          onCommitBatch: (changes) => { for (const change of changes) void commitParameter(change.parameter, change.value); },
          onToggleBypass: () => {
            if (!selectedBlock) return;
            const bypassed = !selectedBlock.bypassed;
            void setBlockBypass(selectedBlock, bypassed).catch((error) => appendAssistant(error instanceof Error ? error.message : `Could not change ${selectedBlock.name}.`));
          },
          onSceneSelect: (scene) => void selectScene(scene),
          onFootswitchAssignmentStart: () => {},
          contextActionEnabled: { "save-device-preset": false, "change-device": false, "copy-device": false, "paste-device": false, "reset-defaults": false, "set-parameters-defaults": false, expression: false, "assign-looper-actions": false, "mute-bypass": false, remove: false },
          onContextAction: () => {},
          onClose: closeBlockEditor
        } : undefined} />
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

    <section className="mobile-chat" aria-label="QC assistant">
      <div className="chat-heading"><span><i /> {busy ? "GEMINI THINKING" : "QC ASSISTANT"}</span><small>{selectedBlock ? `${selectedBlock.name} selected` : usbState === "connected" ? "QC connected" : "USB not connected"}</small></div>
      <div className="message-list" aria-live="polite">
        {messages.map((entry) => <div key={entry.id} className={`message ${entry.role}`}><span>{entry.role === "assistant" ? "QC" : "YOU"}</span><p>{entry.text}</p></div>)}
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
  </main>;
}
