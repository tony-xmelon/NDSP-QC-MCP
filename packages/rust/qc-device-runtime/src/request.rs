//! Platform-neutral validation and planning for public gateway writes.
//!
//! Hosts execute the returned plan using their own HID/MIDI implementation and
//! feed readback into [`GatewaySnapshot`](crate::GatewaySnapshot).

use crate::{GatewaySnapshot, PresetLibrary};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use qc_protocol::commands::{DeviceCommand, DeviceOperation};
use qc_protocol::responses::{
    decode_captured_screen, decode_device_identity, decode_inhibited_modules,
    decode_preset_screenshot, PngImage,
};
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

/// Shared mapping for physical QC controls. Both native hosts execute this
/// plan with their persistent platform MIDI handle.
pub fn plan_host_midi(method: &str, params: &Value) -> Result<HostMidiPlan, String> {
    match method {
        "device.pressFootswitch" => {
            let index = bounded_u32(params, "index", domain::SCENE_COUNT + 2)? as u8;
            Ok(HostMidiPlan {
                controller: profile::FOOTSWITCH_BASE_CONTROLLER + index,
                value: profile::MIDI_PRESSED_VALUE,
                detail: format!("Footswitch index {index} sent"),
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
        _ => Err(format!("Gateway method does not use host MIDI: {method}")),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GatewayWritePlan {
    pub write: PlannedWrite,
    pub detail: String,
    pub verification: GatewayVerification,
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
    Preset {
        setlist_key: String,
        position: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        require_clean: bool,
    },
}

impl GatewayVerification {
    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
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
            Self::None => true,
            Self::Scene { scene } => snapshot.active_scene == *scene,
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
}

#[derive(Debug, Clone, PartialEq)]
pub struct PresetMutationPlan {
    pub stages: Vec<PresetMutationStage>,
    pub detail: String,
    pub saved_name: String,
    pub setlist_key: String,
    pub position: u32,
    pub instrument: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GatewayResponseProjection {
    DeviceIdentity,
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
        "device.inhibitedModules" => Ok(GatewayReadPlan {
            operation: DeviceOperation::ReadInhibitedModules,
            response_type: 42,
            timeout_ms: 5_000,
            projection: GatewayResponseProjection::InhibitedModules,
        }),
        "device.presetScreenshot" => {
            let folder_name = required_text(params, "folderName")?;
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
    if name.is_empty() {
        return Err("name must be a non-empty string".into());
    }
    if name.chars().count() > 80 {
        return Err("Preset name must be 80 characters or fewer.".into());
    }
    Ok(name)
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
        verification: verification_for_operation(&operation, &Value::Null),
        write: PlannedWrite::HidOperation(operation),
        timeout_ms: 15_000,
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
            let setlist_key = required_text(params, "setlistKey")?;
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
            Ok(PresetMutationPlan {
                stages: vec![save_stage(&setlist_key, position, &name, instrument)],
                detail: format!("Saved and verified {name}"),
                saved_name: name,
                setlist_key,
                position,
                instrument,
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
            })
        }
        "device.copyPreset" => {
            if params.get("confirmOverwrite").and_then(Value::as_bool) != Some(true) {
                return Err("Pasting a preset requires explicit overwrite confirmation.".into());
            }
            let source_key = required_text(params, "sourceSetlistKey")?;
            let destination_key = required_text(params, "destinationSetlistKey")?;
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
            let setlist_key = required_text(params, "setlistKey")?;
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
    if let Some(expected) = params.get("expectedModelId").and_then(Value::as_u64) {
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
        if actual != Some(expected as u32) {
            return Err("The block at that grid position changed. Refresh and retry.".into());
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

fn operation(operation: &str, params: &Value) -> Result<DeviceOperation, String> {
    let row = || bounded_u32(params, "row", domain::GRID_ROWS - 1);
    let column = |field: &str| bounded_u32(params, field, domain::GRID_COLUMNS - 1);
    match operation {
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
        "setChainSplit" => Ok(DeviceOperation::SetChainSplit {
            row: row()?,
            split_column: optional_i32(params, "splitColumn")?,
            mix_column: optional_i32(params, "mixColumn")?,
        }),
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
        "listPresetFolders" => Ok(DeviceOperation::ListPresetFolders),
        "savePreset" => Ok(DeviceOperation::SavePreset {
            setlist_key: required_text(params, "setlistKey")?,
            position: bounded_u32(params, "position", 255)?,
            name: required_text(params, "name")?,
            instrument: params
                .get("instrument")
                .and_then(Value::as_i64)
                .and_then(|value| i32::try_from(value).ok())
                .unwrap_or(0),
        }),
        _ => Err(format!("unknown native device operation: {operation}")),
    }
}

fn verification_for_operation(operation: &DeviceOperation, params: &Value) -> GatewayVerification {
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
        DeviceOperation::Command(_)
        | DeviceOperation::SetRoutingParameter { .. }
        | DeviceOperation::ListPresetFolders
        | DeviceOperation::ReadVersion
        | DeviceOperation::SetDeviceName(_)
        | DeviceOperation::Undo
        | DeviceOperation::Redo
        | DeviceOperation::ReadInhibitedModules
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
    if method.starts_with("device.") && !method.starts_with("device.command.") {
        assert_expected_preset(snapshot, params)?;
        assert_expected_state(method, snapshot, params)?;
    }
    let plan = match method {
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
            let column = bounded_u32(params, "column", domain::GRID_COLUMNS - 1)?;
            let parameter_index = bounded_u32(params, "parameterIndex", u32::MAX)?;
            let command = if let Some(text) = params.get("text").and_then(Value::as_str) {
                DeviceCommand::SetParameterText {
                    row,
                    column,
                    parameter_index,
                    value: text.into(),
                }
            } else {
                DeviceCommand::SetParameterNumeric {
                    row,
                    column,
                    parameter_index,
                    value: normalized(params, "value")?,
                }
            };
            GatewayWritePlan {
                write: PlannedWrite::HidCommand(command),
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
                        value: params
                            .get("value")
                            .and_then(Value::as_f64)
                            .unwrap_or_default(),
                    }
                },
            }
        }
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
        "device.showTuner" => {
            let shown = params.get("shown").and_then(Value::as_bool).unwrap_or(true);
            GatewayWritePlan {
                write: PlannedWrite::HidCommand(DeviceCommand::ShowTuner(shown)),
                detail: if shown {
                    "Device view opened"
                } else {
                    "Device view closed"
                }
                .into(),
                verification: GatewayVerification::None,
            }
        }
        "device.showGigView" => {
            let shown = params.get("shown").and_then(Value::as_bool).unwrap_or(true);
            GatewayWritePlan {
                write: PlannedWrite::HidCommand(DeviceCommand::ShowGigView(shown)),
                detail: if shown {
                    "Device view opened"
                } else {
                    "Device view closed"
                }
                .into(),
                verification: GatewayVerification::None,
            }
        }
        "device.setDeviceName" => {
            let name = required_text(params, "name")?;
            if name.chars().any(char::is_control) || name.chars().count() > 64 {
                return Err("Device name must be at most 64 visible characters".into());
            }
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
        | "device.setChainSplit" => {
            let operation_name = match method {
                "device.addBlock" => "addBlock",
                "device.removeBlock" => "removeBlock",
                "device.moveBlock" => "moveBlock",
                "device.setBlockFootswitch" => "setFootswitch",
                "device.setChainInput" => "setChainInput",
                "device.setChainOutput" => "setChainOutput",
                _ => "setChainSplit",
            };
            let operation = operation(operation_name, params)?;
            GatewayWritePlan {
                verification: verification_for_operation(&operation, params),
                write: PlannedWrite::HidOperation(operation),
                detail: if method == "device.moveBlock" {
                    "Block moved".into()
                } else {
                    format!("{operation_name} sent to the Quad Cortex")
                },
            }
        }
        "device.command.operation" => {
            let name = required_text(params, "operation")?;
            let operation = operation(&name, params)?;
            GatewayWritePlan {
                verification: verification_for_operation(&operation, params),
                write: PlannedWrite::HidOperation(operation),
                detail: format!("{name} accepted"),
            }
        }
        "device.pressFootswitch" | "device.selectModeSlot" => {
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
            &json!({"index": 10, "expectedMode": "STOMP", "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .unwrap();
        assert_eq!(
            footswitch.write,
            PlannedWrite::MidiControlChange {
                controller: profile::FOOTSWITCH_BASE_CONTROLLER + 10,
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
        assert!(plan_gateway_write(
            "device.pressFootswitch",
            &json!({"index": 0, "expectedMode": "SCENE", "expectedPresetName": "Live"}),
            Some(&snapshot),
        )
        .is_err());
    }

    #[test]
    fn public_and_low_level_writes_share_operation_planning() {
        let public = plan_gateway_write(
            "device.moveBlock",
            &json!({"row": 1, "fromColumn": 2, "toColumn": 4}),
            None,
        )
        .unwrap();
        let native = plan_gateway_write("device.command.operation", &json!({"operation": "moveBlock", "row": 1, "fromColumn": 2, "toRow": 1, "toColumn": 4}), None).unwrap();
        assert_eq!(public.write, native.write);
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
            &json!({"row": 0, "column": 1, "footswitch": null}),
            None,
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
            &json!({"row": 2, "splitColumn": null, "mixColumn": null}),
            None,
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
            &json!({"row": 1, "column": 4, "desiredBypassed": true}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(bypass.verification.matches(&snapshot, None));

        let parameter = plan_gateway_write(
            "device.setParameter",
            &json!({"row": 1, "column": 4, "parameterIndex": 7, "value": 0.75}),
            Some(&snapshot),
        )
        .unwrap();
        assert!(parameter.verification.matches(&snapshot, Some(0.7504)));
        assert!(!parameter.verification.matches(&snapshot, Some(0.76)));
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
    }

    #[test]
    fn correlated_reads_and_remote_screen_writes_are_planned_once() {
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
}
