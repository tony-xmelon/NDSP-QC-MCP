//! Platform-neutral decoding for correlated device replies that are not part
//! of the continuous preset-state stream.

use crate::generated_payloads::{
    ExpressionPortSettings, GeneralSettings, GlobalBypassRows, GlobalEqParameter, GlobalEqSettings,
    HeadphonesFeed, HeadphonesSettings, InputPortSettings, IoSettings, LooperStatus,
    MasterVolumeAssignment, MidiPortSettings, ModeCycle, OutputPortSettings, TunerSettings,
    UsbPortSettings,
};
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

pub fn decode_io_settings(payload: &[u8]) -> Result<IoSettings, ResponseDecodeError> {
    let message = pa::IoSettingsMessage::decode(payload)?;
    if message.action != pa::message_action::Enum::Update as i32 {
        return Err(ResponseDecodeError::Mismatch(
            "I/O settings action is not UPDATE",
        ));
    }
    let settings = message
        .settings
        .map(|pa::io_settings_message::Settings::Settings(value)| value)
        .ok_or(ResponseDecodeError::Incomplete("I/O settings"))?;
    if settings.in_port.is_empty() {
        return Err(ResponseDecodeError::Incomplete("input ports"));
    }

    let inputs = settings
        .in_port
        .into_iter()
        .map(|port| {
            let level = port
                .level
                .map(|pa::input_port_settings::Level::Level(value)| value);
            InputPortSettings {
                input_port_id: port.input_port_id,
                level,
                level_db: level.map(|value| -12.0 + 72.0 * value),
                impedance: port
                    .input_zmode
                    .map(|pa::input_port_settings::InputZmode::InputZmode(value)| value),
                input_type: port
                    .input_type
                    .map(|pa::input_port_settings::InputType::InputType(value)| value),
                ground_lift: port
                    .ground_lift
                    .map(|pa::input_port_settings::GroundLift::GroundLift(value)| value),
                plugged: port
                    .plugged
                    .map(|pa::input_port_settings::Plugged::Plugged(value)| value),
            }
        })
        .collect();
    let outputs = settings
        .out_port
        .into_iter()
        .map(|port| OutputPortSettings {
            output_port_id: port.output_port_id,
            level: port
                .level
                .map(|pa::output_port_settings::Level::Level(value)| value),
            ground_lift: port
                .ground_lift
                .map(|pa::output_port_settings::GroundLift::GroundLift(value)| value),
            muted: port
                .mute
                .map(|pa::output_port_settings::Mute::Mute(value)| value),
            plugged: port
                .plugged
                .map(|pa::output_port_settings::Plugged::Plugged(value)| value),
        })
        .collect();
    let expression_ports = settings
        .exp_port
        .into_iter()
        .map(|port| ExpressionPortSettings {
            expression_port_id: port.exp_port_id,
            plugged: port
                .plugged
                .map(|pa::exp_port_settings::Plugged::Plugged(value)| value),
            level: port
                .level
                .map(|pa::exp_port_settings::Level::Level(value)| value),
            calibrating: port
                .calibrating
                .map(|pa::exp_port_settings::Calibrating::Calibrating(value)| value),
        })
        .collect();
    let headphones =
        settings.hp_port.map(
            |pa::port_settings::HpPort::HpPort(port)| HeadphonesSettings {
                feeds: port
                    .hp_feed
                    .into_iter()
                    .map(|feed| HeadphonesFeed {
                        output_port_id: feed.output_port_id,
                        level: feed.level,
                    })
                    .collect(),
                level: port
                    .level
                    .map(|pa::headphones_settings::Level::Level(value)| value),
                plugged: port
                    .plugged
                    .map(|pa::headphones_settings::Plugged::Plugged(value)| value),
            },
        );
    let usb = settings.usb_port.map(
        |pa::port_settings::UsbPort::UsbPort(port)| UsbPortSettings {
            level: port
                .level
                .map(|pa::usb_port_settings::Level::Level(value)| value),
            headphones_source: port
                .hp_select
                .map(|pa::usb_port_settings::HpSelect::HpSelect(value)| value),
            plugged: port
                .plugged
                .map(|pa::usb_port_settings::Plugged::Plugged(value)| value),
            dry_wet: port
                .dry_wet
                .map(|pa::usb_port_settings::DryWet::DryWet(value)| value),
        },
    );
    let midi =
        settings.midi_port.map(
            |pa::port_settings::MidiPort::MidiPort(port)| MidiPortSettings {
                thru: port
                    .midi_thru
                    .map(|pa::midi_port_settings::MidiThru::MidiThru(value)| value),
            },
        );

    Ok(IoSettings {
        inputs,
        outputs,
        expression_ports,
        headphones,
        usb,
        midi,
        xlr12_linked: message
            .xlr1_2_linked
            .map(|pa::io_settings_message::Xlr12Linked::Xlr12Linked(value)| value),
        out34_linked: message
            .out3_4_linked
            .map(|pa::io_settings_message::Out34Linked::Out34Linked(value)| value),
    })
}

pub fn decode_global_eq(payload: &[u8]) -> Result<GlobalEqSettings, ResponseDecodeError> {
    let message = pa::GlobalEqMessage::decode(payload)?;
    if message.action != pa::message_action::Enum::Update as i32 {
        return Err(ResponseDecodeError::Mismatch(
            "Global EQ action is not UPDATE",
        ));
    }
    Ok(GlobalEqSettings {
        parameters: message
            .parameters
            .into_iter()
            .map(|parameter| GlobalEqParameter {
                parameter_index: parameter.parameter_index,
                value: parameter.value,
            })
            .collect(),
        bypassed: message
            .bypassed
            .map(|pa::global_eq_message::Bypassed::Bypassed(value)| value),
        has_user_defaults: message
            .has_user_defaults
            .map(|pa::global_eq_message::HasUserDefaults::HasUserDefaults(value)| value),
    })
}

pub fn decode_mode_cycle(payload: &[u8]) -> Result<ModeCycle, ResponseDecodeError> {
    let message = pa::ModeMessage::decode(payload)?;
    if message.action != pa::message_action::Enum::Update as i32 {
        return Err(ResponseDecodeError::Mismatch("mode action is not UPDATE"));
    }
    let slots = message
        .available_modes
        .map(|pa::mode_message::AvailableModes::AvailableModes(value)| value.modes)
        .filter(|values| !values.is_empty())
        .ok_or(ResponseDecodeError::Incomplete("mode cycle"))?;
    Ok(ModeCycle { slots })
}

pub fn decode_looper_status(payload: &[u8]) -> Result<LooperStatus, ResponseDecodeError> {
    let message = pa::LooperMessage::decode(payload)?;
    if message.action != pa::message_action::Enum::Update as i32 {
        return Err(ResponseDecodeError::Mismatch("looper action is not UPDATE"));
    }
    let status = message
        .status
        .map(|pa::looper_message::Status::Status(value)| value)
        .ok_or(ResponseDecodeError::Incomplete("looper status"))?;
    Ok(LooperStatus {
        state: Some(status.state),
        progress: Some(status.progress),
        undo_progress: Some(status.undo_progress),
        duplicate_cycle: Some(status.duplicate_cycle),
        num_duplicate_cycles: Some(status.num_duplicate_cycles),
        one_shot_stopped: Some(status.one_shot_stopped),
        redo_available: Some(status.redo_available),
        loop_length: Some(status.loop_length),
        free_samples: Some(status.free_samples),
        in_reverse: Some(status.in_reverse),
        one_shot: Some(status.one_shot),
        half_speed: Some(status.half_speed),
        fixed_duplicate_cycles: Some(status.fixed_duplicate_cycles),
        armed: Some(status.armed),
        waiting_for_cycle: Some(status.waiting_for_cycle),
        undo_count: Some(status.undo_count),
        max_write_displacement: Some(status.max_write_displacement),
        min_write_displacement: Some(status.min_write_displacement),
        events_waiting_for_quantize: Some(status.events_waiting_for_quantize),
        current_clock: Some(status.current_clock),
        transition: Some(status.transition),
        action: Some(status.action),
        one_shot_play: message
            .one_shot_play
            .map(|pa::looper_message::OneShotPlay::OneShotPlay(value)| value),
        sync_start_waiting: message
            .sync_start_waiting
            .map(|pa::looper_message::SyncStartWaiting::SyncStartWaiting(value)| value),
        quantize_enabled: message
            .quantize_enabled
            .map(|pa::looper_message::QuantizeEnabled::QuantizeEnabled(value)| value),
        update_type: message
            .update_type
            .map(|pa::looper_message::UpdateType::UpdateType(value)| value),
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
        assert_eq!(settings.master_volume_assignment.unwrap().send12, true);
    }

    #[test]
    fn io_settings_preserve_every_sparse_port_field() {
        let payload = pa::IoSettingsMessage {
            action: pa::message_action::Enum::Update as i32,
            settings: Some(pa::io_settings_message::Settings::Settings(
                pa::PortSettings {
                    in_port: vec![pa::InputPortSettings {
                        input_port_id: 1,
                        level: Some(pa::input_port_settings::Level::Level(0.5)),
                        input_zmode: Some(pa::input_port_settings::InputZmode::InputZmode(0.75)),
                        plugged: Some(pa::input_port_settings::Plugged::Plugged(true)),
                        ..Default::default()
                    }],
                    out_port: vec![pa::OutputPortSettings {
                        output_port_id: 4,
                        mute: Some(pa::output_port_settings::Mute::Mute(true)),
                        ..Default::default()
                    }],
                    hp_port: Some(pa::port_settings::HpPort::HpPort(pa::HeadphonesSettings {
                        hp_feed: vec![pa::HeadphonesFeedLevel {
                            level: 0.25,
                            output_port_id: 4,
                        }],
                        level: Some(pa::headphones_settings::Level::Level(0.6)),
                        plugged: Some(pa::headphones_settings::Plugged::Plugged(true)),
                    })),
                    usb_port: Some(pa::port_settings::UsbPort::UsbPort(pa::UsbPortSettings {
                        hp_select: Some(pa::usb_port_settings::HpSelect::HpSelect(0.5)),
                        dry_wet: Some(pa::usb_port_settings::DryWet::DryWet(1.0)),
                        ..Default::default()
                    })),
                    midi_port: Some(pa::port_settings::MidiPort::MidiPort(
                        pa::MidiPortSettings {
                            midi_thru: Some(pa::midi_port_settings::MidiThru::MidiThru(1.0)),
                        },
                    )),
                    exp_port: vec![pa::ExpPortSettings {
                        exp_port_id: 0,
                        level: Some(pa::exp_port_settings::Level::Level(0.33)),
                        calibrating: Some(pa::exp_port_settings::Calibrating::Calibrating(false)),
                        ..Default::default()
                    }],
                },
            )),
            xlr1_2_linked: Some(pa::io_settings_message::Xlr12Linked::Xlr12Linked(true)),
            out3_4_linked: Some(pa::io_settings_message::Out34Linked::Out34Linked(false)),
            ..Default::default()
        }
        .encode_to_vec();

        let settings = decode_io_settings(&payload).unwrap();
        assert_eq!(settings.inputs[0].input_port_id, 1);
        assert_eq!(settings.inputs[0].level, Some(0.5));
        assert_eq!(settings.inputs[0].impedance, Some(0.75));
        assert_eq!(settings.inputs[0].plugged, Some(true));
        assert_eq!(settings.outputs[0].muted, Some(true));
        assert_eq!(
            settings.headphones.as_ref().unwrap().feeds[0].output_port_id,
            4
        );
        assert_eq!(settings.usb.as_ref().unwrap().dry_wet, Some(1.0));
        assert_eq!(settings.midi.as_ref().unwrap().thru, Some(1.0));
        assert_eq!(settings.expression_ports[0].level, Some(0.33));
        assert_eq!(settings.xlr12_linked, Some(true));
        assert_eq!(settings.out34_linked, Some(false));

        let incomplete = pa::IoSettingsMessage {
            action: pa::message_action::Enum::Update as i32,
            settings: Some(pa::io_settings_message::Settings::Settings(
                pa::PortSettings::default(),
            )),
            ..Default::default()
        }
        .encode_to_vec();
        assert!(matches!(
            decode_io_settings(&incomplete),
            Err(ResponseDecodeError::Incomplete("input ports"))
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

    #[test]
    fn global_eq_mode_cycle_and_looper_reads_preserve_device_state() {
        let eq = pa::GlobalEqMessage {
            action: pa::message_action::Enum::Update as i32,
            parameters: vec![pa::GlobalEqParameter {
                parameter_index: 6,
                value: 0.75,
            }],
            bypassed: Some(pa::global_eq_message::Bypassed::Bypassed(false)),
            has_user_defaults: Some(pa::global_eq_message::HasUserDefaults::HasUserDefaults(
                true,
            )),
            ..Default::default()
        }
        .encode_to_vec();
        let eq = decode_global_eq(&eq).unwrap();
        assert_eq!(eq.parameters[0].parameter_index, 6);
        assert_eq!(eq.parameters[0].value, 0.75);
        assert_eq!(eq.bypassed, Some(false));

        let modes = pa::ModeMessage {
            action: pa::message_action::Enum::Update as i32,
            available_modes: Some(pa::mode_message::AvailableModes::AvailableModes(
                pa::AvailableModes {
                    modes: vec![7, 1, 2],
                },
            )),
            ..Default::default()
        }
        .encode_to_vec();
        assert_eq!(decode_mode_cycle(&modes).unwrap().slots, vec![7, 1, 2]);

        let looper = pa::LooperMessage {
            action: pa::message_action::Enum::Update as i32,
            status: Some(pa::looper_message::Status::Status(pa::LooperStatus {
                state: 3,
                progress: 0.5,
                in_reverse: 1,
                undo_count: 2,
                ..Default::default()
            })),
            one_shot_play: Some(pa::looper_message::OneShotPlay::OneShotPlay(true)),
            quantize_enabled: Some(pa::looper_message::QuantizeEnabled::QuantizeEnabled(false)),
            ..Default::default()
        }
        .encode_to_vec();
        let looper = decode_looper_status(&looper).unwrap();
        assert_eq!(looper.state, Some(3));
        assert_eq!(looper.progress, Some(0.5));
        assert_eq!(looper.in_reverse, Some(1));
        assert_eq!(looper.one_shot_play, Some(true));
    }
}
