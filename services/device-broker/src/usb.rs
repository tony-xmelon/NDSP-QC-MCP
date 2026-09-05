use crate::flight::FlightRecorder;
use hidapi::{HidApi, HidDevice};
use prost::Message;
use qc_protocol::commands::{self, OutboundMessage};
use qc_protocol::framing;
use qc_protocol::profile;
use qc_protocol::proto;
use qc_protocol::proto::cortex_protobuf_v2 as pa;
use qc_protocol::responses::{BackupAssembler, ResponseDecodeError};
use qc_protocol::session::{FrameAssembler, SessionMachine};
use std::cell::UnsafeCell;
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum UsbError {
    #[error("Quad Cortex is not present or its HID interface is owned by another application")]
    NotAvailable,
    #[error("Quad Cortex did not answer the native handshake within the configured timeout")]
    HandshakeTimeout,
    #[error("USB read failed: {0}")]
    Read(String),
    #[error("invalid QC frame: {0}")]
    Frame(#[from] framing::FrameError),
    #[error("HID initialization failed: {0}")]
    Hid(String),
    #[error("QC backup could not be decoded: {0}")]
    BackupDecode(#[from] ResponseDecodeError),
    #[error("QC backup timed out: {0}")]
    BackupTimeout(String),
}

#[derive(Debug, Clone)]
pub struct IncomingMessage {
    pub sequence: u64,
    pub message_type: u16,
    pub payload: Vec<u8>,
    pub received_at_unix_ms: u128,
}

pub struct ConnectedQc {
    pub usb: QcUsb,
    pub synchronized: bool,
    pub message_counts: HashMap<u16, usize>,
    pub latest_messages: HashMap<u16, IncomingMessage>,
}

pub struct BackupTransfer {
    pub document: String,
    pub side_messages: Vec<IncomingMessage>,
}

enum HidReadEvent {
    Report(Vec<u8>),
    Error(String),
}

/// One native handle with independent full-duplex read and write lanes.
///
/// hidapi's pure-Rust Windows backend keeps distinct buffers, events and
/// OVERLAPPED records for those operations. This is the topology used by the
/// proven reference client as well: one permanent RX thread is already waiting
/// when the command thread writes a report.
struct SharedWindowsHid(UnsafeCell<HidDevice>);

// Safety: exactly one RX thread calls read_timeout and exactly one broker
// thread calls write. The selected windows-native backend touches disjoint
// read_state/write_state RefCells; read_pending is RX-only and the native
// handle is immutable. HidIo joins RX before releasing the handle.
unsafe impl Sync for SharedWindowsHid {}

impl SharedWindowsHid {
    fn read_timeout(&self, report: &mut [u8], timeout_ms: i32) -> Result<usize, String> {
        unsafe { (&*self.0.get()).read_timeout(report, timeout_ms) }
            .map_err(|error| error.to_string())
    }

    fn write(&self, report: &[u8]) -> Result<usize, String> {
        unsafe { (&*self.0.get()).write(report) }.map_err(|error| error.to_string())
    }
}

struct HidIo {
    device: Arc<SharedWindowsHid>,
    receiver: mpsc::Receiver<HidReadEvent>,
    stopping: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
}

impl HidIo {
    fn start(device: HidDevice) -> Result<Self, UsbError> {
        let device = Arc::new(SharedWindowsHid(UnsafeCell::new(device)));
        let stopping = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::channel();
        let reader_device = Arc::clone(&device);
        let reader_stopping = Arc::clone(&stopping);
        let reader = thread::Builder::new()
            .name("qc-native-hid-rx".into())
            .spawn(move || {
                let mut consecutive_errors = 0_u8;
                while !reader_stopping.load(Ordering::Acquire) {
                    let mut report = [0_u8; 1024];
                    match reader_device.read_timeout(&mut report, 200) {
                        Ok(0) => consecutive_errors = 0,
                        Ok(read) => {
                            consecutive_errors = 0;
                            if sender
                                .send(HidReadEvent::Report(report[..read].to_vec()))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(error) => {
                            consecutive_errors = consecutive_errors.saturating_add(1);
                            if sender.send(HidReadEvent::Error(error)).is_err()
                                || consecutive_errors >= 2
                            {
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(|error| UsbError::Hid(format!("could not start HID reader: {error}")))?;
        Ok(Self {
            device,
            receiver,
            stopping,
            reader: Some(reader),
        })
    }

    fn write(&self, report: &[u8]) -> Result<usize, String> {
        self.device.write(report)
    }

    fn read(&self, timeout_ms: i32) -> Result<Option<Vec<u8>>, UsbError> {
        let timeout = if timeout_ms <= 0 {
            Duration::ZERO
        } else {
            Duration::from_millis(timeout_ms as u64)
        };
        match self.receiver.recv_timeout(timeout) {
            Ok(HidReadEvent::Report(report)) => Ok(Some(report)),
            Ok(HidReadEvent::Error(error)) => Err(UsbError::Read(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(UsbError::Read("native HID reader stopped".into()))
            }
        }
    }
}

impl Drop for HidIo {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

pub struct QcUsb {
    // Rust drops fields in declaration order. Keep the exclusive I/O owner
    // ahead of HidApi so shutdown joins RX and releases USB first.
    io: HidIo,
    _api: HidApi,
    frames: FrameAssembler,
    frame_report_count: usize,
    next_sequence: u64,
    flight: FlightRecorder,
}

impl QcUsb {
    pub fn open() -> Result<Self, UsbError> {
        let api = HidApi::new().map_err(|error| UsbError::Hid(error.to_string()))?;
        let device = api
            .open(profile::VENDOR_ID, profile::PRODUCT_ID)
            .map_err(|_| UsbError::NotAvailable)?;
        let io = HidIo::start(device)?;
        let mut flight = FlightRecorder::open_default();
        flight.event("transport-opened");
        Ok(Self {
            io,
            _api: api,
            frames: FrameAssembler::new(),
            frame_report_count: 0,
            next_sequence: 1,
            flight,
        })
    }

    pub fn connect(
        session: &mut SessionMachine,
        session_clock: &Instant,
    ) -> Result<ConnectedQc, UsbError> {
        let mut usb = Self::open()?;
        session.transport_opened(session_clock.elapsed().as_millis() as u64);
        loop {
            let now_ms = session_clock.elapsed().as_millis() as u64;
            if session.handshake_timed_out(now_ms) {
                return Err(UsbError::HandshakeTimeout);
            }
            let Some(attempt) = session.next_handshake_attempt(now_ms) else {
                std::thread::yield_now();
                continue;
            };
            let session_id = uuid::Uuid::new_v4().simple().to_string();
            usb.flight
                .event(format!("handshake-attempt-{}", attempt.number));
            usb.send_command(commands::reset_comms(attempt.number as u64, session_id));
            while session.awaiting_handshake_reply(session_clock.elapsed().as_millis() as u64) {
                if let Some(message) = usb.read_message(200)? {
                    if message.message_type == profile::MESSAGE_TYPE_DEVICE_VERSION {
                        usb.flight.event("handshake-reply");
                        let connected = usb.finish_hello(attempt.number as u64 + 1)?;
                        session.handshake_completed(
                            session_clock.elapsed().as_millis() as u64,
                            connected.synchronized,
                        );
                        return Ok(connected);
                    }
                }
                if session.handshake_timed_out(session_clock.elapsed().as_millis() as u64) {
                    return Err(UsbError::HandshakeTimeout);
                }
            }
        }
    }

    fn finish_hello(mut self, request_id: u64) -> Result<ConnectedQc, UsbError> {
        // Version, ModelRepo, connection state and live subscriptions share
        // one protocol plan with Android. Directory enumeration stays on
        // demand so it cannot starve the active preset.
        self.flight.event("initialization-started");
        for message in commands::initialization() {
            self.send_command(message);
        }
        self.flight.event("initialization-sent");
        let deadline = Instant::now() + Duration::from_millis(profile::INITIAL_SYNC_TIMEOUT_MS);
        let mut synchronized = false;
        let mut message_counts = HashMap::new();
        let mut latest_messages = HashMap::new();
        while Instant::now() < deadline {
            if let Some(message) = self.read_message(100)? {
                let is_preset = message.message_type == 15;
                *message_counts.entry(message.message_type).or_default() += 1;
                latest_messages.insert(message.message_type, message);
                if is_preset {
                    synchronized = true;
                    break;
                }
            }
        }
        if !synchronized {
            self.send_command(commands::read_current_preset(request_id));
            let deadline = Instant::now() + Duration::from_millis(profile::PRESET_SYNC_TIMEOUT_MS);
            while Instant::now() < deadline {
                if let Some(message) = self.read_message(200)? {
                    let is_preset = message.message_type == 15;
                    *message_counts.entry(message.message_type).or_default() += 1;
                    latest_messages.insert(message.message_type, message);
                    if is_preset {
                        synchronized = true;
                        break;
                    }
                }
            }
        }
        let required_seed_types = [2_u16, 13, 14, 17, 34];
        for message_type in required_seed_types {
            if !latest_messages.contains_key(&message_type) {
                self.send_command(commands::read(message_type));
            }
        }
        let seed_deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < seed_deadline
            && required_seed_types
                .iter()
                .any(|message_type| !latest_messages.contains_key(message_type))
        {
            if let Some(message) = self.read_message(100)? {
                *message_counts.entry(message.message_type).or_default() += 1;
                latest_messages.insert(message.message_type, message);
            }
        }
        // Directory transfer is deliberately not started here. File READ can
        // enqueue hundreds of folder messages and starve the first live
        // command for several seconds; the directory API starts it on demand.
        self.flight.event(if synchronized {
            "initialization-synchronized"
        } else {
            "initialization-incomplete"
        });
        Ok(ConnectedQc {
            usb: self,
            synchronized,
            message_counts,
            latest_messages,
        })
    }

    pub fn send(&mut self, message_type: u16, payload: Vec<u8>) {
        let reports = framing::encode(message_type, &payload);
        self.flight.outbound(message_type, reports.len());
        for report in reports {
            // The QC accepts the report then stalls its status stage, so the
            // return value is intentionally ignored. Device loss is detected
            // only by reads.
            let started = Instant::now();
            let result = self.io.write(&report);
            if message_type == profile::MESSAGE_TYPE_BACKUP {
                self.flight.event(format!(
                    "backup-write-{}-{}ms",
                    if result.is_ok() {
                        "completed"
                    } else {
                        "stalled"
                    },
                    started.elapsed().as_millis()
                ));
            }
        }
    }

    pub fn send_command(&mut self, message: OutboundMessage) {
        self.send(message.message_type, message.payload);
    }

    pub fn read_message(&mut self, timeout_ms: i32) -> Result<Option<IncomingMessage>, UsbError> {
        let Some(report) = self.io.read(timeout_ms)? else {
            return Ok(None);
        };
        if report.len() >= 3 && report[2] & framing::FLAG_FIRST != 0 {
            self.frame_report_count = 1;
        } else if self.frame_report_count > 0 {
            self.frame_report_count += 1;
        }
        let assembled = match self.frames.push(report) {
            Ok(assembled) => assembled,
            Err(error) => {
                self.frame_report_count = 0;
                return Err(error.into());
            }
        };
        let Some((message_type, mut payload)) = assembled else {
            return Ok(None);
        };
        self.flight
            .inbound(message_type, self.frame_report_count.max(1));
        self.frame_report_count = 0;
        // ModelRepo is the largest compressed message. Keep its decompression
        // off this permanent USB worker; the metadata worker inflates it only
        // when the catalog is actually consumed.
        if message_type != profile::MESSAGE_TYPE_MODEL_REPO && payload.starts_with(&[0x1f, 0x8b]) {
            let mut decoded = Vec::new();
            flate2::read::GzDecoder::new(payload.as_slice())
                .take(profile::MAX_INFLATED_BYTES as u64 + 1)
                .read_to_end(&mut decoded)
                .map_err(|error| {
                    UsbError::Read(format!("gzip payload could not be decoded: {error}"))
                })?;
            if decoded.len() > profile::MAX_INFLATED_BYTES {
                return Err(UsbError::Read(
                    "gzip payload exceeds the inflated-size limit".into(),
                ));
            }
            payload = decoded;
        }
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        Ok(Some(IncomingMessage {
            sequence,
            message_type,
            payload,
            received_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        }))
    }

    /// Collect one complete, validated LocalBackup document on this session.
    ///
    /// LocalBackup replies are an uncorrelated stream on current firmware. A
    /// previous client can leave its final chunks queued, so collection starts
    /// only at a JSON object boundary and ignores leading stale terminators.
    /// Before the first document chunk it is safe to retry a request that
    /// produces no traffic. Once a document starts, a stall is terminal: two
    /// attempts are never spliced into one backup.
    pub fn create_backup(&mut self, timeout: Duration) -> Result<BackupTransfer, UsbError> {
        let first_chunk_timeout = Duration::from_millis(profile::BACKUP_FIRST_CHUNK_TIMEOUT_MS);
        let stream_stall_timeout = Duration::from_millis(profile::BACKUP_STREAM_STALL_TIMEOUT_MS);

        let deadline = Instant::now() + timeout;
        let mut first_chunk_deadline = (Instant::now() + first_chunk_timeout).min(deadline);
        let mut progress_deadline = deadline;
        let mut attempts = 1_usize;
        let mut assembler = BackupAssembler::default();
        let mut side_messages = Vec::new();
        let mut next_keepalive =
            Instant::now() + Duration::from_millis(profile::KEEPALIVE_INTERVAL_MS);

        self.flight.event("backup-request-1");
        self.send_command(commands::create_local_backup());

        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err(UsbError::BackupTimeout(format!(
                    "overall deadline reached after {attempts} request(s), {} complete document chunk(s), and {} ignored prefix chunk(s)",
                    assembler.chunks(),
                    assembler.ignored_prefix_chunks()
                )));
            }
            if now >= next_keepalive {
                self.send_command(commands::keepalive());
                next_keepalive =
                    Instant::now() + Duration::from_millis(profile::KEEPALIVE_INTERVAL_MS);
            }
            if assembler.started() && now >= progress_deadline {
                return Err(UsbError::BackupTimeout(format!(
                    "stream stalled after {} chunk(s); the partial document was discarded and was not combined with a retry",
                    assembler.chunks()
                )));
            }
            if !assembler.started() && now >= first_chunk_deadline {
                if attempts >= profile::BACKUP_MAXIMUM_ATTEMPTS {
                    return Err(UsbError::BackupTimeout(format!(
                        "no JSON document start arrived after {attempts} request(s); ignored {} stale chunk(s) and {} stale terminator(s)",
                        assembler.ignored_prefix_chunks(),
                        assembler.ignored_prefix_terminators()
                    )));
                }
                attempts += 1;
                self.flight.event(format!("backup-request-{attempts}"));
                self.send_command(commands::create_local_backup());
                first_chunk_deadline = (Instant::now() + first_chunk_timeout).min(deadline);
                continue;
            }

            let active_deadline = if assembler.started() {
                progress_deadline
            } else {
                first_chunk_deadline
            }
            .min(deadline);
            let wait_ms = active_deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(200))
                .as_millis()
                .max(1) as i32;
            let Some(message) = self.read_message(wait_ms)? else {
                continue;
            };
            if message.message_type != profile::MESSAGE_TYPE_BACKUP {
                side_messages.push(message);
                continue;
            }

            let was_started = assembler.started();
            let previous_chunks = assembler.chunks();
            let previous_ignored = assembler.ignored_prefix_chunks();
            if let Some(document) = assembler.push(&message.payload)? {
                self.flight.event(format!(
                    "backup-complete-{attempts}-attempts-{}-ignored-prefix-chunks",
                    assembler.ignored_prefix_chunks()
                ));
                return Ok(BackupTransfer {
                    document,
                    side_messages,
                });
            }
            let now = Instant::now();
            if assembler.chunks() > previous_chunks {
                progress_deadline = (now + stream_stall_timeout).min(deadline);
            } else if !was_started && assembler.ignored_prefix_chunks() > previous_ignored {
                // Traffic from an earlier uncorrelated transfer is still being
                // drained. Do not inject duplicate CREATE requests into it.
                first_chunk_deadline = (now + first_chunk_timeout).min(deadline);
            }
        }
    }

    pub fn disconnect(&mut self) {
        self.send_command(commands::connection(false));
    }
}

pub fn preset_name(payload: &[u8]) -> Option<String> {
    let message = pa::RecallPresetMessage::decode(payload).ok()?;
    let pa::recall_preset_message::Preset::Preset(preset) = message.preset?;
    let proto::binary_preset::Name::Name(name) = preset.name?;
    Some(name)
}

pub fn scene_value(payload: &[u8]) -> Option<u32> {
    let message = pa::SceneMessage::decode(payload).ok()?;
    let pa::scene_message::SelectedScene::SelectedScene(scene) = message.selected_scene?;
    Some(scene)
}

impl Drop for QcUsb {
    fn drop(&mut self) {
        self.disconnect();
    }
}
