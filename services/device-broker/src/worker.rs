use crate::usb::{ConnectedQc, IncomingMessage, QcUsb, UsbError};
use qc_device_runtime::request::{self as runtime_request, PresetMutationPlan};
use qc_device_runtime::{
    GatewaySnapshot, PresetEntry, PresetFolder, PresetLibrary, PresetList, PresetSlotList,
};
use qc_protocol::commands::{self, DeviceOperation, OutboundMessage};
use qc_protocol::profile;
use qc_protocol::responses::{decode_tempo_clock, BackupAssembler, TempoClock as TempoClockFrame};
use qc_protocol::session::SessionMachine;
use qc_protocol::state::{
    decode_preset_folder, parse_model_repo, BlockDetails, ModelCatalog, ModelList, StateDecoder,
    StateUpdate,
};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerStatus {
    pub phase: String,
    pub detail: String,
    pub connected: bool,
    pub synchronized: bool,
    pub active_preset_name: Option<String>,
    pub active_scene: Option<u32>,
    pub connected_at_unix_ms: Option<u128>,
    pub handshake_ms: Option<u128>,
    pub messages_received: u64,
    pub last_message_type: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedStateFrame {
    pub sequence: u64,
    pub observed_at: u128,
    pub states: Vec<StateUpdate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tempo_clock: Option<TempoClockFrame>,
}

impl Default for BrokerStatus {
    fn default() -> Self {
        Self {
            phase: "searching".into(),
            detail: "Waiting for Quad Cortex USB".into(),
            connected: false,
            synchronized: false,
            active_preset_name: None,
            active_scene: None,
            connected_at_unix_ms: None,
            handshake_ms: None,
            messages_received: 0,
            last_message_type: None,
        }
    }
}

enum Command {
    Reconnect,
    Disconnect,
    SwitchScene(u32, mpsc::Sender<Result<(), String>>),
    Send(u16, Vec<u8>, mpsc::Sender<Result<(), String>>),
    SendSequence {
        messages: Vec<OutboundMessage>,
        delay: Duration,
        interval: Duration,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Request {
        message_type: u16,
        payload: Vec<u8>,
        expected_type: u16,
        request_id: Option<u64>,
        timeout: Duration,
        reply: mpsc::Sender<Result<IncomingMessage, String>>,
    },
    Stop,
}

pub struct DeviceController {
    state: Arc<Mutex<BrokerStatus>>,
    latest_messages: Arc<Mutex<HashMap<u16, IncomingMessage>>>,
    event_log: Arc<Mutex<VecDeque<IncomingMessage>>>,
    state_event_log: Arc<Mutex<VecDeque<DecodedStateFrame>>>,
    state_subscribers: Arc<Mutex<Vec<mpsc::Sender<DecodedStateFrame>>>>,
    gateway_snapshot: Arc<Mutex<GatewaySnapshot>>,
    preset_library: Arc<Mutex<PresetLibrary>>,
    state_commands: mpsc::Sender<StateDecoderCommand>,
    commands: mpsc::Sender<Command>,
}

impl DeviceController {
    pub fn start() -> Self {
        let state = Arc::new(Mutex::new(BrokerStatus::default()));
        let latest_messages = Arc::new(Mutex::new(HashMap::new()));
        let event_log = Arc::new(Mutex::new(VecDeque::new()));
        let state_event_log = Arc::new(Mutex::new(VecDeque::new()));
        let state_subscribers = Arc::new(Mutex::new(Vec::new()));
        let gateway_snapshot = Arc::new(Mutex::new(GatewaySnapshot::default()));
        let preset_library = Arc::new(Mutex::new(PresetLibrary::default()));
        let (state_messages, state_receiver) = mpsc::channel();
        let state_catalogs = state_messages.clone();
        let state_commands = state_messages.clone();
        let decoded_events = Arc::clone(&state_event_log);
        let decoded_snapshot = Arc::clone(&gateway_snapshot);
        let decoded_subscribers = Arc::clone(&state_subscribers);
        thread::Builder::new()
            .name("qc-native-state".into())
            .spawn(move || {
                run_state_decoder(
                    decoded_events,
                    decoded_snapshot,
                    decoded_subscribers,
                    state_catalogs,
                    state_receiver,
                )
            })
            .expect("native QC state decoder starts");
        let (commands, receiver) = mpsc::channel();
        let worker_state = Arc::clone(&state);
        let worker_messages = Arc::clone(&latest_messages);
        let worker_events = Arc::clone(&event_log);
        let worker_library = Arc::clone(&preset_library);
        thread::Builder::new()
            .name("qc-native-usb".into())
            .spawn(move || {
                run(
                    worker_state,
                    worker_messages,
                    worker_events,
                    worker_library,
                    state_messages,
                    receiver,
                )
            })
            .expect("native QC USB worker starts");
        Self {
            state,
            latest_messages,
            event_log,
            state_event_log,
            state_subscribers,
            gateway_snapshot,
            preset_library,
            state_commands,
            commands,
        }
    }

    pub fn status(&self) -> BrokerStatus {
        self.state.lock().expect("device status lock").clone()
    }

    pub fn reconnect(&self) {
        let _ = self.commands.send(Command::Reconnect);
    }
    pub fn disconnect(&self) {
        let _ = self.commands.send(Command::Disconnect);
    }

    pub fn latest_message(&self, message_type: u16) -> Option<IncomingMessage> {
        self.latest_messages
            .lock()
            .expect("latest message lock")
            .get(&message_type)
            .cloned()
    }

    pub fn events_since(
        &self,
        sequence: u64,
        message_type: Option<u16>,
        limit: usize,
    ) -> Vec<IncomingMessage> {
        self.event_log
            .lock()
            .expect("event log lock")
            .iter()
            .filter(|message| {
                message.sequence > sequence
                    && message_type.is_none_or(|kind| kind == message.message_type)
            })
            .take(limit.min(4096))
            .cloned()
            .collect()
    }

    pub fn event_cursor(&self) -> u64 {
        self.event_log
            .lock()
            .expect("event log lock")
            .back()
            .map_or(0, |message| message.sequence)
    }

    pub fn state_events_since(&self, sequence: u64, limit: usize) -> Vec<DecodedStateFrame> {
        self.state_event_log
            .lock()
            .expect("decoded state event log lock")
            .iter()
            .filter(|frame| frame.sequence > sequence)
            .take(limit.min(4096))
            .cloned()
            .collect()
    }

    pub fn subscribe_state_events(&self) -> mpsc::Receiver<DecodedStateFrame> {
        let (sender, receiver) = mpsc::channel();
        self.state_subscribers
            .lock()
            .expect("decoded state subscriber lock")
            .push(sender);
        receiver
    }

    pub fn block_details(&self, row: u32, column: u32) -> Result<Option<BlockDetails>, String> {
        if row > 3 || column > 9 {
            return Err("Block coordinates must address rows 0-3 and columns 0-9".into());
        }
        let (sender, receiver) = mpsc::channel();
        self.state_commands
            .send(StateDecoderCommand::BlockDetails(row, column, sender))
            .map_err(|error| error.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| error.to_string())
    }

    pub fn gateway_snapshot(&self) -> Option<GatewaySnapshot> {
        let snapshot = self
            .gateway_snapshot
            .lock()
            .expect("gateway snapshot lock")
            .clone();
        snapshot.has_preset.then_some(snapshot)
    }

    pub fn wait_for_gateway_snapshot(
        &self,
        timeout: Duration,
        predicate: impl Fn(&GatewaySnapshot) -> bool,
    ) -> Option<GatewaySnapshot> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(snapshot) = self.gateway_snapshot() {
                if predicate(&snapshot) || Instant::now() >= deadline {
                    return Some(snapshot);
                }
            } else if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn list_models(&self) -> Result<ModelList, String> {
        let (sender, receiver) = mpsc::channel();
        self.state_commands
            .send(StateDecoderCommand::ListModels(sender))
            .map_err(|error| error.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| error.to_string())
    }

    pub fn refresh_preset_library(&self) -> Result<(), String> {
        self.send_operation(DeviceOperation::ListPresetFolders)
    }

    pub fn preset_folders(&self) -> Vec<PresetFolder> {
        self.preset_library
            .lock()
            .expect("preset library lock")
            .folders()
    }

    pub fn preset_list(&self, key: &str) -> Option<PresetList> {
        let snapshot = self.gateway_snapshot()?;
        self.preset_library
            .lock()
            .expect("preset library lock")
            .list(key, &snapshot)
    }

    pub fn preset_slots(&self) -> Result<Option<PresetSlotList>, String> {
        let Some(snapshot) = self.gateway_snapshot() else {
            return Ok(None);
        };
        self.preset_library
            .lock()
            .expect("preset library lock")
            .writable_slots(&snapshot)
    }

    pub fn preset_entry(&self, key: &str, position: u32) -> Option<PresetEntry> {
        self.preset_library
            .lock()
            .expect("preset library lock")
            .entry(key, position)
    }

    pub fn record_saved_preset(&self, key: &str, position: u32, name: &str, instrument: i32) {
        self.preset_library
            .lock()
            .expect("preset library lock")
            .record_saved(key, position, name, instrument);
    }

    pub fn plan_preset_mutation(
        &self,
        method: &str,
        params: &serde_json::Value,
    ) -> Result<PresetMutationPlan, String> {
        let snapshot = self.gateway_snapshot.lock().expect("gateway snapshot lock");
        let library = self.preset_library.lock().expect("preset library lock");
        runtime_request::plan_preset_mutation(method, params, Some(&snapshot), &library)
    }

    pub fn wait_for_preset_folders(&self, timeout: Duration) -> Vec<PresetFolder> {
        let deadline = Instant::now() + timeout;
        loop {
            let folders = self.preset_folders();
            if !folders.is_empty() || Instant::now() >= deadline {
                return folders;
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    pub fn wait_for_preset_list(&self, key: &str, timeout: Duration) -> Option<PresetList> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(list) = self.preset_list(key) {
                return Some(list);
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    pub fn send(&self, message_type: u16, payload: Vec<u8>) -> Result<(), String> {
        let (sender, receiver) = mpsc::channel();
        self.commands
            .send(Command::Send(message_type, payload, sender))
            .map_err(|error| error.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| error.to_string())?
    }

    pub fn send_command(&self, message: OutboundMessage) -> Result<(), String> {
        self.send(message.message_type, message.payload)
    }

    pub fn send_sequence(
        &self,
        messages: Vec<OutboundMessage>,
        delay: Duration,
        interval: Duration,
    ) -> Result<(), String> {
        let (sender, receiver) = mpsc::channel();
        self.commands
            .send(Command::SendSequence {
                messages,
                delay,
                interval,
                reply: sender,
            })
            .map_err(|error| error.to_string())?;
        receiver
            .recv_timeout(delay + interval.saturating_mul(16) + Duration::from_secs(2))
            .map_err(|error| error.to_string())?
    }

    pub fn send_operation(&self, operation: DeviceOperation) -> Result<(), String> {
        for message in operation.encode() {
            self.send_command(message)?;
        }
        Ok(())
    }

    pub fn request(
        &self,
        message_type: u16,
        payload: Vec<u8>,
        expected_type: u16,
        request_id: Option<u64>,
        timeout: Duration,
    ) -> Result<IncomingMessage, String> {
        let (sender, receiver) = mpsc::channel();
        self.commands
            .send(Command::Request {
                message_type,
                payload,
                expected_type,
                request_id,
                timeout,
                reply: sender,
            })
            .map_err(|error| error.to_string())?;
        receiver
            .recv_timeout(timeout + Duration::from_secs(1))
            .map_err(|error| error.to_string())?
    }

    pub fn create_backup(&self, timeout: Duration) -> Result<String, String> {
        let cursor = self
            .event_log
            .lock()
            .expect("event log lock")
            .back()
            .map(|message| message.sequence)
            .unwrap_or(0);
        self.send_command(commands::create_local_backup())?;
        let deadline = Instant::now() + timeout;
        let mut consumed = cursor;
        let mut backup = BackupAssembler::default();
        while Instant::now() < deadline {
            for raw in self.events_since(consumed, Some(40), 4096) {
                consumed = consumed.max(raw.sequence);
                if let Some(document) = backup
                    .push(raw.payload.as_slice())
                    .map_err(|error| format!("Could not decode native backup chunk: {error}"))?
                {
                    return Ok(document);
                }
            }
            thread::sleep(Duration::from_millis(25));
        }
        Err("The Quad Cortex did not finish the native backup within 60 seconds.".into())
    }

    pub fn switch_scene(&self, scene: u32) -> Result<(), String> {
        if scene > 7 {
            return Err("Scene must be between 0 and 7".into());
        }
        let (sender, receiver) = mpsc::channel();
        self.commands
            .send(Command::SwitchScene(scene, sender))
            .map_err(|error| error.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| error.to_string())?
    }

    pub fn wait_for_scene(&self, scene: u32, timeout: Duration) -> BrokerStatus {
        let deadline = Instant::now() + timeout;
        loop {
            let status = self.status();
            if status.active_scene == Some(scene)
                || status.phase == "error"
                || Instant::now() >= deadline
            {
                return status;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn wait_for_ready(&self, timeout: Duration) -> BrokerStatus {
        let deadline = Instant::now() + timeout;
        loop {
            let status = self.status();
            if status.phase == "ready" || status.phase == "error" || Instant::now() >= deadline {
                return status;
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

impl Drop for DeviceController {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Stop);
    }
}

struct PendingRequest {
    expected_type: u16,
    request_id: Option<u64>,
    deadline: Instant,
    reply: mpsc::Sender<Result<IncomingMessage, String>>,
}

enum StateDecoderCommand {
    Reset(u64),
    Message(u64, IncomingMessage),
    Catalog(u64, ModelCatalog),
    BlockDetails(u32, u32, mpsc::Sender<Option<BlockDetails>>),
    ListModels(mpsc::Sender<ModelList>),
    Stop,
}

fn run_state_decoder(
    event_log: Arc<Mutex<VecDeque<DecodedStateFrame>>>,
    gateway_snapshot: Arc<Mutex<GatewaySnapshot>>,
    subscribers: Arc<Mutex<Vec<mpsc::Sender<DecodedStateFrame>>>>,
    sender: mpsc::Sender<StateDecoderCommand>,
    messages: mpsc::Receiver<StateDecoderCommand>,
) {
    let mut decoder = StateDecoder::new();
    let mut generation = 0;
    let mut next_sequence = 1_u64;
    while let Ok(message) = messages.recv() {
        match message {
            StateDecoderCommand::Reset(next_generation) => {
                generation = next_generation;
                decoder.reset();
                event_log
                    .lock()
                    .expect("decoded state event log lock")
                    .clear();
                *gateway_snapshot.lock().expect("gateway snapshot lock") =
                    GatewaySnapshot::default();
            }
            StateDecoderCommand::Message(message_generation, message)
                if message_generation == generation =>
            {
                if message.message_type == 51 {
                    let install = sender.clone();
                    thread::Builder::new()
                        .name("qc-native-metadata".into())
                        .spawn(move || {
                            if let Ok(catalog) = parse_model_repo(&message.payload) {
                                let _ = install.send(StateDecoderCommand::Catalog(
                                    message_generation,
                                    catalog,
                                ));
                            }
                        })
                        .ok();
                    continue;
                }
                if let Ok(states) = decoder.decode(message.message_type, &message.payload) {
                    let tempo_clock = message_tempo_clock(&message);
                    if states.is_empty() && tempo_clock.is_none() {
                        continue;
                    }
                    {
                        let mut snapshot = gateway_snapshot.lock().expect("gateway snapshot lock");
                        for state in &states {
                            snapshot.apply(state);
                        }
                    }
                    let frame = DecodedStateFrame {
                        sequence: next_sequence,
                        observed_at: message.received_at_unix_ms,
                        states,
                        tempo_clock,
                    };
                    publish_state_frame(&event_log, &subscribers, frame);
                    next_sequence += 1;
                }
            }
            StateDecoderCommand::Catalog(catalog_generation, catalog)
                if catalog_generation == generation =>
            {
                let states = decoder.install_catalog(catalog);
                if states.is_empty() {
                    continue;
                }
                {
                    let mut snapshot = gateway_snapshot.lock().expect("gateway snapshot lock");
                    for state in &states {
                        snapshot.apply(state);
                    }
                }
                let frame = DecodedStateFrame {
                    sequence: next_sequence,
                    observed_at: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis(),
                    states,
                    tempo_clock: None,
                };
                publish_state_frame(&event_log, &subscribers, frame);
                next_sequence += 1;
            }
            StateDecoderCommand::BlockDetails(row, column, reply) => {
                let _ = reply.send(decoder.block_details(row, column));
            }
            StateDecoderCommand::ListModels(reply) => {
                let _ = reply.send(decoder.model_list());
            }
            StateDecoderCommand::Message(_, _) | StateDecoderCommand::Catalog(_, _) => {}
            StateDecoderCommand::Stop => return,
        }
    }
}

fn message_tempo_clock(message: &IncomingMessage) -> Option<TempoClockFrame> {
    if message.message_type != 33 {
        return None;
    }
    decode_tempo_clock(message.payload.as_slice())
        .ok()
        .flatten()
}

fn publish_state_frame(
    event_log: &Arc<Mutex<VecDeque<DecodedStateFrame>>>,
    subscribers: &Arc<Mutex<Vec<mpsc::Sender<DecodedStateFrame>>>>,
    frame: DecodedStateFrame,
) {
    {
        let mut log = event_log.lock().expect("decoded state event log lock");
        log.push_back(frame.clone());
        while log.len() > 4096 {
            log.pop_front();
        }
    }
    subscribers
        .lock()
        .expect("decoded state subscriber lock")
        .retain(|subscriber| subscriber.send(frame.clone()).is_ok());
}

fn run(
    state: Arc<Mutex<BrokerStatus>>,
    latest_messages: Arc<Mutex<HashMap<u16, IncomingMessage>>>,
    event_log: Arc<Mutex<VecDeque<IncomingMessage>>>,
    preset_library: Arc<Mutex<PresetLibrary>>,
    state_messages: mpsc::Sender<StateDecoderCommand>,
    commands: mpsc::Receiver<Command>,
) {
    let session_clock = Instant::now();
    let mut session = SessionMachine::new(0);
    let mut connection: Option<ConnectedQc> = None;
    let mut auto_connect = true;
    let mut pending_scene: Option<(u32, Instant)> = None;
    let mut next_scene_poll = Instant::now();
    let mut pending_requests: Vec<PendingRequest> = Vec::new();
    let mut state_generation = 0_u64;
    let mut command_not_before = Instant::now();
    loop {
        while let Ok(command) = commands.try_recv() {
            match command {
                Command::Reconnect => {
                    connection = None;
                    fail_pending(&mut pending_requests, "Device session restarted");
                    latest_messages.lock().expect("latest message lock").clear();
                    event_log.lock().expect("event log lock").clear();
                    preset_library.lock().expect("preset library lock").clear();
                    state_generation += 1;
                    let _ = state_messages.send(StateDecoderCommand::Reset(state_generation));
                    auto_connect = true;
                    session.request_reconnect(session_clock.elapsed().as_millis() as u64);
                    set_phase(&state, "searching", "Reconnect requested", false, false);
                }
                Command::Disconnect => {
                    connection = None;
                    fail_pending(&mut pending_requests, "Device session closed");
                    latest_messages.lock().expect("latest message lock").clear();
                    event_log.lock().expect("event log lock").clear();
                    preset_library.lock().expect("preset library lock").clear();
                    state_generation += 1;
                    let _ = state_messages.send(StateDecoderCommand::Reset(state_generation));
                    auto_connect = false;
                    session.disconnect(session_clock.elapsed().as_millis() as u64, false);
                    set_phase(
                        &state,
                        "disconnected",
                        "Device session closed",
                        false,
                        false,
                    );
                }
                Command::SwitchScene(scene, reply) => {
                    let result = if let Some(connected) = connection.as_ref() {
                        thread::sleep(command_not_before.saturating_duration_since(Instant::now()));
                        connected
                            .usb
                            .send_command(commands::DeviceCommand::SelectScene(scene).encode());
                        session.outbound(session_clock.elapsed().as_millis() as u64);
                        pending_scene = Some((
                            scene,
                            Instant::now()
                                + Duration::from_millis(profile::COMMAND_CONFIRMATION_TIMEOUT_MS),
                        ));
                        next_scene_poll = Instant::now();
                        Ok(())
                    } else {
                        Err("Quad Cortex is not connected".into())
                    };
                    let _ = reply.send(result);
                }
                Command::Send(message_type, payload, reply) => {
                    let result = if let Some(connected) = connection.as_ref() {
                        thread::sleep(command_not_before.saturating_duration_since(Instant::now()));
                        connected.usb.send(message_type, payload);
                        session.outbound(session_clock.elapsed().as_millis() as u64);
                        Ok(())
                    } else {
                        Err("Quad Cortex is not connected".into())
                    };
                    let _ = reply.send(result);
                }
                Command::SendSequence {
                    messages,
                    delay,
                    interval,
                    reply,
                } => {
                    let result = if let Some(connected) = connection.as_ref() {
                        thread::sleep(command_not_before.saturating_duration_since(Instant::now()));
                        thread::sleep(delay);
                        for (index, message) in messages.iter().enumerate() {
                            connected.usb.send_command(message.clone());
                            session.outbound(session_clock.elapsed().as_millis() as u64);
                            if index + 1 < messages.len() {
                                thread::sleep(interval);
                            }
                        }
                        Ok(())
                    } else {
                        Err("Quad Cortex is not connected".into())
                    };
                    let _ = reply.send(result);
                }
                Command::Request {
                    message_type,
                    payload,
                    expected_type,
                    request_id,
                    timeout,
                    reply,
                } => {
                    if let Some(connected) = connection.as_ref() {
                        thread::sleep(command_not_before.saturating_duration_since(Instant::now()));
                        pending_requests.push(PendingRequest {
                            expected_type,
                            request_id,
                            deadline: Instant::now() + timeout,
                            reply,
                        });
                        connected.usb.send(message_type, payload);
                        session.outbound(session_clock.elapsed().as_millis() as u64);
                    } else {
                        let _ = reply.send(Err("Quad Cortex is not connected".into()));
                    }
                }
                Command::Stop => {
                    fail_pending(&mut pending_requests, "Native broker stopped");
                    let _ = state_messages.send(StateDecoderCommand::Stop);
                    return;
                }
            }
        }

        let now_ms = session_clock.elapsed().as_millis() as u64;
        if connection.is_none() && auto_connect && session.reconnect_due(now_ms) {
            session.reconnect_attempted(now_ms);
            set_phase(
                &state,
                "connecting",
                "Opening native QC USB session",
                false,
                false,
            );
            let started = Instant::now();
            match QcUsb::connect(&mut session, &session_clock) {
                Ok(connected) => {
                    let handshake_ms = started.elapsed().as_millis();
                    state_generation += 1;
                    let _ = state_messages.send(StateDecoderCommand::Reset(state_generation));
                    install_connection_status(&state, &connected, handshake_ms);
                    *latest_messages.lock().expect("latest message lock") =
                        connected.latest_messages.clone();
                    {
                        let mut log = event_log.lock().expect("event log lock");
                        log.clear();
                        let mut initial = connected
                            .latest_messages
                            .values()
                            .cloned()
                            .collect::<Vec<_>>();
                        initial.sort_by_key(|message| message.sequence);
                        for message in &initial {
                            let _ = state_messages.send(StateDecoderCommand::Message(
                                state_generation,
                                message.clone(),
                            ));
                        }
                        log.extend(initial);
                    }
                    // The QC reports its initial preset before its control loop
                    // is always ready to accept the first host mutation. Hold
                    // only that first post-handshake write briefly; subsequent
                    // commands remain on the zero-debounce realtime lane.
                    command_not_before = Instant::now() + Duration::from_millis(250);
                    connection = Some(connected);
                }
                Err(UsbError::NotAvailable) => {
                    session.disconnect(session_clock.elapsed().as_millis() as u64, true);
                    set_phase(
                        &state,
                        "searching",
                        "Quad Cortex is not attached or is owned by another application",
                        false,
                        false,
                    );
                }
                Err(error) => {
                    session.disconnect(session_clock.elapsed().as_millis() as u64, true);
                    set_phase(&state, "error", &error.to_string(), false, false);
                }
            }
        }

        if let Some(connected) = connection.as_mut() {
            match connected.usb.read_message(50) {
                Ok(Some(message)) => {
                    session.read_succeeded();
                    session.state_observed(
                        session_clock.elapsed().as_millis() as u64,
                        connected.synchronized,
                    );
                    update_message(&state, &mut connected.latest_messages, message.clone());
                    latest_messages
                        .lock()
                        .expect("latest message lock")
                        .insert(message.message_type, message.clone());
                    {
                        let mut log = event_log.lock().expect("event log lock");
                        log.push_back(message.clone());
                        while log.len() > 4096 {
                            log.pop_front();
                        }
                    }
                    let _ = state_messages.send(StateDecoderCommand::Message(
                        state_generation,
                        message.clone(),
                    ));
                    if message.message_type == 4 {
                        if let Ok(Some(listing)) = decode_preset_folder(&message.payload) {
                            preset_library
                                .lock()
                                .expect("preset library lock")
                                .ingest(listing);
                        }
                    }
                    deliver_pending(&mut pending_requests, &message);
                }
                Ok(None) => session.read_succeeded(),
                Err(error) => {
                    if !session.read_failed() {
                        continue;
                    }
                    set_phase(
                        &state,
                        "searching",
                        &format!("USB link lost: {error}"),
                        false,
                        false,
                    );
                    fail_pending(&mut pending_requests, &format!("USB link lost: {error}"));
                    session.disconnect(session_clock.elapsed().as_millis() as u64, true);
                    connection = None;
                    continue;
                }
            }
            if session.keepalive_due(session_clock.elapsed().as_millis() as u64) {
                connected.usb.send_command(commands::keepalive());
                session.outbound(session_clock.elapsed().as_millis() as u64);
            }
            if let Some((wanted, deadline)) = pending_scene {
                let actual = state.lock().expect("device status lock").active_scene;
                if actual == Some(wanted) || Instant::now() >= deadline {
                    pending_scene = None;
                } else if Instant::now() >= next_scene_poll {
                    connected.usb.send_command(commands::read(13));
                    session.outbound(session_clock.elapsed().as_millis() as u64);
                    next_scene_poll = Instant::now()
                        + Duration::from_millis(profile::CONFIRMATION_POLL_INTERVAL_MS);
                }
            }
        } else {
            thread::sleep(Duration::from_millis(100));
        }
        expire_pending(&mut pending_requests);
    }
}

fn deliver_pending(pending: &mut Vec<PendingRequest>, message: &IncomingMessage) {
    let request_id = qc_protocol::wire::varint_field(
        &message.payload,
        if message.message_type == 52 { 1 } else { 2 },
    )
    .ok()
    .flatten();
    if let Some(index) = pending.iter().position(|request| {
        request.expected_type == message.message_type
            && (request_id.is_none()
                || request.request_id.is_none()
                || request_id == request.request_id)
    }) {
        let request = pending.remove(index);
        let _ = request.reply.send(Ok(message.clone()));
    }
}

fn expire_pending(pending: &mut Vec<PendingRequest>) {
    let now = Instant::now();
    let mut index = 0;
    while index < pending.len() {
        if pending[index].deadline <= now {
            let request = pending.remove(index);
            let _ = request.reply.send(Err(format!(
                "No QC message type {} response before timeout",
                request.expected_type
            )));
        } else {
            index += 1;
        }
    }
}

fn fail_pending(pending: &mut Vec<PendingRequest>, detail: &str) {
    for request in pending.drain(..) {
        let _ = request.reply.send(Err(detail.into()));
    }
}

fn set_phase(
    state: &Arc<Mutex<BrokerStatus>>,
    phase: &str,
    detail: &str,
    connected: bool,
    synchronized: bool,
) {
    let mut status = state.lock().expect("device status lock");
    status.phase = phase.into();
    status.detail = detail.into();
    status.connected = connected;
    status.synchronized = synchronized;
    if !connected {
        status.active_preset_name = None;
        status.active_scene = None;
        status.connected_at_unix_ms = None;
    }
}

fn install_connection_status(
    state: &Arc<Mutex<BrokerStatus>>,
    connection: &ConnectedQc,
    handshake_ms: u128,
) {
    let mut status = state.lock().expect("device status lock");
    status.phase = if connection.synchronized {
        "ready"
    } else {
        "syncing"
    }
    .into();
    status.detail = if connection.synchronized {
        "Active preset synchronized"
    } else {
        "Handshake complete; waiting for active preset"
    }
    .into();
    status.connected = true;
    status.synchronized = connection.synchronized;
    status.active_preset_name = connection
        .latest_messages
        .get(&15)
        .and_then(|message| crate::usb::preset_name(&message.payload));
    status.active_scene = connection
        .latest_messages
        .get(&13)
        .and_then(|message| crate::usb::scene_value(&message.payload));
    status.connected_at_unix_ms = Some(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    );
    status.handshake_ms = Some(handshake_ms);
    status.messages_received = connection.message_counts.values().sum::<usize>() as u64;
    status.last_message_type = connection
        .latest_messages
        .values()
        .max_by_key(|message| message.sequence)
        .map(|message| message.message_type);
}

fn update_message(
    state: &Arc<Mutex<BrokerStatus>>,
    latest: &mut HashMap<u16, IncomingMessage>,
    message: IncomingMessage,
) {
    let message_type = message.message_type;
    let preset_name = if message_type == 15 {
        crate::usb::preset_name(&message.payload)
    } else {
        None
    };
    let active_scene = if message_type == 13 {
        crate::usb::scene_value(&message.payload)
    } else {
        None
    };
    latest.insert(message_type, message);
    let mut status = state.lock().expect("device status lock");
    status.messages_received += 1;
    status.last_message_type = Some(message_type);
    if message_type == 15 {
        status.phase = "ready".into();
        status.detail = "Active preset synchronized".into();
        status.synchronized = true;
        status.active_preset_name = preset_name;
    }
    if let Some(scene) = active_scene {
        status.active_scene = Some(scene)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_status_distinguishes_searching_from_ready() {
        let status = BrokerStatus::default();
        assert_eq!(status.phase, "searching");
        assert!(!status.connected);
        assert!(!status.synchronized);
    }

    #[test]
    fn gateway_snapshot_reduces_native_updates_without_python() {
        let mut snapshot = GatewaySnapshot::default();
        let mut position = StateUpdate::empty("position");
        position.position = Some(17);
        position.setlist_key = Some("/media/p4/Presets/Live/".into());
        snapshot.apply(&position);

        let mut preset = StateUpdate::empty("preset");
        preset.preset_name = Some("Direct Rust".into());
        preset.tempo = Some(96);
        preset.scenes = Some(
            (b'A'..=b'H')
                .map(|letter| format!("Scene {}", letter as char))
                .collect(),
        );
        preset.blocks = Some(Vec::new());
        preset.routes = Some(Vec::new());
        snapshot.apply(&preset);

        let mut volume = StateUpdate::empty("master");
        volume.master_volume = Some(0.57);
        snapshot.apply(&volume);

        assert!(snapshot.has_preset);
        assert_eq!(snapshot.preset_name, "Direct Rust");
        assert_eq!(snapshot.preset_location, "3B");
        assert_eq!(snapshot.setlist_name, "Live");
        assert_eq!(snapshot.tempo, 96);
        assert_eq!(snapshot.master_volume, 57);
    }
}
