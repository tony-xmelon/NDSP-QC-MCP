use hidapi::{HidApi, HidDevice};
use prost::Message;
use qc_protocol::commands::{self, OutboundMessage};
use qc_protocol::framing;
use qc_protocol::profile;
use qc_protocol::proto;
use qc_protocol::proto::cortex_protobuf_v2 as pa;
use qc_protocol::session::{FrameAssembler, SessionMachine};
use std::collections::HashMap;
use std::io::Read;
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

pub struct QcUsb {
    _api: HidApi,
    device: HidDevice,
    frames: FrameAssembler,
    next_sequence: u64,
}

impl QcUsb {
    pub fn open() -> Result<Self, UsbError> {
        let api = HidApi::new().map_err(|error| UsbError::Hid(error.to_string()))?;
        let device = api
            .open(profile::VENDOR_ID, profile::PRODUCT_ID)
            .map_err(|_| UsbError::NotAvailable)?;
        Ok(Self {
            _api: api,
            device,
            frames: FrameAssembler::new(),
            next_sequence: 1,
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
            usb.send_command(commands::reset_comms(attempt.number as u64, session_id));
            while session.awaiting_handshake_reply(session_clock.elapsed().as_millis() as u64) {
                if let Some(message) = usb.read_message(200)? {
                    if message.message_type == 52 {
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
        for message in commands::initialization() {
            self.send_command(message);
        }
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
        // RecallPreset can arrive before the smaller scalar subscriptions. A
        // complete app snapshot must not advertise READY with an assumed scene,
        // position, mode, or volume, so explicitly fill any missing seed state
        // before handing the session to the realtime worker.
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
        Ok(ConnectedQc {
            usb: self,
            synchronized,
            message_counts,
            latest_messages,
        })
    }

    pub fn send(&self, message_type: u16, payload: Vec<u8>) {
        for report in framing::encode(message_type, &payload) {
            // QC intentionally stalls the status stage after accepting every
            // HID SET_REPORT. hidapi reports that as a write error, so device
            // loss is established by reads, never by this return value.
            let _ = self.device.write(&report);
        }
    }

    pub fn send_command(&self, message: OutboundMessage) {
        self.send(message.message_type, message.payload);
    }

    pub fn read_message(&mut self, timeout_ms: i32) -> Result<Option<IncomingMessage>, UsbError> {
        let mut report = [0_u8; 1024];
        let read = self
            .device
            .read_timeout(&mut report, timeout_ms)
            .map_err(|error| UsbError::Read(error.to_string()))?;
        if read == 0 {
            return Ok(None);
        }
        let report = report[..read].to_vec();
        let Some((message_type, mut payload)) = self.frames.push(report)? else {
            return Ok(None);
        };
        // ModelRepo is the largest compressed message. Keep its decompression
        // off this permanent USB worker; the metadata worker inflates it only
        // when the catalog is actually consumed.
        if message_type != 51 && payload.starts_with(&[0x1f, 0x8b]) {
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

    pub fn disconnect(&self) {
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
        self.disconnect()
    }
}
