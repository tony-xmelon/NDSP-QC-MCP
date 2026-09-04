//! Platform-neutral decoding for correlated device replies that are not part
//! of the continuous preset-state stream.

use crate::{
    generated_payloads::{
        GeneralSettings, GlobalBypassRows, MasterVolumeAssignment, TunerSettings,
    },
    profile,
    proto::cortex_protobuf_v2 as pa,
};
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
        if self.document.len() > profile::BACKUP_MAXIMUM_DOCUMENT_BYTES {
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

pub fn decode_general_settings(payload: &[u8]) -> Result<GeneralSettings, ResponseDecodeError> {
    let message = pa::GeneralSettingsMessage::decode(payload)?;
    if message.action != pa::message_action::Enum::Update as i32 {
        return Err(ResponseDecodeError::Mismatch(
            "general-settings action is not UPDATE",
        ));
    }
    if message.scene_block_bypass.is_none() {
        return Err(ResponseDecodeError::Incomplete("scene_block_bypass"));
    }
    let rows = |value: pa::GlobalBypassRows| GlobalBypassRows {
        row1: value.row1,
        row2: value.row2,
        row3: value.row3,
        row4: value.row4,
    };
    let hold_timing_index = message
        .hold_timing
        .map(|pa::general_settings_message::HoldTiming::HoldTiming(value)| value);
    Ok(GeneralSettings {
        screen_brightness: message.screen_brightness.map(
            |pa::general_settings_message::ScreenBrightness::ScreenBrightness(value)| value,
        ),
        led_brightness: message
            .led_brightness
            .map(|pa::general_settings_message::LedBrightness::LedBrightness(value)| value),
        dimmed_led_brightness: message.dimmed_led_brightness.map(
            |pa::general_settings_message::DimmedLedBrightness::DimmedLedBrightness(value)| value,
        ),
        lock_screen_and_volume_knob: message.lock_screen_and_volume_knob.map(
            |pa::general_settings_message::LockScreenAndVolumeKnob::LockScreenAndVolumeKnob(
                value,
            )| value,
        ),
        global_bypass_cab: message.global_bypass_cab.map(
            |pa::general_settings_message::GlobalBypassCab::GlobalBypassCab(value)| rows(value),
        ),
        global_bypass_ir: message.global_bypass_ir.map(
            |pa::general_settings_message::GlobalBypassIr::GlobalBypassIr(value)| rows(value),
        ),
        scene_bypass_behavior: message.scene_block_bypass.and_then(
            |pa::general_settings_message::SceneBlockBypass::SceneBlockBypass(value)| match value {
                0 => Some("alwaysOverwrite".to_string()),
                1 => Some("nonstompOverwrite".to_string()),
                2 => Some("neverOverwrite".to_string()),
                _ => None,
            }
        ),
        midi_over_usb: message
            .midi_over_usb
            .map(|pa::general_settings_message::MidiOverUsb::MidiOverUsb(value)| value),
        midi_channel: message
            .midi_channel
            .map(|pa::general_settings_message::MidiChannel::MidiChannel(value)| value),
        ignore_duplicate_pc: message.ignore_duplicate_pc.map(
            |pa::general_settings_message::IgnoreDuplicatePc::IgnoreDuplicatePc(value)| value,
        ),
        available_disk_space: message.available_disk_space.map(
            |pa::general_settings_message::AvailableDiskSpace::AvailableDiskSpace(value)| value,
        ),
        total_disk_space: message.total_disk_space.map(
            |pa::general_settings_message::TotalDiskSpace::TotalDiskSpace(value)| value,
        ),
        internal_midi_clock_enabled: message.internal_midi_clock_enabled.map(
            |pa::general_settings_message::InternalMidiClockEnabled::InternalMidiClockEnabled(
                value,
            )| value,
        ),
        master_volume_assignment: message.master_volume_assignment.map(
            |pa::general_settings_message::MasterVolumeAssignment::MasterVolumeAssignment(value)| {
                MasterVolumeAssignment {
                    out12: value.out12,
                    out34: value.out34,
                    send12: value.send12,
                    headphones: value.headphones,
                }
            },
        ),
        stomp_mode_auto_assign: message.stomp_mode_auto_assign.map(
            |pa::general_settings_message::StompModeAutoAssign::StompModeAutoAssign(value)| value,
        ),
        swap_tempo_tuner_access: message.swap_tempo_tuner_access.map(
            |pa::general_settings_message::SwapTempoTunerAccess::SwapTempoTunerAccess(value)| value,
        ),
        midi_clock_out: message.midi_clock_out.and_then(
            |pa::general_settings_message::MidiClockOut::MidiClockOut(value)| match value {
                0 => Some("off".to_string()),
                1 => Some("midiDinOnly".to_string()),
                2 => Some("usbMidiOnly".to_string()),
                3 => Some("bothUsbAndDinMidi".to_string()),
                _ => None,
            }
        ),
        disable_internet_connection_check: message.disable_internet_connection_check.map(
            |pa::general_settings_message::DisableInternetConnectionCheck::DisableInternetConnectionCheck(value)| value,
        ),
        dynamic_delay_compensation: message.enable_dynamic_delay_compensation.map(
            |pa::general_settings_message::EnableDynamicDelayCompensation::EnableDynamicDelayCompensation(value)| value,
        ),
        preset_dimmed: message.enable_preset_dimmed.map(
            |pa::general_settings_message::EnablePresetDimmed::EnablePresetDimmed(value)| value,
        ),
        scene_dimmed: message.enable_scene_dimmed.map(
            |pa::general_settings_message::EnableSceneDimmed::EnableSceneDimmed(value)| value,
        ),
        stomp_dimmed: message.enable_stomp_dimmed.map(
            |pa::general_settings_message::EnableStompDimmed::EnableStompDimmed(value)| value,
        ),
        midi_clock_in: message.midi_clock_in_enabled.map(
            |pa::general_settings_message::MidiClockInEnabled::MidiClockInEnabled(value)| value,
        ),
        gig_view_stomp_access: message.gig_view_stomp_access_enabled.map(
            |pa::general_settings_message::GigViewStompAccessEnabled::GigViewStompAccessEnabled(
                value,
            )| value,
        ),
        hold_timing_index,
        hold_timing_ms: hold_timing_index
            .filter(|value| (0..=5).contains(value))
            .map(|value| 500 + 100 * value),
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
    fn general_settings_preserve_sparse_presence_and_derive_hold_milliseconds() {
        let payload = pa::GeneralSettingsMessage {
            action: pa::message_action::Enum::Update as i32,
            screen_brightness: Some(
                pa::general_settings_message::ScreenBrightness::ScreenBrightness(59),
            ),
            scene_block_bypass: Some(
                pa::general_settings_message::SceneBlockBypass::SceneBlockBypass(1),
            ),
            hold_timing: Some(pa::general_settings_message::HoldTiming::HoldTiming(3)),
            master_volume_assignment: Some(
                pa::general_settings_message::MasterVolumeAssignment::MasterVolumeAssignment(
                    pa::MasterVolumeAssignmentOptions {
                        out12: true,
                        out34: false,
                        send12: true,
                        headphones: false,
                    },
                ),
            ),
            ..Default::default()
        }
        .encode_to_vec();
        let settings = decode_general_settings(&payload).unwrap();
        assert_eq!(settings.screen_brightness, Some(59));
        assert_eq!(settings.led_brightness, None);
        assert_eq!(
            settings.scene_bypass_behavior.as_deref(),
            Some("nonstompOverwrite")
        );
        assert_eq!(settings.hold_timing_index, Some(3));
        assert_eq!(settings.hold_timing_ms, Some(800));
        assert!(settings.master_volume_assignment.unwrap().send12);
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
