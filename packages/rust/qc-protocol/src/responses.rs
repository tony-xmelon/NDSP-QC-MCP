//! Platform-neutral decoding for correlated device replies that are not part
//! of the continuous preset-state stream.

use crate::generated_payloads::TunerSettings;
use crate::proto::cortex_protobuf_v2 as pa;
use prost::Message;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ResponseDecodeError {
    #[error("QC protobuf reply could not be decoded: {0}")]
    Protobuf(#[from] prost::DecodeError),
    #[error("the QC reply is incomplete: {0}")]
    Incomplete(&'static str),
    #[error("the QC reply does not match the request: {0}")]
    Mismatch(&'static str),
    #[error("the QC response is not a PNG image")]
    InvalidPng,
    #[error("the QC backup exceeded the 32 MiB safety limit")]
    OversizedBackup,
    #[error("the QC backup stream ended with an incomplete or unsupported document")]
    InvalidBackupDocument,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub serial: String,
    pub app_fw_version: Option<String>,
    pub custom_name: Option<String>,
    pub device_type: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InhibitedModules {
    pub global_gate: bool,
    pub global_eq: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PngImage {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoClock {
    pub current_beat: u32,
    pub current_bar: u32,
    pub current_tick: u32,
}

#[derive(Debug, Default)]
pub struct BackupAssembler {
    document: String,
    started: bool,
    chunks: usize,
    ignored_prefix_chunks: usize,
    ignored_prefix_terminators: usize,
}

impl BackupAssembler {
    pub fn reset(&mut self) {
        self.document.clear();
        self.started = false;
        self.chunks = 0;
        self.ignored_prefix_chunks = 0;
        self.ignored_prefix_terminators = 0;
    }

    pub fn started(&self) -> bool {
        self.started
    }

    pub fn chunks(&self) -> usize {
        self.chunks
    }

    pub fn ignored_prefix_chunks(&self) -> usize {
        self.ignored_prefix_chunks
    }

    pub fn ignored_prefix_terminators(&self) -> usize {
        self.ignored_prefix_terminators
    }

    pub fn push(&mut self, payload: &[u8]) -> Result<Option<String>, ResponseDecodeError> {
        let message = pa::LocalBackupMessage::decode(payload)?;
        let terminal = matches!(
            message.is_last_chunk,
            Some(pa::local_backup_message::IsLastChunk::IsLastChunk(true))
        );
        let chunk = match message.backup_json {
            Some(pa::local_backup_message::BackupJson::BackupJson(chunk)) => chunk,
            None => String::new(),
        };

        if !self.started {
            // Current QC firmware does not echo request_id on LocalBackup
            // replies. A new client can therefore inherit the tail of a
            // transfer started by an earlier session. Synchronize only at a
            // JSON document boundary and ignore every preceding fragment or
            // terminator.
            if !chunk.trim_start().starts_with('{') {
                if !chunk.is_empty() || terminal {
                    self.ignored_prefix_chunks += 1;
                }
                if terminal {
                    self.ignored_prefix_terminators += 1;
                }
                return Ok(None);
            }
            self.started = true;
        }

        self.chunks += 1;
        self.document.push_str(&chunk);
        if self.document.len() > 32 * 1024 * 1024 {
            self.reset();
            return Err(ResponseDecodeError::OversizedBackup);
        }

        if terminal {
            let valid = serde_json::from_str::<serde_json::Value>(&self.document)
                .ok()
                .is_some_and(|document| {
                    document.get("type").and_then(serde_json::Value::as_str) == Some("backup")
                        && document.get("creator").and_then(serde_json::Value::as_str)
                            == Some("quad")
                });
            if !valid {
                self.reset();
                return Err(ResponseDecodeError::InvalidBackupDocument);
            }
            let complete = std::mem::take(&mut self.document);
            self.started = false;
            self.chunks = 0;
            return Ok(Some(complete));
        }
        Ok(None)
    }
}

pub fn decode_tempo_clock(payload: &[u8]) -> Result<Option<TempoClock>, ResponseDecodeError> {
    let message = pa::GlobalTempoMessage::decode(payload)?;
    let Some(pa::global_tempo_message::MetronomeStatus::MetronomeStatus(status)) =
        message.metronome_status
    else {
        return Ok(None);
    };
    Ok(Some(TempoClock {
        current_beat: status.current_beat,
        current_bar: status.current_bar,
        current_tick: status.current_tick,
    }))
}

pub fn decode_device_identity(payload: &[u8]) -> Result<DeviceIdentity, ResponseDecodeError> {
    let message = pa::VersionMessage::decode(payload)?;
    if message.action != pa::message_action::Enum::Update as i32 {
        return Err(ResponseDecodeError::Mismatch(
            "identity action is not UPDATE",
        ));
    }
    let serial = match message.device_serial_number {
        Some(pa::version_message::DeviceSerialNumber::DeviceSerialNumber(value)) => value,
        None => return Err(ResponseDecodeError::Incomplete("device serial number")),
    };
    let app_fw_version = message
        .app_fw_version
        .map(|pa::version_message::AppFwVersion::AppFwVersion(value)| value);
    let custom_name = message
        .custom_name
        .map(|pa::version_message::CustomName::CustomName(value)| value);
    let device_type = message.device_type.map(|value| match value {
        pa::version_message::DeviceTypeOneOf::DeviceType(value) => value,
    });
    Ok(DeviceIdentity {
        serial,
        app_fw_version,
        custom_name,
        device_type,
    })
}

pub fn decode_tuner_settings(payload: &[u8]) -> Result<TunerSettings, ResponseDecodeError> {
    let message = pa::TunerMessage::decode(payload)?;
    if message.action != pa::message_action::Enum::Update as i32 {
        return Err(ResponseDecodeError::Mismatch("tuner action is not UPDATE"));
    }
    let input_port_id = message
        .input_port_id
        .map(|pa::tuner_message::InputPortId::InputPortId(value)| value)
        .ok_or(ResponseDecodeError::Incomplete("tuner input_port_id"))?;
    let reference_offset_hz = message
        .frequency
        .map(|pa::tuner_message::Frequency::Frequency(value)| value)
        .ok_or(ResponseDecodeError::Incomplete("tuner frequency"))?;
    let muted = message
        .mute
        .map(|pa::tuner_message::Mute::Mute(value)| value)
        .ok_or(ResponseDecodeError::Incomplete("tuner mute"))?;
    Ok(TunerSettings {
        input_port_id,
        reference_offset_hz,
        reference_hz: 440.0 + reference_offset_hz,
        muted,
    })
}

pub fn decode_inhibited_modules(payload: &[u8]) -> Result<InhibitedModules, ResponseDecodeError> {
    let message = pa::CompilerInhibitedModulesMessage::decode(payload)?;
    if message.action != pa::message_action::Enum::Update as i32 {
        return Err(ResponseDecodeError::Mismatch(
            "inhibited-modules action is not UPDATE",
        ));
    }
    let global_gate = match message.global_gate {
        Some(pa::compiler_inhibited_modules_message::GlobalGate::GlobalGate(value)) => value,
        None => return Err(ResponseDecodeError::Incomplete("global_gate")),
    };
    let global_eq = match message.global_eq {
        Some(pa::compiler_inhibited_modules_message::GlobalEq::GlobalEq(value)) => value,
        None => return Err(ResponseDecodeError::Incomplete("global_eq")),
    };
    Ok(InhibitedModules {
        global_gate,
        global_eq,
    })
}

fn png_image(bytes: Vec<u8>) -> Result<PngImage, ResponseDecodeError> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || !bytes.starts_with(SIGNATURE) || &bytes[12..16] != b"IHDR" {
        return Err(ResponseDecodeError::InvalidPng);
    }
    Ok(PngImage {
        width: u32::from_be_bytes(bytes[16..20].try_into().expect("four width bytes")),
        height: u32::from_be_bytes(bytes[20..24].try_into().expect("four height bytes")),
        bytes,
    })
}

pub fn decode_preset_screenshot(
    payload: &[u8],
    expected_request_id: u64,
    folder_name: &str,
    position: u32,
    is_factory: bool,
) -> Result<PngImage, ResponseDecodeError> {
    let message = pa::ScreenshotMessage::decode(payload)?;
    let request_id = match message.request_id {
        Some(pa::screenshot_message::RequestId::RequestId(value)) => value,
        None => return Err(ResponseDecodeError::Incomplete("request id")),
    };
    if request_id != expected_request_id
        || message.folder_name != folder_name
        || message.index != position as i32
        || message.is_factory != is_factory
    {
        return Err(ResponseDecodeError::Mismatch("preset screenshot target"));
    }
    let bytes = match message.png {
        Some(pa::screenshot_message::Png::Png(value)) => value,
        None => return Err(ResponseDecodeError::Incomplete("PNG payload")),
    };
    png_image(bytes)
}

pub fn decode_captured_screen(payload: &[u8]) -> Result<PngImage, ResponseDecodeError> {
    let message = pa::RemoteControlMessage::decode(payload)?;
    if message.action != pa::message_action::Enum::Update as i32 {
        return Err(ResponseDecodeError::Mismatch("screen action is not UPDATE"));
    }
    let bytes = message
        .screenshot
        .and_then(|value| value.payload)
        .ok_or(ResponseDecodeError::Incomplete("screen PNG payload"))?;
    png_image(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tuner_settings_are_complete_and_expose_absolute_reference() {
        let payload = pa::TunerMessage {
            action: pa::message_action::Enum::Update as i32,
            input_port_id: Some(pa::tuner_message::InputPortId::InputPortId(5)),
            frequency: Some(pa::tuner_message::Frequency::Frequency(2.0)),
            mute: Some(pa::tuner_message::Mute::Mute(true)),
            ..Default::default()
        }
        .encode_to_vec();
        let settings = decode_tuner_settings(&payload).unwrap();
        assert_eq!(settings.input_port_id, 5);
        assert_eq!(settings.reference_offset_hz, 2.0);
        assert_eq!(settings.reference_hz, 442.0);
        assert!(settings.muted);

        let incomplete = pa::TunerMessage {
            action: pa::message_action::Enum::Update as i32,
            input_port_id: Some(pa::tuner_message::InputPortId::InputPortId(5)),
            ..Default::default()
        }
        .encode_to_vec();
        assert!(matches!(
            decode_tuner_settings(&incomplete),
            Err(ResponseDecodeError::Incomplete(_))
        ));
    }

    #[test]
    fn rejects_non_png_screen_payloads() {
        let payload = pa::RemoteControlMessage {
            action: pa::message_action::Enum::Update as i32,
            screenshot: Some(pa::RemoteControlScreenshot {
                payload: Some(vec![1, 2, 3]),
                ..Default::default()
            }),
            ..Default::default()
        }
        .encode_to_vec();
        assert!(matches!(
            decode_captured_screen(&payload),
            Err(ResponseDecodeError::InvalidPng)
        ));
    }

    #[test]
    fn png_dimensions_come_from_the_shared_ihdr_projection() {
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        png.extend_from_slice(&800_u32.to_be_bytes());
        png.extend_from_slice(&480_u32.to_be_bytes());
        let image = png_image(png).unwrap();
        assert_eq!((image.width, image.height), (800, 480));
        assert!(png_image(b"not an image".to_vec()).is_err());
    }

    #[test]
    fn tempo_clock_and_chunked_backup_are_projected_once_for_every_host() {
        let tempo = pa::GlobalTempoMessage {
            metronome_status: Some(pa::global_tempo_message::MetronomeStatus::MetronomeStatus(
                pa::MetronomeStatusUpdate {
                    current_beat: 2,
                    current_bar: 3,
                    current_tick: 4,
                    ..Default::default()
                },
            )),
            ..Default::default()
        }
        .encode_to_vec();
        assert_eq!(
            decode_tempo_clock(&tempo).unwrap(),
            Some(TempoClock {
                current_beat: 2,
                current_bar: 3,
                current_tick: 4
            })
        );

        let mut backup = BackupAssembler::default();
        let first = pa::LocalBackupMessage {
            backup_json: Some(pa::local_backup_message::BackupJson::BackupJson(
                "{\"type\":\"backup\",".into(),
            )),
            ..Default::default()
        }
        .encode_to_vec();
        let last = pa::LocalBackupMessage {
            backup_json: Some(pa::local_backup_message::BackupJson::BackupJson(
                "\"creator\":\"quad\"}".into(),
            )),
            is_last_chunk: Some(pa::local_backup_message::IsLastChunk::IsLastChunk(true)),
            ..Default::default()
        }
        .encode_to_vec();
        assert_eq!(backup.push(&first).unwrap(), None);
        assert_eq!(
            backup.push(&last).unwrap().as_deref(),
            Some("{\"type\":\"backup\",\"creator\":\"quad\"}")
        );

        let stale_tail = pa::LocalBackupMessage {
            backup_json: Some(pa::local_backup_message::BackupJson::BackupJson(
                "old-tail".into(),
            )),
            is_last_chunk: Some(pa::local_backup_message::IsLastChunk::IsLastChunk(true)),
            ..Default::default()
        }
        .encode_to_vec();
        assert_eq!(backup.push(&stale_tail).unwrap(), None);
        assert_eq!(backup.push(&first).unwrap(), None);
        assert_eq!(
            backup.push(&last).unwrap().as_deref(),
            Some("{\"type\":\"backup\",\"creator\":\"quad\"}")
        );
    }

    #[test]
    fn backup_ignores_an_uncorrelated_stale_tail_before_the_next_document() {
        let stale_tail = pa::LocalBackupMessage {
            backup_json: Some(pa::local_backup_message::BackupJson::BackupJson(
                "end-of-an-older-document".into(),
            )),
            is_last_chunk: Some(pa::local_backup_message::IsLastChunk::IsLastChunk(true)),
            ..Default::default()
        }
        .encode_to_vec();
        let valid = pa::LocalBackupMessage {
            backup_json: Some(pa::local_backup_message::BackupJson::BackupJson(
                "{\"type\":\"backup\",\"creator\":\"quad\"}".into(),
            )),
            is_last_chunk: Some(pa::local_backup_message::IsLastChunk::IsLastChunk(true)),
            ..Default::default()
        }
        .encode_to_vec();

        let mut backup = BackupAssembler::default();
        assert_eq!(backup.push(&stale_tail).unwrap(), None);
        assert!(!backup.started());
        assert_eq!(backup.ignored_prefix_chunks(), 1);
        assert_eq!(backup.ignored_prefix_terminators(), 1);
        assert_eq!(
            backup.push(&valid).unwrap().as_deref(),
            Some("{\"type\":\"backup\",\"creator\":\"quad\"}")
        );
    }

    #[test]
    fn backup_rejects_a_partial_document_instead_of_splicing_a_retry() {
        let first = pa::LocalBackupMessage {
            backup_json: Some(pa::local_backup_message::BackupJson::BackupJson(
                "{\"type\":\"backup\",".into(),
            )),
            ..Default::default()
        }
        .encode_to_vec();
        let broken_last = pa::LocalBackupMessage {
            backup_json: Some(pa::local_backup_message::BackupJson::BackupJson(
                "not-json".into(),
            )),
            is_last_chunk: Some(pa::local_backup_message::IsLastChunk::IsLastChunk(true)),
            ..Default::default()
        }
        .encode_to_vec();

        let mut backup = BackupAssembler::default();
        assert_eq!(backup.push(&first).unwrap(), None);
        assert_eq!(
            backup.push(&broken_last).unwrap_err().to_string(),
            "the QC backup stream ended with an incomplete or unsupported document"
        );
        assert!(!backup.started());
    }
}
