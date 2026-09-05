//! Platform-neutral validation and planning for public gateway writes.
//!
//! Hosts execute the returned plan using their own HID/MIDI implementation and
//! feed readback into [`GatewaySnapshot`](crate::GatewaySnapshot).

use crate::{GatewaySnapshot, PresetLibrary};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use qc_protocol::commands::{DeviceCommand, DeviceOperation};
use qc_protocol::responses::{
    decode_captured_screen, decode_device_identity, decode_general_settings, decode_global_eq,
    decode_global_tempo_settings, decode_inhibited_modules, decode_io_settings,
    decode_library_files, decode_looper_status, decode_mode_cycle, decode_pinned_models,
    decode_preset_screenshot, decode_recents_favorites, decode_tuner_settings, PngImage,
};
use qc_protocol::state::MidiOutMessage;
use qc_protocol::{domain, profile};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn finalize_device_backup(raw: &str, requested_name: &str) -> Result<Value, String> {
    let name = requested_name
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect::<String>()
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("Backup name cannot be empty.".into());
    }
    let mut document: Value = serde_json::from_str(raw)
        .map_err(|error| format!("The Quad Cortex returned malformed backup JSON: {error}"))?;
    if !document.is_object()
        || document.get("type").and_then(Value::as_str) != Some("backup")
        || document.get("creator").and_then(Value::as_str) != Some("quad")
    {
        return Err("The Quad Cortex returned an unsupported backup document.".into());
    }
    document["name"] = Value::String(name);
    Ok(document)
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlannedWrite {
    HidCommand(DeviceCommand),
    HidOperation(DeviceOperation),
    MidiControlChange { controller: u8, value: u8 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct HostMidiPlan {
    pub controller: u8,
    pub value: u8,
    pub detail: String,
}

pub fn is_host_midi_method(method: &str) -> bool {
    crate::generated_gateway::PERFORMANCE_MIDI_METHODS.contains(&method)
}

/// Shared mapping for physical QC controls. Both native hosts execute this
/// plan with their persistent platform MIDI handle.
pub fn plan_host_midi(method: &str, params: &Value) -> Result<HostMidiPlan, String> {
    match method {
        "device.pressFootswitch" => {
            let index = bounded_u32(params, "index", domain::SCENE_COUNT - 1)? as u8;
            Ok(HostMidiPlan {
                controller: profile::FOOTSWITCH_BASE_CONTROLLER + index,
                value: profile::MIDI_PRESSED_VALUE,
                detail: format!("Footswitch index {index} sent"),
            })
        }
        "device.tapTempo" => Ok(HostMidiPlan {
            controller: profile::TAP_TEMPO_CONTROLLER,
            value: profile::MIDI_PRESSED_VALUE,
            detail: "Tap Tempo sent".into(),
        }),
        "device.showTuner" | "device.showGigView" => {
            let shown = params
                .get("shown")
                .and_then(Value::as_bool)
                .ok_or_else(|| "shown must be a boolean".to_string())?;
            let (controller, feature) = if method == "device.showTuner" {
                (profile::TUNER_CONTROLLER, "Tuner")
            } else {
                (profile::GIG_VIEW_CONTROLLER, "Gig View")
            };
            Ok(HostMidiPlan {
                controller,
                value: if shown {
                    profile::MIDI_FEATURE_ON_VALUE
                } else {
                    profile::MIDI_FEATURE_OFF_VALUE
                },
                detail: format!("{feature} {}", if shown { "opened" } else { "closed" }),
            })
        }
        "device.selectModeSlot" => {
            let slot = bounded_u32(params, "slot", 2)? as u8;
            Ok(HostMidiPlan {
                controller: profile::MODE_SLOT_CONTROLLER,
                value: slot,
                detail: format!("Mode slot {} sent", slot + 1),
            })
        }
        "device.controlLooper" => {
            let command = required_text(params, "command")?;
            let supplied = params.get("value").filter(|value| !value.is_null());
            let (controller, value, needs_value, maximum) = match command.as_str() {
                "open" => (48, 0, false, 0),
                "close" => (48, 127, false, 0),
                "duplicate" => (49, 127, false, 0),
                "oneShot" => (50, 127, false, 0),
                "halfSpeed" => (51, 127, false, 0),
                "punch" => (52, 127, false, 0),
                "record" => (53, 127, false, 0),
                "play" => (54, 127, false, 0),
                "reverse" => (55, 127, false, 0),
                "undoRedo" => (56, 127, false, 0),
                "duplicateMode" => (57, 0, true, 1),
                "quantize" => (58, 0, true, 9),
                "midiClockStart" => (59, 0, true, 1),
                "performMode" => (60, 0, true, 1),
                "routingMode" => (61, 0, true, 13),
                _ => return Err("unsupported Looper X command".into()),
            };
            if !needs_value && supplied.is_some() {
                return Err(format!("{command} does not accept value"));
            }
            let value = if needs_value {
                supplied
                    .and_then(Value::as_u64)
                    .and_then(|value| u8::try_from(value).ok())
                    .filter(|value| *value <= maximum)
                    .ok_or_else(|| format!("{command} requires value 0 through {maximum}"))?
            } else {
                value
            };
            Ok(HostMidiPlan {
                controller,
                value,
                detail: format!("Looper X {command} sent"),
            })
        }
        _ => Err(format!("Gateway method does not use host MIDI: {method}")),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GatewayWritePlan {
    pub write: PlannedWrite,
    pub detail: String,
    pub verification: GatewayVerification,
}

/// Whether a gateway write may be repeated before authoritative readback confirms it.
///
/// This is protocol policy, not host transport policy: both native hosts must make
/// the same decision. Relative navigation and structural mutations are deliberately
/// excluded because repeating them can produce a different device state.
pub fn gateway_write_retryable(method: &str) -> bool {
    matches!(
        method,
        "device.recallPreset"
            | "device.reloadPreset"
            | "device.selectScene"
            | "device.toggleBypass"
            | "device.setParameter"
            | "device.setLaneControlParameter"
            | "device.setLaneControlSceneMode"
            | "device.setParameterSceneMode"
            | "device.setParameterExpression"
            | "device.setExpressionBypass"
            | "device.setBlockFootswitch"
            | "device.setStompMomentary"
            | "device.setStompLabel"
            | "device.setMidiOut"
            | "device.setPresetLoadMidiOut"
            | "device.setChainInput"
            | "device.setChainOutput"
            | "device.setChainSplit"
            | "device.setSplitMute"
            | "device.setTempo"
            | "device.setMasterVolume"
            | "device.selectModeSlot"
            | "device.showTuner"
            | "device.showGigView"
    )
}

/// Whether a gateway write must return as soon as its bytes reach the native
/// transport and let the pushed state stream reconcile the authoritative QC
/// result. Both hosts use this policy so realtime controls never acquire a
/// platform-specific readback delay or snapshot polling loop.
pub fn gateway_write_is_realtime(method: &str) -> bool {
    matches!(
        method,
        "device.selectScene"
            | "device.command.scene"
            | "device.toggleBypass"
            | "device.command.bypass"
            | "device.setTempo"
            | "device.command.tempo"
            | "device.setMasterVolume"
            | "device.pressFootswitch"
            | "device.tapTempo"
            | "device.selectModeSlot"
            | "device.showTuner"
            | "device.showGigView"
            | "device.controlLooper"
    )
}

/// Authoritative state predicate associated with a planned write. Hosts only
/// decide how to wait for a fresh device observation; the state that proves a
/// command landed is shared across Windows and Android.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GatewayVerification {
    None,
    Scene {
        scene: u32,
    },
    SceneLabel {
        scene: u32,
        label: Option<String>,
    },
    SceneColor {
        scene: u32,
        color: String,
    },
    SceneCopy {
        from_scene: u32,
        to_scene: u32,
        swap: bool,
        from_label: String,
        to_label: String,
        from_color: Option<String>,
        to_color: Option<String>,
    },
    Tempo {
        bpm: u32,
    },
    MasterVolume {
        value: u32,
    },
    Bypass {
        row: u32,
        column: u32,
        bypassed: bool,
    },
    Parameter {
        row: u32,
        column: u32,
        parameter_index: u32,
        value: f64,
    },
    Block {
        row: u32,
        column: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_id: Option<u32>,
        present: bool,
    },
    Footswitch {
        row: u32,
        column: u32,
        footswitch: Option<u32>,
    },
    StompMomentary {
        footswitch: u32,
        momentary: bool,
    },
    StompLabel {
        footswitch: u32,
        label: String,
    },
    MidiOut {
        source: Option<u32>,
        messages: Vec<MidiOutMessage>,
    },
    ExpressionBypass {
        row: u32,
        column: u32,
        pedal: u32,
        mode: u32,
        invert: bool,
        delay_ms: u32,
        latch_emulation: bool,
    },
    RouteInput {
        row: u32,
        input_id: u32,
    },
    RouteOutput {
        row: u32,
        output_id: u32,
    },
    RouteSplit {
        row: u32,
        split_column: Option<i32>,
        mix_column: Option<i32>,
    },
    SplitMute {
        row: u32,
        muted: bool,
    },
    Preset {
        setlist_key: String,
        position: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        require_clean: bool,
    },
}

/// Event-driven lifecycle for a native device write.  Platform hosts own only
/// the OS I/O handle and feed observed snapshots into this shared state
/// machine; freshness, matching, and timeout semantics must not drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayTransactionState {
    Pending,
    Verified,
    TimedOut,
}

/// Merge optimistic UI state into gateway arguments using the canonical field
/// names understood by all native hosts.
pub fn merge_expected_state(params: &Value, expected: &Value) -> Value {
    let mut merged = params.as_object().cloned().unwrap_or_default();
    let Some(expected) = expected.as_object() else {
        return Value::Object(merged);
    };
    for (target, sources) in [
        ("expectedPresetName", &["presetName"][..]),
        ("expectedPosition", &["position", "presetPosition"][..]),
        ("expectedScene", &["activeScene", "scene"][..]),
        ("expectedTempo", &["tempo"][..]),
    ] {
        if merged.contains_key(target) {
            continue;
        }
        if let Some(value) = sources.iter().find_map(|key| expected.get(*key)) {
            merged.insert(target.into(), value.clone());
        }
    }
    Value::Object(merged)
}

#[derive(Debug, Clone, PartialEq)]
pub struct GatewayTransaction {
    verification: GatewayVerification,
    after_observation_token: u128,
    deadline_ms: u64,
}

impl GatewayTransaction {
    pub fn new(
        verification: GatewayVerification,
        after_observation_token: u128,
        started_at_ms: u64,
        timeout_ms: u64,
    ) -> Self {
        Self {
            verification,
            after_observation_token,
            deadline_ms: started_at_ms.saturating_add(timeout_ms),
        }
    }

    pub fn state(
        &self,
        snapshot: &GatewaySnapshot,
        parameter_value: Option<f64>,
        observation_token: u128,
        now_ms: u64,
    ) -> GatewayTransactionState {
        if now_ms >= self.deadline_ms {
            GatewayTransactionState::TimedOut
        } else if observation_token > self.after_observation_token
            && self.verification.matches(snapshot, parameter_value)
        {
            GatewayTransactionState::Verified
        } else {
            GatewayTransactionState::Pending
        }
    }

    pub fn remaining_ms(&self, now_ms: u64) -> u64 {
        self.deadline_ms.saturating_sub(now_ms)
    }
}

impl GatewayVerification {
    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }

    /// Whether a fresh device observation can authoritatively prove this
    /// write landed. A missing predicate must never match an arbitrary state
    /// update merely because that update arrived after the write.
    pub fn requires_authoritative_readback(&self) -> bool {
        !self.is_none()
    }

    pub fn parameter_target(&self) -> Option<(u32, u32, u32)> {
        match self {
            Self::Parameter {
                row,
                column,
                parameter_index,
                ..
            } => Some((*row, *column, *parameter_index)),
            _ => None,
        }
    }

    pub fn matches(&self, snapshot: &GatewaySnapshot, parameter_value: Option<f64>) -> bool {
        match self {
            Self::None => false,
            Self::Scene { scene } => snapshot.active_scene == *scene,
            Self::SceneLabel { scene, label } => {
                snapshot
                    .scenes
                    .get(*scene as usize)
                    .is_some_and(|actual| match label {
                        Some(label) => actual == label,
                        None => actual == &format!("Scene {}", (b'A' + *scene as u8) as char),
                    })
            }
            Self::SceneColor { scene, color } => snapshot
                .scene_colors
                .as_ref()
                .and_then(|colors| colors.get(*scene as usize))
                .is_some_and(|actual| actual.eq_ignore_ascii_case(color)),
            Self::SceneCopy {
                from_scene,
                to_scene,
                swap,
                from_label,
                to_label,
                from_color,
                to_color,
            } => {
                let copied_label = snapshot
                    .scenes
                    .get(*to_scene as usize)
                    .is_some_and(|actual| {
                        scene_copy_label_matches(actual, from_label, *from_scene, *to_scene)
                    });
                let copied_color = scene_copy_color_matches(snapshot, *to_scene, from_color);
                let swapped_label = !swap
                    || snapshot
                        .scenes
                        .get(*from_scene as usize)
                        .is_some_and(|actual| {
                            scene_copy_label_matches(actual, to_label, *to_scene, *from_scene)
                        });
                let swapped_color =
                    !swap || scene_copy_color_matches(snapshot, *from_scene, to_color);
                copied_label && copied_color && swapped_label && swapped_color
            }
            Self::Tempo { bpm } => snapshot.tempo == *bpm,
            Self::MasterVolume { value } => snapshot.master_volume == *value,
            Self::Bypass {
                row,
                column,
                bypassed,
            } => {
                snapshot
                    .blocks
                    .iter()
                    .find(|block| block.row == *row && block.column == *column)
                    .and_then(|block| block.bypassed)
                    == Some(*bypassed)
            }
            Self::Parameter { value, .. } => {
                parameter_value.is_some_and(|actual| (actual - value).abs() <= 0.0005)
            }
            Self::Block {
                row,
                column,
                model_id,
                present,
            } => {
                let actual = snapshot
                    .blocks
                    .iter()
                    .find(|block| block.row == *row && block.column == *column);
                if *present {
                    actual.is_some_and(|block| model_id.is_none() || block.model_id == *model_id)
                } else {
                    actual.is_none()
                }
            }
            Self::Footswitch {
                row,
                column,
                footswitch,
            } => snapshot
                .blocks
                .iter()
                .find(|block| block.row == *row && block.column == *column)
                .is_some_and(|block| block.footswitch == *footswitch),
            Self::StompMomentary {
                footswitch,
                momentary,
            } => {
                snapshot
                    .footswitch_states
                    .as_ref()
                    .and_then(|states| states.iter().find(|state| state.index == *footswitch))
                    .and_then(|state| state.momentary)
                    == Some(*momentary)
            }
            Self::StompLabel { footswitch, label } => {
                snapshot
                    .footswitch_states
                    .as_ref()
                    .and_then(|states| states.iter().find(|state| state.index == *footswitch))
                    .and_then(|state| state.label.as_deref())
                    == Some(label.as_str())
            }
            Self::MidiOut { source, messages } => match source {
                Some(source) => {
                    snapshot
                        .midi_out
                        .as_ref()
                        .and_then(|groups| groups.iter().find(|group| group.source == *source))
                        .map(|group| group.messages.as_slice())
                        .unwrap_or_default()
                        == messages.as_slice()
                }
                None => {
                    snapshot.preset_load_midi_out.as_deref().unwrap_or_default()
                        == messages.as_slice()
                }
            },
            Self::ExpressionBypass {
                row,
                column,
                pedal,
                mode,
                invert,
                delay_ms,
                latch_emulation,
            } => snapshot
                .blocks
                .iter()
                .find(|block| block.row == *row && block.column == *column)
                .and_then(|block| block.bypass_expression.as_ref())
                .is_some_and(|actual| {
                    actual.pedal == *pedal
                        && actual.mode == *mode
                        && actual.invert == *invert
                        && actual.delay_ms == *delay_ms
                        && actual.latch_emulation == *latch_emulation
                        && (actual.minimum - 0.0).abs() <= 0.001
                        && (actual.maximum - 1.0).abs() <= 0.001
                }),
            Self::RouteInput { row, input_id } => {
                snapshot
                    .routes
                    .iter()
                    .find(|route| route.row == *row)
                    .and_then(|route| route.input_id)
                    == Some(*input_id)
            }
            Self::RouteOutput { row, output_id } => {
                snapshot
                    .routes
                    .iter()
                    .find(|route| route.row == *row)
                    .and_then(|route| route.output_id)
                    == Some(*output_id)
            }
            Self::RouteSplit {
                row,
                split_column,
                mix_column,
            } => snapshot
                .routes
                .iter()
                .find(|route| route.row == *row)
                .is_some_and(|route| {
                    route.split_column == *split_column && route.mix_column == *mix_column
                }),
            Self::SplitMute { row, muted } => snapshot
                .routes
                .iter()
                .find(|route| route.row == *row)
                .is_some_and(|route| route.split_muted == *muted),
            Self::Preset {
                setlist_key,
                position,
                name,
                require_clean,
            } => {
                snapshot.setlist_key.trim_end_matches('/') == setlist_key.trim_end_matches('/')
                    && snapshot.preset_position == *position
                    && name
                        .as_ref()
                        .is_none_or(|expected| snapshot.preset_name == *expected)
                    && (!require_clean || !snapshot.dirty)
            }
        }
    }
}

fn default_scene_label(scene: u32) -> String {
    format!("Scene {}", (b'A' + scene as u8) as char)
}

fn scene_copy_label_matches(
    actual: &str,
    before: &str,
    before_scene: u32,
    after_scene: u32,
) -> bool {
    actual == before
        || (before == default_scene_label(before_scene)
            && actual == default_scene_label(after_scene))
}

fn scene_copy_color_matches(
    snapshot: &GatewaySnapshot,
    scene: u32,
    expected: &Option<String>,
) -> bool {
    match expected {
        Some(expected) => snapshot
            .scene_colors
            .as_ref()
            .and_then(|colors| colors.get(scene as usize))
            .is_some_and(|actual| actual.eq_ignore_ascii_case(expected)),
        None => true,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PresetRecallPlan {
    pub command: DeviceCommand,
    pub setlist_key: String,
    pub position: u32,
    pub after_position_revision: u64,
    pub require_clean: bool,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PresetMutationStage {
    pub write: PlannedWrite,
    pub verification: GatewayVerification,
    pub timeout_ms: u64,
    pub settle_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetMutationRecord {
    pub setlist_key: String,
    pub position: u32,
    pub name: String,
    pub instrument: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PresetMutationPlan {
    pub stages: Vec<PresetMutationStage>,
    pub detail: String,
    pub saved_name: String,
    pub setlist_key: String,
    pub position: u32,
    pub instrument: i32,
    pub saved_presets: Vec<PresetMutationRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GatewayResponseProjection {
    DeviceIdentity,
    TunerSettings,
    GeneralSettings,
    IoSettings,
    GlobalEq,
    ModeCycle,
    GlobalTempoSettings,
    LooperStatus,
    RecentsFavorites {
        request_id: u64,
    },
    PinnedModels,
    LibraryFiles {
        request_id: u64,
        folder_key: String,
    },
    InhibitedModules,
    PresetScreenshot {
        request_id: u64,
        folder_name: String,
        position: u32,
        is_factory: bool,
    },
    CapturedScreen,
}

fn image_response(image: PngImage) -> Value {
    serde_json::json!({
        "pngBase64": BASE64.encode(image.bytes),
        "width": image.width,
        "height": image.height,
    })
}

impl GatewayResponseProjection {
    /// Decode the planned correlated reply into the public gateway shape.
    /// Keeping this beside the read plan prevents native hosts from owning
    /// subtly different protobuf validation and image projection rules.
    pub fn decode(&self, payload: &[u8]) -> Result<Value, String> {
        match self {
            Self::DeviceIdentity => serde_json::to_value(
                decode_device_identity(payload).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string()),
            Self::TunerSettings => serde_json::to_value(
                decode_tuner_settings(payload).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string()),
            Self::GeneralSettings => serde_json::to_value(
                decode_general_settings(payload).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string()),
            Self::IoSettings => serde_json::to_value(
                decode_io_settings(payload).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string()),
            Self::GlobalEq => {
                serde_json::to_value(decode_global_eq(payload).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())
            }
            Self::ModeCycle => {
                serde_json::to_value(decode_mode_cycle(payload).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())
            }
            Self::GlobalTempoSettings => serde_json::to_value(
                decode_global_tempo_settings(payload).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string()),
            Self::LooperStatus => serde_json::to_value(
                decode_looper_status(payload).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string()),
            Self::RecentsFavorites { request_id } => serde_json::to_value(
                decode_recents_favorites(payload, *request_id)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string()),
            Self::PinnedModels => serde_json::to_value(
                decode_pinned_models(payload).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string()),
            Self::LibraryFiles {
                request_id,
                folder_key,
            } => serde_json::to_value(
                decode_library_files(payload, *request_id, folder_key)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string()),
            Self::InhibitedModules => serde_json::to_value(
                decode_inhibited_modules(payload).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string()),
            Self::PresetScreenshot {
                request_id,
                folder_name,
                position,
                is_factory,
            } => Ok(image_response(
                decode_preset_screenshot(payload, *request_id, folder_name, *position, *is_factory)
                    .map_err(|error| error.to_string())?,
            )),
            Self::CapturedScreen => Ok(image_response(
                decode_captured_screen(payload).map_err(|error| error.to_string())?,
            )),
        }
    }
}

/// Correlated settings read used to prove a global write where CorOS exposes
/// the written value through an existing public read operation.
pub fn gateway_write_readback_method(method: &str) -> Option<&'static str> {
    match method {
        "device.setTunerInput"
        | "device.setTunerMute"
        | "device.restoreTunerAudio"
        | "device.setTunerReference" => Some("device.tunerSettings"),
        "device.setGeneralInteger"
        | "device.setGeneralToggle"
        | "device.setSceneBypassBehavior"
        | "device.setMasterVolumeAssignment"
        | "device.setGlobalBypass" => Some("device.generalSettings"),
        "device.setInputPort"
        | "device.setOutputPort"
        | "device.setUsbPort"
        | "device.setMidiThru"
        | "device.setOutputPairing" => Some("device.ioSettings"),
        "device.setModeCycle" => Some("device.modeCycle"),
        "device.setGlobalEqBypassed" | "device.setGlobalEqBand" | "device.setGlobalEqOutput" => {
            Some("device.globalEq")
        }
        "device.setTempoMetronome" | "device.setTempoMode" => Some("device.globalTempoSettings"),
        _ => None,
    }
}

fn json_number_matches(actual: Option<&Value>, expected: &Value) -> bool {
    actual
        .and_then(Value::as_f64)
        .zip(expected.as_f64())
        .is_some_and(|(actual, expected)| (actual - expected).abs() <= 0.001)
}

fn supplied_fields_match(params: &Value, response: &Value, fields: &[(&str, &str)]) -> bool {
    fields
        .iter()
        .all(|(argument, output)| match params.get(*argument) {
            None | Some(Value::Null) => true,
            Some(expected) if expected.is_number() => {
                json_number_matches(response.get(*output), expected)
            }
            Some(expected) => response.get(*output) == Some(expected),
        })
}

/// Compare a correlated settings reply with the exact fields a write changed.
pub fn gateway_write_readback_matches(method: &str, params: &Value, response: &Value) -> bool {
    let eq_value = |index: i64| {
        response
            .get("parameters")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("parameterIndex").and_then(Value::as_i64) == Some(index))
                    .and_then(|item| item.get("value"))
                    .and_then(Value::as_f64)
            })
    };
    match method {
        "device.setTunerInput" => {
            supplied_fields_match(params, response, &[("inputPortId", "inputPortId")])
        }
        "device.setTunerMute" => supplied_fields_match(params, response, &[("muted", "muted")]),
        "device.restoreTunerAudio" => response.get("muted") == Some(&Value::Bool(false)),
        "device.setTunerReference" => supplied_fields_match(
            params,
            response,
            &[("referenceOffsetHz", "referenceOffsetHz")],
        ),
        "device.setModeCycle" => supplied_fields_match(params, response, &[("slots", "slots")]),
        "device.setGlobalEqBypassed" => {
            supplied_fields_match(params, response, &[("bypassed", "bypassed")])
        }
        "device.setGlobalEqBand" => {
            let Some(band) = params.get("band").and_then(Value::as_i64) else {
                return false;
            };
            let base = (band - 1) * 5;
            [("gain", 0), ("frequency", 1), ("q", 2)]
                .iter()
                .all(|(field, offset)| {
                    params.get(*field).is_none_or(|expected| {
                        expected.is_null()
                            || eq_value(base + offset)
                                .zip(expected.as_f64())
                                .is_some_and(|(a, e)| (a - e).abs() <= 0.001)
                    })
                })
                && params.get("filterType").is_none_or(|expected| {
                    expected.is_null()
                        || eq_value(base + 3)
                            .zip(expected.as_f64())
                            .is_some_and(|(a, e)| (a - e / 4.0).abs() <= 0.001)
                })
                && params.get("enabled").is_none_or(|expected| {
                    expected.is_null()
                        || expected
                            .as_bool()
                            .zip(eq_value(base + 4))
                            .is_some_and(|(e, a)| (a - if e { 1.0 } else { 0.0 }).abs() <= 0.001)
                })
        }
        "device.setGlobalEqOutput" => {
            [("level", 25), ("out12", 26), ("out34", 27)]
                .iter()
                .all(|(field, index)| {
                    params.get(*field).is_none_or(|expected| {
                        expected.is_null()
                            || if let Some(boolean) = expected.as_bool() {
                                eq_value(*index).is_some_and(|actual| {
                                    (actual - if boolean { 1.0 } else { 0.0 }).abs() <= 0.001
                                })
                            } else {
                                eq_value(*index)
                                    .zip(expected.as_f64())
                                    .is_some_and(|(a, e)| (a - e).abs() <= 0.001)
                            }
                    })
                })
        }
        "device.setTempoMode" => supplied_fields_match(params, response, &[("mode", "mode")]),
        "device.setTempoMetronome" => supplied_fields_match(
            params,
            response,
            &[
                ("ledEnabled", "ledEnabled"),
                ("volumeDb", "volumeDb"),
                ("running", "running"),
                ("pan", "pan"),
                ("timeSignature", "timeSignature"),
                ("subdivision", "subdivision"),
                ("sound", "sound"),
                ("routing", "routing"),
                ("beats", "beats"),
            ],
        ),
        "device.setGeneralInteger" | "device.setGeneralToggle" => {
            let Some(setting) = params.get("setting").and_then(Value::as_str) else {
                return false;
            };
            let output = if setting == "holdTiming" {
                "holdTimingIndex"
            } else {
                setting
            };
            let expected = params.get("value").or_else(|| params.get("enabled"));
            expected.is_some_and(|expected| {
                if expected.is_number() {
                    json_number_matches(response.get(output), expected)
                } else {
                    response.get(output) == Some(expected)
                }
            })
        }
        "device.setSceneBypassBehavior" => {
            supplied_fields_match(params, response, &[("behavior", "sceneBypassBehavior")])
        }
        "device.setMasterVolumeAssignment" => {
            response
                .get("masterVolumeAssignment")
                .is_some_and(|nested| {
                    supplied_fields_match(
                        params,
                        nested,
                        &[
                            ("out12", "out12"),
                            ("out34", "out34"),
                            ("send12", "send12"),
                            ("headphones", "headphones"),
                        ],
                    )
                })
        }
        "device.setGlobalBypass" => ["cab", "ir"].iter().all(|name| {
            let Some(expected) = params.get(*name).and_then(Value::as_array) else {
                return false;
            };
            let output = if *name == "cab" {
                "globalBypassCab"
            } else {
                "globalBypassIr"
            };
            let Some(actual) = response.get(output).and_then(Value::as_object) else {
                return false;
            };
            expected
                .iter()
                .enumerate()
                .all(|(index, value)| actual.get(&format!("row{}", index + 1)) == Some(value))
        }),
        "device.setInputPort" => response
            .get("inputs")
            .and_then(Value::as_array)
            .and_then(|ports| {
                let id = params.get("inputPortId")?;
                ports
                    .iter()
                    .find(|port| port.get("inputPortId") == Some(id))
            })
            .is_some_and(|port| {
                supplied_fields_match(
                    params,
                    port,
                    &[
                        ("levelDb", "levelDb"),
                        ("impedance", "impedance"),
                        ("inputType", "inputType"),
                        ("groundLift", "groundLift"),
                    ],
                )
            }),
        "device.setOutputPort" => response
            .get("outputs")
            .and_then(Value::as_array)
            .and_then(|ports| {
                let id = params.get("outputPortId")?;
                ports
                    .iter()
                    .find(|port| port.get("outputPortId") == Some(id))
            })
            .is_some_and(|port| {
                supplied_fields_match(
                    params,
                    port,
                    &[
                        ("level", "level"),
                        ("groundLift", "groundLift"),
                        ("mute", "muted"),
                    ],
                )
            }),
        "device.setUsbPort" => response.get("usb").is_some_and(|usb| {
            supplied_fields_match(
                params,
                usb,
                &[
                    ("level", "level"),
                    ("headphonesSource", "headphonesSource"),
                    ("dryWet", "dryWet"),
                ],
            )
        }),
        "device.setMidiThru" => params
            .get("enabled")
            .and_then(Value::as_bool)
            .zip(
                response
                    .get("midi")
                    .and_then(|midi| midi.get("thru"))
                    .and_then(Value::as_f64),
            )
            .is_some_and(|(enabled, thru)| (thru - if enabled { 1.0 } else { 0.0 }).abs() <= 0.001),
        "device.setOutputPairing" => supplied_fields_match(
            params,
            response,
            &[
                ("xlr12Linked", "xlr12Linked"),
                ("out34Linked", "out34Linked"),
            ],
        ),
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GatewayReadPlan {
    pub operation: DeviceOperation,
    pub response_type: u16,
    pub timeout_ms: u64,
    pub projection: GatewayResponseProjection,
}

impl PresetRecallPlan {
    pub fn matches(&self, snapshot: &GatewaySnapshot) -> bool {
        snapshot.setlist_key.trim_end_matches('/') == self.setlist_key.trim_end_matches('/')
            && snapshot.preset_position == self.position
            && snapshot.position_revision > self.after_position_revision
            && (!self.require_clean || !snapshot.dirty)
    }

    pub fn verification(&self) -> GatewayVerification {
        GatewayVerification::Preset {
            setlist_key: self.setlist_key.clone(),
            position: self.position,
            name: None,
            require_clean: self.require_clean,
        }
    }
}

pub fn assert_expected_parameter(actual: Option<f64>, params: &Value) -> Result<(), String> {
    let Some(expected) = params.get("expectedValue").and_then(Value::as_f64) else {
        return Ok(());
    };
    let actual =
        actual.ok_or_else(|| "That parameter has no synchronized numeric value".to_string())?;
    if (actual - expected).abs() > 0.000_01 {
        return Err("The parameter changed on the Quad Cortex. Refresh and retry.".into());
    }
    Ok(())
}

pub fn plan_gateway_read(
    method: &str,
    params: &Value,
    request_id: u64,
) -> Result<GatewayReadPlan, String> {
    match method {
        "device.identity" => Ok(GatewayReadPlan {
            operation: DeviceOperation::ReadVersion,
            response_type: 10,
            timeout_ms: 5_000,
            projection: GatewayResponseProjection::DeviceIdentity,
        }),
        "device.tunerSettings" => Ok(GatewayReadPlan {
            operation: DeviceOperation::ReadTuner,
            response_type: 6,
            timeout_ms: 5_000,
            projection: GatewayResponseProjection::TunerSettings,
        }),
        "device.generalSettings" => Ok(GatewayReadPlan {
            operation: DeviceOperation::ReadGeneralSettings,
            response_type: 9,
            timeout_ms: 5_000,
            projection: GatewayResponseProjection::GeneralSettings,
        }),
        "device.ioSettings" => Ok(GatewayReadPlan {
            operation: DeviceOperation::ReadIoSettings,
            response_type: 3,
            timeout_ms: 10_000,
            projection: GatewayResponseProjection::IoSettings,
        }),
        "device.globalEq" => Ok(GatewayReadPlan {
            operation: DeviceOperation::ReadGlobalEq,
            response_type: 38,
            timeout_ms: 5_000,
            projection: GatewayResponseProjection::GlobalEq,
        }),
        "device.modeCycle" => Ok(GatewayReadPlan {
            operation: DeviceOperation::ReadModeCycle,
            response_type: 14,
            timeout_ms: 5_000,
            projection: GatewayResponseProjection::ModeCycle,
        }),
        "device.globalTempoSettings" => Ok(GatewayReadPlan {
            operation: DeviceOperation::ReadGlobalTempo,
            response_type: 33,
            timeout_ms: 30_000,
            projection: GatewayResponseProjection::GlobalTempoSettings,
        }),
        "device.looperStatus" => Ok(GatewayReadPlan {
            operation: DeviceOperation::ReadLooperStatus,
            response_type: 28,
            timeout_ms: 5_000,
            projection: GatewayResponseProjection::LooperStatus,
        }),
        "device.recents" | "device.favorites" => Ok(GatewayReadPlan {
            operation: DeviceOperation::ReadRecentsFavorites {
                favorites: method == "device.favorites",
                request_id,
            },
            response_type: 20,
            timeout_ms: if method == "device.favorites" {
                20_000
            } else {
                10_000
            },
            projection: GatewayResponseProjection::RecentsFavorites { request_id },
        }),
        "device.pinnedModels" => Ok(GatewayReadPlan {
            operation: DeviceOperation::ReadPinnedModels,
            response_type: 54,
            timeout_ms: 8_000,
            projection: GatewayResponseProjection::PinnedModels,
        }),
        "device.captures" | "device.irs" => {
            let folder_key = if method == "device.captures" {
                "local_nc_root".to_string()
            } else {
                params
                    .get("folder")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("local_ir_root")
                    .to_string()
            };
            let folder_key = validate_library_key(folder_key, "folder")?;
            Ok(GatewayReadPlan {
                operation: DeviceOperation::ReadLibraryFiles {
                    folder_key: folder_key.clone(),
                    file_type: if method == "device.captures" { 2 } else { 1 },
                    request_id,
                },
                response_type: 4,
                timeout_ms: 30_000,
                projection: GatewayResponseProjection::LibraryFiles {
                    request_id,
                    folder_key,
                },
            })
        }
        "device.inhibitedModules" => Ok(GatewayReadPlan {
            operation: DeviceOperation::ReadInhibitedModules,
            response_type: 42,
            timeout_ms: 5_000,
            projection: GatewayResponseProjection::InhibitedModules,
        }),
        "device.presetScreenshot" => {
            let folder_name = validate_path_component(
                required_text(params, "folderName")?,
                "folderName",
                64,
                &[],
            )?;
            let position = bounded_u32(params, "position", 255)?;
            let is_factory = params
                .get("isFactory")
                .and_then(Value::as_bool)
                .ok_or_else(|| "isFactory must be a boolean".to_string())?;
            Ok(GatewayReadPlan {
                operation: DeviceOperation::PresetScreenshot {
                    folder_name: folder_name.clone(),
                    position,
                    is_factory,
                    request_id,
                },
                response_type: 25,
                timeout_ms: 10_000,
                projection: GatewayResponseProjection::PresetScreenshot {
                    request_id,
                    folder_name,
                    position,
                    is_factory,
                },
            })
        }
        "device.captureScreen" => Ok(GatewayReadPlan {
            operation: DeviceOperation::CaptureScreen,
            response_type: 72,
            timeout_ms: 10_000,
            projection: GatewayResponseProjection::CapturedScreen,
        }),
        _ => Err(format!(
            "Gateway correlated read is not supported: {method}"
        )),
    }
}

fn screen_coordinate(params: &Value, field: &str, upper: f64) -> Result<f32, String> {
    params
        .get(field)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && (0.0..upper).contains(value))
        .map(|value| value as f32)
        .ok_or_else(|| format!("{field} must satisfy 0 <= {field} < {upper}"))
}

fn preset_name(params: &Value) -> Result<String, String> {
    let name = required_text(params, "name")?.trim().to_string();
    validate_path_component(name, "Preset name", 80, &[])
}

fn save_stage(
    setlist_key: &str,
    position: u32,
    name: &str,
    instrument: i32,
) -> PresetMutationStage {
    let operation = DeviceOperation::SavePreset {
        setlist_key: setlist_key.into(),
        position,
        name: name.into(),
        instrument,
    };
    PresetMutationStage {
        verification: verification_for_operation(&operation, &Value::Null, None),
        write: PlannedWrite::HidOperation(operation),
        timeout_ms: 15_000,
        settle_ms: 0,
    }
}

/// Plan persistent preset workflows once for every native host. The host owns
/// USB scheduling and waits, while overwrite policy, stale-state guards,
/// factory-library rules and the multi-stage copy sequence live here.
pub fn plan_preset_mutation(
    method: &str,
    params: &Value,
    snapshot: Option<&GatewaySnapshot>,
    library: &PresetLibrary,
) -> Result<PresetMutationPlan, String> {
    let before =
        snapshot.ok_or_else(|| "No Quad Cortex preset has been synchronized yet".to_string())?;
    assert_expected_preset(Some(before), params)?;
    if before.preset_position != expected_position(params)? {
        return Err("The active preset slot changed on the Quad Cortex. Refresh and retry.".into());
    }

    match method {
        "device.savePresetAs" => {
            let setlist_key =
                validate_setlist_key(required_text(params, "setlistKey")?, "setlistKey")?;
            let position = bounded_u32(params, "position", 255)?;
            let name = preset_name(params)?;
            let confirm_overwrite = params
                .get("confirmOverwrite")
                .and_then(Value::as_bool)
                .ok_or_else(|| "confirmOverwrite must be a boolean".to_string())?;
            if before.setlist_key.trim_end_matches('/') != setlist_key.trim_end_matches('/') {
                return Err("The active preset or setlist changed. Refresh and retry.".into());
            }
            if setlist_key.starts_with("/opt/") {
                return Err(
                    "Factory Library is read-only. Recall a user setlist before saving.".into(),
                );
            }
            let saving_current_unnamed = position == before.preset_position
                && (before.preset_name.is_empty() || before.preset_name == "Unsaved");
            if let Some(entry) = library
                .entry(&setlist_key, position)
                .filter(|_| !confirm_overwrite && !saving_current_unnamed)
            {
                return Err(format!(
                    "Slot {} contains {:?}; explicit overwrite confirmation is required.",
                    entry.location, entry.name
                ));
            }
            let instrument = library
                .entry(&setlist_key, before.preset_position)
                .map(|entry| entry.instrument)
                .unwrap_or(0);
            let saved_presets = vec![PresetMutationRecord {
                setlist_key: setlist_key.clone(),
                position,
                name: name.clone(),
                instrument,
            }];
            Ok(PresetMutationPlan {
                stages: vec![save_stage(&setlist_key, position, &name, instrument)],
                detail: format!("Saved and verified {name}"),
                saved_name: name,
                setlist_key,
                position,
                instrument,
                saved_presets,
            })
        }
        "device.renameCurrentPreset" => {
            if params.get("confirmRename").and_then(Value::as_bool) != Some(true) {
                return Err("Renaming a stored preset requires explicit confirmation.".into());
            }
            if before.setlist_key.starts_with("/opt/") {
                return Err(
                    "Factory Library is read-only. Recall a user setlist before renaming.".into(),
                );
            }
            let name = preset_name(params)?;
            if name == before.preset_name {
                return Err("The new preset name is identical to the current name.".into());
            }
            let instrument = library
                .entry(&before.setlist_key, before.preset_position)
                .map(|entry| entry.instrument)
                .unwrap_or(0);
            let saved_presets = vec![PresetMutationRecord {
                setlist_key: before.setlist_key.clone(),
                position: before.preset_position,
                name: name.clone(),
                instrument,
            }];
            Ok(PresetMutationPlan {
                stages: vec![save_stage(
                    &before.setlist_key,
                    before.preset_position,
                    &name,
                    instrument,
                )],
                detail: format!("Renamed and verified {name}"),
                saved_name: name,
                setlist_key: before.setlist_key.clone(),
                position: before.preset_position,
                instrument,
                saved_presets,
            })
        }
        "device.copyPreset" => {
            if params.get("confirmOverwrite").and_then(Value::as_bool) != Some(true) {
                return Err("Pasting a preset requires explicit overwrite confirmation.".into());
            }
            let source_key = validate_setlist_key(
                required_text(params, "sourceSetlistKey")?,
                "sourceSetlistKey",
            )?;
            let destination_key = writable_setlist_key(params, "destinationSetlistKey")?;
            let source_position = bounded_u32(params, "sourcePosition", 255)?;
            let destination_position = bounded_u32(params, "destinationPosition", 255)?;
            if source_key.trim_end_matches('/') == destination_key.trim_end_matches('/')
                && source_position == destination_position
            {
                return Err("The source and destination preset slots are identical.".into());
            }
            if before.setlist_key.trim_end_matches('/') != destination_key.trim_end_matches('/')
                || before.preset_position != destination_position
            {
                return Err("The destination preset or setlist changed. Refresh and retry.".into());
            }
            if destination_key.starts_with("/opt/") {
                return Err(
                    "Factory Library is read-only. Paste into a user setlist instead.".into(),
                );
            }
            if before.dirty {
                return Err(
                    "The destination has unsaved changes. Save or discard them before pasting a preset."
                        .into(),
                );
            }
            let source = library
                .entry(&source_key, source_position)
                .ok_or_else(|| "The copied source preset no longer exists.".to_string())?;
            let expected_source_name = params
                .get("sourceName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !expected_source_name.is_empty() && source.name != expected_source_name {
                return Err(format!(
                    "The copied source changed from {expected_source_name:?} to {:?}. Copy it again before pasting.",
                    source.name
                ));
            }
            let source_verification = GatewayVerification::Preset {
                setlist_key: source_key.clone(),
                position: source_position,
                name: Some(source.name.clone()),
                require_clean: false,
            };
            let saved_presets = vec![PresetMutationRecord {
                setlist_key: destination_key.clone(),
                position: destination_position,
                name: source.name.clone(),
                instrument: source.instrument,
            }];
            Ok(PresetMutationPlan {
                stages: vec![
                    PresetMutationStage {
                        write: PlannedWrite::HidCommand(DeviceCommand::SetlistPosition {
                            is_factory: source_key.starts_with("/opt/"),
                            setlist_key: source_key,
                            position: source_position,
                        }),
                        verification: source_verification,
                        timeout_ms: 40_000,
                        settle_ms: 0,
                    },
                    save_stage(
                        &destination_key,
                        destination_position,
                        &source.name,
                        source.instrument,
                    ),
                ],
                detail: format!("Copied {} · {} and verified", source.location, source.name),
                saved_name: source.name,
                setlist_key: destination_key,
                position: destination_position,
                instrument: source.instrument,
                saved_presets,
            })
        }
        "device.duplicateSetlist" => {
            let source_key = validate_setlist_key(
                required_text(params, "sourceSetlistKey")?,
                "sourceSetlistKey",
            )?
            .trim_end_matches('/')
            .to_string();
            let destination_name =
                validate_setlist_name(required_text(params, "destinationName")?)?;
            let destination_key = format!("/media/p4/Presets/{destination_name}");
            if source_key == destination_key {
                return Err("The source and destination setlists are identical.".into());
            }
            if library.folders().iter().any(|folder| {
                folder.key.trim_end_matches('/') == destination_key
                    || folder.name.eq_ignore_ascii_case(&destination_name)
            }) {
                return Err("The destination setlist already exists.".into());
            }
            let mut entries = library
                .list(&source_key, before)
                .ok_or_else(|| {
                    "The source setlist has not been loaded from the Quad Cortex.".to_string()
                })?
                .presets
                .into_iter()
                .filter(|entry| entry.name != "Unsaved")
                .collect::<Vec<_>>();
            entries.sort_by_key(|entry| entry.position);
            let limit = match params.get("limit") {
                None | Some(Value::Null) => entries.len(),
                Some(value) => value
                    .as_u64()
                    .and_then(|value| usize::try_from(value).ok())
                    .filter(|value| *value <= 256)
                    .ok_or_else(|| {
                        "limit must be null or an integer from 0 through 256".to_string()
                    })?,
            };
            entries.truncate(limit);

            let mut stages = vec![PresetMutationStage {
                write: PlannedWrite::HidOperation(DeviceOperation::CreateSetlist {
                    name: destination_name.clone(),
                }),
                verification: GatewayVerification::None,
                timeout_ms: 0,
                settle_ms: 3_000,
            }];
            let mut saved_presets = Vec::with_capacity(entries.len());
            for (destination_position, entry) in entries.into_iter().enumerate() {
                let destination_position = u32::try_from(destination_position)
                    .map_err(|_| "The source setlist contains too many presets".to_string())?;
                stages.push(PresetMutationStage {
                    write: PlannedWrite::HidCommand(DeviceCommand::SetlistPosition {
                        is_factory: source_key.starts_with("/opt/"),
                        setlist_key: source_key.clone(),
                        position: entry.position,
                    }),
                    verification: GatewayVerification::Preset {
                        setlist_key: source_key.clone(),
                        position: entry.position,
                        name: Some(entry.name.clone()),
                        require_clean: false,
                    },
                    timeout_ms: 40_000,
                    settle_ms: 0,
                });
                stages.push(save_stage(
                    &destination_key,
                    destination_position,
                    &entry.name,
                    entry.instrument,
                ));
                saved_presets.push(PresetMutationRecord {
                    setlist_key: destination_key.clone(),
                    position: destination_position,
                    name: entry.name,
                    instrument: entry.instrument,
                });
            }
            let copied = saved_presets.len();
            Ok(PresetMutationPlan {
                stages,
                detail: format!(
                    "Created {destination_name} and copied {copied} preset{}",
                    if copied == 1 { "" } else { "s" }
                ),
                saved_name: destination_name,
                setlist_key: destination_key,
                position: copied.saturating_sub(1) as u32,
                instrument: saved_presets.last().map_or(0, |entry| entry.instrument),
                saved_presets,
            })
        }
        _ => Err(format!(
            "Persistent preset method is not supported: {method}"
        )),
    }
}

pub fn bounded_u32(params: &Value, field: &str, maximum: u32) -> Result<u32, String> {
    params
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value <= maximum)
        .ok_or_else(|| format!("{field} must be an integer from 0 through {maximum}"))
}

pub fn required_text(params: &Value, field: &str) -> Result<String, String> {
    params
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(String::from)
        .ok_or_else(|| format!("{field} must be a non-empty string"))
}

fn validate_visible_text(value: String, field: &str, maximum: usize) -> Result<String, String> {
    if value.is_empty() || value.chars().count() > maximum || value.chars().any(char::is_control) {
        return Err(format!(
            "{field} must contain 1-{maximum} visible characters"
        ));
    }
    Ok(value)
}

fn validate_path_component(
    value: String,
    field: &str,
    maximum: usize,
    reserved: &[&str],
) -> Result<String, String> {
    let value = validate_visible_text(value, field, maximum)?;
    if value.trim() != value
        || value.contains(['/', '\\'])
        || matches!(value.as_str(), "." | "..")
        || reserved
            .iter()
            .any(|candidate| value.eq_ignore_ascii_case(candidate))
    {
        return Err(format!(
            "{field} must not have surrounding whitespace, path separators, traversal components, or a reserved name"
        ));
    }
    Ok(value)
}

fn validate_library_key(value: String, field: &str) -> Result<String, String> {
    let value = validate_visible_text(value, field, 512)?;
    if value.trim() != value
        || value.trim_end_matches('/').is_empty()
        || value.contains('\\')
        || value.contains("//")
        || value
            .trim_end_matches('/')
            .split('/')
            .filter(|component| !component.is_empty())
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(format!(
            "{field} must be a library key without control characters, backslashes, or traversal components"
        ));
    }
    Ok(value)
}

fn validate_setlist_key(value: String, field: &str) -> Result<String, String> {
    let value = validate_library_key(value, field)?;
    if !value.starts_with('/') {
        return Err(format!("{field} must be an absolute setlist key"));
    }
    Ok(value)
}

pub fn optional_i32(params: &Value, field: &str) -> Result<Option<i32>, String> {
    match params.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .and_then(|value| i32::try_from(value).ok())
            .map(Some)
            .ok_or_else(|| format!("{field} must be null or an integer")),
    }
}

fn optional_positive_u32(params: &Value, field: &str) -> Result<Option<u32>, String> {
    match params.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value > 0)
            .map(Some)
            .ok_or_else(|| format!("{field} must be null or a positive integer")),
    }
}

fn writable_setlist_key(params: &Value, field: &str) -> Result<String, String> {
    let key = validate_setlist_key(required_text(params, field)?, field)?;
    let trimmed = key.trim_end_matches('/');
    let Some(name) = trimmed.strip_prefix("/media/p4/Presets/") else {
        return Err(format!("{field} must identify a writable user setlist"));
    };
    if name.is_empty() || name.contains('/') {
        return Err(format!("{field} must identify a writable user setlist"));
    }
    Ok(trimmed.to_string())
}

fn validate_setlist_name(name: String) -> Result<String, String> {
    validate_path_component(name, "setlist name", 64, &["My Presets"])
}

pub fn expected_position(params: &Value) -> Result<u32, String> {
    bounded_u32(params, "expectedPosition", 255)
}

pub fn assert_expected_preset(
    snapshot: Option<&GatewaySnapshot>,
    params: &Value,
) -> Result<(), String> {
    let expected = params
        .get("expectedPresetName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if expected.is_empty() {
        return Ok(());
    }
    let actual = snapshot
        .map(|value| value.preset_name.as_str())
        .unwrap_or_default();
    let placeholder = matches!(
        expected.to_ascii_lowercase().as_str(),
        "current preset" | "empty preset" | "unsaved"
    );
    if actual != expected && !(actual.is_empty() && placeholder) {
        return Err(format!(
            "Preset changed on the Quad Cortex: expected {expected:?}, but {:?} is active. Refresh and retry.",
            if actual.is_empty() { "an unnamed preset" } else { actual }
        ));
    }
    Ok(())
}

/** Plan guarded preset recall/navigation/reload while hosts own asynchronous readback. */
pub fn plan_preset_recall(
    method: &str,
    params: &Value,
    snapshot: Option<&GatewaySnapshot>,
) -> Result<PresetRecallPlan, String> {
    let before =
        snapshot.ok_or_else(|| "No Quad Cortex preset has been synchronized yet".to_string())?;
    assert_expected_preset(Some(before), params)?;
    if before.preset_position != expected_position(params)? {
        return Err("The active preset slot changed on the Quad Cortex. Refresh and retry.".into());
    }

    let (setlist_key, position, require_clean, detail) = match method {
        "device.recallPreset" => {
            let setlist_key =
                validate_setlist_key(required_text(params, "setlistKey")?, "setlistKey")?;
            if before.setlist_key.trim_end_matches('/') != setlist_key.trim_end_matches('/') {
                return Err(
                    "The active setlist changed on the Quad Cortex. Refresh and retry.".into(),
                );
            }
            if before.dirty {
                return Err("The current preset has unsaved changes. Save or revert them before recalling another preset.".into());
            }
            (
                setlist_key,
                bounded_u32(params, "position", 255)?,
                false,
                "Preset recalled and verified",
            )
        }
        "device.navigateBank" => {
            if before.dirty {
                return Err("The current preset has unsaved changes. Save or revert them before recalling another preset.".into());
            }
            let direction = params
                .get("direction")
                .and_then(Value::as_i64)
                .filter(|value| matches!(value, -1 | 1))
                .ok_or_else(|| "direction must be -1 or 1".to_string())?;
            let target = before.preset_position as i64 + direction * 8;
            if !(0..256).contains(&target) {
                return Err("Already at the first or last preset bank.".into());
            }
            (
                before.setlist_key.clone(),
                target as u32,
                false,
                "Preset bank changed and verified",
            )
        }
        "device.reloadPreset" => (
            before.setlist_key.clone(),
            before.preset_position,
            true,
            "Unsaved device changes discarded and preset reloaded",
        ),
        _ => return Err(format!("Preset recall method is not supported: {method}")),
    };

    Ok(PresetRecallPlan {
        command: DeviceCommand::SetlistPosition {
            is_factory: setlist_key.starts_with("/opt/"),
            setlist_key: setlist_key.clone(),
            position,
        },
        setlist_key,
        position,
        after_position_revision: before.position_revision,
        require_clean,
        detail: detail.into(),
    })
}

/// Rejects a write when the UI's optimistic concurrency token no longer
/// matches the latest device snapshot.  Both desktop and Android call this
/// planner, so these guards cannot drift between hosts.
pub fn assert_expected_state(
    method: &str,
    snapshot: Option<&GatewaySnapshot>,
    params: &Value,
) -> Result<(), String> {
    let has_expected_state = [
        "expectedScene",
        "expectedMode",
        "expectedTempo",
        "expectedValue",
        "expectedModelId",
        "expectedBypassed",
        "expectedFootswitch",
        "expectedInputId",
        "expectedOutputId",
        "expectedSplitColumn",
        "expectedMixColumn",
        "expectedMuted",
    ]
    .iter()
    .any(|field| params.get(field).is_some());
    if !has_expected_state {
        return Ok(());
    }
    let Some(snapshot) = snapshot else {
        return Err("No Quad Cortex preset has been synchronized yet".into());
    };
    if let Some(expected) = params.get("expectedMode").and_then(Value::as_str) {
        if snapshot.mode != expected {
            return Err(format!(
                "Footswitch mode changed on the Quad Cortex: expected {expected}, but {} is active. Refresh and retry.",
                snapshot.mode
            ));
        }
    }
    if let Some(expected) = params.get("expectedScene").and_then(Value::as_u64) {
        if snapshot.active_scene != expected as u32 {
            return Err(format!(
                "Scene changed on the Quad Cortex: expected {}, but {} is active. Refresh and retry.",
                (b'A' + expected.min(7) as u8) as char,
                (b'A' + snapshot.active_scene.min(7) as u8) as char
            ));
        }
    }
    if let Some(expected) = params.get("expectedTempo").and_then(Value::as_u64) {
        if snapshot.tempo != expected as u32 {
            return Err(format!(
                "Tempo changed on the Quad Cortex: expected {expected}, but {} is active. Refresh and retry.",
                snapshot.tempo
            ));
        }
    }
    if method == "device.setMasterVolume" {
        if let Some(expected) = params.get("expectedValue").and_then(Value::as_u64) {
            if snapshot.master_volume != expected as u32 {
                return Err(format!(
                    "Master Volume changed on the Quad Cortex: expected {expected}, but {} is active. Refresh and retry.",
                    snapshot.master_volume
                ));
            }
        }
    }

    let Some(row) = params
        .get("row")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
    else {
        return Ok(());
    };
    if let Some(expected_value) = params.get("expectedModelId") {
        let expected = if expected_value.is_null() {
            None
        } else {
            Some(
                expected_value
                    .as_u64()
                    .and_then(|value| u32::try_from(value).ok())
                    .ok_or_else(|| {
                        "expectedModelId must be an unsigned 32-bit integer or null".to_string()
                    })?,
            )
        };
        let actual = snapshot
            .blocks
            .iter()
            .find(|block| {
                block.row == row
                    && block.column
                        == params
                            .get("fromColumn")
                            .or_else(|| params.get("column"))
                            .and_then(Value::as_u64)
                            .unwrap_or(u64::MAX) as u32
            })
            .and_then(|block| block.model_id);
        if actual != expected {
            return Err(format!(
                "The block at row {row}, column {} changed: expected model {:?}, found {:?}. Refresh and retry.",
                params
                    .get("fromColumn")
                    .or_else(|| params.get("column"))
                    .and_then(Value::as_u64)
                    .unwrap_or(u64::MAX),
                expected, actual
            ));
        }
    }
    if let (Some(column), Some(expected)) = (
        params.get("column").and_then(Value::as_u64),
        params.get("expectedBypassed").and_then(Value::as_bool),
    ) {
        let actual = snapshot
            .blocks
            .iter()
            .find(|block| block.row == row && block.column == column as u32)
            .and_then(|block| block.bypassed);
        if actual != Some(expected) {
            return Err(
                "The block bypass state changed on the Quad Cortex. Refresh and retry.".into(),
            );
        }
    }
    if let Some(column) = params.get("column").and_then(Value::as_u64) {
        if let Some(expected) = params.get("expectedFootswitch") {
            let expected = if expected.is_null() {
                None
            } else {
                Some(
                    expected
                        .as_u64()
                        .and_then(|value| u32::try_from(value).ok())
                        .filter(|value| *value < domain::SCENE_COUNT)
                        .ok_or_else(|| {
                            format!(
                                "expectedFootswitch must be null or an integer from 0 through {}",
                                domain::SCENE_COUNT - 1
                            )
                        })?,
                )
            };
            let actual = snapshot
                .blocks
                .iter()
                .find(|block| block.row == row && block.column == column as u32)
                .and_then(|block| block.footswitch);
            if expected != actual {
                return Err(
                    "The block footswitch assignment changed on the Quad Cortex. Refresh and retry."
                        .into(),
                );
            }
        }
    }
    let route_fields = [
        "expectedInputId",
        "expectedOutputId",
        "expectedSplitColumn",
        "expectedMixColumn",
        "expectedMuted",
    ];
    if route_fields.iter().any(|field| params.get(field).is_some()) {
        let route = snapshot
            .routes
            .iter()
            .find(|route| route.row == row)
            .ok_or_else(|| {
                "The signal-chain routing is not synchronized. Refresh and retry.".to_string()
            })?;
        for (field, actual) in [
            ("expectedInputId", route.input_id.map(i64::from)),
            ("expectedOutputId", route.output_id.map(i64::from)),
            ("expectedSplitColumn", route.split_column.map(i64::from)),
            ("expectedMixColumn", route.mix_column.map(i64::from)),
        ] {
            if let Some(expected) = params.get(field) {
                let expected = if expected.is_null() {
                    None
                } else {
                    expected.as_i64()
                };
                if expected != actual {
                    return Err(
                        "The signal-chain routing changed on the Quad Cortex. Refresh and retry."
                            .into(),
                    );
                }
            }
        }
        if let Some(expected) = params.get("expectedMuted").and_then(Value::as_bool) {
            if route.split_muted != expected {
                return Err(
                    "The splitter/mixer mute state changed on the Quad Cortex. Refresh and retry."
                        .into(),
                );
            }
        }
    }
    Ok(())
}

fn boolean(params: &Value, field: &str) -> Result<bool, String> {
    params
        .get(field)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("{field} must be a boolean"))
}

fn normalized(params: &Value, field: &str) -> Result<f32, String> {
    params
        .get(field)
        .and_then(Value::as_f64)
        .filter(|value| (0.0..=1.0).contains(value))
        .map(|value| value as f32)
        .ok_or_else(|| format!("{field} must be a number from zero through one"))
}

fn optional_normalized(params: &Value, field: &str) -> Result<Option<f32>, String> {
    match params.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => normalized(params, field).map(Some),
    }
}

fn optional_boolean(params: &Value, field: &str) -> Result<Option<bool>, String> {
    match params.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => boolean(params, field).map(Some),
    }
}

fn optional_input_gain(params: &Value, field: &str) -> Result<Option<f32>, String> {
    match params.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .filter(|value| (-12.0..=60.0).contains(value))
            .map(|value| Some(((value + 12.0) / 72.0) as f32))
            .ok_or_else(|| format!("{field} must be an input gain from -12 through +60 dB")),
    }
}

fn midi_out_messages(params: &Value) -> Result<Vec<MidiOutMessage>, String> {
    let values = params
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "messages must be an array".to_string())?;
    if values.len() > 12 {
        return Err("A MIDI Out source supports at most 12 messages".into());
    }
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let object = value
                .as_object()
                .ok_or_else(|| format!("messages[{index}] must be an object"))?;
            let field = |name: &str, minimum: u32, maximum: u32| {
                object
                    .get(name)
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                    .filter(|value| (minimum..=maximum).contains(value))
                    .ok_or_else(|| {
                        format!("messages[{index}].{name} must be {minimum} through {maximum}")
                    })
            };
            Ok(MidiOutMessage {
                r#type: field("type", 1, 3)?,
                channel: field("channel", 1, 16)?,
                param1: field("param1", 0, 127)?,
                param2: field("param2", 0, 127)?,
                param3: field("param3", 0, 127)?,
            })
        })
        .collect()
}

fn operation(operation: &str, params: &Value) -> Result<DeviceOperation, String> {
    let row = || bounded_u32(params, "row", domain::GRID_ROWS - 1);
    let column = |field: &str| bounded_u32(params, field, domain::GRID_COLUMNS - 1);
    match operation {
        "setTunerInput" => {
            if params
                .get("confirmTunerActivation")
                .and_then(Value::as_bool)
                != Some(true)
            {
                return Err("Changing tuner input engages the tuner invisibly; confirmTunerActivation must be true.".into());
            }
            let input_port_id = params
                .get("inputPortId")
                .and_then(Value::as_i64)
                .and_then(|value| i32::try_from(value).ok())
                .filter(|value| matches!(value, 1 | 2 | 3 | 4 | 5 | 8 | 9))
                .ok_or_else(|| "inputPortId must be Input 1, Input 2, Input 1/2, Return 1, Return 2, USB 5, or USB 6 (1, 2, 3, 4, 5, 8, or 9)".to_string())?;
            Ok(DeviceOperation::SetTunerInput(input_port_id))
        }
        "setTunerMute" => {
            if params
                .get("confirmTunerActivation")
                .and_then(Value::as_bool)
                != Some(true)
            {
                return Err("Changing tuner mute engages the tuner invisibly and may silence every output; confirmTunerActivation must be true.".into());
            }
            Ok(DeviceOperation::SetTunerMute(boolean(params, "muted")?))
        }
        "restoreTunerAudio" => {
            if params
                .get("confirmPreferenceReset")
                .and_then(Value::as_bool)
                != Some(true)
            {
                return Err("Restoring audio clears the persistent mute-while-tuning preference; confirmPreferenceReset must be true.".into());
            }
            Ok(DeviceOperation::SetTunerMute(false))
        }
        "setTunerReference" => {
            if params
                .get("confirmTunerActivation")
                .and_then(Value::as_bool)
                != Some(true)
            {
                return Err("Changing tuner reference engages the tuner invisibly; confirmTunerActivation must be true.".into());
            }
            let offset_hz = params
                .get("referenceOffsetHz")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .ok_or_else(|| {
                    "referenceOffsetHz must be a finite Hz offset from 440".to_string()
                })?;
            Ok(DeviceOperation::SetTunerReference(offset_hz as f32))
        }
        "setGeneralInteger" => {
            let setting = required_text(params, "setting")?;
            let (minimum, maximum) = match setting.as_str() {
                "screenBrightness" | "ledBrightness" | "dimmedLedBrightness" => (0, 100),
                "holdTiming" => (0, 5),
                "midiChannel" => (0, 16),
                _ => return Err("unsupported GeneralSettings integer".into()),
            };
            let value = params
                .get("value")
                .and_then(Value::as_i64)
                .and_then(|value| i32::try_from(value).ok())
                .filter(|value| (minimum..=maximum).contains(value))
                .ok_or_else(|| format!("value must be {minimum} through {maximum}"))?;
            Ok(DeviceOperation::SetGeneralInteger { setting, value })
        }
        "setGeneralToggle" => {
            let setting = required_text(params, "setting")?;
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
                return Err("unsupported GeneralSettings toggle".into());
            }
            Ok(DeviceOperation::SetGeneralToggle {
                setting,
                enabled: boolean(params, "enabled")?,
            })
        }
        "setSceneBypassBehavior" => {
            let behavior =
                match required_text(params, "behavior")?.as_str() {
                    "alwaysOverwrite" => 0,
                    "nonstompOverwrite" => 1,
                    "neverOverwrite" => 2,
                    _ => return Err(
                        "behavior must be alwaysOverwrite, nonstompOverwrite, or neverOverwrite"
                            .into(),
                    ),
                };
            Ok(DeviceOperation::SetSceneBypassBehavior(behavior))
        }
        "setMasterVolumeAssignment" => Ok(DeviceOperation::SetMasterVolumeAssignment {
            out12: boolean(params, "out12")?,
            out34: boolean(params, "out34")?,
            send12: boolean(params, "send12")?,
            headphones: boolean(params, "headphones")?,
        }),
        "setGlobalBypass" => {
            let rows = |field: &str| -> Result<[bool; 4], String> {
                let values = params
                    .get(field)
                    .and_then(Value::as_array)
                    .filter(|values| values.len() == 4)
                    .ok_or_else(|| format!("{field} must contain four booleans"))?;
                let mut rows = [false; 4];
                for (index, value) in values.iter().enumerate() {
                    rows[index] = value
                        .as_bool()
                        .ok_or_else(|| format!("{field}[{index}] must be a boolean"))?;
                }
                Ok(rows)
            };
            Ok(DeviceOperation::SetGlobalBypass {
                cab: rows("cab")?,
                ir: rows("ir")?,
            })
        }
        "setInputPort" => {
            let input_port_id = bounded_u32(params, "inputPortId", 14)?;
            if input_port_id == 0 {
                return Err("inputPortId must identify a real input port (1 through 14)".into());
            }
            let level = optional_input_gain(params, "levelDb")?;
            let impedance = optional_normalized(params, "impedance")?;
            let input_type = optional_normalized(params, "inputType")?;
            let ground_lift = optional_normalized(params, "groundLift")?;
            if level.is_none()
                && impedance.is_none()
                && input_type.is_none()
                && ground_lift.is_none()
            {
                return Err("setInputPort needs at least one setting".into());
            }
            Ok(DeviceOperation::SetInputPort {
                input_port_id,
                level,
                impedance,
                input_type,
                ground_lift,
            })
        }
        "setOutputPort" => {
            let output_port_id = bounded_u32(params, "outputPortId", 22)?;
            if output_port_id == 0 {
                return Err("outputPortId must identify a real output port (1 through 22)".into());
            }
            let level = optional_normalized(params, "level")?;
            let ground_lift = optional_normalized(params, "groundLift")?;
            let mute = optional_boolean(params, "mute")?;
            if level.is_none() && ground_lift.is_none() && mute.is_none() {
                return Err("setOutputPort needs at least one setting".into());
            }
            Ok(DeviceOperation::SetOutputPort {
                output_port_id,
                level,
                ground_lift,
                mute,
            })
        }
        "setUsbPort" => {
            let level = optional_normalized(params, "level")?;
            let headphones_source = optional_normalized(params, "headphonesSource")?;
            let dry_wet = optional_normalized(params, "dryWet")?;
            if level.is_none() && headphones_source.is_none() && dry_wet.is_none() {
                return Err("setUsbPort needs at least one setting".into());
            }
            Ok(DeviceOperation::SetUsbPort {
                level,
                headphones_source,
                dry_wet,
            })
        }
        "setMidiThru" => Ok(DeviceOperation::SetMidiThru(boolean(params, "enabled")?)),
        "setOutputPairing" => {
            let xlr12_linked = optional_boolean(params, "xlr12Linked")?;
            let out34_linked = optional_boolean(params, "out34Linked")?;
            if xlr12_linked.is_none() && out34_linked.is_none() {
                return Err("setOutputPairing needs xlr12Linked or out34Linked".into());
            }
            Ok(DeviceOperation::SetOutputPairing {
                xlr12_linked,
                out34_linked,
            })
        }
        "setGlobalEqBypassed" => Ok(DeviceOperation::SetGlobalEqBypassed(boolean(
            params, "bypassed",
        )?)),
        "setGlobalEqBand" => {
            let band = bounded_u32(params, "band", 5)?;
            if band == 0 {
                return Err("band must be 1 through 5".into());
            }
            let mut controls = Vec::new();
            let base = ((band - 1) * 5) as i32;
            for (field, offset) in [("gain", 0), ("frequency", 1), ("q", 2)] {
                if let Some(value) = optional_normalized(params, field)? {
                    controls.push((base + offset, value));
                }
            }
            if let Some(value) = params.get("filterType").filter(|value| !value.is_null()) {
                let filter_type = value
                    .as_u64()
                    .filter(|value| *value <= 4)
                    .ok_or_else(|| "filterType must be null or 0 through 4".to_string())?;
                controls.push((base + 3, filter_type as f32 / 4.0));
            }
            if let Some(enabled) = optional_boolean(params, "enabled")? {
                controls.push((base + 4, if enabled { 1.0 } else { 0.0 }));
            }
            if controls.is_empty() {
                return Err("setGlobalEqBand needs at least one control".into());
            }
            Ok(DeviceOperation::SetGlobalEqParameters(controls))
        }
        "setGlobalEqOutput" => {
            let mut controls = Vec::new();
            if let Some(level) = optional_normalized(params, "level")? {
                controls.push((25, level));
            }
            if let Some(out12) = optional_boolean(params, "out12")? {
                controls.push((26, if out12 { 1.0 } else { 0.0 }));
            }
            if let Some(out34) = optional_boolean(params, "out34")? {
                controls.push((27, if out34 { 1.0 } else { 0.0 }));
            }
            if controls.is_empty() {
                return Err("setGlobalEqOutput needs level, out12, or out34".into());
            }
            Ok(DeviceOperation::SetGlobalEqParameters(controls))
        }
        "setModeCycle" => {
            let values = params
                .get("slots")
                .and_then(Value::as_array)
                .filter(|values| !values.is_empty() && values.len() <= 3)
                .ok_or_else(|| "slots must contain one through three mode values".to_string())?;
            let mut slots = Vec::with_capacity(values.len());
            for value in values {
                let slot = value
                    .as_u64()
                    .and_then(|value| u32::try_from(value).ok())
                    .filter(|value| *value <= 8)
                    .ok_or_else(|| "mode-cycle values must be 0 through 8".to_string())?;
                if slots.contains(&slot) {
                    return Err("mode-cycle values must be unique".into());
                }
                slots.push(slot);
            }
            Ok(DeviceOperation::SetModeCycle(slots))
        }
        "setTempoMetronome" => {
            let mut values = Vec::new();
            let option = |key: &str, labels: &[&str]| -> Result<Option<f32>, String> {
                match params.get(key) {
                    None | Some(Value::Null) => Ok(None),
                    Some(Value::String(value)) => labels
                        .iter()
                        .position(|label| *label == value)
                        .map(|index| index as f32 / (labels.len() - 1) as f32)
                        .ok_or_else(|| format!("unsupported {key} value"))
                        .map(Some),
                    _ => Err(format!("{key} must be a named option or null")),
                }
            };
            // Signature first: the QC rewrites beat accents when it changes.
            if let Some(value) = option(
                "timeSignature",
                &[
                    "2/4",
                    "3/4",
                    "4/4",
                    "5/4",
                    "6/4",
                    "7/4",
                    "8/4",
                    "9/4",
                    "10/4",
                    "11/4",
                    "12/4",
                    "13/4",
                    "3/8",
                    "6/8",
                    "9/8",
                    "12/8",
                    "5/8 (3+2)",
                    "5/8 (2+3)",
                    "7/8 (3+2+2)",
                    "7/8 (2+3+2)",
                    "7/8 (2+2+3)",
                ],
            )? {
                values.push((6, value));
            }
            if let Some(enabled) = optional_boolean(params, "ledEnabled")? {
                values.push((2, if enabled { 1.0 } else { 0.0 }));
            }
            if let Some(db) = params
                .get("volumeDb")
                .filter(|value| !value.is_null())
                .map(|value| {
                    value
                        .as_f64()
                        .filter(|value| (-60.0..=9.0).contains(value))
                        .ok_or_else(|| "volumeDb must be -60 through +9 dB".to_string())
                })
                .transpose()?
            {
                values.push((3, ((db + 60.0) / 69.0) as f32));
            }
            if let Some(running) = optional_boolean(params, "running")? {
                values.push((4, if running { 1.0 } else { 0.0 }));
            }
            if let Some(pan) = params
                .get("pan")
                .filter(|value| !value.is_null())
                .map(|value| {
                    value
                        .as_f64()
                        .filter(|value| (-1.0..=1.0).contains(value))
                        .ok_or_else(|| "pan must be -1 through +1".to_string())
                })
                .transpose()?
            {
                values.push((5, ((pan + 1.0) / 2.0) as f32));
            }
            if let Some(value) = option("subdivision", &["1/4", "1/8", "1/8T", "1/16"])? {
                values.push((7, value));
            }
            if let Some(value) = option(
                "sound",
                &[
                    "BLIP", "BLOCK", "COWBELL", "DIGITAL", "DRUM KIT", "SOFT KIT",
                ],
            )? {
                values.push((8, value));
            }
            if let Some(value) = option(
                "routing",
                &["MULTI", "HP", "OUT 1/2", "OUT 3/4", "SEND 1/2"],
            )? {
                values.push((9, value));
            }
            if let Some(beats) = params.get("beats").filter(|value| !value.is_null()) {
                let beats = beats
                    .as_array()
                    .ok_or_else(|| "beats must be an array".to_string())?;
                if beats.len() > 13 {
                    return Err("the QC stores at most 13 metronome beats".into());
                }
                for (index, beat) in beats.iter().enumerate() {
                    let label = beat
                        .as_str()
                        .ok_or_else(|| "every beat must be OFF, MUTE, DOWN, or ON".to_string())?;
                    let value = ["OFF", "MUTE", "DOWN", "ON"]
                        .iter()
                        .position(|candidate| *candidate == label)
                        .ok_or_else(|| "every beat must be OFF, MUTE, DOWN, or ON".to_string())?
                        as f32
                        / 3.0;
                    values.push((10 + index as u32, value));
                }
            }
            if values.is_empty() {
                return Err("setTempoMetronome needs at least one setting".into());
            }
            Ok(DeviceOperation::SetTempoParameters(values))
        }
        "setTempoMode" => Ok(DeviceOperation::SetTempoMode(
            match params.get("mode").and_then(Value::as_str) {
                Some("GLOBAL") => true,
                Some("PRESET") => false,
                _ => return Err("mode must be PRESET or GLOBAL".into()),
            },
        )),
        "setFavorite" => {
            let name = validate_path_component(required_text(params, "name")?, "name", 80, &[])?;
            let folder_key =
                validate_library_key(required_text(params, "folderKey")?, "folderKey")?;
            let folder_name = params
                .get("folderName")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .map(|value| validate_path_component(value, "folderName", 64, &[]))
                .transpose()?
                .unwrap_or_else(|| {
                    folder_key
                        .trim_end_matches('/')
                        .rsplit('/')
                        .next()
                        .unwrap_or_default()
                        .to_string()
                });
            Ok(DeviceOperation::SetFavorite {
                name,
                folder_key,
                folder_name,
                is_factory: boolean(params, "isFactory")?,
                favorite: boolean(params, "favorite")?,
            })
        }
        "setModelPinned" => {
            let model_id = bounded_u32(params, "modelId", u32::MAX)?;
            if model_id == 0 {
                return Err("modelId must be a positive integer".into());
            }
            Ok(DeviceOperation::SetModelPinned {
                model_id,
                pinned: boolean(params, "pinned")?,
            })
        }
        "createSetlist" | "deleteSetlist" => {
            let name = validate_setlist_name(required_text(params, "name")?)?;
            if operation == "createSetlist" {
                Ok(DeviceOperation::CreateSetlist { name })
            } else {
                Ok(DeviceOperation::DeleteSetlist { name })
            }
        }
        "deletePreset" => Ok(DeviceOperation::DeletePreset {
            setlist_key: writable_setlist_key(params, "setlistKey")?,
            name: validate_path_component(required_text(params, "name")?, "name", 80, &[])?,
        }),
        "movePreset" => Ok(DeviceOperation::MovePreset {
            setlist_key: writable_setlist_key(params, "setlistKey")?,
            name: validate_path_component(required_text(params, "name")?, "name", 80, &[])?,
            position: bounded_u32(params, "position", 255)?,
        }),
        "loadCapture" => Ok(DeviceOperation::LoadCapture {
            row: row()?,
            column: column("column")?,
            key: validate_library_key(required_text(params, "key")?, "key")?,
            name: validate_visible_text(required_text(params, "name")?, "name", 128)?,
            model_id: optional_positive_u32(params, "modelId")?,
        }),
        "loadIr" => Ok(DeviceOperation::LoadIr {
            row: row()?,
            column: column("column")?,
            key: validate_library_key(required_text(params, "key")?, "key")?,
            name: validate_visible_text(required_text(params, "name")?, "name", 128)?,
            slot: bounded_u32(params, "slot", 1)?,
            model_id: optional_positive_u32(params, "modelId")?,
        }),
        "addBlock" => Ok(DeviceOperation::AddBlock {
            row: row()?,
            column: column("column")?,
            model_id: params
                .get("modelId")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .filter(|value| *value > 0)
                .ok_or_else(|| "modelId must be a positive integer".to_string())?,
        }),
        "removeBlock" => Ok(DeviceOperation::RemoveBlock {
            row: row()?,
            column: column("column")?,
        }),
        "moveBlock" => Ok(DeviceOperation::MoveBlock {
            from_row: row()?,
            from_column: column("fromColumn")?,
            to_row: params
                .get("toRow")
                .or_else(|| params.get("row"))
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .filter(|value| *value < domain::GRID_ROWS)
                .ok_or_else(|| {
                    format!(
                        "toRow must be an integer from 0 through {}",
                        domain::GRID_ROWS - 1
                    )
                })?,
            to_column: column("toColumn")?,
        }),
        "setFootswitch" => Ok(DeviceOperation::SetFootswitch {
            row: row()?,
            column: column("column")?,
            footswitch: match params.get("footswitch") {
                None | Some(Value::Null) => None,
                Some(value) => Some(
                    value
                        .as_u64()
                        .and_then(|value| u32::try_from(value).ok())
                        .filter(|value| *value < domain::SCENE_COUNT)
                        .ok_or_else(|| {
                            format!(
                                "footswitch must be null or an integer from 0 through {}",
                                domain::SCENE_COUNT - 1
                            )
                        })?,
                ),
            },
        }),
        "setChainInput" => Ok(DeviceOperation::SetChainInput {
            row: row()?,
            input_id: bounded_u32(params, "inputId", u32::MAX)?,
        }),
        "setChainOutput" => Ok(DeviceOperation::SetChainOutput {
            row: row()?,
            output_id: bounded_u32(params, "outputId", u32::MAX)?,
        }),
        "setChainSplit" => {
            let row = row()?;
            if row % 2 != 0 {
                return Err("Parallel routing is available only on rows 0 and 2".into());
            }
            let split_column = optional_i32(params, "splitColumn")?;
            let mix_column = optional_i32(params, "mixColumn")?;
            match (split_column, mix_column) {
                (None, None) => {}
                (None, Some(_)) => {
                    return Err("mixColumn must be null when the split is disabled".into());
                }
                (Some(split), Some(mix))
                    if (0..domain::GRID_COLUMNS as i32).contains(&split)
                        && (mix == -1
                            || ((0..domain::GRID_COLUMNS as i32).contains(&mix)
                                && mix > split)) => {}
                _ => {
                    return Err(
                        "splitColumn must be 0 through 7 and mixColumn must be -1 or a later column"
                            .into(),
                    );
                }
            }
            Ok(DeviceOperation::SetChainSplit {
                row,
                split_column,
                mix_column,
            })
        }
        "setSplitMute" => {
            let row = row()?;
            if row % 2 != 0 {
                return Err("Splitter/mixer controls are available only on rows 0 and 2".into());
            }
            Ok(DeviceOperation::SetSplitMute {
                row,
                muted: boolean(params, "muted")?,
            })
        }
        "setRoutingParameter" => {
            let node = required_text(params, "node")?;
            if !matches!(node.as_str(), "splitter" | "mixer") {
                return Err("node must be splitter or mixer".into());
            }
            Ok(DeviceOperation::SetRoutingParameter {
                row: row()?,
                node,
                parameter_index: bounded_u32(params, "parameterIndex", u32::MAX)?,
                value: normalized(params, "value")?,
            })
        }
        "device.setLaneControlParameter" | "setLaneControlParameter" => {
            let control = required_text(params, "control")?;
            if !matches!(control.as_str(), "inputGate" | "laneOutput") {
                return Err("control must be inputGate or laneOutput".into());
            }
            Ok(DeviceOperation::SetLaneControlParameter {
                row: row()?,
                control,
                parameter_index: bounded_u32(params, "parameterIndex", u32::MAX)?,
                value: normalized(params, "value")?,
            })
        }
        "device.setLaneControlSceneMode" | "setLaneControlSceneMode" => {
            let control = required_text(params, "control")?;
            if !matches!(control.as_str(), "inputGate" | "laneOutput") {
                return Err("control must be inputGate or laneOutput".into());
            }
            Ok(DeviceOperation::SetLaneControlSceneMode {
                row: row()?,
                control,
                parameter_index: bounded_u32(params, "parameterIndex", u32::MAX)?,
                enabled: boolean(params, "enabled")?,
            })
        }
        "device.setParameterSceneMode" | "setParameterSceneMode" => {
            let column = bounded_u32(params, "column", domain::GRID_COLUMNS + 1)?;
            if column >= domain::GRID_COLUMNS && row()? % 2 != 0 {
                return Err("Splitter and mixer parameters exist only on rows 0 and 2".into());
            }
            Ok(DeviceOperation::SetParameterSceneMode {
                row: row()?,
                column,
                parameter_index: bounded_u32(params, "parameterIndex", u32::MAX)?,
                enabled: boolean(params, "enabled")?,
            })
        }
        "device.setParameterExpression" | "setParameterExpression" => {
            let column = bounded_u32(params, "column", domain::GRID_COLUMNS + 1)?;
            if column >= domain::GRID_COLUMNS && row()? % 2 != 0 {
                return Err("Splitter and mixer parameters exist only on rows 0 and 2".into());
            }
            Ok(DeviceOperation::SetParameterExpression {
                row: row()?,
                column,
                parameter_index: bounded_u32(params, "parameterIndex", u32::MAX)?,
                pedal: bounded_u32(params, "pedal", 2)?,
                minimum: normalized(params, "minimum")?,
                maximum: normalized(params, "maximum")?,
            })
        }
        "device.setStompMomentary" | "setStompMomentary" => {
            Ok(DeviceOperation::SetStompMomentary {
                footswitch: bounded_u32(params, "footswitch", domain::SCENE_COUNT - 1)?,
                momentary: boolean(params, "momentary")?,
            })
        }
        "device.setStompLabel" | "setStompLabel" => {
            let label = validate_visible_text(required_text(params, "label")?, "label", 32)?;
            Ok(DeviceOperation::SetStompLabel {
                footswitch: bounded_u32(params, "footswitch", domain::SCENE_COUNT - 1)?,
                label,
                single: params
                    .get("single")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        }
        "device.setMidiOut" | "setMidiOut" => Ok(DeviceOperation::SetMidiOut {
            source: bounded_u32(params, "source", 9)?,
            messages: midi_out_messages(params)?,
        }),
        "device.setPresetLoadMidiOut" | "setPresetLoadMidiOut" => {
            Ok(DeviceOperation::SetPresetLoadMidiOut {
                messages: midi_out_messages(params)?,
            })
        }
        "device.setExpressionBypass" | "setExpressionBypass" => {
            Ok(DeviceOperation::SetExpressionBypass {
                row: row()?,
                column: column("column")?,
                pedal: params
                    .get("pedal")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                    .filter(|value| (1..=2).contains(value))
                    .ok_or_else(|| "pedal must be 1 or 2".to_string())?,
                mode: bounded_u32(params, "mode", 2)?,
                invert: boolean(params, "invert")?,
                delay_ms: bounded_u32(params, "delayMs", 5_000)?,
                latch_emulation: boolean(params, "latchEmulation")?,
            })
        }
        "listPresetFolders" => Ok(DeviceOperation::ListPresetFolders),
        "savePreset" => Ok(DeviceOperation::SavePreset {
            setlist_key: validate_setlist_key(required_text(params, "setlistKey")?, "setlistKey")?,
            position: bounded_u32(params, "position", 255)?,
            name: validate_path_component(required_text(params, "name")?, "name", 80, &[])?,
            instrument: params
                .get("instrument")
                .and_then(Value::as_i64)
                .and_then(|value| i32::try_from(value).ok())
                .unwrap_or(0),
        }),
        "device.copyScene" | "copyScene" => Ok(DeviceOperation::CopyScene {
            from_index: bounded_u32(params, "fromScene", domain::SCENE_COUNT - 1)?,
            to_index: bounded_u32(params, "toScene", domain::SCENE_COUNT - 1)?,
            swap: params.get("swap").and_then(Value::as_bool).unwrap_or(false),
        }),
        "device.setSceneLabel" | "setSceneLabel" => Ok(DeviceOperation::SetSceneLabel {
            scene: bounded_u32(params, "scene", domain::SCENE_COUNT - 1)?,
            label: match params.get("label") {
                None | Some(Value::Null) => None,
                Some(Value::String(label)) => {
                    Some(validate_visible_text(label.clone(), "label", 32)?)
                }
                _ => return Err("label must be null or at most 32 visible characters".into()),
            },
        }),
        "device.setSceneColor" | "setSceneColor" => Ok(DeviceOperation::SetSceneColor {
            scene: bounded_u32(params, "scene", domain::SCENE_COUNT - 1)?,
            color: params
                .get("color")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "color must be an unsigned 32-bit ARGB integer".to_string())?,
        }),
        _ => Err(format!("unknown native device operation: {operation}")),
    }
}

fn verification_for_operation(
    operation: &DeviceOperation,
    params: &Value,
    snapshot: Option<&GatewaySnapshot>,
) -> GatewayVerification {
    match operation {
        DeviceOperation::AddBlock {
            row,
            column,
            model_id,
        } => GatewayVerification::Block {
            row: *row,
            column: *column,
            model_id: Some(*model_id),
            present: true,
        },
        DeviceOperation::RemoveBlock { row, column } => GatewayVerification::Block {
            row: *row,
            column: *column,
            model_id: None,
            present: false,
        },
        DeviceOperation::LoadCapture {
            row,
            column,
            model_id: Some(model_id),
            ..
        }
        | DeviceOperation::LoadIr {
            row,
            column,
            model_id: Some(model_id),
            ..
        } => GatewayVerification::Block {
            row: *row,
            column: *column,
            model_id: Some(*model_id),
            present: true,
        },
        DeviceOperation::MoveBlock {
            to_row, to_column, ..
        } => GatewayVerification::Block {
            row: *to_row,
            column: *to_column,
            model_id: params
                .get("expectedModelId")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok()),
            present: true,
        },
        DeviceOperation::SetFootswitch {
            row,
            column,
            footswitch,
        } => GatewayVerification::Footswitch {
            row: *row,
            column: *column,
            footswitch: *footswitch,
        },
        DeviceOperation::SetStompMomentary {
            footswitch,
            momentary,
        } => GatewayVerification::StompMomentary {
            footswitch: *footswitch,
            momentary: *momentary,
        },
        DeviceOperation::SetStompLabel {
            footswitch, label, ..
        } => GatewayVerification::StompLabel {
            footswitch: *footswitch,
            label: label.clone(),
        },
        DeviceOperation::SetMidiOut { source, messages } => GatewayVerification::MidiOut {
            source: Some(*source),
            messages: messages.clone(),
        },
        DeviceOperation::SetPresetLoadMidiOut { messages } => GatewayVerification::MidiOut {
            source: None,
            messages: messages.clone(),
        },
        DeviceOperation::SetExpressionBypass {
            row,
            column,
            pedal,
            mode,
            invert,
            delay_ms,
            latch_emulation,
        } => GatewayVerification::ExpressionBypass {
            row: *row,
            column: *column,
            pedal: *pedal,
            mode: *mode,
            invert: *invert,
            delay_ms: *delay_ms,
            latch_emulation: *latch_emulation,
        },
        DeviceOperation::SetChainInput { row, input_id } => GatewayVerification::RouteInput {
            row: *row,
            input_id: *input_id,
        },
        DeviceOperation::SetChainOutput { row, output_id } => GatewayVerification::RouteOutput {
            row: *row,
            output_id: *output_id,
        },
        DeviceOperation::SetChainSplit {
            row,
            split_column,
            mix_column,
        } => GatewayVerification::RouteSplit {
            row: *row,
            split_column: *split_column,
            mix_column: *mix_column,
        },
        DeviceOperation::SetSplitMute { row, muted } => GatewayVerification::SplitMute {
            row: *row,
            muted: *muted,
        },
        DeviceOperation::SavePreset {
            setlist_key,
            position,
            name,
            ..
        } => GatewayVerification::Preset {
            setlist_key: setlist_key.clone(),
            position: *position,
            name: Some(name.clone()),
            require_clean: true,
        },
        DeviceOperation::SetSceneLabel { scene, label } => GatewayVerification::SceneLabel {
            scene: *scene,
            label: label.clone(),
        },
        DeviceOperation::SetSceneColor { scene, color } => GatewayVerification::SceneColor {
            scene: *scene,
            color: format!("#{:06x}", color & 0x00ff_ffff),
        },
        DeviceOperation::CopyScene {
            from_index,
            to_index,
            swap,
        } => snapshot
            .and_then(|before| {
                Some(GatewayVerification::SceneCopy {
                    from_scene: *from_index,
                    to_scene: *to_index,
                    swap: *swap,
                    from_label: before.scenes.get(*from_index as usize)?.clone(),
                    to_label: before.scenes.get(*to_index as usize)?.clone(),
                    from_color: before
                        .scene_colors
                        .as_ref()
                        .and_then(|colors| colors.get(*from_index as usize))
                        .cloned(),
                    to_color: before
                        .scene_colors
                        .as_ref()
                        .and_then(|colors| colors.get(*to_index as usize))
                        .cloned(),
                })
            })
            .unwrap_or(GatewayVerification::None),
        DeviceOperation::Command(_)
        | DeviceOperation::SetRoutingParameter { .. }
        | DeviceOperation::SetLaneControlParameter { .. }
        | DeviceOperation::SetLaneControlSceneMode { .. }
        | DeviceOperation::SetParameterSceneMode { .. }
        | DeviceOperation::SetParameterExpression { .. }
        | DeviceOperation::ListPresetFolders
        | DeviceOperation::ReadVersion
        | DeviceOperation::SetDeviceName(_)
        | DeviceOperation::Undo
        | DeviceOperation::Redo
        | DeviceOperation::ReadInhibitedModules
        | DeviceOperation::ReadTuner
        | DeviceOperation::SetTunerInput(_)
        | DeviceOperation::SetTunerMute(_)
        | DeviceOperation::SetTunerReference(_)
        | DeviceOperation::ReadGeneralSettings
        | DeviceOperation::SetGeneralInteger { .. }
        | DeviceOperation::SetGeneralToggle { .. }
        | DeviceOperation::SetSceneBypassBehavior(_)
        | DeviceOperation::SetMasterVolumeAssignment { .. }
        | DeviceOperation::SetGlobalBypass { .. }
        | DeviceOperation::ReadIoSettings
        | DeviceOperation::SetInputPort { .. }
        | DeviceOperation::SetOutputPort { .. }
        | DeviceOperation::SetUsbPort { .. }
        | DeviceOperation::SetMidiThru(_)
        | DeviceOperation::SetOutputPairing { .. }
        | DeviceOperation::ReadGlobalEq
        | DeviceOperation::SetGlobalEqBypassed(_)
        | DeviceOperation::SetGlobalEqParameters(_)
        | DeviceOperation::ReadModeCycle
        | DeviceOperation::SetModeCycle(_)
        | DeviceOperation::ReadGlobalTempo
        | DeviceOperation::SetTempoParameters(_)
        | DeviceOperation::SetTempoMode(_)
        | DeviceOperation::ReadLooperStatus
        | DeviceOperation::ReadRecentsFavorites { .. }
        | DeviceOperation::SetFavorite { .. }
        | DeviceOperation::ReadPinnedModels
        | DeviceOperation::SetModelPinned { .. }
        | DeviceOperation::ReadLibraryFiles { .. }
        | DeviceOperation::CreateSetlist { .. }
        | DeviceOperation::DeleteSetlist { .. }
        | DeviceOperation::DeletePreset { .. }
        | DeviceOperation::MovePreset { .. }
        | DeviceOperation::LoadCapture { model_id: None, .. }
        | DeviceOperation::LoadIr { model_id: None, .. }
        | DeviceOperation::PresetScreenshot { .. }
        | DeviceOperation::CaptureScreen
        | DeviceOperation::ScreenTap { .. } => GatewayVerification::None,
    }
}

pub fn plan_gateway_write(
    method: &str,
    params: &Value,
    snapshot: Option<&GatewaySnapshot>,
) -> Result<GatewayWritePlan, String> {
    let required_guards: &[&str] = match method {
        "device.selectScene"
        | "device.copyScene"
        | "device.setSceneLabel"
        | "device.setSceneColor"
        | "device.selectModeSlot"
        | "device.setParameterSceneMode"
        | "device.setParameterExpression"
        | "device.setLaneControlSceneMode"
        | "device.setExpressionBypass"
        | "device.addBlock"
        | "device.setStompMomentary"
        | "device.setStompLabel"
        | "device.setMidiOut"
        | "device.setPresetLoadMidiOut" => &["expectedPresetName"],
        "device.pressFootswitch" | "device.tapTempo" => &["expectedMode", "expectedPresetName"],
        "device.setMasterVolume" => &["expectedValue"],
        "device.setTempo" => &["expectedTempo", "expectedPresetName"],
        "device.toggleBypass" => &["expectedBypassed", "expectedScene", "expectedPresetName"],
        "device.setParameter" | "device.previewParameter" => {
            &["expectedValue", "expectedScene", "expectedPresetName"]
        }
        "device.setLaneControlParameter" | "device.previewLaneControlParameter" => {
            &["expectedValue", "expectedPresetName"]
        }
        "device.moveBlock" | "device.removeBlock" | "device.loadCapture" | "device.loadIr" => {
            &["expectedModelId", "expectedPresetName"]
        }
        "device.setBlockFootswitch" => &[
            "expectedFootswitch",
            "expectedModelId",
            "expectedPresetName",
        ],
        "device.setChainInput" => &["expectedInputId", "expectedPresetName"],
        "device.setChainOutput" => &["expectedOutputId", "expectedPresetName"],
        "device.setChainSplit" => &[
            "expectedSplitColumn",
            "expectedMixColumn",
            "expectedPresetName",
        ],
        "device.setSplitMute" => &["expectedMuted", "expectedPresetName"],
        _ => &[],
    };
    for field in required_guards {
        let present = params.get(*field).is_some_and(|value| {
            *field != "expectedPresetName" || value.as_str().is_some_and(|name| !name.is_empty())
        });
        if !present {
            return Err(format!("{field} is required to guard {method}"));
        }
    }
    if method.starts_with("device.") && !method.starts_with("device.command.") {
        assert_expected_preset(snapshot, params)?;
        assert_expected_state(method, snapshot, params)?;
    }
    let plan = match method {
        "device.setGeneralInteger"
        | "device.setGeneralToggle"
        | "device.setSceneBypassBehavior"
        | "device.setMasterVolumeAssignment"
        | "device.setGlobalBypass" => {
            let operation_name = match method {
                "device.setGeneralInteger" => "setGeneralInteger",
                "device.setGeneralToggle" => "setGeneralToggle",
                "device.setSceneBypassBehavior" => "setSceneBypassBehavior",
                "device.setMasterVolumeAssignment" => "setMasterVolumeAssignment",
                _ => "setGlobalBypass",
            };
            GatewayWritePlan {
                write: PlannedWrite::HidOperation(operation(operation_name, params)?),
                detail: "Global device setting sent to the Quad Cortex".into(),
                verification: GatewayVerification::None,
            }
        }
        "device.setTunerInput"
        | "device.setTunerMute"
        | "device.restoreTunerAudio"
        | "device.setTunerReference" => {
            let operation_name = match method {
                "device.setTunerInput" => "setTunerInput",
                "device.setTunerMute" => "setTunerMute",
                "device.restoreTunerAudio" => "restoreTunerAudio",
                _ => "setTunerReference",
            };
            GatewayWritePlan {
                write: PlannedWrite::HidOperation(operation(operation_name, params)?),
                detail: match method {
                    "device.setTunerInput" => {
                        "Tuner input updated; the tuner is now invisibly engaged"
                    }
                    "device.setTunerMute" => {
                        "Tuner mute preference updated; the tuner is now invisibly engaged"
                    }
                    "device.restoreTunerAudio" => "Tuner mute preference cleared to restore audio",
                    _ => "Tuner reference updated; the tuner is now invisibly engaged",
                }
                .into(),
                verification: GatewayVerification::None,
            }
        }
        "device.setInputPort"
        | "device.setOutputPort"
        | "device.setUsbPort"
        | "device.setMidiThru"
        | "device.setOutputPairing" => {
            let operation_name = match method {
                "device.setInputPort" => "setInputPort",
                "device.setOutputPort" => "setOutputPort",
                "device.setUsbPort" => "setUsbPort",
                "device.setMidiThru" => "setMidiThru",
                _ => "setOutputPairing",
            };
            GatewayWritePlan {
                write: PlannedWrite::HidOperation(operation(operation_name, params)?),
                detail: "Global I/O setting sent to the Quad Cortex".into(),
                verification: GatewayVerification::None,
            }
        }
        "device.setGlobalEqBypassed"
        | "device.setGlobalEqBand"
        | "device.setGlobalEqOutput"
        | "device.setModeCycle" => {
            let operation_name = match method {
                "device.setGlobalEqBypassed" => "setGlobalEqBypassed",
                "device.setGlobalEqBand" => "setGlobalEqBand",
                "device.setGlobalEqOutput" => "setGlobalEqOutput",
                _ => "setModeCycle",
            };
            GatewayWritePlan {
                write: PlannedWrite::HidOperation(operation(operation_name, params)?),
                detail: if method == "device.setModeCycle" {
                    "Mode cycle sent to the Quad Cortex"
                } else {
                    "Global EQ setting sent to the Quad Cortex"
                }
                .into(),
                verification: GatewayVerification::None,
            }
        }
        "device.setTempoMetronome" => GatewayWritePlan {
            write: PlannedWrite::HidOperation(operation("setTempoMetronome", params)?),
            detail: "Preset tempo and metronome settings sent to the Quad Cortex".into(),
            verification: GatewayVerification::None,
        },
        "device.setTempoMode" => GatewayWritePlan {
            write: PlannedWrite::HidOperation(operation("setTempoMode", params)?),
            detail: "Global tempo mode sent to the Quad Cortex".into(),
            verification: GatewayVerification::None,
        },
        "device.setFavorite"
        | "device.setModelPinned"
        | "device.createSetlist"
        | "device.deleteSetlist"
        | "device.deletePreset"
        | "device.movePreset"
        | "device.loadCapture"
        | "device.loadIr" => {
            let operation_name = match method {
                "device.setFavorite" => "setFavorite",
                "device.setModelPinned" => "setModelPinned",
                "device.createSetlist" => "createSetlist",
                "device.deleteSetlist" => "deleteSetlist",
                "device.deletePreset" => "deletePreset",
                "device.movePreset" => "movePreset",
                "device.loadCapture" => "loadCapture",
                _ => "loadIr",
            };
            GatewayWritePlan {
                write: PlannedWrite::HidOperation(operation(operation_name, params)?),
                detail: format!("{operation_name} sent to the Quad Cortex"),
                verification: GatewayVerification::None,
            }
        }
        "device.selectScene" | "device.command.scene" => {
            let scene = bounded_u32(params, "scene", domain::SCENE_COUNT - 1)?;
            GatewayWritePlan {
                write: PlannedWrite::HidCommand(DeviceCommand::SelectScene(scene)),
                detail: format!("Scene {} selected", (b'A' + scene as u8) as char),
                verification: GatewayVerification::Scene { scene },
            }
        }
        "device.toggleBypass" | "device.command.bypass" => {
            let bypassed = if method == "device.toggleBypass" {
                boolean(params, "desiredBypassed")?
            } else {
                boolean(params, "bypassed")?
            };
            GatewayWritePlan {
                write: PlannedWrite::HidCommand(DeviceCommand::SetBypass {
                    row: bounded_u32(params, "row", domain::GRID_ROWS - 1)?,
                    column: bounded_u32(params, "column", domain::GRID_COLUMNS - 1)?,
                    bypassed,
                }),
                detail: "Block bypass updated".into(),
                verification: GatewayVerification::Bypass {
                    row: bounded_u32(params, "row", domain::GRID_ROWS - 1)?,
                    column: bounded_u32(params, "column", domain::GRID_COLUMNS - 1)?,
                    bypassed,
                },
            }
        }
        "device.previewParameter" | "device.setParameter" | "device.command.parameter" => {
            let row = bounded_u32(params, "row", domain::GRID_ROWS - 1)?;
            let column = bounded_u32(params, "column", domain::GRID_COLUMNS + 1)?;
            let parameter_index = bounded_u32(params, "parameterIndex", u32::MAX)?;
            let numeric_value = params.get("value").and_then(Value::as_f64);
            let write = if column >= domain::GRID_COLUMNS {
                if row % 2 != 0 {
                    return Err("Splitter and mixer parameters exist only on rows 0 and 2".into());
                }
                if params.get("text").is_some() {
                    return Err(
                        "Splitter and mixer parameters use normalized numeric values".into(),
                    );
                }
                PlannedWrite::HidOperation(DeviceOperation::SetRoutingParameter {
                    row,
                    node: if column == domain::GRID_COLUMNS {
                        "splitter"
                    } else {
                        "mixer"
                    }
                    .into(),
                    parameter_index,
                    value: normalized(params, "value")?,
                })
            } else if let Some(text) = params.get("text").and_then(Value::as_str) {
                PlannedWrite::HidCommand(DeviceCommand::SetParameterText {
                    row,
                    column,
                    parameter_index,
                    value: text.into(),
                })
            } else {
                PlannedWrite::HidCommand(DeviceCommand::SetParameterNumeric {
                    row,
                    column,
                    parameter_index,
                    value: normalized(params, "value")?,
                })
            };
            GatewayWritePlan {
                write,
                detail: if method == "device.previewParameter" {
                    "Parameter preview sent"
                } else {
                    "Parameter update sent to the Quad Cortex"
                }
                .into(),
                verification: if method == "device.previewParameter" {
                    GatewayVerification::None
                } else {
                    GatewayVerification::Parameter {
                        row,
                        column,
                        parameter_index,
                        value: numeric_value.unwrap_or_default(),
                    }
                },
            }
        }
        "device.previewLaneControlParameter" | "device.setLaneControlParameter" => {
            let operation = operation("setLaneControlParameter", params)?;
            GatewayWritePlan {
                write: PlannedWrite::HidOperation(operation),
                detail: if method == "device.previewLaneControlParameter" {
                    "Lane control parameter preview sent"
                } else {
                    "Lane control parameter update sent to the Quad Cortex"
                }
                .into(),
                verification: GatewayVerification::None,
            }
        }
        "device.setLaneControlSceneMode" => GatewayWritePlan {
            write: PlannedWrite::HidOperation(operation("setLaneControlSceneMode", params)?),
            detail: "Lane control scene behavior updated".into(),
            verification: GatewayVerification::None,
        },
        "device.setTempo" | "device.command.tempo" => {
            let bpm = bounded_u32(params, "bpm", domain::MAXIMUM_TEMPO_BPM)?;
            if bpm < domain::MINIMUM_TEMPO_BPM {
                return Err(format!(
                    "bpm must be an integer from {} through {}",
                    domain::MINIMUM_TEMPO_BPM,
                    domain::MAXIMUM_TEMPO_BPM
                ));
            }
            GatewayWritePlan {
                write: PlannedWrite::HidCommand(DeviceCommand::SetTempo(bpm)),
                detail: format!("Tempo set to {bpm} BPM"),
                verification: GatewayVerification::Tempo { bpm },
            }
        }
        "device.setMasterVolume" => {
            let value = bounded_u32(params, "value", 100)?;
            GatewayWritePlan {
                write: PlannedWrite::HidCommand(DeviceCommand::SetMasterVolume(
                    value as f32 / 100.0,
                )),
                detail: format!("Master Volume set to {value}; awaiting device echo"),
                verification: GatewayVerification::MasterVolume { value },
            }
        }
        "device.setDeviceName" => {
            let name = validate_visible_text(required_text(params, "name")?, "Device name", 64)?;
            GatewayWritePlan {
                write: PlannedWrite::HidOperation(DeviceOperation::SetDeviceName(name.clone())),
                detail: format!("Device name change to {name} sent"),
                verification: GatewayVerification::None,
            }
        }
        "device.undo" => GatewayWritePlan {
            write: PlannedWrite::HidOperation(DeviceOperation::Undo),
            detail: "Device undo sent".into(),
            verification: GatewayVerification::None,
        },
        "device.redo" => GatewayWritePlan {
            write: PlannedWrite::HidOperation(DeviceOperation::Redo),
            detail: "Device redo sent".into(),
            verification: GatewayVerification::None,
        },
        "device.tapScreen" => {
            let x = screen_coordinate(params, "x", 800.0)?;
            let y = screen_coordinate(params, "y", 480.0)?;
            GatewayWritePlan {
                write: PlannedWrite::HidOperation(DeviceOperation::ScreenTap { x, y }),
                detail: format!("Tapped the Quad Cortex screen at ({x}, {y})"),
                verification: GatewayVerification::None,
            }
        }
        "device.addBlock"
        | "device.removeBlock"
        | "device.moveBlock"
        | "device.setBlockFootswitch"
        | "device.setChainInput"
        | "device.setChainOutput"
        | "device.setChainSplit"
        | "device.setSplitMute"
        | "device.copyScene"
        | "device.setSceneLabel"
        | "device.setSceneColor" => {
            let operation_name = match method {
                "device.addBlock" => "addBlock",
                "device.removeBlock" => "removeBlock",
                "device.moveBlock" => "moveBlock",
                "device.setBlockFootswitch" => "setFootswitch",
                "device.setChainInput" => "setChainInput",
                "device.setChainOutput" => "setChainOutput",
                "device.setSplitMute" => "setSplitMute",
                "device.copyScene" => "copyScene",
                "device.setSceneLabel" => "setSceneLabel",
                "device.setSceneColor" => "setSceneColor",
                _ => "setChainSplit",
            };
            let operation = operation(operation_name, params)?;
            GatewayWritePlan {
                verification: verification_for_operation(&operation, params, snapshot),
                write: PlannedWrite::HidOperation(operation),
                detail: if method == "device.moveBlock" {
                    "Block moved".into()
                } else {
                    format!("{operation_name} sent to the Quad Cortex")
                },
            }
        }
        "device.setParameterSceneMode" | "device.setParameterExpression" => {
            let operation = operation(method, params)?;
            GatewayWritePlan {
                verification: GatewayVerification::None,
                write: PlannedWrite::HidOperation(operation),
                detail: if method == "device.setParameterSceneMode" {
                    "Parameter scene behavior sent to the Quad Cortex"
                } else {
                    "Parameter expression assignment sent to the Quad Cortex"
                }
                .into(),
            }
        }
        "device.setStompMomentary" => {
            let operation = operation(method, params)?;
            let DeviceOperation::SetStompMomentary { footswitch, .. } = operation else {
                unreachable!();
            };
            let assigned = snapshot
                .ok_or_else(|| {
                    "A synchronized preset is required to change stomp behavior".to_string()
                })?
                .blocks
                .iter()
                .filter(|block| block.footswitch == Some(footswitch))
                .count();
            if assigned != 1 {
                return Err(format!(
                    "Footswitch {} must drive exactly one block to change latching behavior; it currently drives {assigned}",
                    (b'A' + footswitch as u8) as char
                ));
            }
            GatewayWritePlan {
                verification: verification_for_operation(&operation, params, snapshot),
                write: PlannedWrite::HidOperation(operation),
                detail: "STOMP latching behavior sent to the Quad Cortex".into(),
            }
        }
        "device.setStompLabel" => {
            let footswitch = bounded_u32(params, "footswitch", domain::SCENE_COUNT - 1)?;
            let label = validate_visible_text(required_text(params, "label")?, "label", 32)?;
            let single = snapshot
                .ok_or_else(|| {
                    "A synchronized preset is required to label a stomp switch".to_string()
                })?
                .blocks
                .iter()
                .filter(|block| block.footswitch == Some(footswitch))
                .count()
                == 1;
            let operation = DeviceOperation::SetStompLabel {
                footswitch,
                label,
                single,
            };
            GatewayWritePlan {
                verification: verification_for_operation(&operation, params, snapshot),
                write: PlannedWrite::HidOperation(operation),
                detail: "STOMP label sent to the Quad Cortex".into(),
            }
        }
        "device.setMidiOut" | "device.setPresetLoadMidiOut" | "device.setExpressionBypass" => {
            let operation = operation(method, params)?;
            GatewayWritePlan {
                verification: verification_for_operation(&operation, params, snapshot),
                write: PlannedWrite::HidOperation(operation),
                detail: match method {
                    "device.setMidiOut" => "Preset MIDI Out source sent to the Quad Cortex",
                    "device.setPresetLoadMidiOut" => "Preset-load MIDI Out sent to the Quad Cortex",
                    _ => "Expression bypass assignment sent to the Quad Cortex",
                }
                .into(),
            }
        }
        "device.command.operation" => {
            let name = required_text(params, "operation")?;
            let operation = operation(&name, params)?;
            GatewayWritePlan {
                verification: verification_for_operation(&operation, params, snapshot),
                write: PlannedWrite::HidOperation(operation),
                detail: format!("{name} accepted"),
            }
        }
        "device.pressFootswitch"
        | "device.tapTempo"
        | "device.selectModeSlot"
        | "device.showTuner"
        | "device.showGigView"
        | "device.controlLooper" => {
            let midi = plan_host_midi(method, params)?;
            GatewayWritePlan {
                write: PlannedWrite::MidiControlChange {
                    controller: midi.controller,
                    value: midi.value,
                },
                detail: midi.detail,
                verification: GatewayVerification::None,
            }
        }
        _ => return Err(format!("Gateway write method is not supported: {method}")),
    };
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use qc_protocol::state::{GridBlock, GridRoute, PresetFileListing, PresetFolderListing};
    use serde_json::json;

    #[test]
    fn retry_policy_is_shared_and_excludes_relative_or_structural_writes() {
        for method in [
            "device.recallPreset",
            "device.selectScene",
            "device.setParameter",
            "device.setTempo",
            "device.showTuner",
        ] {
            assert!(
                gateway_write_retryable(method),
                "{method} should be retryable"
            );
        }
        for method in [
            "device.navigateBank",
            "device.moveBlock",
            "device.addBlock",
            "device.removeBlock",
            "device.copyScene",
            "device.tapTempo",
        ] {
            assert!(
                !gateway_write_retryable(method),
                "{method} must not be retried"
            );
        }
    }

    #[test]
    fn every_guarded_public_write_requires_its_optimistic_token() {
        for (method, first_guard) in [
            ("device.selectScene", "expectedPresetName"),
            ("device.copyScene", "expectedPresetName"),
            ("device.setSceneLabel", "expectedPresetName"),
            ("device.setSceneColor", "expectedPresetName"),
            ("device.pressFootswitch", "expectedMode"),
            ("device.tapTempo", "expectedMode"),
            ("device.selectModeSlot", "expectedPresetName"),
            ("device.setMasterVolume", "expectedValue"),
            ("device.setTempo", "expectedTempo"),
            ("device.toggleBypass", "expectedBypassed"),
            ("device.setParameter", "expectedValue"),
            ("device.previewParameter", "expectedValue"),
            ("device.setParameterSceneMode", "expectedPresetName"),
            ("device.setParameterExpression", "expectedPresetName"),
            ("device.setLaneControlParameter", "expectedValue"),
            ("device.previewLaneControlParameter", "expectedValue"),
            ("device.setLaneControlSceneMode", "expectedPresetName"),
            ("device.setExpressionBypass", "expectedPresetName"),
            ("device.moveBlock", "expectedModelId"),
            ("device.addBlock", "expectedPresetName"),
            ("device.removeBlock", "expectedModelId"),
            ("device.setBlockFootswitch", "expectedFootswitch"),
            ("device.setStompMomentary", "expectedPresetName"),
            ("device.setStompLabel", "expectedPresetName"),
            ("device.setMidiOut", "expectedPresetName"),
            ("device.setPresetLoadMidiOut", "expectedPresetName"),
            ("device.setChainInput", "expectedInputId"),
            ("device.setChainOutput", "expectedOutputId"),
            ("device.setChainSplit", "expectedSplitColumn"),
            ("device.setSplitMute", "expectedMuted"),
            ("device.loadCapture", "expectedModelId"),
            ("device.loadIr", "expectedModelId"),
        ] {
            let error = plan_gateway_write(method, &json!({}), Some(&GatewaySnapshot::default()))
                .expect_err(method);
            assert!(error.contains(first_guard), "{method}: {error}");
        }
    }

    #[test]
    fn correlated_global_readbacks_match_only_the_fields_written() {
        assert!(gateway_write_readback_matches(
            "device.setTunerReference",
            &json!({"referenceOffsetHz": 2.5}),
            &json!({"inputPortId": 1, "referenceOffsetHz": 2.5, "muted": false})
        ));
        assert!(!gateway_write_readback_matches(
            "device.setTunerMute",
            &json!({"muted": true}),
            &json!({"muted": false})
        ));
        assert!(gateway_write_readback_matches(
            "device.setInputPort",
            &json!({"inputPortId": 2, "levelDb": -10.0, "impedance": null}),
            &json!({"inputs": [{"inputPortId": 2, "levelDb": -10.0, "impedance": 1.0}]})
        ));
        assert!(gateway_write_readback_matches(
            "device.setTempoMetronome",
            &json!({"ledEnabled": true, "volumeDb": null, "timeSignature": "4/4"}),
            &json!({"ledEnabled": true, "volumeDb": -12.0, "timeSignature": "4/4"})
        ));
        assert_eq!(
            gateway_write_readback_method("device.setGlobalEqBand"),
            Some("device.globalEq")
        );
        assert!(gateway_write_readback_matches(
            "device.setGlobalEqBand",
            &json!({"band": 2, "gain": 0.75, "filterType": 2, "enabled": true}),
            &json!({"parameters": [
                {"parameterIndex": 5, "value": 0.75},
                {"parameterIndex": 8, "value": 0.5},
                {"parameterIndex": 9, "value": 1.0}
            ]})
        ));
    }

    #[test]
    fn realtime_completion_policy_is_shared_for_performance_controls() {
        for method in [
            "device.selectScene",
            "device.toggleBypass",
            "device.setTempo",
            "device.setMasterVolume",
            "device.pressFootswitch",
            "device.tapTempo",
            "device.selectModeSlot",
            "device.showTuner",
            "device.showGigView",
            "device.controlLooper",
        ] {
            assert!(
                gateway_write_is_realtime(method),
                "{method} must complete immediately"
            );
        }
        for method in [
            "device.setParameter",
            "device.moveBlock",
            "device.recallPreset",
            "device.setSceneLabel",
        ] {
            assert!(
                !gateway_write_is_realtime(method),
                "{method} requires its existing workflow"
            );
        }
    }

    #[test]
    fn event_transactions_share_freshness_matching_and_timeout_policy() {
        let before = GatewaySnapshot {
            tempo: 100,
            ..GatewaySnapshot::default()
        };
        let after = GatewaySnapshot {
            tempo: 120,
            ..before.clone()
        };
        let transaction =
            GatewayTransaction::new(GatewayVerification::Tempo { bpm: 120 }, 5_000, 5_000, 650);
        assert_eq!(
            transaction.state(&after, None, 5_000, 5_001),
            GatewayTransactionState::Pending,
            "a matching snapshot that predates the write is not authoritative"
        );
        assert_eq!(
            transaction.state(&before, None, 5_001, 5_100),
            GatewayTransactionState::Pending,
            "a fresh event with the wrong value does not acknowledge the write"
        );
        assert_eq!(
            transaction.state(&after, None, 5_001, 5_100),
            GatewayTransactionState::Verified
        );
        assert_eq!(transaction.remaining_ms(5_600), 50);
        assert_eq!(
            transaction.state(&after, None, 5_700, 5_700),
            GatewayTransactionState::TimedOut
        );
    }

    #[test]
    fn unverified_writes_never_match_an_unrelated_snapshot() {
        let snapshot = GatewaySnapshot::default();
        let verification = GatewayVerification::None;
        assert!(!verification.requires_authoritative_readback());
        assert!(!verification.matches(&snapshot, None));

        let transaction = GatewayTransaction::new(verification, 5_000, 5_000, 650);
        assert_eq!(
            transaction.state(&snapshot, None, 5_001, 5_100),
            GatewayTransactionState::Pending
        );
        assert_eq!(
            transaction.state(&snapshot, None, 5_001, 5_700),
            GatewayTransactionState::TimedOut
        );
    }

    #[test]
    fn expected_state_merge_is_shared_and_preserves_explicit_arguments() {
        let merged = merge_expected_state(
            &json!({"scene": 2, "expectedTempo": 90}),
            &json!({"presetName": "Live", "presetPosition": 7, "activeScene": 1, "tempo": 120}),
        );
        assert_eq!(merged["expectedPresetName"], "Live");
        assert_eq!(merged["expectedPosition"], 7);
        assert_eq!(merged["expectedScene"], 1);
        assert_eq!(merged["expectedTempo"], 90);
    }

    #[test]
    fn expected_state_and_ranges_are_validated_once() {
        let snapshot = GatewaySnapshot {
            preset_name: "Live".into(),
            ..GatewaySnapshot::default()
        };
        assert!(plan_gateway_write(
            "device.selectScene",
            &json!({"scene": 2, "expectedPresetName": "Live"}),
            Some(&snapshot)
        )
        .is_ok());
        assert!(plan_gateway_write(
            "device.selectScene",
            &json!({"scene": 8, "expectedPresetName": "Live"}),
            Some(&snapshot)
        )
        .is_err());
        assert!(plan_gateway_write(
            "device.selectScene",
            &json!({"scene": 2, "expectedPresetName": "Other"}),
            Some(&snapshot)
        )
        .is_err());
    }

    #[test]
    fn hid_and_midi_execution_lanes_are_host_independent() {
        let snapshot = GatewaySnapshot {
            preset_name: "Live".into(),
            mode: "STOMP".into(),
            ..GatewaySnapshot::default()
        };
        let scene = plan_gateway_write(
            "device.selectScene",
            &json!({"scene": 3, "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(matches!(
            scene.write,
            PlannedWrite::HidCommand(DeviceCommand::SelectScene(3))
        ));

        let footswitch = plan_gateway_write(
            "device.pressFootswitch",
            &json!({"index": 7, "expectedMode": "STOMP", "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .unwrap();
        assert_eq!(
            footswitch.write,
            PlannedWrite::MidiControlChange {
                controller: profile::FOOTSWITCH_BASE_CONTROLLER + 7,
                value: profile::MIDI_PRESSED_VALUE,
            }
        );

        assert!(plan_gateway_write(
            "device.pressFootswitch",
            &json!({"index": 8, "expectedMode": "STOMP", "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .is_err());

        let tap = plan_gateway_write(
            "device.tapTempo",
            &json!({"expectedMode": "STOMP", "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .unwrap();
        assert_eq!(
            tap.write,
            PlannedWrite::MidiControlChange {
                controller: profile::TAP_TEMPO_CONTROLLER,
                value: profile::MIDI_PRESSED_VALUE,
            }
        );

        let mode = plan_gateway_write(
            "device.selectModeSlot",
            &json!({"slot": 2, "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .unwrap();
        assert_eq!(
            mode.write,
            PlannedWrite::MidiControlChange {
                controller: profile::MODE_SLOT_CONTROLLER,
                value: 2,
            }
        );

        let tuner =
            plan_gateway_write("device.showTuner", &json!({"shown": true}), Some(&snapshot))
                .unwrap();
        assert_eq!(
            tuner.write,
            PlannedWrite::MidiControlChange {
                controller: profile::TUNER_CONTROLLER,
                value: profile::MIDI_FEATURE_ON_VALUE,
            }
        );
        let gig_view = plan_gateway_write(
            "device.showGigView",
            &json!({"shown": false}),
            Some(&snapshot),
        )
        .unwrap();
        assert_eq!(
            gig_view.write,
            PlannedWrite::MidiControlChange {
                controller: profile::GIG_VIEW_CONTROLLER,
                value: profile::MIDI_FEATURE_OFF_VALUE,
            }
        );
        assert!(plan_gateway_write("device.showTuner", &json!({}), Some(&snapshot)).is_err());
        assert!(plan_gateway_write(
            "device.pressFootswitch",
            &json!({"index": 0, "expectedMode": "SCENE", "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .is_err());
    }

    #[test]
    fn public_and_low_level_writes_share_operation_planning() {
        let snapshot = GatewaySnapshot::default();
        let public = plan_gateway_write(
            "device.moveBlock",
            &json!({"row": 1, "fromColumn": 2, "toColumn": 4, "expectedModelId": null, "expectedPresetName": "Unsaved"}),
            Some(&snapshot),
        )
        .unwrap();
        let native = plan_gateway_write("device.command.operation", &json!({"operation": "moveBlock", "row": 1, "fromColumn": 2, "toRow": 1, "toColumn": 4}), None).unwrap();
        assert_eq!(public.write, native.write);
    }

    #[test]
    fn scene_management_is_validated_and_planned_in_shared_rust() {
        let snapshot = GatewaySnapshot {
            preset_name: "Scene Test".into(),
            scenes: vec!["A".into(), "B".into(), "C".into(), "D".into()],
            scene_colors: Some(vec!["#000000".into(); 8]),
            ..GatewaySnapshot::default()
        };
        let copy = plan_gateway_write(
            "device.copyScene",
            &json!({"fromScene": 1, "toScene": 3, "swap": true, "expectedPresetName": "Scene Test"}),
            Some(&snapshot),
        ).unwrap();
        assert!(matches!(
            copy.write,
            PlannedWrite::HidOperation(DeviceOperation::CopyScene {
                from_index: 1,
                to_index: 3,
                swap: true
            })
        ));
        let copied = GatewaySnapshot {
            scenes: vec!["A".into(), "D".into(), "C".into(), "B".into()],
            scene_colors: Some(vec!["#000000".into(); 8]),
            dirty: true,
            ..snapshot.clone()
        };
        assert!(copy.verification.matches(&copied, None));

        let restore = plan_gateway_write(
            "device.copyScene",
            &json!({"fromScene": 1, "toScene": 3, "swap": true, "expectedPresetName": "Scene Test"}),
            Some(&copied),
        )
        .unwrap();
        assert!(!snapshot.dirty);
        assert!(restore.verification.matches(&snapshot, None));

        let label = plan_gateway_write(
            "device.setSceneLabel",
            &json!({"scene": 2, "label": "Lead", "expectedPresetName": "Scene Test"}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(
            matches!(label.verification, GatewayVerification::SceneLabel { scene: 2, ref label } if label.as_deref() == Some("Lead"))
        );

        let clear = plan_gateway_write(
            "device.setSceneLabel",
            &json!({"scene": 2, "label": null, "expectedPresetName": "Scene Test"}),
            Some(&snapshot),
        )
        .unwrap();
        let cleared = GatewaySnapshot {
            scenes: vec![
                "Scene A".into(),
                "Scene B".into(),
                "Scene C".into(),
                "Scene D".into(),
            ],
            ..snapshot.clone()
        };
        assert!(clear.verification.matches(&cleared, None));

        let color = plan_gateway_write(
            "device.setSceneColor",
            &json!({"scene": 3, "color": 4294902466_u64, "expectedPresetName": "Scene Test"}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(
            matches!(color.verification, GatewayVerification::SceneColor { scene: 3, ref color } if color == "#ff02c2")
        );
        assert!(plan_gateway_write(
            "device.copyScene",
            &json!({"fromScene": 8, "toScene": 0}),
            Some(&snapshot)
        )
        .is_err());
    }

    #[test]
    fn parameter_assignments_are_validated_and_planned_in_shared_rust() {
        let snapshot = GatewaySnapshot {
            preset_name: "Assignment Test".into(),
            ..GatewaySnapshot::default()
        };
        let scene_mode = plan_gateway_write(
            "device.setParameterSceneMode",
            &json!({
                "row": 1,
                "column": 4,
                "parameterIndex": 7,
                "enabled": true,
                "expectedPresetName": "Assignment Test"
            }),
            Some(&snapshot),
        )
        .unwrap();
        assert_eq!(
            scene_mode.write,
            PlannedWrite::HidOperation(DeviceOperation::SetParameterSceneMode {
                row: 1,
                column: 4,
                parameter_index: 7,
                enabled: true,
            })
        );

        let expression = plan_gateway_write(
            "device.setParameterExpression",
            &json!({
                "row": 1,
                "column": 4,
                "parameterIndex": 7,
                "pedal": 2,
                "minimum": 0.9,
                "maximum": 0.1,
                "expectedPresetName": "Assignment Test"
            }),
            Some(&snapshot),
        )
        .unwrap();
        assert_eq!(
            expression.write,
            PlannedWrite::HidOperation(DeviceOperation::SetParameterExpression {
                row: 1,
                column: 4,
                parameter_index: 7,
                pedal: 2,
                minimum: 0.9,
                maximum: 0.1,
            })
        );
        let splitter_scene = plan_gateway_write(
            "device.setParameterSceneMode",
            &json!({"row": 0, "column": 8, "parameterIndex": 4, "enabled": true,
                "expectedPresetName": "Assignment Test"}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(matches!(
            splitter_scene.write,
            PlannedWrite::HidOperation(DeviceOperation::SetParameterSceneMode {
                row: 0,
                column: 8,
                parameter_index: 4,
                enabled: true
            })
        ));
        let mixer_expression = plan_gateway_write(
            "device.setParameterExpression",
            &json!({"row": 2, "column": 9, "parameterIndex": 3, "pedal": 1,
                "minimum": 0.2, "maximum": 0.9, "expectedPresetName": "Assignment Test"}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(matches!(
            mixer_expression.write,
            PlannedWrite::HidOperation(DeviceOperation::SetParameterExpression {
                row: 2,
                column: 9,
                parameter_index: 3,
                pedal: 1,
                ..
            })
        ));
        assert!(plan_gateway_write(
            "device.setParameterSceneMode",
            &json!({"row": 1, "column": 8, "parameterIndex": 4, "enabled": true}),
            Some(&snapshot),
        )
        .is_err());
        assert!(plan_gateway_write(
            "device.setParameterExpression",
            &json!({"row": 1, "column": 4, "parameterIndex": 7, "pedal": 3, "minimum": 0.0, "maximum": 1.0}),
            Some(&snapshot),
        )
        .is_err());
        assert!(plan_gateway_write(
            "device.setParameterExpression",
            &json!({"row": 1, "column": 4, "parameterIndex": 7, "pedal": 1, "minimum": -0.1, "maximum": 1.0}),
            Some(&snapshot),
        )
        .is_err());
    }

    #[test]
    fn stomp_metadata_uses_assignment_count_and_authoritative_readback() {
        let snapshot = GatewaySnapshot {
            preset_name: "Stomp Test".into(),
            blocks: vec![GridBlock {
                id: "gate".into(),
                model_id: Some(1),
                category_id: None,
                name: "Gate".into(),
                kind: "utility".into(),
                category: Some("Utility".into()),
                plugin: None,
                plugin_id: None,
                row: 0,
                column: 1,
                bypassed: Some(false),
                bypass_expression: None,
                color: None,
                glyph: None,
                footswitch: Some(4),
                footswitch_order: Some(0),
            }],
            footswitch_states: Some(vec![qc_protocol::state::FootswitchState {
                index: 4,
                active: true,
                assigned: true,
                color: "#f4f4f4".into(),
                momentary: Some(false),
                label: Some("Gate".into()),
            }]),
            ..GatewaySnapshot::default()
        };
        let momentary = plan_gateway_write(
            "device.setStompMomentary",
            &json!({"footswitch": 4, "momentary": true, "expectedPresetName": "Stomp Test"}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(matches!(
            momentary.write,
            PlannedWrite::HidOperation(DeviceOperation::SetStompMomentary {
                footswitch: 4,
                momentary: true
            })
        ));
        let readback = GatewaySnapshot {
            footswitch_states: Some(vec![qc_protocol::state::FootswitchState {
                momentary: Some(true),
                ..snapshot.footswitch_states.as_ref().unwrap()[0].clone()
            }]),
            ..snapshot.clone()
        };
        assert!(momentary.verification.matches(&readback, None));

        let label = plan_gateway_write(
            "device.setStompLabel",
            &json!({"footswitch": 4, "label": "Solo", "expectedPresetName": "Stomp Test"}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(matches!(
            label.write,
            PlannedWrite::HidOperation(DeviceOperation::SetStompLabel {
                footswitch: 4,
                ref label,
                single: true
            }) if label == "Solo"
        ));

        let unassigned = GatewaySnapshot {
            blocks: Vec::new(),
            ..snapshot
        };
        assert!(plan_gateway_write(
            "device.setStompMomentary",
            &json!({"footswitch": 4, "momentary": true, "expectedPresetName": "Stomp Test"}),
            Some(&unassigned),
        )
        .is_err());
    }

    #[test]
    fn preset_midi_out_is_bounded_and_verified_from_preset_readback() {
        let params = json!({
            "source": 8,
            "messages": [{"type": 1, "channel": 3, "param1": 10, "param2": 5, "param3": 120}],
            "expectedPresetName": "MIDI Test"
        });
        let before = GatewaySnapshot {
            preset_name: "MIDI Test".into(),
            ..GatewaySnapshot::default()
        };
        let plan = plan_gateway_write("device.setMidiOut", &params, Some(&before)).unwrap();
        assert!(matches!(
            plan.write,
            PlannedWrite::HidOperation(DeviceOperation::SetMidiOut { source: 8, ref messages })
                if messages.len() == 1 && messages[0].channel == 3
        ));
        let after = GatewaySnapshot {
            midi_out: Some(vec![qc_protocol::state::MidiOutSource {
                source: 8,
                messages: vec![MidiOutMessage {
                    r#type: 1,
                    channel: 3,
                    param1: 10,
                    param2: 5,
                    param3: 120,
                }],
            }]),
            ..before.clone()
        };
        assert!(plan.verification.matches(&after, None));
        assert!(plan_gateway_write(
            "device.setMidiOut",
            &json!({"source": 10, "messages": [], "expectedPresetName": "MIDI Test"}),
            Some(&before)
        )
        .is_err());
        assert!(plan_gateway_write(
            "device.setPresetLoadMidiOut",
            &json!({"messages": [{"type": 4, "channel": 1, "param1": 0, "param2": 0, "param3": 0}], "expectedPresetName": "MIDI Test"}),
            Some(&before)
        )
        .is_err());
    }

    #[test]
    fn expression_bypass_is_validated_and_verified_from_block_state() {
        let before = GatewaySnapshot {
            preset_name: "Expression Test".into(),
            blocks: vec![GridBlock {
                id: "amp".into(),
                model_id: Some(42),
                category_id: None,
                name: "Amp".into(),
                kind: "amp".into(),
                category: Some("Amp".into()),
                plugin: None,
                plugin_id: None,
                row: 0,
                column: 2,
                bypassed: Some(false),
                bypass_expression: None,
                color: None,
                glyph: None,
                footswitch: None,
                footswitch_order: None,
            }],
            ..GatewaySnapshot::default()
        };
        let params = json!({"row":0,"column":2,"pedal":2,"mode":1,"invert":true,
            "delayMs":250,"latchEmulation":true,"expectedPresetName":"Expression Test"});
        let plan =
            plan_gateway_write("device.setExpressionBypass", &params, Some(&before)).unwrap();
        assert!(matches!(
            plan.write,
            PlannedWrite::HidOperation(DeviceOperation::SetExpressionBypass {
                row: 0,
                column: 2,
                pedal: 2,
                mode: 1,
                invert: true,
                delay_ms: 250,
                latch_emulation: true
            })
        ));
        let mut after = before.clone();
        after.blocks[0].bypass_expression = Some(qc_protocol::state::BypassExpression {
            pedal: 2,
            minimum: 0.0,
            maximum: 1.0,
            mode: 1,
            invert: true,
            delay_ms: 250,
            latch_emulation: true,
        });
        assert!(plan.verification.matches(&after, None));
        let bad = json!({"row":0,"column":2,"pedal":0,"mode":1,"invert":false,
            "delayMs":0,"latchEmulation":false,"expectedPresetName":"Expression Test"});
        assert!(plan_gateway_write("device.setExpressionBypass", &bad, Some(&before)).is_err());
    }

    #[test]
    fn optimistic_tokens_guard_blocks_routes_and_global_state() {
        let snapshot = GatewaySnapshot {
            preset_name: "Live".into(),
            active_scene: 3,
            tempo: 122,
            master_volume: 64,
            blocks: vec![GridBlock {
                id: "block-1".into(),
                model_id: Some(42),
                category_id: None,
                name: "Drive".into(),
                kind: "Drive".into(),
                category: Some("Drive".into()),
                plugin: None,
                plugin_id: None,
                row: 1,
                column: 2,
                bypassed: Some(false),
                bypass_expression: None,
                color: None,
                glyph: None,
                footswitch: Some(5),
                footswitch_order: None,
            }],
            routes: vec![GridRoute {
                row: 1,
                input_id: Some(1),
                output_id: Some(5),
                input: "In 1".into(),
                output: "Out 1/2".into(),
                split_column: Some(4),
                mix_column: Some(8),
                split_muted: false,
            }],
            ..GatewaySnapshot::default()
        };
        let current = json!({
            "row": 1, "column": 2, "desiredBypassed": true,
            "expectedPresetName": "Live", "expectedScene": 3,
            "expectedBypassed": false
        });
        assert!(plan_gateway_write("device.toggleBypass", &current, Some(&snapshot)).is_ok());
        assert!(plan_gateway_write(
            "device.toggleBypass",
            &json!({"row": 1, "column": 2, "desiredBypassed": true, "expectedScene": 2}),
            Some(&snapshot)
        )
        .is_err());
        assert!(assert_expected_state(
            "device.setBlockFootswitch",
            Some(&snapshot),
            &json!({"row": 1, "column": 2, "expectedModelId": 42, "expectedFootswitch": 5})
        )
        .is_ok());
        assert!(assert_expected_state(
            "device.setChainSplit",
            Some(&snapshot),
            &json!({"row": 1, "expectedSplitColumn": 3, "expectedMixColumn": 8})
        )
        .is_err());
        assert!(assert_expected_state(
            "device.setMasterVolume",
            Some(&snapshot),
            &json!({"expectedValue": 63})
        )
        .is_err());
    }

    #[test]
    fn preset_recall_plans_and_verification_are_host_independent() {
        let before = GatewaySnapshot {
            preset_name: "Live".into(),
            setlist_key: "/user/live".into(),
            preset_position: 8,
            position_revision: 14,
            preset_revision: 14,
            ..GatewaySnapshot::default()
        };
        let plan = plan_preset_recall(
            "device.navigateBank",
            &json!({"direction": 1, "expectedPresetName": "Live", "expectedPosition": 8}),
            Some(&before),
        )
        .unwrap();
        assert_eq!(plan.position, 16);
        assert!(!plan.matches(&before));
        let after = GatewaySnapshot {
            setlist_key: "/user/live/".into(),
            preset_position: 16,
            position_revision: 15,
            preset_revision: 15,
            ..GatewaySnapshot::default()
        };
        assert!(plan.matches(&after));
    }

    #[test]
    fn nullable_gateway_assignments_are_preserved_as_explicit_clears() {
        let footswitch = plan_gateway_write(
            "device.setBlockFootswitch",
            &json!({"row": 0, "column": 1, "footswitch": null, "expectedFootswitch": null, "expectedModelId": null, "expectedPresetName": "Unsaved"}),
            Some(&GatewaySnapshot::default()),
        )
        .unwrap();
        assert_eq!(
            footswitch.write,
            PlannedWrite::HidOperation(DeviceOperation::SetFootswitch {
                row: 0,
                column: 1,
                footswitch: None,
            })
        );
        let split = plan_gateway_write(
            "device.setChainSplit",
            &json!({"row": 2, "splitColumn": null, "mixColumn": null, "expectedSplitColumn": null, "expectedMixColumn": null, "expectedPresetName": "Unsaved"}),
            Some(&GatewaySnapshot {
                routes: vec![GridRoute {
                    row: 2,
                    input_id: None,
                    output_id: None,
                    input: String::new(),
                    output: String::new(),
                    split_column: None,
                    mix_column: None,
                    split_muted: false,
                }],
                ..GatewaySnapshot::default()
            }),
        )
        .unwrap();
        assert_eq!(
            split.write,
            PlannedWrite::HidOperation(DeviceOperation::SetChainSplit {
                row: 2,
                split_column: None,
                mix_column: None,
            })
        );

        let snapshot = GatewaySnapshot {
            preset_name: "Live".into(),
            routes: vec![GridRoute {
                row: 2,
                input_id: Some(1),
                output_id: Some(1),
                input: "In 1".into(),
                output: "Out 1/2".into(),
                split_column: Some(2),
                mix_column: Some(7),
                split_muted: false,
            }],
            ..GatewaySnapshot::default()
        };
        let mute = plan_gateway_write(
            "device.setSplitMute",
            &json!({"row": 2, "muted": true, "expectedMuted": false, "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .unwrap();
        assert_eq!(
            mute.write,
            PlannedWrite::HidOperation(DeviceOperation::SetSplitMute {
                row: 2,
                muted: true,
            })
        );
        assert!(!mute.verification.matches(&snapshot, None));
        let muted = GatewaySnapshot {
            routes: vec![GridRoute {
                split_muted: true,
                ..snapshot.routes[0].clone()
            }],
            ..snapshot.clone()
        };
        assert!(mute.verification.matches(&muted, None));
        assert!(plan_gateway_write(
            "device.setSplitMute",
            &json!({"row": 1, "muted": true}),
            None,
        )
        .is_err());
        assert!(plan_gateway_write(
            "device.setChainSplit",
            &json!({"row": 0, "splitColumn": 5, "mixColumn": 3}),
            None,
        )
        .is_err());
    }

    #[test]
    fn planned_write_readback_predicates_are_host_independent() {
        let snapshot = GatewaySnapshot {
            preset_name: "Live".into(),
            active_scene: 2,
            tempo: 126,
            blocks: vec![GridBlock {
                id: "block-1".into(),
                model_id: Some(42),
                category_id: None,
                name: "Drive".into(),
                kind: "Drive".into(),
                category: Some("Drive".into()),
                plugin: None,
                plugin_id: None,
                row: 1,
                column: 4,
                bypassed: Some(true),
                bypass_expression: None,
                color: None,
                glyph: None,
                footswitch: Some(3),
                footswitch_order: None,
            }],
            ..GatewaySnapshot::default()
        };
        let scene = plan_gateway_write(
            "device.selectScene",
            &json!({"scene": 2, "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(scene.verification.matches(&snapshot, None));

        let bypass = plan_gateway_write(
            "device.toggleBypass",
            &json!({"row": 1, "column": 4, "desiredBypassed": true, "expectedBypassed": true, "expectedScene": 2, "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(bypass.verification.matches(&snapshot, None));

        let parameter = plan_gateway_write(
            "device.setParameter",
            &json!({"row": 1, "column": 4, "parameterIndex": 7, "value": 0.75, "expectedValue": 0.5, "expectedScene": 2, "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(parameter.verification.matches(&snapshot, Some(0.7504)));
        assert!(!parameter.verification.matches(&snapshot, Some(0.76)));

        let splitter = plan_gateway_write(
            "device.setParameter",
            &json!({"row": 0, "column": 8, "parameterIndex": 5, "value": 0.25, "expectedValue": 0.5, "expectedScene": 2, "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(matches!(splitter.write,
            PlannedWrite::HidOperation(DeviceOperation::SetRoutingParameter {
                row: 0, ref node, parameter_index: 5, value
            }) if node == "splitter" && value == 0.25));
        assert!(plan_gateway_write(
            "device.setParameter",
            &json!({"row": 1, "column": 9, "parameterIndex": 1, "value": 0.5}),
            Some(&snapshot),
        )
        .is_err());

        let lane = plan_gateway_write(
            "device.setLaneControlParameter",
            &json!({"row": 3, "control": "laneOutput", "parameterIndex": 0, "value": 0.64, "expectedValue": 0.5, "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(matches!(lane.write,
            PlannedWrite::HidOperation(DeviceOperation::SetLaneControlParameter {
                row: 3, ref control, parameter_index: 0, value
            }) if control == "laneOutput" && value == 0.64));
        assert!(plan_gateway_write(
            "device.setLaneControlParameter",
            &json!({"row": 0, "control": "models", "parameterIndex": 0, "value": 0.5}),
            Some(&snapshot),
        )
        .is_err());
    }

    #[test]
    fn persistent_preset_workflows_share_validation_and_stages() {
        let mut library = PresetLibrary::default();
        library.ingest(PresetFolderListing {
            key: "/media/p4/Presets/Live".into(),
            name: "Live".into(),
            is_factory: false,
            files: vec![
                PresetFileListing {
                    position: 8,
                    name: "Current".into(),
                    instrument: 2,
                },
                PresetFileListing {
                    position: 9,
                    name: "Source".into(),
                    instrument: 3,
                },
            ],
        });
        let snapshot = GatewaySnapshot {
            preset_name: "Current".into(),
            setlist_key: "/media/p4/Presets/Live".into(),
            preset_position: 8,
            ..GatewaySnapshot::default()
        };
        let save = plan_preset_mutation(
            "device.savePresetAs",
            &json!({
                "setlistKey": "/media/p4/Presets/Live", "position": 10,
                "name": "Saved", "expectedPresetName": "Current",
                "expectedPosition": 8, "confirmOverwrite": false
            }),
            Some(&snapshot),
            &library,
        )
        .unwrap();
        assert_eq!(save.stages.len(), 1);
        assert_eq!(save.instrument, 2);

        let destination = GatewaySnapshot {
            preset_position: 10,
            ..snapshot.clone()
        };
        let copy = plan_preset_mutation(
            "device.copyPreset",
            &json!({
                "sourceSetlistKey": "/media/p4/Presets/Live", "sourcePosition": 9,
                "sourceName": "Source", "destinationSetlistKey": "/media/p4/Presets/Live",
                "destinationPosition": 10, "expectedPresetName": "Current",
                "expectedPosition": 10, "confirmOverwrite": true
            }),
            Some(&destination),
            &library,
        )
        .unwrap();
        assert_eq!(copy.stages.len(), 2);
        assert_eq!(copy.saved_name, "Source");
        assert_eq!(copy.instrument, 3);

        let duplicate = plan_preset_mutation(
            "device.duplicateSetlist",
            &json!({
                "sourceSetlistKey": "/media/p4/Presets/Live",
                "destinationName": "Live Copy",
                "limit": null,
                "expectedPresetName": "Current",
                "expectedPosition": 8
            }),
            Some(&snapshot),
            &library,
        )
        .unwrap();
        assert_eq!(duplicate.stages.len(), 5);
        assert_eq!(duplicate.stages[0].settle_ms, 3_000);
        assert!(matches!(
            duplicate.stages[0].write,
            PlannedWrite::HidOperation(DeviceOperation::CreateSetlist { ref name })
                if name == "Live Copy"
        ));
        assert_eq!(duplicate.saved_presets.len(), 2);
        assert_eq!(duplicate.saved_presets[0].name, "Current");
        assert_eq!(duplicate.saved_presets[0].position, 0);
        assert_eq!(duplicate.saved_presets[1].name, "Source");
        assert_eq!(duplicate.saved_presets[1].position, 1);
        assert!(plan_preset_mutation(
            "device.duplicateSetlist",
            &json!({
                "sourceSetlistKey": "/media/p4/Presets/Live",
                "destinationName": "My Presets",
                "limit": 1,
                "expectedPresetName": "Current",
                "expectedPosition": 8
            }),
            Some(&snapshot),
            &library,
        )
        .is_err());
    }

    #[test]
    fn native_library_reads_and_writes_are_planned_with_strict_guards() {
        let recents = plan_gateway_read("device.recents", &Value::Null, 81).unwrap();
        assert_eq!(recents.response_type, 20);
        assert!(matches!(
            recents.operation,
            DeviceOperation::ReadRecentsFavorites {
                favorites: false,
                request_id: 81
            }
        ));
        let favorites = plan_gateway_read("device.favorites", &Value::Null, 82).unwrap();
        assert!(matches!(
            favorites.operation,
            DeviceOperation::ReadRecentsFavorites {
                favorites: true,
                request_id: 82
            }
        ));
        let captures = plan_gateway_read("device.captures", &Value::Null, 83).unwrap();
        assert!(matches!(
            captures.operation,
            DeviceOperation::ReadLibraryFiles { ref folder_key, file_type: 2, request_id: 83 }
                if folder_key == "local_nc_root"
        ));
        let irs =
            plan_gateway_read("device.irs", &json!({"folder": "factory_ir_root"}), 84).unwrap();
        assert!(matches!(
            irs.operation,
            DeviceOperation::ReadLibraryFiles { ref folder_key, file_type: 1, request_id: 84 }
                if folder_key == "factory_ir_root"
        ));

        assert!(plan_gateway_write(
            "device.deletePreset",
            &json!({"setlistKey": "/opt/Presets/Factory", "name": "Factory"}),
            None,
        )
        .is_err());
        let capture = plan_gateway_write(
            "device.loadCapture",
            &json!({
                "row": 1, "column": 2, "key": "capture/", "name": "Crunch",
                "modelId": null, "expectedModelId": null, "expectedPresetName": "Current"
            }),
            Some(&GatewaySnapshot {
                preset_name: "Current".into(),
                ..GatewaySnapshot::default()
            }),
        )
        .unwrap();
        assert!(matches!(
            capture.write,
            PlannedWrite::HidOperation(DeviceOperation::LoadCapture {
                row: 1, column: 2, ref key, ref name, model_id: None
            }) if key == "capture/" && name == "Crunch"
        ));
        assert!(plan_gateway_write(
            "device.loadIr",
            &json!({
                "row": 1, "column": 2, "key": "ir/key", "name": "Room",
                "slot": 2, "modelId": null, "expectedModelId": null, "expectedPresetName": "Current"
            }),
            Some(&GatewaySnapshot {
                preset_name: "Current".into(),
                ..GatewaySnapshot::default()
            }),
        )
        .is_err());
        assert!(plan_gateway_write(
            "device.loadCapture",
            &json!({
                "row": 1, "column": 2, "key": "capture/", "name": "Crunch",
                "modelId": null, "expectedPresetName": "Current"
            }),
            Some(&GatewaySnapshot {
                preset_name: "Current".into(),
                ..GatewaySnapshot::default()
            }),
        )
        .is_err());
    }

    #[test]
    fn correlated_reads_and_remote_screen_writes_are_planned_once() {
        let tuner = plan_gateway_read("device.tunerSettings", &Value::Null, 0).unwrap();
        assert_eq!(tuner.response_type, 6);
        assert_eq!(tuner.timeout_ms, 5_000);
        assert!(matches!(tuner.operation, DeviceOperation::ReadTuner));
        assert!(matches!(
            tuner.projection,
            GatewayResponseProjection::TunerSettings
        ));

        let screenshot = plan_gateway_read(
            "device.presetScreenshot",
            &json!({"folderName": "Live", "position": 12, "isFactory": false}),
            91,
        )
        .unwrap();
        assert_eq!(screenshot.response_type, 25);
        assert!(matches!(
            screenshot.projection,
            GatewayResponseProjection::PresetScreenshot { request_id: 91, .. }
        ));

        let tap =
            plan_gateway_write("device.tapScreen", &json!({"x": 799.0, "y": 479.0}), None).unwrap();
        assert!(matches!(
            tap.write,
            PlannedWrite::HidOperation(DeviceOperation::ScreenTap { .. })
        ));
        assert!(
            plan_gateway_write("device.tapScreen", &json!({"x": 800.0, "y": 10.0}), None).is_err()
        );

        assert!(
            plan_gateway_write("device.setDeviceName", &json!({"name": "Stage QC"}), None).is_ok()
        );
        assert!(
            plan_gateway_write("device.setDeviceName", &json!({"name": "bad\nname"}), None)
                .is_err()
        );
    }

    #[test]
    fn tuner_writes_require_explicit_hazard_acknowledgement() {
        let rejected = plan_gateway_write("device.setTunerMute", &json!({"muted": true}), None);
        assert!(rejected.is_err());

        let input = plan_gateway_write(
            "device.setTunerInput",
            &json!({"inputPortId": 8, "confirmTunerActivation": true}),
            None,
        )
        .unwrap();
        assert!(matches!(
            input.write,
            PlannedWrite::HidOperation(DeviceOperation::SetTunerInput(8))
        ));
        assert!(plan_gateway_write(
            "device.setTunerInput",
            &json!({"inputPortId": 6, "confirmTunerActivation": true}),
            None,
        )
        .is_err());

        let reference = plan_gateway_write(
            "device.setTunerReference",
            &json!({"referenceOffsetHz": 2.0, "confirmTunerActivation": true}),
            None,
        )
        .unwrap();
        assert!(matches!(
            reference.write,
            PlannedWrite::HidOperation(DeviceOperation::SetTunerReference(value)) if (value - 2.0).abs() < f32::EPSILON
        ));

        let restore = plan_gateway_write(
            "device.restoreTunerAudio",
            &json!({"confirmPreferenceReset": true}),
            None,
        )
        .unwrap();
        assert!(matches!(
            restore.write,
            PlannedWrite::HidOperation(DeviceOperation::SetTunerMute(false))
        ));
    }

    #[test]
    fn global_eq_mode_cycle_and_looper_are_planned_and_bounded() {
        let global_eq = plan_gateway_read("device.globalEq", &Value::Null, 0).unwrap();
        assert_eq!(global_eq.response_type, 38);
        assert!(matches!(global_eq.operation, DeviceOperation::ReadGlobalEq));
        assert!(matches!(
            global_eq.projection,
            GatewayResponseProjection::GlobalEq
        ));

        let mode_cycle = plan_gateway_read("device.modeCycle", &Value::Null, 0).unwrap();
        assert_eq!(mode_cycle.response_type, 14);
        assert!(matches!(
            mode_cycle.operation,
            DeviceOperation::ReadModeCycle
        ));

        let looper = plan_gateway_read("device.looperStatus", &Value::Null, 0).unwrap();
        assert_eq!(looper.response_type, 28);
        assert!(matches!(
            looper.operation,
            DeviceOperation::ReadLooperStatus
        ));

        let band = plan_gateway_write(
            "device.setGlobalEqBand",
            &json!({"band": 2, "gain": 0.25, "filterType": 4, "enabled": false}),
            None,
        )
        .unwrap();
        assert!(matches!(
            band.write,
            PlannedWrite::HidOperation(DeviceOperation::SetGlobalEqParameters(ref controls))
                if controls == &vec![(5, 0.25), (8, 1.0), (9, 0.0)]
        ));
        assert!(plan_gateway_write(
            "device.setGlobalEqBand",
            &json!({"band": 0, "gain": 0.5}),
            None,
        )
        .is_err());

        let modes =
            plan_gateway_write("device.setModeCycle", &json!({"slots": [2, 0, 1]}), None).unwrap();
        assert!(matches!(
            modes.write,
            PlannedWrite::HidOperation(DeviceOperation::SetModeCycle(ref slots))
                if slots == &vec![2, 0, 1]
        ));
        assert!(
            plan_gateway_write("device.setModeCycle", &json!({"slots": [1, 1]}), None,).is_err()
        );

        let record = plan_host_midi("device.controlLooper", &json!({"command": "record"})).unwrap();
        assert_eq!((record.controller, record.value), (53, 127));
        let routing = plan_host_midi(
            "device.controlLooper",
            &json!({"command": "routingMode", "value": 13}),
        )
        .unwrap();
        assert_eq!((routing.controller, routing.value), (61, 13));
        assert!(plan_host_midi(
            "device.controlLooper",
            &json!({"command": "routingMode", "value": 14}),
        )
        .is_err());
        assert!(plan_host_midi(
            "device.controlLooper",
            &json!({"command": "record", "value": 1}),
        )
        .is_err());
        assert_eq!(crate::generated_gateway::PERFORMANCE_MIDI_METHODS.len(), 6);
        assert!(crate::generated_gateway::PERFORMANCE_MIDI_METHODS
            .iter()
            .all(|method| is_host_midi_method(method)));
        assert!(!is_host_midi_method("device.setTempo"));
    }

    #[test]
    fn tempo_metronome_preserves_signature_before_beats_and_validates_semantics() {
        let plan = plan_gateway_write(
            "device.setTempoMetronome",
            &json!({
                "timeSignature":"7/8 (2+2+3)", "ledEnabled":true, "volumeDb":-20.0,
                "running":false, "pan":0.25, "subdivision":"1/8T", "sound":"COWBELL",
                "routing":"OUT 3/4", "beats":["DOWN","OFF","MUTE"]
            }),
            None,
        )
        .unwrap();
        let PlannedWrite::HidOperation(DeviceOperation::SetTempoParameters(values)) = plan.write
        else {
            panic!("wrong operation")
        };
        assert_eq!(values[0].0, 6);
        assert_eq!(
            values
                .iter()
                .rev()
                .take(3)
                .map(|value| value.0)
                .collect::<Vec<_>>(),
            vec![12, 11, 10]
        );
        assert!(
            plan_gateway_write("device.setTempoMetronome", &json!({"beats":["LOUD"]}), None)
                .is_err()
        );
        assert!(matches!(
            plan_gateway_write("device.setTempoMode", &json!({"mode":"GLOBAL"}), None)
                .unwrap()
                .write,
            PlannedWrite::HidOperation(DeviceOperation::SetTempoMode(true))
        ));
        assert!(plan_gateway_write("device.setTempoMode", &json!({"mode":"AUTO"}), None).is_err());
    }

    #[test]
    fn backup_validation_and_naming_are_shared_by_native_hosts() {
        let backup = finalize_device_backup(
            r#"{"type":"backup","creator":"quad","name":"device"}"#,
            "  Tour\nBackup  ",
        )
        .unwrap();
        assert_eq!(backup["name"], "TourBackup");
        assert!(finalize_device_backup("{}", "Tour").is_err());
        assert!(finalize_device_backup("not json", "Tour").is_err());
        assert!(finalize_device_backup(r#"{"type":"backup","creator":"quad"}"#, "\n").is_err());
    }

    #[test]
    fn user_supplied_names_and_library_keys_reject_path_injection() {
        for name in ["../Tour", "Tour/Encore", "Tour\\Encore", "My Presets"] {
            assert!(
                plan_gateway_write("device.createSetlist", &json!({"name": name}), None,).is_err()
            );
        }

        for name in ["../Stage", "Stage/Lead", "Stage\nLead"] {
            assert!(operation(
                "deletePreset",
                &json!({"setlistKey": "/media/p4/Presets/Live", "name": name}),
            )
            .is_err());
        }

        for key in [
            "/media/p4/Presets/../Factory",
            "/media/p4/Presets/Live/Child",
            "/media/p4/Presets/Live\\Child",
        ] {
            assert!(operation(
                "movePreset",
                &json!({"setlistKey": key, "name": "Stage", "position": 1}),
            )
            .is_err());
        }

        assert!(operation(
            "loadCapture",
            &json!({"row": 0, "column": 0, "key": "capture/../", "name": "Lead"}),
        )
        .is_err());
        assert!(
            plan_gateway_read("device.irs", &json!({"folder": "factory/../private"}), 1,).is_err()
        );
        assert!(plan_gateway_write(
            "device.setDeviceName",
            &json!({"name": "x".repeat(65)}),
            None,
        )
        .is_err());
    }
}
