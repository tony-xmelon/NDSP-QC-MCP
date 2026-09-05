//! Typed outbound Quad Cortex protocol messages shared by native hosts.
//!
//! Hosts own USB/MIDI handles and scheduling. This module owns message types,
//! protobuf shape, initialization order, and value normalization so Android and
//! Windows never hand-assemble the same wire command independently.

use crate::generated_payloads::MidiOutMessage;
use crate::proto::cortex_protobuf_v2 as pa;
use crate::proto::{
    bypass, chain, col_bypass, model, param, param_value, BinaryPreset, Bypass, Chain, ColBypass,
    Model, Param, ParamValue, SceneBypass, SplitControlPoints, StompModeAssignment,
};
use crate::{domain, profile};
use prost::Message;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CommandEncodeError {
    #[error("unsupported {field}: {value}")]
    UnsupportedValue { field: &'static str, value: String },
    #[error("{field} must fit in a signed 32-bit protobuf field")]
    SignedFieldOverflow { field: &'static str },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundMessage {
    pub message_type: u16,
    pub payload: Vec<u8>,
}

impl OutboundMessage {
    fn encoded<M: Message>(message_type: u16, message: M) -> Self {
        Self {
            message_type,
            payload: message.encode_to_vec(),
        }
    }

    fn action(message_type: u16, action: pa::message_action::Enum) -> Self {
        Self {
            message_type,
            payload: vec![0x08, action as u8],
        }
    }
}

/// Intent-level live device operations supported by every native host.
/// Platform adapters parse host arguments and schedule USB writes; this enum
/// keeps operation-to-wire selection in the protocol crate.
#[derive(Debug, Clone, PartialEq)]
pub enum DeviceCommand {
    SelectScene(u32),
    SetBypass {
        row: u32,
        column: u32,
        bypassed: bool,
    },
    SetParameterNumeric {
        row: u32,
        column: u32,
        parameter_index: u32,
        value: f32,
    },
    SetParameterText {
        row: u32,
        column: u32,
        parameter_index: u32,
        value: String,
    },
    ShowTuner(bool),
    ShowGigView(bool),
    SetlistPosition {
        setlist_key: String,
        position: u32,
        is_factory: bool,
    },
    SetTempo(u32),
    SetMasterVolume(f32),
    Disconnect,
}

/// Higher-level mutations shared by every native host. Operations may expand
/// to several ordered messages.
#[derive(Debug, Clone, PartialEq)]
pub enum DeviceOperation {
    Command(DeviceCommand),
    AddBlock {
        row: u32,
        column: u32,
        model_id: u32,
    },
    RemoveBlock {
        row: u32,
        column: u32,
    },
    MoveBlock {
        from_row: u32,
        from_column: u32,
        to_row: u32,
        to_column: u32,
    },
    SetFootswitch {
        row: u32,
        column: u32,
        footswitch: Option<u32>,
    },
    SetChainInput {
        row: u32,
        input_id: u32,
    },
    SetChainOutput {
        row: u32,
        output_id: u32,
    },
    SetChainSplit {
        row: u32,
        split_column: Option<i32>,
        mix_column: Option<i32>,
    },
    SetSplitMute {
        row: u32,
        muted: bool,
    },
    SetRoutingParameter {
        row: u32,
        node: String,
        parameter_index: u32,
        value: f32,
    },
    SetLaneControlParameter {
        row: u32,
        control: String,
        parameter_index: u32,
        value: f32,
    },
    SetLaneControlSceneMode {
        row: u32,
        control: String,
        parameter_index: u32,
        enabled: bool,
    },
    ListPresetFolders,
    SavePreset {
        setlist_key: String,
        position: u32,
        name: String,
        instrument: i32,
    },
    ReadVersion,
    ReadTuner,
    SetTunerInput(i32),
    SetTunerMute(bool),
    SetTunerReference(f32),
    ReadGeneralSettings,
    SetGeneralInteger {
        setting: String,
        value: i32,
    },
    SetGeneralToggle {
        setting: String,
        enabled: bool,
    },
    SetSceneBypassBehavior(i32),
    SetMasterVolumeAssignment {
        out12: bool,
        out34: bool,
        send12: bool,
        headphones: bool,
    },
    SetGlobalBypass {
        cab: [bool; 4],
        ir: [bool; 4],
    },
    ReadIoSettings,
    ReadGlobalEq,
    SetGlobalEqBypassed(bool),
    SetGlobalEqParameters(Vec<(i32, f32)>),
    ReadModeCycle,
    SetModeCycle(Vec<u32>),
    ReadGlobalTempo,
    SetTempoParameters(Vec<(u32, f32)>),
    SetTempoMode(bool),
    ReadLooperStatus,
    ReadRecentsFavorites {
        favorites: bool,
        request_id: u64,
    },
    SetFavorite {
        name: String,
        folder_key: String,
        folder_name: String,
        is_factory: bool,
        favorite: bool,
    },
    ReadPinnedModels,
    SetModelPinned {
        model_id: u32,
        pinned: bool,
    },
    ReadLibraryFiles {
        folder_key: String,
        file_type: i32,
        request_id: u64,
    },
    CreateSetlist {
        name: String,
    },
    DeleteSetlist {
        name: String,
    },
    DeletePreset {
        setlist_key: String,
        name: String,
    },
    MovePreset {
        setlist_key: String,
        name: String,
        position: u32,
    },
    LoadCapture {
        row: u32,
        column: u32,
        key: String,
        name: String,
        model_id: Option<u32>,
    },
    LoadIr {
        row: u32,
        column: u32,
        key: String,
        name: String,
        slot: u32,
        model_id: Option<u32>,
    },
    SetInputPort {
        input_port_id: u32,
        level: Option<f32>,
        impedance: Option<f32>,
        input_type: Option<f32>,
        ground_lift: Option<f32>,
    },
    SetOutputPort {
        output_port_id: u32,
        level: Option<f32>,
        ground_lift: Option<f32>,
        mute: Option<bool>,
    },
    SetUsbPort {
        level: Option<f32>,
        headphones_source: Option<f32>,
        dry_wet: Option<f32>,
    },
    SetMidiThru(bool),
    SetOutputPairing {
        xlr12_linked: Option<bool>,
        out34_linked: Option<bool>,
    },
    SetDeviceName(String),
    Undo,
    Redo,
    ReadInhibitedModules,
    PresetScreenshot {
        folder_name: String,
        position: u32,
        is_factory: bool,
        request_id: u64,
    },
    CaptureScreen,
    ScreenTap {
        x: f32,
        y: f32,
    },
    CopyScene {
        from_index: u32,
        to_index: u32,
        swap: bool,
    },
    SetSceneLabel {
        scene: u32,
        label: Option<String>,
    },
    SetSceneColor {
        scene: u32,
        color: u32,
    },
    SetParameterSceneMode {
        row: u32,
        column: u32,
        parameter_index: u32,
        enabled: bool,
    },
    SetParameterExpression {
        row: u32,
        column: u32,
        parameter_index: u32,
        pedal: u32,
        minimum: f32,
        maximum: f32,
    },
    SetStompMomentary {
        footswitch: u32,
        momentary: bool,
    },
    SetStompLabel {
        footswitch: u32,
        label: String,
        single: bool,
    },
    SetMidiOut {
        source: u32,
        messages: Vec<MidiOutMessage>,
    },
    SetPresetLoadMidiOut {
        messages: Vec<MidiOutMessage>,
    },
    SetExpressionBypass {
        row: u32,
        column: u32,
        pedal: u32,
        mode: u32,
        invert: bool,
        delay_ms: u32,
        latch_emulation: bool,
    },
}

impl DeviceOperation {
    /// Encode a public operation after checking values that the protobuf wire
    /// shape cannot represent and string selectors used for sparse dispatch.
    pub fn try_encode(self) -> Result<Vec<OutboundMessage>, CommandEncodeError> {
        self.validate_for_encoding()?;
        Ok(self.encode())
    }

    fn validate_for_encoding(&self) -> Result<(), CommandEncodeError> {
        let signed = |field, value| {
            i32::try_from(value)
                .map(|_| ())
                .map_err(|_| CommandEncodeError::SignedFieldOverflow { field })
        };
        match self {
            Self::SetGeneralInteger { setting, .. } => {
                if !matches!(
                    setting.as_str(),
                    "screenBrightness"
                        | "ledBrightness"
                        | "dimmedLedBrightness"
                        | "holdTiming"
                        | "midiChannel"
                ) {
                    return Err(CommandEncodeError::UnsupportedValue {
                        field: "GeneralSettings integer",
                        value: setting.clone(),
                    });
                }
            }
            Self::SetGeneralToggle { setting, .. } => {
                if !matches!(
                    setting.as_str(),
                    "midiOverUsb"
                        | "ignoreDuplicatePc"
                        | "stompModeAutoAssign"
                        | "swapTempoTunerAccess"
                        | "disableInternetConnectionCheck"
                        | "dynamicDelayCompensation"
                        | "presetDimmed"
                        | "midiClockIn"
                        | "gigViewStompAccess"
                ) {
                    return Err(CommandEncodeError::UnsupportedValue {
                        field: "GeneralSettings toggle",
                        value: setting.clone(),
                    });
                }
            }
            Self::SetRoutingParameter { node, .. } => {
                if !matches!(node.as_str(), "splitter" | "mixer") {
                    return Err(CommandEncodeError::UnsupportedValue {
                        field: "routing node",
                        value: node.clone(),
                    });
                }
            }
            Self::SetLaneControlParameter { control, .. }
            | Self::SetLaneControlSceneMode { control, .. } => {
                if !matches!(control.as_str(), "inputGate" | "laneOutput") {
                    return Err(CommandEncodeError::UnsupportedValue {
                        field: "lane control",
                        value: control.clone(),
                    });
                }
            }
            Self::SetParameterSceneMode { column, .. }
            | Self::SetParameterExpression { column, .. }
                if *column > 9 =>
            {
                return Err(CommandEncodeError::UnsupportedValue {
                    field: "parameter target column",
                    value: column.to_string(),
                });
            }
            Self::MovePreset { position, .. }
            | Self::SavePreset { position, .. }
            | Self::PresetScreenshot { position, .. } => signed("position", *position)?,
            Self::CopyScene {
                from_index,
                to_index,
                ..
            } => {
                signed("from_index", *from_index)?;
                signed("to_index", *to_index)?;
            }
            Self::SetSceneLabel { scene, .. } | Self::SetSceneColor { scene, .. } => {
                signed("scene", *scene)?;
            }
            Self::SetParameterExpression { pedal, .. }
            | Self::SetExpressionBypass { pedal, .. } => signed("pedal", *pedal)?,
            _ => {}
        }
        Ok(())
    }

    pub fn encode(self) -> Vec<OutboundMessage> {
        match self {
            Self::Command(command) => vec![command.encode()],
            Self::AddBlock {
                row,
                column,
                model_id,
            } => vec![set_block(row, column, model_id)],
            Self::RemoveBlock { row, column } => vec![remove_block(row, column)],
            Self::MoveBlock {
                from_row,
                from_column,
                to_row,
                to_column,
            } => {
                vec![move_block(from_row, from_column, to_row, to_column)]
            }
            Self::SetFootswitch {
                row,
                column,
                footswitch,
            } => set_footswitch(row, column, footswitch),
            Self::SetChainInput { row, input_id } => vec![set_chain_input(row, input_id)],
            Self::SetChainOutput { row, output_id } => vec![set_chain_output(row, output_id)],
            Self::SetChainSplit {
                row,
                split_column,
                mix_column,
            } => {
                vec![set_chain_split(row, split_column, mix_column)]
            }
            Self::SetSplitMute { row, muted } => vec![set_split_mute(row, muted)],
            Self::SetRoutingParameter {
                row,
                node,
                parameter_index,
                value,
            } => {
                vec![set_routing_parameter(row, &node, parameter_index, value)]
            }
            Self::SetLaneControlParameter {
                row,
                control,
                parameter_index,
                value,
            } => vec![set_lane_control_parameter(
                row,
                &control,
                parameter_index,
                value,
            )],
            Self::SetLaneControlSceneMode {
                row,
                control,
                parameter_index,
                enabled,
            } => vec![set_lane_control_scene_mode(
                row,
                &control,
                parameter_index,
                enabled,
            )],
            Self::ListPresetFolders => vec![read(4)],
            Self::ReadGeneralSettings => vec![read(9)],
            Self::SetGeneralInteger { setting, value } => {
                vec![set_general_integer(&setting, value)]
            }
            Self::SetGeneralToggle { setting, enabled } => {
                vec![set_general_toggle(&setting, enabled)]
            }
            Self::SetSceneBypassBehavior(behavior) => vec![set_scene_bypass_behavior(behavior)],
            Self::SetMasterVolumeAssignment {
                out12,
                out34,
                send12,
                headphones,
            } => vec![set_master_volume_assignment(
                out12, out34, send12, headphones,
            )],
            Self::SetGlobalBypass { cab, ir } => vec![set_global_bypass(cab, ir)],
            Self::SavePreset {
                setlist_key,
                position,
                name,
                instrument,
            } => {
                vec![save_preset(setlist_key, position, name, instrument)]
            }
            Self::ReadVersion => vec![read_version()],
            Self::ReadTuner => vec![read_tuner()],
            Self::SetTunerInput(input_port_id) => vec![set_tuner_input(input_port_id)],
            Self::SetTunerMute(muted) => vec![set_tuner_mute(muted)],
            Self::SetTunerReference(offset_hz) => vec![set_tuner_reference(offset_hz)],
            Self::ReadIoSettings => vec![read(3)],
            Self::ReadGlobalEq => vec![read_global_eq()],
            Self::SetGlobalEqBypassed(bypassed) => vec![set_global_eq_bypassed(bypassed)],
            Self::SetGlobalEqParameters(parameters) => vec![set_global_eq_parameters(&parameters)],
            Self::ReadModeCycle => vec![read_mode_cycle()],
            Self::SetModeCycle(slots) => vec![set_mode_cycle(&slots)],
            Self::ReadGlobalTempo => vec![read(profile::MESSAGE_TYPE_GLOBAL_TEMPO)],
            Self::SetTempoParameters(parameters) => set_tempo_parameters(parameters),
            Self::SetTempoMode(global) => vec![set_tempo_mode(global)],
            Self::ReadLooperStatus => vec![read_looper_status()],
            Self::ReadRecentsFavorites {
                favorites,
                request_id,
            } => vec![read_recents_favorites(favorites, request_id)],
            Self::SetFavorite {
                name,
                folder_key,
                folder_name,
                is_factory,
                favorite,
            } => vec![set_favorite(
                name,
                folder_key,
                folder_name,
                is_factory,
                favorite,
            )],
            Self::ReadPinnedModels => vec![read_pinned_models()],
            Self::SetModelPinned { model_id, pinned } => {
                vec![set_model_pinned(model_id, pinned)]
            }
            Self::ReadLibraryFiles {
                folder_key,
                file_type,
                request_id,
            } => vec![read_library_files(folder_key, file_type, request_id)],
            Self::CreateSetlist { name } => vec![create_setlist(name)],
            Self::DeleteSetlist { name } => vec![delete_setlist(name)],
            Self::DeletePreset { setlist_key, name } => vec![delete_preset(setlist_key, name)],
            Self::MovePreset {
                setlist_key,
                name,
                position,
            } => vec![move_preset(setlist_key, name, position)],
            Self::LoadCapture {
                row,
                column,
                key,
                name,
                model_id,
            } => {
                let mut messages = Vec::new();
                if let Some(model_id) = model_id {
                    messages.push(set_block(row, column, model_id));
                }
                messages.push(set_parameter_text(row, column, 5, format!("{key}{name}")));
                messages
            }
            Self::LoadIr {
                row,
                column,
                key,
                name,
                slot,
                model_id,
            } => {
                let mut messages = Vec::new();
                if let Some(model_id) = model_id {
                    messages.push(set_block(row, column, model_id));
                }
                let (path_index, name_index) = if slot == 0 { (2, 22) } else { (10, 23) };
                messages.push(set_parameter_text(row, column, path_index, key));
                messages.push(set_parameter_text(row, column, name_index, name));
                messages
            }
            Self::SetInputPort {
                input_port_id,
                level,
                impedance,
                input_type,
                ground_lift,
            } => set_input_port(input_port_id, level, impedance, input_type, ground_lift),
            Self::SetOutputPort {
                output_port_id,
                level,
                ground_lift,
                mute,
            } => set_output_port(output_port_id, level, ground_lift, mute),
            Self::SetUsbPort {
                level,
                headphones_source,
                dry_wet,
            } => set_usb_port(level, headphones_source, dry_wet),
            Self::SetMidiThru(enabled) => vec![set_midi_thru(enabled)],
            Self::SetOutputPairing {
                xlr12_linked,
                out34_linked,
            } => vec![set_output_pairing(xlr12_linked, out34_linked)],
            Self::SetDeviceName(name) => vec![set_device_name(name)],
            Self::Undo => vec![undo()],
            Self::Redo => vec![redo()],
            Self::ReadInhibitedModules => vec![read_inhibited_modules()],
            Self::PresetScreenshot {
                folder_name,
                position,
                is_factory,
                request_id,
            } => vec![preset_screenshot(
                folder_name,
                position,
                is_factory,
                request_id,
            )],
            Self::CaptureScreen => vec![capture_screen()],
            Self::ScreenTap { x, y } => screen_tap(x, y).to_vec(),
            Self::CopyScene {
                from_index,
                to_index,
                swap,
            } => vec![copy_scene(from_index, to_index, swap)],
            Self::SetSceneLabel { scene, label } => vec![set_scene_label(scene, label)],
            Self::SetSceneColor { scene, color } => vec![set_scene_color(scene, color)],
            Self::SetParameterSceneMode {
                row,
                column,
                parameter_index,
                enabled,
            } => {
                vec![set_parameter_scene_mode(
                    row,
                    column,
                    parameter_index,
                    enabled,
                )]
            }
            Self::SetParameterExpression {
                row,
                column,
                parameter_index,
                pedal,
                minimum,
                maximum,
            } => {
                vec![set_parameter_expression(
                    row,
                    column,
                    parameter_index,
                    pedal,
                    minimum,
                    maximum,
                )]
            }
            Self::SetStompMomentary {
                footswitch,
                momentary,
            } => vec![set_stomp_momentary(footswitch, momentary)],
            Self::SetStompLabel {
                footswitch,
                label,
                single,
            } => vec![set_stomp_label(footswitch, label, single)],
            Self::SetMidiOut { source, messages } => vec![set_midi_out(source, messages, false)],
            Self::SetPresetLoadMidiOut { messages } => vec![set_midi_out(0, messages, true)],
            Self::SetExpressionBypass {
                row,
                column,
                pedal,
                mode,
                invert,
                delay_ms,
                latch_emulation,
            } => vec![set_expression_bypass(
                row,
                column,
                pedal,
                mode,
                invert,
                delay_ms,
                latch_emulation,
            )],
        }
    }
}

impl DeviceCommand {
    pub fn encode(self) -> OutboundMessage {
        match self {
            Self::SelectScene(scene) => select_scene(scene),
            Self::SetBypass {
                row,
                column,
                bypassed,
            } => set_bypass(row, column, bypassed),
            Self::SetParameterNumeric {
                row,
                column,
                parameter_index,
                value,
            } => set_parameter_numeric(row, column, parameter_index, value),
            Self::SetParameterText {
                row,
                column,
                parameter_index,
                value,
            } => set_parameter_text(row, column, parameter_index, value),
            Self::ShowTuner(show) => show_tuner(show),
            Self::ShowGigView(show) => show_gig_view(show),
            Self::SetlistPosition {
                setlist_key,
                position,
                is_factory,
            } => setlist_position(setlist_key, position, is_factory),
            Self::SetTempo(bpm) => set_tempo(bpm),
            Self::SetMasterVolume(volume) => set_master_volume(volume),
            Self::Disconnect => connection(false),
        }
    }
}

pub fn reset_comms(request_id: u64, session_id: impl Into<String>) -> OutboundMessage {
    OutboundMessage::encoded(
        profile::MESSAGE_TYPE_DEVICE_VERSION,
        pa::ResetCommsBuffersMessage {
            request_id: Some(pa::reset_comms_buffers_message::RequestId::RequestId(
                request_id,
            )),
            session_id: Some(pa::reset_comms_buffers_message::SessionId::SessionId(
                session_id.into(),
            )),
        },
    )
}

pub fn version_hello() -> OutboundMessage {
    OutboundMessage::encoded(
        10,
        pa::VersionMessage {
            action: pa::message_action::Enum::Update as i32,
            cortex_control_version: Some(
                pa::version_message::CortexControlVersion::CortexControlVersion(
                    profile::CORTEX_CONTROL_VERSION.into(),
                ),
            ),
            ..Default::default()
        },
    )
}

pub fn read(message_type: u16) -> OutboundMessage {
    OutboundMessage::action(message_type, pa::message_action::Enum::Read)
}

pub fn read_global_eq() -> OutboundMessage {
    read(38)
}

pub fn set_global_eq_bypassed(bypassed: bool) -> OutboundMessage {
    OutboundMessage::encoded(
        38,
        pa::GlobalEqMessage {
            action: pa::message_action::Enum::Update as i32,
            bypassed: Some(pa::global_eq_message::Bypassed::Bypassed(bypassed)),
            ..Default::default()
        },
    )
}

pub fn set_global_eq_parameters(parameters: &[(i32, f32)]) -> OutboundMessage {
    OutboundMessage::encoded(
        38,
        pa::GlobalEqMessage {
            action: pa::message_action::Enum::Update as i32,
            parameters: parameters
                .iter()
                .map(|(parameter_index, value)| pa::GlobalEqParameter {
                    parameter_index: *parameter_index,
                    value: *value,
                })
                .collect(),
            ..Default::default()
        },
    )
}

pub fn read_mode_cycle() -> OutboundMessage {
    read(14)
}

pub fn set_mode_cycle(slots: &[u32]) -> OutboundMessage {
    OutboundMessage::encoded(
        14,
        pa::ModeMessage {
            action: pa::message_action::Enum::Update as i32,
            available_modes: Some(pa::mode_message::AvailableModes::AvailableModes(
                pa::AvailableModes {
                    modes: slots.to_vec(),
                },
            )),
            ..Default::default()
        },
    )
}

pub fn read_looper_status() -> OutboundMessage {
    read(28)
}

pub fn read_recents_favorites(favorites: bool, request_id: u64) -> OutboundMessage {
    OutboundMessage::encoded(
        20,
        pa::RecentsFavoritesMessage {
            action: pa::message_action::Enum::Read as i32,
            request_id: Some(pa::recents_favorites_message::RequestId::RequestId(
                request_id,
            )),
            is_favorites: favorites,
            ..Default::default()
        },
    )
}

pub fn set_favorite(
    name: String,
    folder_key: String,
    folder_name: String,
    is_factory: bool,
    favorite: bool,
) -> OutboundMessage {
    OutboundMessage::encoded(
        20,
        pa::RecentsFavoritesMessage {
            action: if favorite {
                pa::message_action::Enum::Create as i32
            } else {
                pa::message_action::Enum::Delete as i32
            },
            is_favorites: true,
            items: vec![pa::RecentsFavoritesItem {
                name,
                folder_key,
                folder_name,
                is_factory,
                is_plugin: false,
            }],
            ..Default::default()
        },
    )
}

pub fn read_pinned_models() -> OutboundMessage {
    read(54)
}

pub fn set_model_pinned(model_id: u32, pinned: bool) -> OutboundMessage {
    OutboundMessage::encoded(
        54,
        pa::PinnedModelsMessage {
            action: if pinned {
                pa::message_action::Enum::Create as i32
            } else {
                pa::message_action::Enum::Delete as i32
            },
            models: vec![model_id],
            ..Default::default()
        },
    )
}

pub fn read_library_files(folder_key: String, file_type: i32, request_id: u64) -> OutboundMessage {
    OutboundMessage::encoded(
        4,
        pa::FileMessage {
            action: pa::message_action::Enum::Read as i32,
            request_id: Some(pa::file_message::RequestId::RequestId(request_id)),
            r#type: Some(pa::file_message::Type::Type(file_type)),
            folder: Some(pa::file_message::Folder::Folder(pa::FolderInfo {
                key: Some(pa::folder_info::Key::Key(folder_key)),
                ..Default::default()
            })),
            ..Default::default()
        },
    )
}

pub fn create_setlist(name: String) -> OutboundMessage {
    let key = format!("/media/p4/Presets/{name}");
    OutboundMessage::encoded(
        4,
        pa::FileMessage {
            action: pa::message_action::Enum::Create as i32,
            r#type: Some(pa::file_message::Type::Type(0)),
            folder: Some(pa::file_message::Folder::Folder(pa::FolderInfo {
                key: Some(pa::folder_info::Key::Key(key)),
                name: Some(pa::folder_info::Name::Name(name)),
                is_factory: Some(pa::folder_info::IsFactory::IsFactory(false)),
                ..Default::default()
            })),
            ..Default::default()
        },
    )
}

pub fn delete_setlist(name: String) -> OutboundMessage {
    let key = format!("/media/p4/Presets/{name}");
    OutboundMessage::encoded(
        4,
        pa::FileMessage {
            action: pa::message_action::Enum::Delete as i32,
            r#type: Some(pa::file_message::Type::Type(0)),
            folder: Some(pa::file_message::Folder::Folder(pa::FolderInfo {
                key: Some(pa::folder_info::Key::Key(key)),
                name: Some(pa::folder_info::Name::Name(name)),
                ..Default::default()
            })),
            ..Default::default()
        },
    )
}

pub fn delete_preset(setlist_key: String, name: String) -> OutboundMessage {
    let file_key = format!("{setlist_key}/{name}.pb");
    OutboundMessage::encoded(
        4,
        pa::FileMessage {
            action: pa::message_action::Enum::Delete as i32,
            r#type: Some(pa::file_message::Type::Type(0)),
            folder: Some(pa::file_message::Folder::Folder(pa::FolderInfo {
                key: Some(pa::folder_info::Key::Key(setlist_key)),
                is_factory: Some(pa::folder_info::IsFactory::IsFactory(false)),
                files: vec![pa::ProductData {
                    key: Some(pa::product_data::Key::Key(file_key)),
                    ..Default::default()
                }],
                ..Default::default()
            })),
            ..Default::default()
        },
    )
}

pub fn move_preset(setlist_key: String, name: String, position: u32) -> OutboundMessage {
    let source_key = format!("{setlist_key}/{name}.pb");
    OutboundMessage::encoded(
        4,
        pa::FileMessage {
            action: pa::message_action::Enum::Move as i32,
            r#type: Some(pa::file_message::Type::Type(0)),
            folder: Some(pa::file_message::Folder::Folder(pa::FolderInfo {
                key: Some(pa::folder_info::Key::Key(setlist_key.clone())),
                is_factory: Some(pa::folder_info::IsFactory::IsFactory(false)),
                files: vec![pa::ProductData {
                    key: Some(pa::product_data::Key::Key(source_key)),
                    ..Default::default()
                }],
                ..Default::default()
            })),
            to_folder: Some(pa::file_message::ToFolder::ToFolder(pa::FolderInfo {
                key: Some(pa::folder_info::Key::Key(setlist_key)),
                files: vec![pa::ProductData {
                    index: Some(pa::product_data::Index::Index(position as i32)),
                    ..Default::default()
                }],
                ..Default::default()
            })),
            ..Default::default()
        },
    )
}

pub fn connection(connected: bool) -> OutboundMessage {
    OutboundMessage::encoded(
        49,
        pa::ConnectionMessage {
            connected: Some(pa::connection_message::Connected::Connected(connected)),
            ..Default::default()
        },
    )
}

/// Messages sent after the correlated reset reply, in the exact order expected
/// by the QC. Directory/file enumeration is intentionally excluded.
pub fn initialization() -> Vec<OutboundMessage> {
    let mut messages = Vec::with_capacity(profile::LIVE_SUBSCRIPTIONS.len() + 3);
    messages.push(version_hello());
    messages.push(read(profile::MESSAGE_TYPE_MODEL_REPO));
    messages.push(connection(true));
    messages.extend(profile::LIVE_SUBSCRIPTIONS.iter().copied().map(read));
    messages
}

pub fn keepalive() -> OutboundMessage {
    OutboundMessage::encoded(
        32,
        pa::KeepAliveMessage {
            action: pa::message_action::Enum::Update as i32,
            ..Default::default()
        },
    )
}

pub fn read_current_preset(request_id: u64) -> OutboundMessage {
    OutboundMessage::encoded(
        15,
        pa::RecallPresetMessage {
            action: pa::message_action::Enum::Read as i32,
            request_id: Some(pa::recall_preset_message::RequestId::RequestId(request_id)),
            ..Default::default()
        },
    )
}

/// Read the active setlist address without recalling or reloading a preset.
pub fn read_setlist_position(request_id: u64) -> OutboundMessage {
    OutboundMessage::encoded(
        2,
        pa::SetlistPositionMessage {
            action: pa::message_action::Enum::Read as i32,
            request_id: Some(pa::setlist_position_message::RequestId::RequestId(
                request_id,
            )),
            ..Default::default()
        },
    )
}

pub fn select_scene(scene: u32) -> OutboundMessage {
    OutboundMessage::encoded(
        13,
        pa::SceneMessage {
            action: pa::message_action::Enum::Update as i32,
            selected_scene: Some(pa::scene_message::SelectedScene::SelectedScene(scene)),
            ..Default::default()
        },
    )
}

/// Copy or swap complete scene state, including its label and colour.
pub fn copy_scene(from_index: u32, to_index: u32, swap: bool) -> OutboundMessage {
    OutboundMessage::encoded(
        22,
        pa::SceneCopyMessage {
            action: pa::message_action::Enum::Update as i32,
            from_index: from_index as i32,
            to_index: to_index as i32,
            is_swap: swap,
            ..Default::default()
        },
    )
}

/// Rename a scene. The QC represents an unlabelled scene as one space.
pub fn set_scene_label(scene: u32, label: Option<String>) -> OutboundMessage {
    OutboundMessage::encoded(
        23,
        pa::SceneLabelMessage {
            action: pa::message_action::Enum::Update as i32,
            index: scene as i32,
            label: label.unwrap_or_else(|| " ".into()),
            ..Default::default()
        },
    )
}

/// Set a scene's native ARGB colour value.
pub fn set_scene_color(scene: u32, color: u32) -> OutboundMessage {
    OutboundMessage::encoded(
        48,
        pa::SceneColorMessage {
            action: pa::message_action::Enum::Update as i32,
            index: scene as i32,
            color,
            ..Default::default()
        },
    )
}

pub fn set_bypass(row: u32, column: u32, bypassed: bool) -> OutboundMessage {
    let preset = BinaryPreset {
        bypass: vec![Bypass {
            row: Some(bypass::Row::Row(row)),
            col_bypass: vec![ColBypass {
                column: Some(col_bypass::Column::Column(column)),
                scene_bypass: vec![SceneBypass { bypass: bypassed }],
                ..Default::default()
            }],
        }],
        ..Default::default()
    };
    grid_update(preset)
}

pub fn set_parameter_numeric(
    row: u32,
    column: u32,
    parameter_index: u32,
    normalized_value: f32,
) -> OutboundMessage {
    parameter_update(
        row,
        column,
        parameter_index,
        param_value::Value::FloatValue(normalized_value),
    )
}

pub fn set_parameter_text(
    row: u32,
    column: u32,
    parameter_index: u32,
    value: impl Into<String>,
) -> OutboundMessage {
    parameter_update(
        row,
        column,
        parameter_index,
        param_value::Value::StringValue(value.into()),
    )
}

fn parameter_update(
    row: u32,
    column: u32,
    parameter_index: u32,
    value: param_value::Value,
) -> OutboundMessage {
    let parameter = Param {
        param_values: vec![ParamValue { value: Some(value) }],
        index: Some(param::Index::Index(parameter_index)),
        ..Default::default()
    };
    let preset = BinaryPreset {
        chains: vec![Chain {
            row: Some(chain::Row::Row(row)),
            models: vec![Model {
                column: Some(model::Column::Column(column)),
                params: vec![parameter],
                ..Default::default()
            }],
            ..Default::default()
        }],
        ..Default::default()
    };
    grid_update(preset)
}

fn parameter_metadata_update(row: u32, column: u32, parameter: Param) -> OutboundMessage {
    let mut target = Model {
        params: vec![parameter],
        ..Default::default()
    };
    let mut chain = Chain {
        row: Some(chain::Row::Row(row)),
        ..Default::default()
    };
    match column {
        0..=7 => {
            target.column = Some(model::Column::Column(column));
            chain.models.push(target);
        }
        8 => chain.combined_splitter.push(target),
        9 => {
            target.hash = Some(model::Hash::Hash(11_000));
            chain.mixer.push(target);
        }
        _ => panic!("unsupported parameter target column: {column}"),
    }
    grid_update(BinaryPreset {
        chains: vec![chain],
        ..Default::default()
    })
}

fn lane_control_update(row: u32, control: &str, parameter: Param) -> OutboundMessage {
    let mut target = Model {
        params: vec![parameter],
        ..Default::default()
    };
    let mut chain = Chain {
        row: Some(chain::Row::Row(row)),
        ..Default::default()
    };
    match control {
        "inputGate" => {
            target.hash = Some(model::Hash::Hash(28_000));
            chain.input_control.push(target);
        }
        "laneOutput" => {
            target.hash = Some(model::Hash::Hash(23_000));
            chain.output_control.push(target);
        }
        _ => panic!("unsupported lane control: {control}"),
    }
    grid_update(BinaryPreset {
        chains: vec![chain],
        ..Default::default()
    })
}

pub fn set_lane_control_parameter(
    row: u32,
    control: &str,
    parameter_index: u32,
    value: f32,
) -> OutboundMessage {
    lane_control_update(
        row,
        control,
        Param {
            index: Some(param::Index::Index(parameter_index)),
            param_values: vec![ParamValue {
                value: Some(param_value::Value::FloatValue(value)),
            }],
            ..Default::default()
        },
    )
}

pub fn set_lane_control_scene_mode(
    row: u32,
    control: &str,
    parameter_index: u32,
    enabled: bool,
) -> OutboundMessage {
    lane_control_update(
        row,
        control,
        Param {
            index: Some(param::Index::Index(parameter_index)),
            scene_mode: Some(param::SceneMode::SceneMode(enabled)),
            ..Default::default()
        },
    )
}

/// Toggle per-scene storage for one block parameter. The flag travels alone.
pub fn set_parameter_scene_mode(
    row: u32,
    column: u32,
    parameter_index: u32,
    enabled: bool,
) -> OutboundMessage {
    parameter_metadata_update(
        row,
        column,
        Param {
            index: Some(param::Index::Index(parameter_index)),
            scene_mode: Some(param::SceneMode::SceneMode(enabled)),
            ..Default::default()
        },
    )
}

/// Assign EXP 1/2 to a block parameter, or clear it with pedal zero.
pub fn set_parameter_expression(
    row: u32,
    column: u32,
    parameter_index: u32,
    pedal: u32,
    minimum: f32,
    maximum: f32,
) -> OutboundMessage {
    parameter_metadata_update(
        row,
        column,
        Param {
            index: Some(param::Index::Index(parameter_index)),
            expression: Some(param::Expression::Expression(pedal as i32)),
            expression_min: Some(param::ExpressionMin::ExpressionMin(minimum)),
            expression_max: Some(param::ExpressionMax::ExpressionMax(maximum)),
            ..Default::default()
        },
    )
}

/// Assign an expression pedal to a placed block's bypass switch.
pub fn set_expression_bypass(
    row: u32,
    column: u32,
    pedal: u32,
    mode: u32,
    invert: bool,
    delay_ms: u32,
    latch_emulation: bool,
) -> OutboundMessage {
    grid_update(BinaryPreset {
        chains: vec![Chain {
            row: Some(chain::Row::Row(row)),
            models: vec![Model {
                column: Some(model::Column::Column(column)),
                bypass_expression: vec![crate::proto::Expression {
                    expression: pedal as i32,
                    expression_min: 0.0,
                    expression_max: 1.0,
                }],
                expression_bypass_info: vec![crate::proto::ExpressionBypassInfo {
                    r#type: mode,
                    invert,
                    delay_ms,
                    latch_emulation,
                }],
                ..Default::default()
            }],
            ..Default::default()
        }],
        ..Default::default()
    })
}

pub fn set_block(row: u32, column: u32, model_id: u32) -> OutboundMessage {
    grid_update(BinaryPreset {
        chains: vec![Chain {
            row: Some(chain::Row::Row(row)),
            models: vec![Model {
                hash: Some(model::Hash::Hash(model_id)),
                column: Some(model::Column::Column(column)),
                ..Default::default()
            }],
            ..Default::default()
        }],
        ..Default::default()
    })
}

pub fn remove_block(row: u32, column: u32) -> OutboundMessage {
    let preset = BinaryPreset {
        chains: vec![Chain {
            row: Some(chain::Row::Row(row)),
            models: vec![Model {
                hash: Some(model::Hash::Hash(0)),
                column: Some(model::Column::Column(column)),
                ..Default::default()
            }],
            ..Default::default()
        }],
        ..Default::default()
    };
    OutboundMessage::encoded(
        1,
        pa::GridMessage {
            action: pa::message_action::Enum::Delete as i32,
            preset: Some(pa::grid_message::Preset::Preset(preset)),
            ..Default::default()
        },
    )
}

pub fn move_block(from_row: u32, from_column: u32, to_row: u32, to_column: u32) -> OutboundMessage {
    OutboundMessage::encoded(
        12,
        pa::GridMoveMessage {
            r#move: vec![pa::GridMoveElement {
                from_row,
                from_col: from_column,
                to_row,
                to_col: to_column,
                is_drop: true,
            }],
            ..Default::default()
        },
    )
}

pub fn set_footswitch(row: u32, column: u32, footswitch: Option<u32>) -> Vec<OutboundMessage> {
    let assignment = StompModeAssignment {
        row,
        column,
        stomp_index: footswitch.unwrap_or_default(),
    };
    let delete = OutboundMessage::encoded(
        1,
        pa::GridMessage {
            action: pa::message_action::Enum::Delete as i32,
            preset: Some(pa::grid_message::Preset::Preset(BinaryPreset {
                stomp_mode_assignments: vec![assignment],
                ..Default::default()
            })),
            ..Default::default()
        },
    );
    let Some(footswitch) = footswitch else {
        return vec![delete];
    };
    let update = grid_update(BinaryPreset {
        stomp_mode_assignments: vec![StompModeAssignment {
            row,
            column,
            stomp_index: footswitch,
        }],
        ..Default::default()
    });
    vec![delete, update]
}

/// Set the per-preset latching/momentary behavior for a physical A-H switch.
pub fn set_stomp_momentary(footswitch: u32, momentary: bool) -> OutboundMessage {
    let mut preset = BinaryPreset::default();
    preset.stomp_is_momentary.insert(footswitch, momentary);
    grid_update(preset)
}

/// Set one of the QC's two footswitch-label maps.
pub fn set_stomp_label(footswitch: u32, label: String, single: bool) -> OutboundMessage {
    let mut preset = BinaryPreset::default();
    if single {
        preset.single_stomp_labels.insert(footswitch, label);
    } else {
        preset.stomp_labels.insert(footswitch, label);
    }
    grid_update(preset)
}

/// Replace the MIDI messages for one A-H/EXP source, or the preset-load list.
pub fn set_midi_out(
    source: u32,
    messages: Vec<MidiOutMessage>,
    preset_load: bool,
) -> OutboundMessage {
    let messages = pa::GeneralMidiMessages {
        messages: vec![pa::GeneralMidiMessage {
            source: Some(pa::general_midi_message::Source::Source(source)),
            msg: messages
                .into_iter()
                .map(|message| crate::proto::MidiMessageInfo {
                    r#type: message.r#type,
                    channel: message.channel,
                    param1: message.param1,
                    param2: message.param2,
                    param3: message.param3,
                })
                .collect(),
        }],
    };
    OutboundMessage::encoded(
        8,
        pa::MidiSettingsMessage {
            action: pa::message_action::Enum::Update as i32,
            preset_load_messages: preset_load.then_some(
                pa::midi_settings_message::PresetLoadMessages::PresetLoadMessages(messages.clone()),
            ),
            general_midi_messages: (!preset_load).then_some(
                pa::midi_settings_message::GeneralMidiMessages::GeneralMidiMessages(messages),
            ),
            ..Default::default()
        },
    )
}

pub fn set_chain_input(row: u32, input_id: u32) -> OutboundMessage {
    grid_update(BinaryPreset {
        chains: vec![Chain {
            row: Some(chain::Row::Row(row)),
            in_portid: Some(chain::InPortid::InPortid(input_id)),
            ..Default::default()
        }],
        ..Default::default()
    })
}

pub fn set_chain_output(row: u32, output_id: u32) -> OutboundMessage {
    grid_update(BinaryPreset {
        chains: vec![Chain {
            row: Some(chain::Row::Row(row)),
            out_portid: Some(chain::OutPortid::OutPortid(output_id)),
            ..Default::default()
        }],
        ..Default::default()
    })
}

pub fn set_chain_split(
    row: u32,
    split_column: Option<i32>,
    mix_column: Option<i32>,
) -> OutboundMessage {
    let (split, mix) = match split_column {
        Some(split) => (split, mix_column.unwrap_or(-1)),
        None => (-1, -1),
    };
    grid_update(BinaryPreset {
        chains: vec![Chain {
            row: Some(chain::Row::Row(row)),
            split_control_points: vec![SplitControlPoints { split, mix }],
            ..Default::default()
        }],
        ..Default::default()
    })
}

/// The device accepts this setting in `splitBypass` but reports its
/// authoritative value in `mixBypass`. Although both fields are repeated for
/// scenes, one write changes the shared splitter/mixer mute for all scenes.
pub fn set_split_mute(row: u32, muted: bool) -> OutboundMessage {
    grid_update(BinaryPreset {
        chains: vec![Chain {
            row: Some(chain::Row::Row(row)),
            split_bypass: vec![SceneBypass { bypass: muted }],
            ..Default::default()
        }],
        ..Default::default()
    })
}

pub fn set_routing_parameter(
    row: u32,
    node: &str,
    parameter_index: u32,
    value: f32,
) -> OutboundMessage {
    let parameter = Param {
        param_values: vec![ParamValue {
            value: Some(param_value::Value::FloatValue(value)),
        }],
        index: Some(param::Index::Index(parameter_index)),
        ..Default::default()
    };
    let mut chain_value = Chain {
        row: Some(chain::Row::Row(row)),
        ..Default::default()
    };
    match node {
        "splitter" => chain_value.combined_splitter.push(Model {
            params: vec![parameter],
            ..Default::default()
        }),
        "mixer" => chain_value.mixer.push(Model {
            hash: Some(model::Hash::Hash(11_000)),
            params: vec![parameter],
            ..Default::default()
        }),
        _ => panic!("unsupported routing node: {node}"),
    }
    grid_update(BinaryPreset {
        chains: vec![chain_value],
        ..Default::default()
    })
}

pub fn save_preset(
    setlist_key: impl Into<String>,
    position: u32,
    name: impl Into<String>,
    instrument: i32,
) -> OutboundMessage {
    OutboundMessage::encoded(
        4,
        pa::FileMessage {
            r#type: Some(pa::file_message::Type::Type(0)),
            folder: Some(pa::file_message::Folder::Folder(pa::FolderInfo {
                key: Some(pa::folder_info::Key::Key(setlist_key.into())),
                is_factory: Some(pa::folder_info::IsFactory::IsFactory(false)),
                files: vec![pa::ProductData {
                    index: Some(pa::product_data::Index::Index(position as i32)),
                    name: Some(pa::product_data::Name::Name(name.into())),
                    instrument: Some(pa::product_data::Instrument::Instrument(instrument)),
                    ..Default::default()
                }],
                ..Default::default()
            })),
            ..Default::default()
        },
    )
}

pub fn show_tuner(show: bool) -> OutboundMessage {
    // Preserve the explicit false field used by Cortex Control. Proto3 would
    // otherwise omit it, which makes a hide command indistinguishable from a
    // message whose sender never supplied the `show` field.
    OutboundMessage {
        message_type: 27,
        payload: vec![0x08, 0x01, 0x18, u8::from(show)],
    }
}

pub fn show_gig_view(show: bool) -> OutboundMessage {
    OutboundMessage {
        message_type: 24,
        payload: vec![0x08, 0x01, 0x18, u8::from(show)],
    }
}

/// Reply to the QC's request for a host-owned Neural Capture dialog.
///
/// This exactly replaces pyquadcortex's `show_capture_dialog` wire operation,
/// but is intentionally not an intent-level [`DeviceCommand`]. Sending `true`
/// transfers the capture flow to the host; a client must not do that unless it
/// implements the recorder, trainer, refiner, calibration, A/B, and save UI.
pub fn acknowledge_capture_dialog(shown: bool) -> OutboundMessage {
    OutboundMessage::encoded(
        36,
        pa::NeuralCaptureMessage {
            action: pa::message_action::Enum::Update as i32,
            show_dialog: Some(pa::neural_capture_message::ShowDialog::ShowDialog(shown)),
            ..Default::default()
        },
    )
}

pub fn read_version() -> OutboundMessage {
    OutboundMessage::encoded(
        10,
        pa::VersionMessage {
            action: pa::message_action::Enum::Read as i32,
            ..Default::default()
        },
    )
}

pub fn read_tuner() -> OutboundMessage {
    OutboundMessage::encoded(
        6,
        pa::TunerMessage {
            action: pa::message_action::Enum::Read as i32,
            ..Default::default()
        },
    )
}

/// Select the tuner input. Any tuner write engages the tuner invisibly on the
/// measured firmware; callers must surface that hazard before sending it.
pub fn set_tuner_input(input_port_id: i32) -> OutboundMessage {
    OutboundMessage::encoded(
        6,
        pa::TunerMessage {
            action: pa::message_action::Enum::Update as i32,
            input_port_id: Some(pa::tuner_message::InputPortId::InputPortId(input_port_id)),
            ..Default::default()
        },
    )
}

/// Set the persistent mute-while-tuning preference. Sending this also engages
/// the tuner invisibly; `true` can therefore silence every output immediately.
pub fn set_tuner_mute(muted: bool) -> OutboundMessage {
    OutboundMessage::encoded(
        6,
        pa::TunerMessage {
            action: pa::message_action::Enum::Update as i32,
            mute: Some(pa::tuner_message::Mute::Mute(muted)),
            ..Default::default()
        },
    )
}

/// Set reference pitch as the signed Hz offset from A=440, matching the QC
/// wire representation (for example `2.0` means 442 Hz).
pub fn set_tuner_reference(offset_hz: f32) -> OutboundMessage {
    OutboundMessage::encoded(
        6,
        pa::TunerMessage {
            action: pa::message_action::Enum::Update as i32,
            frequency: Some(pa::tuner_message::Frequency::Frequency(offset_hz)),
            ..Default::default()
        },
    )
}

pub fn read_general_settings() -> OutboundMessage {
    OutboundMessage::encoded(
        9,
        pa::GeneralSettingsMessage {
            action: pa::message_action::Enum::Read as i32,
            ..Default::default()
        },
    )
}

pub fn set_general_integer(setting: &str, value: i32) -> OutboundMessage {
    let mut message = pa::GeneralSettingsMessage {
        action: pa::message_action::Enum::Update as i32,
        ..Default::default()
    };
    match setting {
        "screenBrightness" => {
            message.screen_brightness =
                Some(pa::general_settings_message::ScreenBrightness::ScreenBrightness(value))
        }
        "ledBrightness" => {
            message.led_brightness = Some(
                pa::general_settings_message::LedBrightness::LedBrightness(value),
            )
        }
        "dimmedLedBrightness" => {
            message.dimmed_led_brightness =
                Some(pa::general_settings_message::DimmedLedBrightness::DimmedLedBrightness(value))
        }
        "holdTiming" => {
            message.hold_timing = Some(pa::general_settings_message::HoldTiming::HoldTiming(value))
        }
        "midiChannel" => {
            message.midi_channel = Some(pa::general_settings_message::MidiChannel::MidiChannel(
                value,
            ))
        }
        _ => panic!("unsupported validated GeneralSettings integer: {setting}"),
    }
    OutboundMessage::encoded(9, message)
}

pub fn set_general_toggle(setting: &str, enabled: bool) -> OutboundMessage {
    let mut message = pa::GeneralSettingsMessage {
        action: pa::message_action::Enum::Update as i32,
        ..Default::default()
    };
    match setting {
        "midiOverUsb" => {
            message.midi_over_usb =
                Some(pa::general_settings_message::MidiOverUsb::MidiOverUsb(enabled))
        }
        "ignoreDuplicatePc" => message.ignore_duplicate_pc = Some(
            pa::general_settings_message::IgnoreDuplicatePc::IgnoreDuplicatePc(enabled),
        ),
        "stompModeAutoAssign" => message.stomp_mode_auto_assign = Some(
            pa::general_settings_message::StompModeAutoAssign::StompModeAutoAssign(enabled),
        ),
        "swapTempoTunerAccess" => message.swap_tempo_tuner_access = Some(
            pa::general_settings_message::SwapTempoTunerAccess::SwapTempoTunerAccess(enabled),
        ),
        "disableInternetConnectionCheck" => message.disable_internet_connection_check = Some(
            pa::general_settings_message::DisableInternetConnectionCheck::DisableInternetConnectionCheck(enabled),
        ),
        "dynamicDelayCompensation" => message.enable_dynamic_delay_compensation = Some(
            pa::general_settings_message::EnableDynamicDelayCompensation::EnableDynamicDelayCompensation(enabled),
        ),
        "presetDimmed" => message.enable_preset_dimmed = Some(
            pa::general_settings_message::EnablePresetDimmed::EnablePresetDimmed(enabled),
        ),
        "midiClockIn" => message.midi_clock_in_enabled = Some(
            pa::general_settings_message::MidiClockInEnabled::MidiClockInEnabled(enabled),
        ),
        "gigViewStompAccess" => message.gig_view_stomp_access_enabled = Some(
            pa::general_settings_message::GigViewStompAccessEnabled::GigViewStompAccessEnabled(
                enabled,
            ),
        ),
        _ => panic!("unsupported validated GeneralSettings toggle: {setting}"),
    }
    OutboundMessage::encoded(9, message)
}

pub fn set_scene_bypass_behavior(behavior: i32) -> OutboundMessage {
    OutboundMessage::encoded(
        9,
        pa::GeneralSettingsMessage {
            action: pa::message_action::Enum::Update as i32,
            scene_block_bypass: Some(
                pa::general_settings_message::SceneBlockBypass::SceneBlockBypass(behavior),
            ),
            ..Default::default()
        },
    )
}

fn io_update(settings: pa::PortSettings) -> OutboundMessage {
    OutboundMessage::encoded(
        3,
        pa::IoSettingsMessage {
            action: pa::message_action::Enum::Update as i32,
            settings: Some(pa::io_settings_message::Settings::Settings(settings)),
            ..Default::default()
        },
    )
}

pub fn set_master_volume_assignment(
    out12: bool,
    out34: bool,
    send12: bool,
    headphones: bool,
) -> OutboundMessage {
    OutboundMessage::encoded(
        9,
        pa::GeneralSettingsMessage {
            action: pa::message_action::Enum::Update as i32,
            master_volume_assignment: Some(
                pa::general_settings_message::MasterVolumeAssignment::MasterVolumeAssignment(
                    pa::MasterVolumeAssignmentOptions {
                        out12,
                        out34,
                        send12,
                        headphones,
                    },
                ),
            ),
            ..Default::default()
        },
    )
}

pub fn set_global_bypass(cab: [bool; 4], ir: [bool; 4]) -> OutboundMessage {
    let rows = |values: [bool; 4]| pa::GlobalBypassRows {
        row1: values[0],
        row2: values[1],
        row3: values[2],
        row4: values[3],
    };
    OutboundMessage::encoded(
        9,
        pa::GeneralSettingsMessage {
            action: pa::message_action::Enum::Update as i32,
            global_bypass_cab: Some(
                pa::general_settings_message::GlobalBypassCab::GlobalBypassCab(rows(cab)),
            ),
            global_bypass_ir: Some(
                pa::general_settings_message::GlobalBypassIr::GlobalBypassIr(rows(ir)),
            ),
            ..Default::default()
        },
    )
}

pub fn set_input_port(
    input_port_id: u32,
    level: Option<f32>,
    impedance: Option<f32>,
    input_type: Option<f32>,
    ground_lift: Option<f32>,
) -> Vec<OutboundMessage> {
    let mut messages = Vec::new();
    for field in [
        level.map(|value| ("level", value)),
        impedance.map(|value| ("impedance", value)),
        input_type.map(|value| ("inputType", value)),
        ground_lift.map(|value| ("groundLift", value)),
    ]
    .into_iter()
    .flatten()
    {
        let mut port = pa::InputPortSettings {
            input_port_id,
            ..Default::default()
        };
        match field {
            ("level", value) => port.level = Some(pa::input_port_settings::Level::Level(value)),
            ("impedance", value) => {
                port.input_zmode = Some(pa::input_port_settings::InputZmode::InputZmode(value))
            }
            ("inputType", value) => {
                port.input_type = Some(pa::input_port_settings::InputType::InputType(value))
            }
            ("groundLift", value) => {
                port.ground_lift = Some(pa::input_port_settings::GroundLift::GroundLift(value))
            }
            _ => unreachable!(),
        }
        messages.push(io_update(pa::PortSettings {
            in_port: vec![port],
            ..Default::default()
        }));
    }
    messages
}

pub fn set_output_port(
    output_port_id: u32,
    level: Option<f32>,
    ground_lift: Option<f32>,
    mute: Option<bool>,
) -> Vec<OutboundMessage> {
    let mut messages = Vec::new();
    if let Some(value) = level {
        messages.push(io_update(pa::PortSettings {
            out_port: vec![pa::OutputPortSettings {
                output_port_id,
                level: Some(pa::output_port_settings::Level::Level(value)),
                ..Default::default()
            }],
            ..Default::default()
        }));
    }
    if let Some(value) = ground_lift {
        messages.push(io_update(pa::PortSettings {
            out_port: vec![pa::OutputPortSettings {
                output_port_id,
                ground_lift: Some(pa::output_port_settings::GroundLift::GroundLift(value)),
                ..Default::default()
            }],
            ..Default::default()
        }));
    }
    if let Some(value) = mute {
        messages.push(io_update(pa::PortSettings {
            out_port: vec![pa::OutputPortSettings {
                output_port_id,
                mute: Some(pa::output_port_settings::Mute::Mute(value)),
                ..Default::default()
            }],
            ..Default::default()
        }));
    }
    messages
}

pub fn set_usb_port(
    level: Option<f32>,
    headphones_source: Option<f32>,
    dry_wet: Option<f32>,
) -> Vec<OutboundMessage> {
    let mut messages = Vec::new();
    for field in [
        level.map(|value| ("level", value)),
        headphones_source.map(|value| ("headphonesSource", value)),
        dry_wet.map(|value| ("dryWet", value)),
    ]
    .into_iter()
    .flatten()
    {
        let mut port = pa::UsbPortSettings::default();
        match field {
            ("level", value) => port.level = Some(pa::usb_port_settings::Level::Level(value)),
            ("headphonesSource", value) => {
                port.hp_select = Some(pa::usb_port_settings::HpSelect::HpSelect(value))
            }
            ("dryWet", value) => port.dry_wet = Some(pa::usb_port_settings::DryWet::DryWet(value)),
            _ => unreachable!(),
        }
        messages.push(io_update(pa::PortSettings {
            usb_port: Some(pa::port_settings::UsbPort::UsbPort(port)),
            ..Default::default()
        }));
    }
    messages
}

pub fn set_midi_thru(enabled: bool) -> OutboundMessage {
    io_update(pa::PortSettings {
        midi_port: Some(pa::port_settings::MidiPort::MidiPort(
            pa::MidiPortSettings {
                midi_thru: Some(pa::midi_port_settings::MidiThru::MidiThru(if enabled {
                    1.0
                } else {
                    0.0
                })),
            },
        )),
        ..Default::default()
    })
}

pub fn set_output_pairing(
    xlr12_linked: Option<bool>,
    out34_linked: Option<bool>,
) -> OutboundMessage {
    OutboundMessage::encoded(
        3,
        pa::IoSettingsMessage {
            action: pa::message_action::Enum::Update as i32,
            xlr1_2_linked: xlr12_linked.map(pa::io_settings_message::Xlr12Linked::Xlr12Linked),
            out3_4_linked: out34_linked.map(pa::io_settings_message::Out34Linked::Out34Linked),
            ..Default::default()
        },
    )
}

pub fn set_device_name(name: impl Into<String>) -> OutboundMessage {
    OutboundMessage::encoded(
        10,
        pa::VersionMessage {
            action: pa::message_action::Enum::Update as i32,
            custom_name: Some(pa::version_message::CustomName::CustomName(name.into())),
            ..Default::default()
        },
    )
}

pub fn undo() -> OutboundMessage {
    OutboundMessage::encoded(
        21,
        pa::UndoRedoMessage {
            action: pa::message_action::Enum::Update as i32,
            undo: Some(pa::undo_redo_message::Undo::Undo(true)),
            ..Default::default()
        },
    )
}

pub fn redo() -> OutboundMessage {
    OutboundMessage::encoded(
        21,
        pa::UndoRedoMessage {
            action: pa::message_action::Enum::Update as i32,
            redo: Some(pa::undo_redo_message::Redo::Redo(true)),
            ..Default::default()
        },
    )
}

pub fn read_inhibited_modules() -> OutboundMessage {
    OutboundMessage::encoded(
        42,
        pa::CompilerInhibitedModulesMessage {
            action: pa::message_action::Enum::Read as i32,
            ..Default::default()
        },
    )
}

pub fn preset_screenshot(
    folder_name: impl Into<String>,
    position: u32,
    is_factory: bool,
    request_id: u64,
) -> OutboundMessage {
    OutboundMessage::encoded(
        25,
        pa::ScreenshotMessage {
            action: pa::message_action::Enum::Read as i32,
            request_id: Some(pa::screenshot_message::RequestId::RequestId(request_id)),
            folder_name: folder_name.into(),
            is_factory,
            index: position as i32,
            ..Default::default()
        },
    )
}

pub fn capture_screen() -> OutboundMessage {
    OutboundMessage::encoded(
        72,
        pa::RemoteControlMessage {
            action: pa::message_action::Enum::Read as i32,
            screenshot: Some(pa::RemoteControlScreenshot::default()),
            ..Default::default()
        },
    )
}

pub fn screen_tap(x: f32, y: f32) -> [OutboundMessage; 2] {
    let mouse = |r#type| pa::RemoteControlMessage {
        action: pa::message_action::Enum::Update as i32,
        mouse: Some(pa::RemoteControlMouse {
            x,
            y,
            r#type,
            ..Default::default()
        }),
        ..Default::default()
    };
    [
        OutboundMessage::encoded(72, mouse(pa::remote_control_mouse::Type::Press as i32)),
        OutboundMessage::encoded(72, mouse(pa::remote_control_mouse::Type::Release as i32)),
    ]
}

pub fn create_local_backup() -> OutboundMessage {
    OutboundMessage::encoded(
        profile::MESSAGE_TYPE_BACKUP,
        pa::LocalBackupMessage {
            action: pa::message_action::Enum::Create as i32,
            ..Default::default()
        },
    )
}

pub fn setlist_position(
    setlist_key: impl Into<String>,
    position: u32,
    is_factory: bool,
) -> OutboundMessage {
    setlist_position_with_request_id(setlist_key, position, is_factory, None)
}

/// Recall a setlist position with an optional transaction id.
///
/// The QC uses the id to distinguish successive host recalls.  In particular,
/// repeating untagged UPDATE messages in one USB session can be treated as a
/// duplicate after the first preset change.
pub fn setlist_position_with_request_id(
    setlist_key: impl Into<String>,
    position: u32,
    is_factory: bool,
    request_id: Option<u64>,
) -> OutboundMessage {
    OutboundMessage::encoded(
        2,
        pa::SetlistPositionMessage {
            action: pa::message_action::Enum::Update as i32,
            request_id: request_id.map(pa::setlist_position_message::RequestId::RequestId),
            folder_key: Some(pa::setlist_position_message::FolderKey::FolderKey(
                setlist_key.into(),
            )),
            position: Some(pa::setlist_position_message::Position::Position(position)),
            is_factory: Some(pa::setlist_position_message::IsFactory::IsFactory(
                is_factory,
            )),
            ..Default::default()
        },
    )
}

pub fn set_tempo(bpm: u32) -> OutboundMessage {
    let minimum = domain::MINIMUM_TEMPO_BPM as f32;
    let span = (domain::MAXIMUM_TEMPO_BPM - domain::MINIMUM_TEMPO_BPM) as f32;
    let normalized =
        (bpm.clamp(domain::MINIMUM_TEMPO_BPM, domain::MAXIMUM_TEMPO_BPM) as f32 - minimum) / span;
    let preset = BinaryPreset {
        tempo_program_data: vec![Model {
            hash: Some(model::Hash::Hash(25_000)),
            params: vec![Param {
                param_values: vec![ParamValue {
                    value: Some(param_value::Value::FloatValue(normalized)),
                }],
                index: Some(param::Index::Index(0)),
                ..Default::default()
            }],
            ..Default::default()
        }],
        ..Default::default()
    };
    grid_update(preset)
}

/// Update one or more fields of the loaded preset's TempoControl (model 25000).
/// Each field is deliberately emitted in its own sparse Grid frame, matching
/// the hardware UI and avoiding the QC's order-sensitive time-signature rewrite.
pub fn set_tempo_parameters(parameters: Vec<(u32, f32)>) -> Vec<OutboundMessage> {
    parameters
        .into_iter()
        .map(|(index, value)| {
            grid_update(BinaryPreset {
                tempo_program_data: vec![Model {
                    hash: Some(model::Hash::Hash(25_000)),
                    params: vec![Param {
                        param_values: vec![ParamValue {
                            value: Some(param_value::Value::FloatValue(value.clamp(0.0, 1.0))),
                        }],
                        index: Some(param::Index::Index(index)),
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            })
        })
        .collect()
}

/// Select whether the QC plays the loaded preset tempo or the device-global
/// tempo block. This is GlobalTempo parameter 1, not preset TempoControl TYPE.
pub fn set_tempo_mode(global: bool) -> OutboundMessage {
    OutboundMessage::encoded(
        profile::MESSAGE_TYPE_GLOBAL_TEMPO,
        pa::GlobalTempoMessage {
            action: pa::message_action::Enum::Update as i32,
            params: vec![Param {
                index: Some(param::Index::Index(1)),
                param_values: vec![ParamValue {
                    value: Some(param_value::Value::FloatValue(if global {
                        1.0
                    } else {
                        0.0
                    })),
                }],
                ..Default::default()
            }],
            ..Default::default()
        },
    )
}

/// Set the downstream master level. The QC wire value is normalized while the
/// hardware and QC Control display it as 0-100. Never include `calibrate` in a
/// level write: on the device that field opens the calibration workflow.
pub fn set_master_volume(volume: f32) -> OutboundMessage {
    OutboundMessage::encoded(
        17,
        pa::MasterVolumeMessage {
            action: pa::message_action::Enum::Update as i32,
            volume: Some(pa::master_volume_message::Volume::Volume(
                volume.clamp(0.0, 1.0),
            )),
            ..Default::default()
        },
    )
}

fn grid_update(preset: BinaryPreset) -> OutboundMessage {
    OutboundMessage::encoded(
        1,
        pa::GridMessage {
            action: pa::message_action::Enum::Update as i32,
            preset: Some(pa::grid_message::Preset::Preset(preset)),
            ..Default::default()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialization_order_and_subscriptions_have_one_source() {
        let messages = initialization();
        assert_eq!(messages[0].message_type, 10);
        assert_eq!(messages[1], read(51));
        assert_eq!(messages[2], connection(true));
        assert_eq!(
            messages[3..]
                .iter()
                .map(|message| message.message_type)
                .collect::<Vec<_>>(),
            profile::LIVE_SUBSCRIPTIONS
        );
    }

    #[test]
    fn shared_commands_match_the_verified_android_wire_shapes() {
        assert_eq!(select_scene(3).payload, [0x08, 0x01, 0x18, 0x03]);
        assert_eq!(show_tuner(true).payload, [0x08, 0x01, 0x18, 0x01]);
        assert_eq!(show_gig_view(false).payload, [0x08, 0x01, 0x18, 0x00]);
        assert_eq!(acknowledge_capture_dialog(true).message_type, 36);
        assert_eq!(
            acknowledge_capture_dialog(true).payload,
            [0x08, 0x01, 0x28, 0x01]
        );
        assert_eq!(
            acknowledge_capture_dialog(false).payload,
            [0x08, 0x01, 0x28, 0x00]
        );
        assert_eq!(keepalive().payload, [0x08, 0x01]);
        assert_eq!(read(51).payload, [0x08, 0x03]);
        assert_eq!(read_version().payload, [0x08, 0x03]);
        assert_eq!(read_tuner().message_type, 6);
        assert_eq!(read_tuner().payload, [0x08, 0x03]);
        assert_eq!(set_tuner_input(8).payload, [0x08, 0x01, 0x18, 0x08]);
        assert_eq!(set_tuner_mute(true).payload, [0x08, 0x01, 0x28, 0x01]);
        assert_eq!(set_tuner_mute(false).payload, [0x08, 0x01, 0x28, 0x00]);
        assert_eq!(
            set_tuner_reference(2.0).payload,
            [0x08, 0x01, 0x25, 0x00, 0x00, 0x00, 0x40]
        );
        assert_eq!(undo().payload, [0x08, 0x01, 0x28, 0x01]);
        assert_eq!(redo().payload, [0x08, 0x01, 0x30, 0x01]);
        assert_eq!(
            set_device_name("Stage QC").payload,
            [0x08, 0x01, 0x7a, 0x08, b'S', b't', b'a', b'g', b'e', b' ', b'Q', b'C']
        );
        assert_eq!(read_inhibited_modules().payload, [0x08, 0x03]);
        assert_eq!(
            preset_screenshot("My Presets", 12, false, 9).payload,
            [
                0x08, 0x03, 0x10, 0x09, 0x1a, 0x0a, b'M', b'y', b' ', b'P', b'r', b'e', b's', b'e',
                b't', b's', 0x28, 0x0c
            ]
        );
        assert_eq!(capture_screen().payload, [0x08, 0x03, 0x22, 0x00]);
        let tap = screen_tap(184.0, 147.0);
        assert_eq!(
            tap[0].payload,
            [0x08, 0x01, 0x1a, 0x0a, 0x0d, 0x00, 0x00, 0x38, 0x43, 0x15, 0x00, 0x00, 0x13, 0x43]
        );
        assert_eq!(
            tap[1].payload,
            [
                0x08, 0x01, 0x1a, 0x0c, 0x0d, 0x00, 0x00, 0x38, 0x43, 0x15, 0x00, 0x00, 0x13, 0x43,
                0x18, 0x01
            ]
        );
    }

    #[test]
    fn parameter_and_bypass_commands_round_trip_through_the_schema() {
        let numeric = set_parameter_numeric(2, 5, 7, 0.25);
        let grid = pa::GridMessage::decode(numeric.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        let parameter = &preset.chains[0].models[0].params[0];
        assert_eq!(preset.chains[0].row, Some(chain::Row::Row(2)));
        assert_eq!(
            preset.chains[0].models[0].column,
            Some(model::Column::Column(5))
        );
        assert_eq!(parameter.index, Some(param::Index::Index(7)));
        assert!(matches!(
            parameter.param_values[0].value,
            Some(param_value::Value::FloatValue(value)) if value == 0.25
        ));

        let bypass = set_bypass(1, 4, true);
        let grid = pa::GridMessage::decode(bypass.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        assert!(preset.bypass[0].col_bypass[0].scene_bypass[0].bypass);
    }

    #[test]
    fn io_port_updates_send_exactly_one_field_per_message() {
        let messages = set_input_port(2, Some(0.4), Some(0.875), Some(0.5), Some(0.0));
        assert_eq!(messages.len(), 4);
        for message in messages {
            assert_eq!(message.message_type, 3);
            let decoded = pa::IoSettingsMessage::decode(message.payload.as_slice()).unwrap();
            let pa::io_settings_message::Settings::Settings(settings) = decoded.settings.unwrap();
            assert_eq!(settings.in_port.len(), 1);
            let port = &settings.in_port[0];
            assert_eq!(port.input_port_id, 2);
            let populated = [
                port.level.is_some(),
                port.input_zmode.is_some(),
                port.input_type.is_some(),
                port.ground_lift.is_some(),
            ]
            .into_iter()
            .filter(|value| *value)
            .count();
            assert_eq!(populated, 1);
        }

        let messages = set_output_port(1, Some(0.25), Some(1.0), Some(true));
        assert_eq!(messages.len(), 3);
        for message in messages {
            let decoded = pa::IoSettingsMessage::decode(message.payload.as_slice()).unwrap();
            let pa::io_settings_message::Settings::Settings(settings) = decoded.settings.unwrap();
            let port = &settings.out_port[0];
            let populated = [
                port.level.is_some(),
                port.ground_lift.is_some(),
                port.mute.is_some(),
            ]
            .into_iter()
            .filter(|value| *value)
            .count();
            assert_eq!(populated, 1, "QC drops some coalesced I/O fields");
        }

        let messages = set_usb_port(Some(0.2), Some(0.5), Some(1.0));
        assert_eq!(messages.len(), 3);
        for message in messages {
            let decoded = pa::IoSettingsMessage::decode(message.payload.as_slice()).unwrap();
            let pa::io_settings_message::Settings::Settings(settings) = decoded.settings.unwrap();
            let pa::port_settings::UsbPort::UsbPort(port) = settings.usb_port.unwrap();
            let populated = [
                port.level.is_some(),
                port.hp_select.is_some(),
                port.dry_wet.is_some(),
            ]
            .into_iter()
            .filter(|value| *value)
            .count();
            assert_eq!(populated, 1);
        }
    }

    #[test]
    fn io_midi_and_pairing_shapes_match_hardware_verified_upstream() {
        let midi = set_midi_thru(true);
        let decoded = pa::IoSettingsMessage::decode(midi.payload.as_slice()).unwrap();
        let pa::io_settings_message::Settings::Settings(settings) = decoded.settings.unwrap();
        let pa::port_settings::MidiPort::MidiPort(midi) = settings.midi_port.unwrap();
        assert!(matches!(
            midi.midi_thru,
            Some(pa::midi_port_settings::MidiThru::MidiThru(1.0))
        ));

        let pairing = set_output_pairing(None, Some(false));
        let decoded = pa::IoSettingsMessage::decode(pairing.payload.as_slice()).unwrap();
        assert!(decoded.xlr1_2_linked.is_none());
        assert!(matches!(
            decoded.out3_4_linked,
            Some(pa::io_settings_message::Out34Linked::Out34Linked(false))
        ));
    }

    #[test]
    fn parameter_assignment_updates_are_sparse_and_preserve_reversed_ranges() {
        let scene_mode = set_parameter_scene_mode(2, 5, 7, true);
        let grid = pa::GridMessage::decode(scene_mode.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        let parameter = &preset.chains[0].models[0].params[0];
        assert_eq!(preset.chains[0].row, Some(chain::Row::Row(2)));
        assert_eq!(
            preset.chains[0].models[0].column,
            Some(model::Column::Column(5))
        );
        assert_eq!(parameter.index, Some(param::Index::Index(7)));
        assert_eq!(
            parameter.scene_mode,
            Some(param::SceneMode::SceneMode(true))
        );
        assert!(parameter.param_values.is_empty());
        assert!(parameter.expression.is_none());

        let expression = set_parameter_expression(1, 3, 9, 2, 0.85, 0.1);
        let grid = pa::GridMessage::decode(expression.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        let parameter = &preset.chains[0].models[0].params[0];
        assert_eq!(parameter.index, Some(param::Index::Index(9)));
        assert_eq!(parameter.expression, Some(param::Expression::Expression(2)));
        assert_eq!(
            parameter.expression_min,
            Some(param::ExpressionMin::ExpressionMin(0.85))
        );
        assert_eq!(
            parameter.expression_max,
            Some(param::ExpressionMax::ExpressionMax(0.1))
        );
        assert!(parameter.param_values.is_empty());
        assert!(parameter.scene_mode.is_none());

        let bypass = set_expression_bypass(2, 4, 1, 2, true, 250, true);
        let grid = pa::GridMessage::decode(bypass.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        let model = &preset.chains[0].models[0];
        assert_eq!(preset.chains[0].row, Some(chain::Row::Row(2)));
        assert_eq!(model.column, Some(model::Column::Column(4)));
        assert_eq!(model.bypass_expression[0].expression, 1);
        assert_eq!(model.bypass_expression[0].expression_min, 0.0);
        assert_eq!(model.bypass_expression[0].expression_max, 1.0);
        assert_eq!(model.expression_bypass_info[0].r#type, 2);
        assert!(model.expression_bypass_info[0].invert);
        assert_eq!(model.expression_bypass_info[0].delay_ms, 250);
        assert!(model.expression_bypass_info[0].latch_emulation);
        assert!(model.params.is_empty());

        let splitter_scene = set_parameter_scene_mode(0, 8, 4, true);
        let grid = pa::GridMessage::decode(splitter_scene.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        assert!(preset.chains[0].models.is_empty());
        assert!(preset.chains[0].combined_splitter[0].hash.is_none());
        assert_eq!(
            preset.chains[0].combined_splitter[0].params[0].index,
            Some(param::Index::Index(4))
        );
        assert_eq!(
            preset.chains[0].combined_splitter[0].params[0].scene_mode,
            Some(param::SceneMode::SceneMode(true))
        );

        let mixer_expression = set_parameter_expression(2, 9, 3, 1, 0.2, 0.9);
        let grid = pa::GridMessage::decode(mixer_expression.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        let mixer = &preset.chains[0].mixer[0];
        assert_eq!(mixer.hash, Some(model::Hash::Hash(11_000)));
        assert_eq!(
            mixer.params[0].expression,
            Some(param::Expression::Expression(1))
        );
    }

    #[test]
    fn splitter_and_mixer_parameters_use_their_native_chain_containers() {
        let splitter = set_routing_parameter(0, "splitter", 5, 0.25);
        let grid = pa::GridMessage::decode(splitter.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        let chain = &preset.chains[0];
        assert_eq!(chain.row, Some(chain::Row::Row(0)));
        assert!(chain.models.is_empty());
        assert!(chain.combined_splitter[0].hash.is_none());
        assert_eq!(
            chain.combined_splitter[0].params[0].index,
            Some(param::Index::Index(5))
        );

        let mixer = set_routing_parameter(2, "mixer", 3, 0.75);
        let grid = pa::GridMessage::decode(mixer.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        let model = &preset.chains[0].mixer[0];
        assert_eq!(model.hash, Some(model::Hash::Hash(11_000)));
        assert_eq!(model.params[0].index, Some(param::Index::Index(3)));
    }

    #[test]
    fn lane_control_updates_use_their_native_chain_containers() {
        let input = set_lane_control_parameter(1, "inputGate", 2, 0.4);
        let grid = pa::GridMessage::decode(input.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        let chain = &preset.chains[0];
        assert!(chain.models.is_empty());
        assert!(chain.output_control.is_empty());
        assert_eq!(chain.input_control[0].hash, Some(model::Hash::Hash(28_000)));
        assert_eq!(
            chain.input_control[0].params[0].index,
            Some(param::Index::Index(2))
        );

        let output = set_lane_control_scene_mode(3, "laneOutput", 0, true);
        let grid = pa::GridMessage::decode(output.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        let control = &preset.chains[0].output_control[0];
        assert_eq!(control.hash, Some(model::Hash::Hash(23_000)));
        assert_eq!(
            control.params[0].scene_mode,
            Some(param::SceneMode::SceneMode(true))
        );
        assert!(
            control.params[0].param_values.is_empty(),
            "scene-mode metadata must travel alone"
        );
    }

    #[test]
    fn stomp_metadata_updates_are_sparse_and_keyed_by_footswitch() {
        let momentary = set_stomp_momentary(4, true);
        let grid = pa::GridMessage::decode(momentary.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        assert!(matches!(preset.stomp_is_momentary.get(&4), Some(true)));
        assert!(preset.stomp_mode_assignments.is_empty());
        assert!(preset.stomp_labels.is_empty());
        assert!(preset.single_stomp_labels.is_empty());

        let label = set_stomp_label(7, "Solo".into(), true);
        let grid = pa::GridMessage::decode(label.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        assert_eq!(
            preset.single_stomp_labels.get(&7).map(String::as_str),
            Some("Solo")
        );
        assert!(preset.stomp_labels.is_empty());
        assert!(preset.stomp_is_momentary.is_empty());
    }

    #[test]
    fn preset_midi_out_uses_midi_settings_and_preserves_source_slots() {
        let message = MidiOutMessage {
            r#type: 2,
            channel: 4,
            param1: 30,
            param2: 5,
            param3: 120,
        };
        let outbound = set_midi_out(7, vec![message.clone()], false);
        assert_eq!(outbound.message_type, 8);
        let decoded = pa::MidiSettingsMessage::decode(outbound.payload.as_slice()).unwrap();
        assert_eq!(decoded.action, pa::message_action::Enum::Update as i32);
        assert!(decoded.preset_load_messages.is_none());
        let Some(pa::midi_settings_message::GeneralMidiMessages::GeneralMidiMessages(groups)) =
            decoded.general_midi_messages
        else {
            panic!("general MIDI messages missing");
        };
        assert_eq!(groups.messages.len(), 1);
        assert_eq!(
            groups.messages[0].source,
            Some(pa::general_midi_message::Source::Source(7))
        );
        assert_eq!(groups.messages[0].msg[0].r#type, message.r#type);
        assert_eq!(groups.messages[0].msg[0].param3, message.param3);

        let outbound = set_midi_out(0, vec![message], true);
        let decoded = pa::MidiSettingsMessage::decode(outbound.payload.as_slice()).unwrap();
        assert!(decoded.general_midi_messages.is_none());
        assert!(matches!(
            decoded.preset_load_messages,
            Some(pa::midi_settings_message::PresetLoadMessages::PresetLoadMessages(_))
        ));
    }

    #[test]
    fn scene_management_matches_the_hardware_verified_message_shapes() {
        let copy = copy_scene(1, 3, true);
        assert_eq!(copy.message_type, 22);
        let decoded = pa::SceneCopyMessage::decode(copy.payload.as_slice()).unwrap();
        assert_eq!(
            (decoded.from_index, decoded.to_index, decoded.is_swap),
            (1, 3, true)
        );

        let label = set_scene_label(2, Some("Lead".into()));
        assert_eq!(label.message_type, 23);
        assert_eq!(
            pa::SceneLabelMessage::decode(label.payload.as_slice())
                .unwrap()
                .label,
            "Lead"
        );
        assert_eq!(
            pa::SceneLabelMessage::decode(set_scene_label(2, None).payload.as_slice())
                .unwrap()
                .label,
            " "
        );

        let color = set_scene_color(4, 0xffff02c2);
        assert_eq!(color.message_type, 48);
        assert_eq!(
            pa::SceneColorMessage::decode(color.payload.as_slice())
                .unwrap()
                .color,
            0xffff02c2
        );
    }

    #[test]
    fn tempo_is_clamped_and_normalized_once() {
        let message = set_tempo(280);
        let grid = pa::GridMessage::decode(message.payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        assert!(matches!(
            preset.tempo_program_data[0].params[0].param_values[0].value,
            Some(param_value::Value::FloatValue(value)) if value == 1.0
        ));
    }

    #[test]
    fn tempo_metronome_and_mode_use_distinct_verified_containers() {
        let frames = set_tempo_parameters(vec![(6, 0.5), (10, 2.0 / 3.0)]);
        assert_eq!(frames.len(), 2);
        for (frame, index) in frames.iter().zip([6_u32, 10]) {
            assert_eq!(frame.message_type, 1);
            let grid = pa::GridMessage::decode(frame.payload.as_slice()).unwrap();
            let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
            assert_eq!(
                preset.tempo_program_data[0].params[0].index,
                Some(param::Index::Index(index))
            );
        }
        let mode = set_tempo_mode(true);
        assert_eq!(mode.message_type, 33);
        let decoded = pa::GlobalTempoMessage::decode(mode.payload.as_slice()).unwrap();
        assert_eq!(decoded.params[0].index, Some(param::Index::Index(1)));
        assert!(matches!(
            decoded.params[0].param_values[0].value,
            Some(param_value::Value::FloatValue(1.0))
        ));
    }

    #[test]
    fn master_volume_uses_the_normalized_device_scale_without_calibration() {
        let outbound = set_master_volume(0.57);
        assert_eq!(outbound.message_type, 17);
        let message = pa::MasterVolumeMessage::decode(outbound.payload.as_slice()).unwrap();
        assert_eq!(message.action, pa::message_action::Enum::Update as i32);
        assert_eq!(
            message.volume,
            Some(pa::master_volume_message::Volume::Volume(0.57))
        );
        assert!(message.calibrate.is_none());
    }

    #[test]
    fn device_command_owns_intent_to_wire_selection() {
        assert_eq!(DeviceCommand::SelectScene(3).encode(), select_scene(3));
        assert_eq!(
            DeviceCommand::SetBypass {
                row: 1,
                column: 4,
                bypassed: true
            }
            .encode(),
            set_bypass(1, 4, true)
        );
        assert_eq!(DeviceCommand::Disconnect.encode(), connection(false));
    }

    #[test]
    fn correlated_setlist_positions_carry_the_transaction_id() {
        let outbound = setlist_position_with_request_id(
            "/media/p4/Presets/My Presets",
            42,
            false,
            Some(9_001),
        );
        let decoded = pa::SetlistPositionMessage::decode(outbound.payload.as_slice()).unwrap();
        assert_eq!(
            decoded.request_id,
            Some(pa::setlist_position_message::RequestId::RequestId(9_001))
        );
        assert_eq!(
            decoded.position,
            Some(pa::setlist_position_message::Position::Position(42))
        );
    }

    #[test]
    fn active_setlist_position_reads_are_correlated_and_side_effect_free() {
        let outbound = read_setlist_position(7_321);
        let decoded = pa::SetlistPositionMessage::decode(outbound.payload.as_slice()).unwrap();
        assert_eq!(decoded.action, pa::message_action::Enum::Read as i32);
        assert_eq!(
            decoded.request_id,
            Some(pa::setlist_position_message::RequestId::RequestId(7_321))
        );
        assert!(decoded.position.is_none());
        assert!(decoded.folder_key.is_none());
    }

    #[test]
    fn advanced_device_operations_own_verified_sparse_wire_shapes() {
        let add = DeviceOperation::AddBlock {
            row: 2,
            column: 5,
            model_id: 12_345,
        }
        .encode();
        assert_eq!(add.len(), 1);
        let grid = pa::GridMessage::decode(add[0].payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        assert_eq!(
            preset.chains[0].models[0].hash,
            Some(model::Hash::Hash(12_345))
        );

        let assignment = DeviceOperation::SetFootswitch {
            row: 1,
            column: 3,
            footswitch: Some(6),
        }
        .encode();
        assert_eq!(
            assignment.len(),
            2,
            "assignment must delete stale state before update"
        );

        let split = DeviceOperation::SetChainSplit {
            row: 0,
            split_column: Some(2),
            mix_column: Some(7),
        }
        .encode();
        let grid = pa::GridMessage::decode(split[0].payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        assert_eq!(
            preset.chains[0].split_control_points[0],
            SplitControlPoints { split: 2, mix: 7 }
        );

        let mute = DeviceOperation::SetSplitMute {
            row: 2,
            muted: true,
        }
        .encode();
        let grid = pa::GridMessage::decode(mute[0].payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
        assert_eq!(preset.chains[0].row, Some(chain::Row::Row(2)));
        assert_eq!(
            preset.chains[0].split_bypass,
            vec![SceneBypass { bypass: true }]
        );
        assert!(preset.chains[0].mix_bypass.is_empty());

        let save = DeviceOperation::SavePreset {
            setlist_key: "/media/p4/Presets/My Presets".into(),
            position: 220,
            name: "Shared Rust save".into(),
            instrument: 2,
        }
        .encode();
        assert_eq!(save[0].message_type, 4);
        let file = pa::FileMessage::decode(save[0].payload.as_slice()).unwrap();
        let pa::file_message::Folder::Folder(folder) = file.folder.unwrap();
        assert_eq!(folder.files.len(), 1);
        assert_eq!(
            folder.files[0].index,
            Some(pa::product_data::Index::Index(220))
        );
    }

    #[test]
    fn general_settings_writes_are_sparse_and_nested_values_are_complete() {
        let brightness = DeviceOperation::SetGeneralInteger {
            setting: "screenBrightness".into(),
            value: 59,
        }
        .encode();
        let decoded = pa::GeneralSettingsMessage::decode(brightness[0].payload.as_slice()).unwrap();
        assert_eq!(decoded.action, pa::message_action::Enum::Update as i32);
        assert!(decoded.screen_brightness.is_some());
        assert!(decoded.led_brightness.is_none());
        assert!(
            decoded.power_option.is_none(),
            "safe setting writes must never carry power commands"
        );
        assert!(decoded.reset_wifi_networks.is_none());

        let assignment = DeviceOperation::SetMasterVolumeAssignment {
            out12: true,
            out34: false,
            send12: true,
            headphones: false,
        }
        .encode();
        let decoded = pa::GeneralSettingsMessage::decode(assignment[0].payload.as_slice()).unwrap();
        let pa::general_settings_message::MasterVolumeAssignment::MasterVolumeAssignment(value) =
            decoded.master_volume_assignment.unwrap();
        assert!(value.out12);
        assert!(!value.out34);
        assert!(value.send12);
        assert!(!value.headphones);
    }

    #[test]
    fn global_eq_and_mode_cycle_writes_are_typed_and_sparse() {
        let bypass = set_global_eq_bypassed(true);
        assert_eq!(bypass.message_type, 38);
        let decoded = pa::GlobalEqMessage::decode(bypass.payload.as_slice()).unwrap();
        assert_eq!(decoded.action, pa::message_action::Enum::Update as i32);
        assert!(matches!(
            decoded.bypassed,
            Some(pa::global_eq_message::Bypassed::Bypassed(true))
        ));
        assert!(decoded.parameters.is_empty());

        let controls = set_global_eq_parameters(&[(0, 0.75), (4, 1.0)]);
        let decoded = pa::GlobalEqMessage::decode(controls.payload.as_slice()).unwrap();
        assert!(decoded.bypassed.is_none());
        assert_eq!(decoded.parameters.len(), 2);
        assert_eq!(decoded.parameters[0].parameter_index, 0);
        assert_eq!(decoded.parameters[1].value, 1.0);

        let cycle = set_mode_cycle(&[7, 1, 2]);
        assert_eq!(cycle.message_type, 14);
        let decoded = pa::ModeMessage::decode(cycle.payload.as_slice()).unwrap();
        let pa::mode_message::AvailableModes::AvailableModes(available) =
            decoded.available_modes.unwrap();
        assert_eq!(available.modes, vec![7, 1, 2]);

        assert_eq!(read_global_eq().message_type, 38);
        assert_eq!(read_mode_cycle().message_type, 14);
        assert_eq!(read_looper_status().message_type, 28);
    }

    #[test]
    fn library_reads_and_mutations_use_the_verified_file_protocol() {
        let recents = read_recents_favorites(false, 91);
        assert_eq!(recents.message_type, 20);
        let decoded = pa::RecentsFavoritesMessage::decode(recents.payload.as_slice()).unwrap();
        assert_eq!(decoded.action, pa::message_action::Enum::Read as i32);
        assert!(!decoded.is_favorites);
        assert!(matches!(
            decoded.request_id,
            Some(pa::recents_favorites_message::RequestId::RequestId(91))
        ));

        let favorite = set_favorite(
            "Stage".into(),
            "/media/p4/Presets/Live".into(),
            "Live".into(),
            false,
            true,
        );
        let decoded = pa::RecentsFavoritesMessage::decode(favorite.payload.as_slice()).unwrap();
        assert_eq!(decoded.action, pa::message_action::Enum::Create as i32);
        assert!(decoded.is_favorites);
        assert_eq!(decoded.items[0].name, "Stage");

        let unfavorite = set_favorite(
            "Stage".into(),
            "/media/p4/Presets/Live".into(),
            "Live".into(),
            false,
            false,
        );
        let decoded = pa::RecentsFavoritesMessage::decode(unfavorite.payload.as_slice()).unwrap();
        assert_eq!(decoded.action, pa::message_action::Enum::Delete as i32);

        let pinned = set_model_pinned(12_345, true);
        let decoded = pa::PinnedModelsMessage::decode(pinned.payload.as_slice()).unwrap();
        assert_eq!(decoded.action, pa::message_action::Enum::Create as i32);
        assert_eq!(decoded.models, vec![12_345]);
        let pinned = set_model_pinned(12_345, false);
        let decoded = pa::PinnedModelsMessage::decode(pinned.payload.as_slice()).unwrap();
        assert_eq!(decoded.action, pa::message_action::Enum::Delete as i32);
        assert_eq!(decoded.models, vec![12_345]);

        let listing = read_library_files("local_ir_root".into(), 1, 92);
        let decoded = pa::FileMessage::decode(listing.payload.as_slice()).unwrap();
        assert_eq!(decoded.action, pa::message_action::Enum::Read as i32);
        assert!(matches!(
            decoded.request_id,
            Some(pa::file_message::RequestId::RequestId(92))
        ));
        assert!(matches!(
            decoded.r#type,
            Some(pa::file_message::Type::Type(1))
        ));

        for (message, action) in [
            (
                create_setlist("Tour".into()),
                pa::message_action::Enum::Create,
            ),
            (
                delete_setlist("Tour".into()),
                pa::message_action::Enum::Delete,
            ),
        ] {
            let decoded = pa::FileMessage::decode(message.payload.as_slice()).unwrap();
            assert_eq!(decoded.action, action as i32);
            let pa::file_message::Folder::Folder(folder) = decoded.folder.unwrap();
            assert_eq!(
                folder.key,
                Some(pa::folder_info::Key::Key("/media/p4/Presets/Tour".into()))
            );
        }

        let moved = move_preset("/media/p4/Presets/Live".into(), "Stage".into(), 17);
        let decoded = pa::FileMessage::decode(moved.payload.as_slice()).unwrap();
        assert_eq!(decoded.action, pa::message_action::Enum::Move as i32);
        let pa::file_message::Folder::Folder(source) = decoded.folder.unwrap();
        assert_eq!(
            source.files[0].key,
            Some(pa::product_data::Key::Key(
                "/media/p4/Presets/Live/Stage.pb".into()
            ))
        );
        let pa::file_message::ToFolder::ToFolder(destination) = decoded.to_folder.unwrap();
        assert_eq!(
            destination.files[0].index,
            Some(pa::product_data::Index::Index(17))
        );

        let deleted = delete_preset("/media/p4/Presets/Live".into(), "Stage".into());
        let decoded = pa::FileMessage::decode(deleted.payload.as_slice()).unwrap();
        let pa::file_message::Folder::Folder(folder) = decoded.folder.unwrap();
        assert_eq!(
            folder.files[0].key,
            Some(pa::product_data::Key::Key(
                "/media/p4/Presets/Live/Stage.pb".into()
            ))
        );
    }

    #[test]
    fn capture_and_ir_loads_compose_model_and_text_updates_in_order() {
        fn text_update(message: &OutboundMessage) -> (u32, String) {
            assert_eq!(message.message_type, 1);
            let grid = pa::GridMessage::decode(message.payload.as_slice()).unwrap();
            let pa::grid_message::Preset::Preset(preset) = grid.preset.unwrap();
            let parameter = &preset.chains[0].models[0].params[0];
            let value = parameter.param_values[0].value.as_ref().unwrap();
            let param_value::Value::StringValue(value) = value else {
                panic!("expected text parameter update")
            };
            let Some(param::Index::Index(index)) = parameter.index else {
                panic!("expected parameter index")
            };
            (index, value.clone())
        }

        let capture = DeviceOperation::LoadCapture {
            row: 1,
            column: 2,
            key: "capture/".into(),
            name: "Crunch".into(),
            model_id: Some(14_000),
        }
        .encode();
        assert_eq!(capture.len(), 2);
        let grid = pa::GridMessage::decode(capture[0].payload.as_slice()).unwrap();
        let pa::grid_message::Preset::Preset(model) = grid.preset.unwrap();
        assert_eq!(
            model.chains[0].models[0].hash,
            Some(model::Hash::Hash(14_000))
        );
        assert_eq!(text_update(&capture[1]), (5, "capture/Crunch".into()));

        let ir = DeviceOperation::LoadIr {
            row: 2,
            column: 3,
            key: "ir/key".into(),
            name: "Room".into(),
            slot: 1,
            model_id: None,
        }
        .encode();
        assert_eq!(ir.len(), 2);
        assert_eq!(text_update(&ir[0]), (10, "ir/key".into()));
        assert_eq!(text_update(&ir[1]), (23, "Room".into()));
    }

    #[test]
    fn checked_operation_encoding_rejects_invalid_dispatch_and_signed_overflow() {
        let invalid_setting = DeviceOperation::SetGeneralInteger {
            setting: "notASetting".into(),
            value: 1,
        };
        assert!(matches!(
            invalid_setting.try_encode(),
            Err(CommandEncodeError::UnsupportedValue {
                field: "GeneralSettings integer",
                ..
            })
        ));

        let invalid_control = DeviceOperation::SetLaneControlParameter {
            row: 0,
            control: "sidechain".into(),
            parameter_index: 0,
            value: 0.5,
        };
        assert!(matches!(
            invalid_control.try_encode(),
            Err(CommandEncodeError::UnsupportedValue {
                field: "lane control",
                ..
            })
        ));

        let overflowing_position = DeviceOperation::MovePreset {
            setlist_key: "/media/p4/Presets/Live".into(),
            name: "Stage".into(),
            position: i32::MAX as u32 + 1,
        };
        assert_eq!(
            overflowing_position.try_encode(),
            Err(CommandEncodeError::SignedFieldOverflow { field: "position" })
        );
    }

    #[test]
    fn checked_operation_encoding_preserves_valid_wire_bytes() {
        let operation = DeviceOperation::SetGeneralToggle {
            setting: "midiOverUsb".into(),
            enabled: true,
        };
        assert_eq!(operation.clone().try_encode().unwrap(), operation.encode());
    }
}
