//! Stateful QC protobuf normalization shared by every native host.
//!
//! USB enumeration, permissions, and endpoint I/O remain platform concerns.
//! This module owns the device-independent mapping from QC protobuf messages to
//! the small camelCase state-event contract consumed by `@ndsp-qc/core`.

pub use crate::generated_payloads::{
    BlockDetails, BlockParameter, BypassExpression, BypassUpdate, FootswitchState, GridBlock,
    GridRoute, IoPortState, MidiOutMessage, MidiOutSource, ModeSlot, QcStateUpdate as StateUpdate,
    ScalePoint,
};
use crate::proto::cortex_protobuf_v2 as pa;
use crate::proto::{
    binary_preset, bypass, chain, col_bypass, model, param, param_value, BinaryPreset, Chain,
    Model, Param,
};
use crate::{domain, profile};
use flate2::read::GzDecoder;
use prost::Message;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StateDecodeError {
    #[error("QC protobuf type {message_type} could not be decoded: {source}")]
    Protobuf {
        message_type: u16,
        #[source]
        source: prost::DecodeError,
    },
    #[error("compressed QC state exceeds the inflated-size limit")]
    InflatedLimit,
    #[error("compressed QC state could not be decoded: {0}")]
    Compression(String),
    #[error("model catalog archive is invalid: {0}")]
    CatalogArchive(String),
    #[error("model catalog XML is invalid: {0}")]
    CatalogXml(String),
}

impl StateUpdate {
    /// Construct an empty typed update for native reducers and parity fixtures.
    pub fn empty(kind: &str) -> Self {
        Self::new(kind)
    }

    fn new(kind: &str) -> Self {
        Self {
            kind: kind.into(),
            active_scene: None,
            dirty: None,
            master_volume: None,
            index: None,
            label: None,
            color: None,
            setlist_key: None,
            position: None,
            is_factory: None,
            preset_name: None,
            tempo: None,
            tempo_led_enabled: None,
            scenes: None,
            scene_colors: None,
            footswitch_states: None,
            midi_out: None,
            preset_load_midi_out: None,
            blocks: None,
            routes: None,
            io_ports: None,
            mode: None,
            mode_slots: None,
            footswitch_modes: None,
            row: None,
            column: None,
            bypassed: None,
            bypass_updates: None,
            parameter_index: None,
            normalized_value: None,
            catalog_refresh: None,
            observed_at: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct ModelInfo {
    name: String,
    category: String,
    kind: String,
    clone_id: Option<u32>,
    direct_parameters: Vec<ParameterSpec>,
    parameters: BTreeMap<u32, ParameterSpec>,
    hidden: bool,
    based_on: String,
}

/// Parsed, resolved ModelRepo metadata. Hosts may build this on a low-priority
/// worker and install it atomically without delaying live state reduction.
pub struct ModelCatalog(HashMap<u32, ModelInfo>);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: u32,
    pub name: String,
    pub category: String,
    pub based_on: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogAuditException {
    pub model_id: u32,
    pub model_name: String,
    pub parameter_index: u32,
    pub issue: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogAudit {
    pub model_count: usize,
    pub parameter_count: usize,
    pub category_count: usize,
    pub exceptions: Vec<ModelCatalogAuditException>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelList {
    pub models: Vec<ModelEntry>,
    pub audit: ModelCatalogAudit,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PresetFileListing {
    pub position: u32,
    pub name: String,
    pub instrument: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PresetFolderListing {
    pub key: String,
    pub name: String,
    pub is_factory: bool,
    pub files: Vec<PresetFileListing>,
}

/// Decode one File push. A File READ yields many independent folder messages;
/// callers aggregate them without blocking the live-state decoder.
pub fn decode_preset_folder(
    payload: &[u8],
) -> Result<Option<PresetFolderListing>, StateDecodeError> {
    let decoded = maybe_gunzip(payload)?;
    let message = decode::<pa::FileMessage>(4, &decoded)?;
    let Some(pa::file_message::Folder::Folder(folder)) = message.folder else {
        return Ok(None);
    };
    let Some(pa::folder_info::Key::Key(key)) = folder.key else {
        return Ok(None);
    };
    if key.is_empty() {
        return Ok(None);
    }
    let name = match folder.name {
        Some(pa::folder_info::Name::Name(value)) => value,
        _ => key
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .into(),
    };
    let is_factory = matches!(
        folder.is_factory,
        Some(pa::folder_info::IsFactory::IsFactory(true))
    );
    let mut files = folder
        .files
        .into_iter()
        .filter_map(|file| {
            let pa::product_data::Index::Index(index) = file.index?;
            if !(0..256).contains(&index) {
                return None;
            }
            let name = match file.name {
                Some(pa::product_data::Name::Name(value)) => value,
                _ => String::new(),
            };
            let instrument = match file.instrument {
                Some(pa::product_data::Instrument::Instrument(value)) => value,
                _ => 0,
            };
            Some(PresetFileListing {
                position: index as u32,
                name,
                instrument,
            })
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|file| file.position);
    Ok(Some(PresetFolderListing {
        key,
        name,
        is_factory,
        files,
    }))
}

impl ModelCatalog {
    pub fn model_list(&self) -> ModelList {
        const SUPPORTED: &[&str] = &[
            "comboBox",
            "empty",
            "fader",
            "float",
            "floatWithLed",
            "grMeter",
            "int",
            "rotarySwitch",
            "string",
            "switch",
            "toggleButton",
        ];
        let mut models = Vec::new();
        let mut categories = HashSet::new();
        let mut parameter_count = 0;
        let mut exceptions = Vec::new();
        for (id, info) in &self.0 {
            if info.hidden {
                continue;
            }
            categories.insert(info.category.clone());
            models.push(ModelEntry {
                id: *id,
                name: info.name.clone(),
                category: display_category(&info.category),
                based_on: info.based_on.clone(),
            });
            let mut seen = HashSet::new();
            for parameter in info
                .parameters
                .values()
                .filter(|parameter| !parameter.hidden)
            {
                parameter_count += 1;
                let issue = if !seen.insert(parameter.index) {
                    Some(format!("duplicate parameter index {}", parameter.index))
                } else if parameter.name.trim().is_empty() {
                    Some("parameter name is empty".into())
                } else if !SUPPORTED.contains(&parameter.r#type.as_str()) {
                    Some(format!("unsupported parameter type {:?}", parameter.r#type))
                } else if parameter.steps == Some(0) {
                    Some("invalid step count 0".into())
                } else {
                    None
                };
                if let Some(issue) = issue {
                    exceptions.push(ModelCatalogAuditException {
                        model_id: *id,
                        model_name: info.name.clone(),
                        parameter_index: parameter.index,
                        issue,
                    });
                }
            }
        }
        models.sort_by(|left, right| {
            left.category
                .to_ascii_lowercase()
                .cmp(&right.category.to_ascii_lowercase())
                .then_with(|| {
                    left.name
                        .to_ascii_lowercase()
                        .cmp(&right.name.to_ascii_lowercase())
                })
                .then_with(|| left.id.cmp(&right.id))
        });
        ModelList {
            audit: ModelCatalogAudit {
                model_count: models.len(),
                parameter_count,
                category_count: categories.len(),
                exceptions,
            },
            models,
        }
    }
}

#[derive(Debug, Clone)]
struct ParameterSpec {
    index: u32,
    name: String,
    r#type: String,
    minimum: f64,
    maximum: f64,
    scale_known: bool,
    value_scale: String,
    scale_exponent: Option<f64>,
    scale_points: Vec<ScalePoint>,
    units: String,
    steps: Option<u32>,
    display_position: u32,
    display_position_raw: Option<u32>,
    screen_visible: bool,
    options: Vec<String>,
    hidden: bool,
    minimum_label: Option<String>,
    midpoint_label: Option<String>,
    maximum_label: Option<String>,
    show_as_integer: bool,
    expression_assignable: bool,
    linked_scene_mode: Option<u32>,
    enable_when_on: Option<u32>,
    enable_when_off: Option<u32>,
    enable_when_steps: Vec<u32>,
    replaces: Option<u32>,
}

impl ParameterSpec {
    fn display_precision(&self) -> Option<u32> {
        if self.show_as_integer {
            return Some(0);
        }
        let units = self.units.trim().to_ascii_lowercase();
        match units.as_str() {
            "bpm" | "semitones" | "cents" | "st" | "bits" => Some(0),
            "%" => Some(if self.steps.unwrap_or(0) > 101 { 1 } else { 0 }),
            "db" | "db/oct" => Some(1),
            "hz" => Some(if self.maximum <= 20.0 { 2 } else { 0 }),
            "s" | "seconds" => Some(2),
            "ms" => Some(if self.maximum <= 10.0 {
                2
            } else if self.maximum <= 100.0 {
                1
            } else {
                0
            }),
            _ => Some(1),
        }
    }
}

fn catalog_number(value: &str) -> Option<f64> {
    let symbolic = match value.trim() {
        "MIN_EQ_DB" => Some(-12.0),
        "MAX_EQ_DB" => Some(12.0),
        "MIN_EQ_FREQ" => Some(20.0),
        "MAX_EQ_FREQ" => Some(20_000.0),
        "MIN_TEMPO" => Some(domain::MINIMUM_TEMPO_BPM as f64),
        "MAX_TEMPO" => Some(domain::MAXIMUM_TEMPO_BPM as f64),
        "DEFAULT_TEMPO" => Some(120.0),
        "MIN_CABSIM_DB" | "MIN_MIXER_DB" | "MIN_FXLOOP_OUT_GAIN_DB" | "MIN_FXLOOP_IN_GAIN_DB" => {
            Some(-40.0)
        }
        "MAX_CABSIM_DB" | "MAX_MIXER_DB" | "MAX_FXLOOP_OUT_GAIN_DB" | "MAX_FXLOOP_IN_GAIN_DB" => {
            Some(12.0)
        }
        "MIN_INPUT_TRIM" => Some(-20.0),
        "MAX_INPUT_TRIM" => Some(20.0),
        "LIN_SKEW" => Some(1.0),
        _ => None,
    };
    symbolic.or_else(|| value.trim().parse().ok())
}

fn split_text_list(value: Option<&String>) -> Vec<String> {
    value
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

fn split_u32_list(value: Option<&String>) -> Vec<u32> {
    value
        .map(|value| {
            value
                .split(',')
                .filter_map(|item| item.trim().parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

fn number_list(value: Option<&String>) -> Vec<f64> {
    value
        .map(|value| value.split(',').filter_map(catalog_number).collect())
        .unwrap_or_default()
}

fn normalized_to_real(normalized: f64, spec: Option<&ParameterSpec>) -> f64 {
    let amount = normalized.clamp(0.0, 1.0);
    let Some(spec) = spec else { return amount };
    match spec.value_scale.as_str() {
        "lookup" if spec.scale_points.len() >= 2 => {
            for pair in spec.scale_points.windows(2) {
                let left = &pair[0];
                let right = &pair[1];
                if amount <= right.normalized {
                    let span = right.normalized - left.normalized;
                    let ratio = if span == 0.0 {
                        0.0
                    } else {
                        (amount - left.normalized) / span
                    };
                    return left.real + ratio * (right.real - left.real);
                }
            }
            spec.scale_points
                .last()
                .map(|point| point.real)
                .unwrap_or(amount)
        }
        "power" => {
            spec.minimum
                + amount.powf(spec.scale_exponent.unwrap_or(1.0)) * (spec.maximum - spec.minimum)
        }
        "logarithmic" if spec.minimum > 0.0 => {
            spec.minimum * (spec.maximum / spec.minimum).powf(amount)
        }
        _ => spec.minimum + amount * (spec.maximum - spec.minimum),
    }
}

fn special_value_label(normalized: f64, spec: Option<&ParameterSpec>) -> Option<String> {
    let spec = spec?;
    if normalized <= 0.000_001 {
        spec.minimum_label.clone()
    } else if (normalized - 0.5).abs() <= 0.000_001 {
        spec.midpoint_label.clone()
    } else if normalized >= 0.999_999 {
        spec.maximum_label.clone()
    } else {
        None
    }
}

fn trim_number(value: f64, precision: usize) -> String {
    let rendered = format!("{value:.precision$}");
    let rendered = rendered.trim_end_matches('0').trim_end_matches('.');
    if rendered == "-0" {
        "0".into()
    } else {
        rendered.into()
    }
}

fn format_parameter_number(value: f64, precision: Option<u32>) -> String {
    match precision {
        Some(precision) => {
            let rendered = format!("{value:.precision$}", precision = precision as usize);
            if rendered.starts_with('-') && rendered.parse::<f64>().unwrap_or(value) == 0.0 {
                rendered[1..].into()
            } else {
                rendered
            }
        }
        None => trim_number(value, 3),
    }
}

fn parameter_enabled(
    spec: &ParameterSpec,
    values: &HashMap<u32, Option<f64>>,
    info: Option<&ModelInfo>,
) -> bool {
    let selected_step = |controller: u32, value: f64| {
        let count = info
            .and_then(|model| model.parameters.get(&controller))
            .and_then(|parameter| parameter.steps)
            .unwrap_or(2);
        (value.clamp(0.0, 1.0) * count.saturating_sub(1).max(1) as f64).round() as u32
    };
    if let Some(controller) = spec.enable_when_on {
        let Some(value) = values.get(&controller).copied().flatten() else {
            return false;
        };
        if if spec.enable_when_steps.is_empty() {
            value < 0.5
        } else {
            !spec
                .enable_when_steps
                .contains(&selected_step(controller, value))
        } {
            return false;
        }
    }
    if let Some(controller) = spec.enable_when_off {
        let Some(value) = values.get(&controller).copied().flatten() else {
            return false;
        };
        if if spec.enable_when_steps.is_empty() {
            value >= 0.5
        } else {
            spec.enable_when_steps
                .contains(&selected_step(controller, value))
        } {
            return false;
        }
    }
    true
}

fn conditional_parameter_hidden(
    model_id: u32,
    parameter_index: u32,
    values: &HashMap<u32, Option<f64>>,
) -> bool {
    if model_id != 18007 {
        return false;
    }
    let quantized = values.get(&4).copied().flatten().unwrap_or(0.0) >= 0.5;
    if quantized {
        matches!(parameter_index, 20 | 21)
    } else {
        matches!(parameter_index, 7 | 11)
    }
}

fn normalized_category(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn display_category(value: &str) -> String {
    match normalized_category(value).as_str() {
        "bassamplifier" | "bassamp" => "Bass Amp",
        "bassoverdrive" => "Bass Overdrive",
        "cabsimbassm" | "cabsimbassst" | "basscabinet" | "basscab" => "Bass Cab",
        "cabsimguitarm" | "cabsimguitarst" | "guitarcabinet" | "guitarcab" => "Guitar Cab",
        "compressor" => "Compressor",
        "delay" => "Delay",
        "equalizer" | "eq" => "EQ",
        "filter" => "Filter",
        "fxloop" => "FX Loop",
        "guitaramplifier" | "guitaramp" | "amp" => "Guitar Amp",
        "guitaroverdrive" => "Guitar Overdrive",
        "irloaders" | "irloader" => "IR Loader",
        "loopers" | "looper" => "Looper",
        "modulation" => "Modulation",
        "morph" => "Morph",
        "neuralcapture" => "Neural Capture",
        "pitch" => "Pitch",
        "reverb" => "Reverb",
        "synth" => "Synth",
        "utility" => "Utility",
        "wah" => "Wah",
        _ => return value.trim().into(),
    }
    .into()
}

#[derive(Debug, Clone, Default)]
struct TempoState {
    bpm: Option<u32>,
    led_enabled: Option<bool>,
}

/// Stateful because scene selection, ModelRepo metadata, the active preset,
/// and live parameter overrides arrive in independent QC messages.
#[derive(Default)]
pub struct StateDecoder {
    active_scene: u32,
    setlist_key: Option<String>,
    position: Option<u32>,
    is_factory: Option<bool>,
    preset: Option<BinaryPreset>,
    catalog: HashMap<u32, ModelInfo>,
    parameter_overrides: HashMap<(u32, u32, u32), f64>,
}

impl StateDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn model_count(&self) -> usize {
        self.catalog.len()
    }

    pub fn model_list(&self) -> ModelList {
        ModelCatalog(self.catalog.clone()).model_list()
    }

    pub fn install_catalog(&mut self, catalog: ModelCatalog) -> Vec<StateUpdate> {
        self.catalog = catalog.0;
        if self.preset.is_none() {
            Vec::new()
        } else {
            vec![self.preset_update(true)]
        }
    }

    pub fn decode(
        &mut self,
        message_type: u16,
        payload: &[u8],
    ) -> Result<Vec<StateUpdate>, StateDecodeError> {
        let decoded = maybe_gunzip(payload)?;
        match message_type {
            1 => self.decode_grid(&decoded),
            2 => self.decode_position(&decoded),
            3 => self.decode_io_settings(&decoded),
            13 => self.decode_scene(&decoded),
            14 => self.decode_mode(&decoded),
            15 => self.decode_preset_message(&decoded),
            17 => self.decode_master_volume(&decoded),
            23 => self.decode_scene_label(&decoded),
            33 => self.decode_global_tempo(&decoded),
            34 => self.decode_dirty(&decoded),
            48 => self.decode_scene_color(&decoded),
            51 => self.decode_model_repo(&decoded),
            _ => Ok(Vec::new()),
        }
    }

    fn decode_io_settings(&self, payload: &[u8]) -> Result<Vec<StateUpdate>, StateDecodeError> {
        let message: pa::IoSettingsMessage = decode(3, payload)?;
        let Some(pa::io_settings_message::Settings::Settings(settings)) = message.settings else {
            return Ok(Vec::new());
        };
        let mut ports = Vec::new();
        for port in settings.in_port {
            if let Some(pa::input_port_settings::Plugged::Plugged(plugged)) = port.plugged {
                ports.push(IoPortState {
                    kind: "input".into(),
                    id: port.input_port_id as i32,
                    label: input_label(port.input_port_id),
                    plugged,
                });
            }
        }
        for port in settings.out_port {
            if let Some(pa::output_port_settings::Plugged::Plugged(plugged)) = port.plugged {
                ports.push(IoPortState {
                    kind: "output".into(),
                    id: port.output_port_id as i32,
                    label: output_label(port.output_port_id),
                    plugged,
                });
            }
        }
        if let Some(pa::port_settings::HpPort::HpPort(port)) = settings.hp_port {
            if let Some(pa::headphones_settings::Plugged::Plugged(plugged)) = port.plugged {
                ports.push(IoPortState {
                    kind: "headphones".into(),
                    id: 0,
                    label: "Headphones".into(),
                    plugged,
                });
            }
        }
        if let Some(pa::port_settings::UsbPort::UsbPort(port)) = settings.usb_port {
            if let Some(pa::usb_port_settings::Plugged::Plugged(plugged)) = port.plugged {
                ports.push(IoPortState {
                    kind: "usb".into(),
                    id: 0,
                    label: "USB".into(),
                    plugged,
                });
            }
        }
        for port in settings.exp_port {
            if let Some(pa::exp_port_settings::Plugged::Plugged(plugged)) = port.plugged {
                ports.push(IoPortState {
                    kind: "expression".into(),
                    id: port.exp_port_id,
                    label: format!("EXP {}", port.exp_port_id + 1),
                    plugged,
                });
            }
        }
        if ports.is_empty() {
            return Ok(Vec::new());
        }
        let mut update = StateUpdate::new("ioPorts");
        update.io_ports = Some(ports);
        Ok(vec![update])
    }

    pub fn block_details(&self, row: u32, column: u32) -> Option<BlockDetails> {
        let preset = self.preset.as_ref()?;
        let chain = preset
            .chains
            .iter()
            .enumerate()
            .find(|(index, item)| chain_row(item, *index as u32) == row)?
            .1;
        let routing_node = match column {
            8 => Some("splitter"),
            9 => Some("mixer"),
            _ => None,
        };
        let (model, model_id) = match routing_node {
            Some("splitter") => {
                let points = chain.split_control_points.first()?;
                if points.split < 0 {
                    return None;
                }
                (chain.combined_splitter.first()?, 10_004)
            }
            Some("mixer") => {
                let points = chain.split_control_points.first()?;
                if points.split < 0 || points.mix < 0 {
                    return None;
                }
                (chain.mixer.first()?, 11_000)
            }
            _ => {
                let model = chain
                    .models
                    .iter()
                    .enumerate()
                    .find(|(index, item)| model_column(item, *index as u32) == column)?
                    .1;
                (model, model_hash(model)?)
            }
        };
        self.parameter_target_details(row, column, model, model_id, routing_node)
    }

    /// Parameters attached to the row itself rather than to a Grid cell.
    /// These are explicit control targets in the public API; the private column
    /// discriminator only keeps optimistic live-value overrides collision-free.
    pub fn lane_control_details(&self, row: u32, control: &str) -> Option<BlockDetails> {
        let preset = self.preset.as_ref()?;
        let chain = preset
            .chains
            .iter()
            .enumerate()
            .find(|(index, item)| chain_row(item, *index as u32) == row)?
            .1;
        let (model, model_id, discriminator) = match control {
            "inputGate" => (chain.input_control.first()?, 28_000, 10),
            "laneOutput" => (chain.output_control.first()?, 23_000, 11),
            _ => return None,
        };
        self.parameter_target_details(row, discriminator, model, model_id, None)
    }

    fn parameter_target_details(
        &self,
        row: u32,
        column: u32,
        model: &Model,
        model_id: u32,
        routing_node: Option<&str>,
    ) -> Option<BlockDetails> {
        let info = self.catalog.get(&model_id);
        let mut current_values = HashMap::new();
        for (positional, parameter) in model.params.iter().enumerate() {
            let index = param_index(parameter, positional as u32);
            let mut options = if parameter.dynamic_steps.is_empty() {
                info.and_then(|item| item.parameters.get(&index))
                    .map(|item| item.options.clone())
                    .unwrap_or_default()
            } else {
                parameter.dynamic_steps.clone()
            };
            if options.is_empty() && matches!(index, 1 | 9) {
                options = cab_microphone_options(
                    model_id,
                    effective_string_parameter(parameter, self.active_scene),
                );
            }
            if options.is_empty() {
                options = routing_parameter_options(routing_node, index);
            }
            current_values.insert(
                index,
                self.parameter_overrides
                    .get(&(row, column, index))
                    .copied()
                    .or_else(|| normalized_parameter(parameter, self.active_scene, &options)),
            );
        }
        let category_key = info
            .map(|item| normalized_category(&item.category))
            .unwrap_or_default();
        let show_offscreen = category_key.contains("cabsim") || category_key.contains("irloader");
        let splitter_visible = if routing_node == Some("splitter") {
            current_values
                .get(&0)
                .and_then(|value| *value)
                .map(|value| {
                    match (value * 2.0).round().clamp(0.0, 2.0) as u32 {
                        0 => [0, 1, 3, 4].as_slice(),
                        1 => [0, 1, 2].as_slice(),
                        _ => [0, 1, 5, 6].as_slice(),
                    }
                    .to_vec()
                })
        } else {
            None
        };
        let mut parameters = Vec::new();
        for (positional, parameter) in model.params.iter().enumerate() {
            let index = param_index(parameter, positional as u32);
            let spec = info.and_then(|item| item.parameters.get(&index));
            if spec.is_some_and(|item| {
                item.hidden
                    || (!item.screen_visible && !show_offscreen)
                    || conditional_parameter_hidden(model_id, index, &current_values)
            }) {
                continue;
            }
            if splitter_visible
                .as_ref()
                .is_some_and(|visible| !visible.contains(&index))
            {
                continue;
            }
            if routing_node == Some("mixer") && spec.is_some_and(|item| item.name == "SPLIT MODE") {
                continue;
            }
            let mut options = if parameter.dynamic_steps.is_empty() {
                spec.map(|item| item.options.clone()).unwrap_or_default()
            } else {
                parameter.dynamic_steps.clone()
            };
            if options.is_empty() && matches!(index, 1 | 9) {
                options = cab_microphone_options(
                    model_id,
                    effective_string_parameter(parameter, self.active_scene),
                );
            }
            if options.is_empty() {
                options = routing_parameter_options(routing_node, index);
            }
            let scene_mode = param_scene_mode(parameter);
            let Some(normalized) = self
                .parameter_overrides
                .get(&(row, column, index))
                .copied()
                .or_else(|| normalized_parameter(parameter, self.active_scene, &options))
            else {
                continue;
            };
            let minimum = spec.map(|item| item.minimum).unwrap_or(0.0);
            let maximum = spec.map(|item| item.maximum).unwrap_or(1.0);
            let units = spec.map(|item| item.units.clone()).unwrap_or_default();
            let value_scale = if !options.is_empty() {
                "options"
            } else {
                spec.map(|item| item.value_scale.as_str())
                    .unwrap_or("unknown")
            };
            let scale_known = !options.is_empty() || spec.is_some_and(|item| item.scale_known);
            let display_precision = spec.and_then(|item| item.display_precision());
            let display = if !options.is_empty() {
                let selected = ((normalized * (options.len().saturating_sub(1)) as f64).round()
                    as usize)
                    .min(options.len() - 1);
                options[selected].clone()
            } else if scale_known {
                special_value_label(normalized, spec).unwrap_or_else(|| {
                    format_parameter_number(normalized_to_real(normalized, spec), display_precision)
                })
            } else {
                trim_number(normalized, 3)
            };
            parameters.push(BlockParameter {
                index,
                display_position: spec.map(|item| item.display_position).unwrap_or(index),
                name: spec
                    .map(|item| item.name.clone())
                    .unwrap_or_else(|| format!("Parameter {}", index + 1)),
                normalized_value: Some(normalized),
                display_value: display,
                units,
                r#type: spec.map(|item| item.r#type.clone()).unwrap_or_else(|| {
                    if options.is_empty() {
                        "float".into()
                    } else {
                        "enum".into()
                    }
                }),
                minimum,
                maximum,
                value_scale: value_scale.into(),
                scale_exponent: spec.and_then(|item| item.scale_exponent),
                scale_points: spec
                    .map(|item| item.scale_points.clone())
                    .unwrap_or_default(),
                scale_known,
                display_precision,
                minimum_label: spec.and_then(|item| item.minimum_label.clone()),
                midpoint_label: spec.and_then(|item| item.midpoint_label.clone()),
                maximum_label: spec.and_then(|item| item.maximum_label.clone()),
                steps: spec.and_then(|item| item.steps),
                scene_mode,
                options,
                writable: !parameter.param_values.is_empty(),
                enabled: spec
                    .map(|item| parameter_enabled(item, &current_values, info))
                    .unwrap_or(true),
                expression_assignable: spec.map(|item| item.expression_assignable).unwrap_or(true),
                linked_scene_mode: spec.and_then(|item| item.linked_scene_mode),
                expression: param_expression(parameter),
                expression_minimum: param_expression_minimum(parameter),
                expression_maximum: param_expression_maximum(parameter),
                led_value: None,
                wire_value_kind: if parameter
                    .param_values
                    .iter()
                    .any(|value| matches!(value.value, Some(param_value::Value::StringValue(_))))
                {
                    "text".into()
                } else {
                    "numeric".into()
                },
            });
        }
        Some(BlockDetails {
            row,
            column,
            model_id,
            name: info
                .map(|item| item.name.clone())
                .unwrap_or_else(|| format!("Model {model_id}")),
            category: info
                .map(|item| display_category(&item.category))
                .unwrap_or_else(|| "Utility".into()),
            scene: self.active_scene,
            bypass_expression: model_bypass_expression(model),
            parameters,
        })
    }

    fn decode_scene(&mut self, payload: &[u8]) -> Result<Vec<StateUpdate>, StateDecodeError> {
        let message = decode::<pa::SceneMessage>(13, payload)?;
        let Some(pa::scene_message::SelectedScene::SelectedScene(scene)) = message.selected_scene
        else {
            return Ok(Vec::new());
        };
        self.active_scene = scene.min(7);
        let mut update = StateUpdate::new("scene");
        update.active_scene = Some(self.active_scene);
        Ok(vec![update])
    }

    fn decode_position(&mut self, payload: &[u8]) -> Result<Vec<StateUpdate>, StateDecodeError> {
        let message = decode::<pa::SetlistPositionMessage>(2, payload)?;
        if let Some(pa::setlist_position_message::FolderKey::FolderKey(value)) = message.folder_key
        {
            self.setlist_key = Some(value);
        }
        if let Some(pa::setlist_position_message::Position::Position(value)) = message.position {
            self.position = Some(value);
        }
        if let Some(pa::setlist_position_message::IsFactory::IsFactory(value)) = message.is_factory
        {
            self.is_factory = Some(value);
        }
        let mut update = StateUpdate::new("position");
        update.setlist_key = self.setlist_key.clone();
        update.position = self.position;
        update.is_factory = self.is_factory;
        Ok(vec![update])
    }

    fn decode_preset_message(
        &mut self,
        payload: &[u8],
    ) -> Result<Vec<StateUpdate>, StateDecodeError> {
        let message = decode::<pa::RecallPresetMessage>(15, payload)?;
        let Some(pa::recall_preset_message::Preset::Preset(preset)) = message.preset else {
            return Ok(Vec::new());
        };
        self.parameter_overrides.clear();
        self.preset = Some(preset);
        Ok(vec![self.preset_update(false)])
    }

    fn decode_grid(&mut self, payload: &[u8]) -> Result<Vec<StateUpdate>, StateDecodeError> {
        let message = decode::<pa::GridMessage>(1, payload)?;
        let Some(pa::grid_message::Preset::Preset(preset)) = message.preset else {
            return Ok(Vec::new());
        };
        let mut states = Vec::new();
        let tempo = tempo_state(preset.tempo_program_data.first());
        if tempo.bpm.is_some() || tempo.led_enabled.is_some() {
            let mut update = StateUpdate::new("tempo");
            update.tempo = tempo.bpm;
            update.tempo_led_enabled = tempo.led_enabled;
            states.push(update);
        }
        let bypasses = bypass_updates(&preset.bypass, self.active_scene, false);
        if !bypasses.is_empty() {
            let mut update = StateUpdate::new("bypassBatch");
            update.bypass_updates = Some(bypasses);
            states.push(update);
        }
        for (chain_index, chain) in preset.chains.iter().enumerate() {
            let row = chain_row(chain, chain_index as u32);
            if row > 3 {
                continue;
            }
            for (model_index, model) in chain.models.iter().enumerate() {
                let column = model_column(model, model_index as u32);
                if column > 7 {
                    continue;
                }
                for (parameter_pos, parameter) in model.params.iter().enumerate() {
                    let index = param_index(parameter, parameter_pos as u32);
                    let Some(value) = parameter.param_values.first().and_then(float_value) else {
                        continue;
                    };
                    if !(0.0..=1.0).contains(&value) {
                        continue;
                    }
                    self.parameter_overrides
                        .insert((row, column, index), value as f64);
                    let mut update = StateUpdate::new("parameter");
                    update.row = Some(row);
                    update.column = Some(column);
                    update.parameter_index = Some(index);
                    update.normalized_value = Some(value);
                    states.push(update);
                }
            }
            for (discriminator, controls) in [
                (10_u32, chain.input_control.as_slice()),
                (11_u32, chain.output_control.as_slice()),
            ] {
                for control in controls {
                    for (parameter_pos, parameter) in control.params.iter().enumerate() {
                        let index = param_index(parameter, parameter_pos as u32);
                        let Some(value) = parameter.param_values.first().and_then(float_value)
                        else {
                            continue;
                        };
                        if !(0.0..=1.0).contains(&value) {
                            continue;
                        }
                        self.parameter_overrides
                            .insert((row, discriminator, index), value as f64);
                        let mut update = StateUpdate::new("laneControlParameter");
                        update.row = Some(row);
                        update.column = Some(discriminator);
                        update.parameter_index = Some(index);
                        update.normalized_value = Some(value);
                        states.push(update);
                    }
                }
            }
        }
        Ok(states)
    }

    fn decode_mode(&self, payload: &[u8]) -> Result<Vec<StateUpdate>, StateDecodeError> {
        let message = decode::<pa::ModeMessage>(14, payload)?;
        let Some(pa::mode_message::Mode::Mode(value)) = message.mode else {
            return Ok(Vec::new());
        };
        let mut update = StateUpdate::new("mode");
        update.mode = Some(mode_kind(value));
        let hybrid = [(0, 1), (0, 2), (1, 0), (1, 2), (2, 0), (2, 1)];
        let pair = if (3..=8).contains(&value) {
            hybrid[(value - 3) as usize]
        } else {
            (value, value)
        };
        update.footswitch_modes = Some(vec![mode_name(pair.0), mode_name(pair.1)]);
        if let Some(pa::mode_message::AvailableModes::AvailableModes(available)) =
            message.available_modes
        {
            let slots = available
                .modes
                .into_iter()
                .take(3)
                .enumerate()
                .map(|(slot, mode)| ModeSlot {
                    slot: slot as u32,
                    label: mode_label(mode),
                    mode: mode_kind(mode),
                })
                .collect::<Vec<_>>();
            if !slots.is_empty() {
                update.mode_slots = Some(slots);
            }
        }
        Ok(vec![update])
    }

    fn decode_master_volume(&self, payload: &[u8]) -> Result<Vec<StateUpdate>, StateDecodeError> {
        let message = decode::<pa::MasterVolumeMessage>(17, payload)?;
        let Some(pa::master_volume_message::Volume::Volume(value)) = message.volume else {
            return Ok(Vec::new());
        };
        let mut update = StateUpdate::new("master");
        update.master_volume = Some(value);
        Ok(vec![update])
    }

    fn decode_dirty(&self, payload: &[u8]) -> Result<Vec<StateUpdate>, StateDecodeError> {
        let message = decode::<pa::PresetDirtyMessage>(34, payload)?;
        let mut update = StateUpdate::new("dirty");
        update.dirty = Some(message.is_dirty);
        Ok(vec![update])
    }

    fn decode_scene_label(&self, payload: &[u8]) -> Result<Vec<StateUpdate>, StateDecodeError> {
        let message = decode::<pa::SceneLabelMessage>(23, payload)?;
        if message.index < 0 {
            return Ok(Vec::new());
        }
        let mut update = StateUpdate::new("sceneLabel");
        update.index = Some(message.index as u32);
        update.label = Some(message.label);
        Ok(vec![update])
    }

    fn decode_scene_color(&self, payload: &[u8]) -> Result<Vec<StateUpdate>, StateDecodeError> {
        let message = decode::<pa::SceneColorMessage>(48, payload)?;
        if message.index < 0 {
            return Ok(Vec::new());
        }
        let mut update = StateUpdate::new("sceneColor");
        update.index = Some(message.index as u32);
        update.color = Some(color_hex(message.color));
        Ok(vec![update])
    }

    fn decode_global_tempo(&self, payload: &[u8]) -> Result<Vec<StateUpdate>, StateDecodeError> {
        let message = decode::<pa::GlobalTempoMessage>(33, payload)?;
        let state = tempo_from_params(&message.params);
        if state.bpm.is_none() && state.led_enabled.is_none() {
            return Ok(Vec::new());
        }
        let mut update = StateUpdate::new("tempo");
        update.tempo = state.bpm;
        update.tempo_led_enabled = state.led_enabled;
        Ok(vec![update])
    }

    fn decode_model_repo(&mut self, payload: &[u8]) -> Result<Vec<StateUpdate>, StateDecodeError> {
        let catalog = parse_model_repo(payload)?;
        Ok(self.install_catalog(catalog))
    }

    fn preset_update(&self, catalog_refresh: bool) -> StateUpdate {
        let preset = self
            .preset
            .as_ref()
            .expect("preset update requires a preset");
        let mut update = StateUpdate::new("preset");
        update.preset_name = match &preset.name {
            Some(binary_preset::Name::Name(value)) => Some(value.clone()),
            _ => None,
        };
        let tempo = tempo_state(preset.tempo_program_data.first());
        update.tempo = tempo.bpm.or(match preset.tempo {
            Some(binary_preset::Tempo::Tempo(value)) => Some(value),
            _ => None,
        });
        update.tempo_led_enabled = tempo.led_enabled;
        update.scenes = Some(
            (0..8)
                .map(|index| {
                    preset
                        .scene_labels
                        .get(index)
                        .filter(|label| !label.trim().is_empty())
                        .cloned()
                        .unwrap_or_else(|| format!("Scene {}", (b'A' + index as u8) as char))
                })
                .collect(),
        );
        update.scene_colors = Some(
            preset
                .scene_colors
                .iter()
                .map(|value| color_hex(*value))
                .collect(),
        );
        let bypasses = bypass_map(&preset.bypass, true);
        let assignments = preset
            .stomp_mode_assignments
            .iter()
            .enumerate()
            .filter(|(_, item)| item.stomp_index <= 7)
            .map(|(order, item)| ((item.row, item.column), (item.stomp_index, order as u32)))
            .collect::<HashMap<_, _>>();
        let mut blocks = Vec::new();
        let mut routes = Vec::new();
        for (chain_index, chain) in preset.chains.iter().enumerate() {
            let row = chain_row(chain, chain_index as u32);
            let input_id = chain_input(chain);
            let output_id = chain_output(chain);
            routes.push(GridRoute {
                row,
                input_id: Some(input_id),
                output_id: Some(output_id),
                input: input_label(input_id),
                output: output_label(output_id),
                split_column: chain
                    .split_control_points
                    .first()
                    .and_then(|value| (value.split >= 0).then_some(value.split)),
                mix_column: chain
                    .split_control_points
                    .first()
                    .and_then(|value| (value.split >= 0).then_some(value.mix)),
                split_muted: chain
                    .mix_bypass
                    .get((self.active_scene as usize).min(chain.mix_bypass.len().saturating_sub(1)))
                    .or_else(|| chain.mix_bypass.first())
                    .is_some_and(|value| value.bypass),
            });
            for (model_index, model) in chain.models.iter().enumerate() {
                let Some(model_id) = model_hash(model).filter(|value| *value != 0) else {
                    continue;
                };
                let column = model_column(model, model_index as u32);
                let info = self.catalog.get(&model_id);
                blocks.push(GridBlock {
                    id: format!("{row}:{column}"),
                    model_id: Some(model_id),
                    category_id: None,
                    name: info
                        .map(|item| item.name.clone())
                        .unwrap_or_else(|| format!("Model {model_id}")),
                    kind: info
                        .map(|item| item.kind.clone())
                        .unwrap_or_else(|| "utility".into()),
                    category: info.map(|item| item.category.clone()),
                    plugin: None,
                    plugin_id: None,
                    row,
                    column,
                    bypassed: bypasses
                        .get(&(row, column))
                        .and_then(|values| {
                            values.get(
                                (self.active_scene as usize).min(values.len().saturating_sub(1)),
                            )
                        })
                        .copied(),
                    bypass_expression: model_bypass_expression(model),
                    color: None,
                    glyph: None,
                    footswitch: assignments.get(&(row, column)).map(|value| value.0),
                    footswitch_order: assignments.get(&(row, column)).map(|value| value.1),
                });
            }
        }
        update.footswitch_states = Some(
            (0..domain::SCENE_COUNT)
                .map(|index| {
                    let mut targets = blocks
                        .iter()
                        .filter(|block| block.footswitch == Some(index))
                        .collect::<Vec<_>>();
                    targets.sort_by_key(|block| block.footswitch_order.unwrap_or(u32::MAX));
                    FootswitchState {
                        index,
                        active: targets
                            .first()
                            .is_some_and(|block| block.bypassed == Some(false)),
                        assigned: !targets.is_empty(),
                        color: stomp_color(&targets),
                        momentary: Some(
                            preset
                                .stomp_is_momentary
                                .get(&index)
                                .copied()
                                .unwrap_or(false),
                        ),
                        label: Some(
                            preset
                                .single_stomp_labels
                                .get(&index)
                                .or_else(|| preset.stomp_labels.get(&index))
                                .cloned()
                                .unwrap_or_default(),
                        ),
                    }
                })
                .collect(),
        );
        update.midi_out = Some(
            preset
                .midi_messages_general_v2
                .chunks(12)
                .take(10)
                .enumerate()
                .filter_map(|(source, messages)| {
                    let messages = messages
                        .iter()
                        .filter(|message| midi_message_present(message))
                        .map(midi_message)
                        .collect::<Vec<_>>();
                    (!messages.is_empty()).then_some(MidiOutSource {
                        source: source as u32,
                        messages,
                    })
                })
                .collect(),
        );
        update.preset_load_midi_out = Some(
            preset
                .midi_messages
                .iter()
                .filter(|message| midi_message_present(message))
                .map(midi_message)
                .collect(),
        );
        update.blocks = Some(blocks);
        update.routes = Some(routes);
        if catalog_refresh {
            update.catalog_refresh = Some(true);
        }
        update
    }
}

fn midi_message_present(message: &crate::proto::MidiMessageInfo) -> bool {
    message.r#type != 0
        || message.channel != 0
        || message.param1 != 0
        || message.param2 != 0
        || message.param3 != 0
}

fn midi_message(message: &crate::proto::MidiMessageInfo) -> MidiOutMessage {
    MidiOutMessage {
        r#type: message.r#type,
        channel: message.channel,
        param1: message.param1,
        param2: message.param2,
        param3: message.param3,
    }
}

fn model_bypass_expression(model: &Model) -> Option<BypassExpression> {
    let assignment = model.bypass_expression.first()?;
    if assignment.expression <= 0 {
        return None;
    }
    let info = model
        .expression_bypass_info
        .first()
        .cloned()
        .unwrap_or_default();
    Some(BypassExpression {
        pedal: assignment.expression as u32,
        minimum: assignment.expression_min,
        maximum: assignment.expression_max,
        mode: info.r#type,
        invert: info.invert,
        delay_ms: info.delay_ms,
        latch_emulation: info.latch_emulation,
    })
}

fn stomp_color(blocks: &[&GridBlock]) -> String {
    if blocks.len() != 1 {
        return if blocks.is_empty() {
            domain::visual_colors::IDLE_LED
        } else {
            domain::visual_colors::WHITE_LED
        }
        .into();
    }
    let block = blocks[0];
    let category = format!(
        "{} {}",
        block.category.as_deref().unwrap_or_default(),
        block.kind
    )
    .to_ascii_lowercase();
    let name = block.name.to_ascii_lowercase();
    let color = if block.plugin == Some(true) {
        domain::visual_colors::PLUGIN
    } else if category.contains("capture") {
        domain::visual_colors::WHITE_LED
    } else if category.contains("amplifier")
        || category.split_whitespace().any(|word| word == "amp")
    {
        domain::visual_colors::AMP
    } else if category.contains("looper") {
        domain::visual_colors::LOOPER
    } else if category.contains("ir loader")
        || category.contains("irloader")
        || category.contains("cab")
        || category.contains("impulse response")
    {
        domain::visual_colors::CAB
    } else if ["overdrive", "distortion", "drive", "boost", "fuzz"]
        .iter()
        .any(|term| category.contains(term))
    {
        // CorOS uses orange for the Grid block but yellow for the physical
        // STOMP lamp assigned to a drive-family device.
        domain::visual_colors::PITCH
    } else if category.contains("delay") || category.contains("reverb") {
        domain::visual_colors::DELAY
    } else if category.contains("compressor") {
        domain::visual_colors::COMPRESSOR
    } else if category.contains("pitch") || name.contains("octav") {
        domain::visual_colors::PITCH
    } else if category.contains("modulation")
        || category.split_whitespace().any(|word| word == "mod")
    {
        domain::visual_colors::MODULATION
    } else if category.contains("morph") || category.contains("filter") {
        domain::visual_colors::MORPH
    } else if category.contains("synth") {
        domain::visual_colors::SYNTH
    } else if category.contains("equalizer") || category.split_whitespace().any(|word| word == "eq")
    {
        domain::visual_colors::EQUALIZER
    } else {
        domain::visual_colors::WHITE_LED
    };
    color.into()
}

fn routing_parameter_options(node: Option<&str>, index: u32) -> Vec<String> {
    let values: &[&str] = match (node, index) {
        (Some("splitter"), 0) => &["A/B", "BALANCE", "CROSSOVER"],
        (Some("splitter"), 1) => &["MONO", "STEREO"],
        (Some("splitter"), 6) => &["LOW / HIGH", "HIGH / LOW"],
        (Some("mixer"), 4) => &["NORMAL", "INVERTED"],
        _ => &[],
    };
    values.iter().map(|value| (*value).to_string()).collect()
}

pub fn parse_model_repo(payload: &[u8]) -> Result<ModelCatalog, StateDecodeError> {
    let payload = maybe_gunzip(payload)?;
    let message = decode::<pa::ModelRepoMessage>(51, &payload)?;
    let Some(pa::model_repo_message::ModelRepoPayload::ModelRepoPayload(repo)) =
        message.model_repo_payload
    else {
        return Ok(ModelCatalog(HashMap::new()));
    };
    let repo = maybe_gunzip(&repo)?;
    Ok(ModelCatalog(parse_catalog(extract_xml(&repo)?)?))
}

fn decode<M: Message + Default>(message_type: u16, payload: &[u8]) -> Result<M, StateDecodeError> {
    M::decode(payload).map_err(|source| StateDecodeError::Protobuf {
        message_type,
        source,
    })
}

fn maybe_gunzip(payload: &[u8]) -> Result<Vec<u8>, StateDecodeError> {
    if !payload.starts_with(&[0x1f, 0x8b]) {
        return Ok(payload.to_vec());
    }
    let mut decoded = Vec::new();
    GzDecoder::new(payload)
        .take(profile::MAX_INFLATED_BYTES as u64 + 1)
        .read_to_end(&mut decoded)
        .map_err(|error| StateDecodeError::Compression(error.to_string()))?;
    if decoded.len() > profile::MAX_INFLATED_BYTES {
        return Err(StateDecodeError::InflatedLimit);
    }
    Ok(decoded)
}

fn model_hash(model: &Model) -> Option<u32> {
    match model.hash {
        Some(model::Hash::Hash(value)) => Some(value),
        _ => None,
    }
}
fn model_column(model: &Model, fallback: u32) -> u32 {
    match model.column {
        Some(model::Column::Column(value)) => value,
        _ => fallback,
    }
}
fn chain_row(chain: &Chain, fallback: u32) -> u32 {
    match chain.row {
        Some(chain::Row::Row(value)) => value,
        _ => fallback,
    }
}
fn chain_input(chain: &Chain) -> u32 {
    match chain.in_portid {
        Some(chain::InPortid::InPortid(value)) => value,
        _ => 0,
    }
}
fn chain_output(chain: &Chain) -> u32 {
    match chain.out_portid {
        Some(chain::OutPortid::OutPortid(value)) => value,
        _ => 0,
    }
}
fn param_index(parameter: &Param, fallback: u32) -> u32 {
    match parameter.index {
        Some(param::Index::Index(value)) => value,
        _ => fallback,
    }
}
fn param_scene_mode(parameter: &Param) -> bool {
    matches!(
        parameter.scene_mode,
        Some(param::SceneMode::SceneMode(true))
    )
}
fn float_value(value: &crate::proto::ParamValue) -> Option<f32> {
    match value.value {
        Some(param_value::Value::FloatValue(value)) => Some(value),
        _ => None,
    }
}

fn normalized_parameter(parameter: &Param, scene: u32, options: &[String]) -> Option<f64> {
    let selected = if param_scene_mode(parameter) {
        (scene as usize).min(parameter.param_values.len().saturating_sub(1))
    } else {
        0
    };
    match parameter.param_values.get(selected)?.value.as_ref()? {
        param_value::Value::FloatValue(value) if (0.0..=1.0).contains(value) => Some(*value as f64),
        param_value::Value::StringValue(value) if !options.is_empty() => {
            options.iter().position(|item| item == value).map(|index| {
                if options.len() == 1 {
                    0.0
                } else {
                    index as f64 / (options.len() - 1) as f64
                }
            })
        }
        _ => None,
    }
}

fn effective_string_parameter(parameter: &Param, scene: u32) -> Option<&str> {
    let selected = if param_scene_mode(parameter) {
        (scene as usize).min(parameter.param_values.len().saturating_sub(1))
    } else {
        0
    };
    match parameter.param_values.get(selected)?.value.as_ref()? {
        param_value::Value::StringValue(value) => Some(value),
        _ => None,
    }
}

fn cab_microphone_options(model_id: u32, value: Option<&str>) -> Vec<String> {
    const MICROPHONES: &[&str] = &[
        "Condenser 184",
        "Condenser 414",
        "Dynamic 421",
        "Dynamic 57",
        "Ribbon 10",
        "Ribbon 160",
    ];
    if !matches!(model_id, 12024 | 32024) {
        return Vec::new();
    }
    let Some(prefix) = value.and_then(|value| value.rsplit_once('_').map(|pair| pair.0)) else {
        return Vec::new();
    };
    MICROPHONES
        .iter()
        .map(|microphone| format!("{prefix}_{microphone}"))
        .collect()
}

fn param_expression(parameter: &Param) -> Option<i32> {
    match parameter.expression {
        Some(param::Expression::Expression(value)) => Some(value),
        _ => None,
    }
}

fn param_expression_minimum(parameter: &Param) -> Option<f32> {
    match parameter.expression_min {
        Some(param::ExpressionMin::ExpressionMin(value)) => Some(value),
        _ => None,
    }
}

fn param_expression_maximum(parameter: &Param) -> Option<f32> {
    match parameter.expression_max {
        Some(param::ExpressionMax::ExpressionMax(value)) => Some(value),
        _ => None,
    }
}

fn tempo_state(model: Option<&Model>) -> TempoState {
    model
        .map(|item| tempo_from_params(&item.params))
        .unwrap_or_default()
}
fn tempo_from_params(parameters: &[Param]) -> TempoState {
    let mut state = TempoState::default();
    for (fallback, parameter) in parameters.iter().enumerate() {
        let Some(value) = parameter
            .param_values
            .first()
            .and_then(float_value)
            .filter(|value| (0.0..=1.0).contains(value))
        else {
            continue;
        };
        match param_index(parameter, fallback as u32) {
            0 => {
                let minimum = domain::MINIMUM_TEMPO_BPM as f32;
                let span = (domain::MAXIMUM_TEMPO_BPM - domain::MINIMUM_TEMPO_BPM) as f32;
                state.bpm = Some((minimum + span * value).round() as u32);
            }
            2 => state.led_enabled = Some(value >= 0.5),
            _ => {}
        }
    }
    state
}

fn bypass_map(rows: &[crate::proto::Bypass], positional: bool) -> HashMap<(u32, u32), Vec<bool>> {
    let mut result = HashMap::new();
    for (row_index, row) in rows.iter().enumerate() {
        let reported_row = match row.row {
            Some(bypass::Row::Row(value)) => value,
            _ => row_index as u32,
        };
        let row_address = if positional {
            row_index as u32
        } else {
            reported_row
        };
        for (column_index, column) in row.col_bypass.iter().enumerate() {
            let reported_column = match column.column {
                Some(col_bypass::Column::Column(value)) => value,
                _ => column_index as u32,
            };
            let column_address = if positional {
                column_index as u32
            } else {
                reported_column
            };
            result.insert(
                (row_address, column_address),
                column.scene_bypass.iter().map(|item| item.bypass).collect(),
            );
        }
    }
    result
}

fn bypass_updates(
    rows: &[crate::proto::Bypass],
    active_scene: u32,
    positional: bool,
) -> Vec<BypassUpdate> {
    let mut updates = bypass_map(rows, positional)
        .into_iter()
        .filter_map(|((row, column), values)| {
            let bypassed = values
                .get((active_scene as usize).min(values.len().saturating_sub(1)))
                .copied()?;
            Some(BypassUpdate {
                row,
                column,
                bypassed,
            })
        })
        .collect::<Vec<_>>();
    updates.sort_by_key(|item| (item.row, item.column));
    updates
}

fn mode_name(value: u32) -> String {
    match value {
        1 => "SCENE",
        2 => "STOMP",
        _ => "PRESET",
    }
    .into()
}
fn mode_kind(value: u32) -> String {
    if (3..=8).contains(&value) {
        "HYBRID".into()
    } else {
        mode_name(value)
    }
}
fn mode_label(value: u32) -> String {
    match value {
        3 => "PRESET / SCENE",
        4 => "PRESET / STOMP",
        5 => "SCENE / PRESET",
        6 => "SCENE / STOMP",
        7 => "STOMP / PRESET",
        8 => "STOMP / SCENE",
        _ => return mode_name(value),
    }
    .into()
}
fn color_hex(value: u32) -> String {
    format!("#{:06x}", value & 0x00ff_ffff)
}

fn input_label(value: u32) -> String {
    const VALUES: &[&str] = &[
        "Internal",
        "In 1",
        "In 2",
        "In 1/2",
        "Return 1",
        "Return 2",
        "Return 1/2",
        "Prev. Row",
        "USB 5",
        "USB 6",
        "USB 7",
        "USB 8",
        "USB 5/6",
        "USB 7/8",
        "Sidechain",
    ];
    VALUES
        .get(value as usize)
        .map(|item| (*item).into())
        .unwrap_or_else(|| format!("Input {value}"))
}
fn output_label(value: u32) -> String {
    const VALUES: &[&str] = &[
        "Internal",
        "Out 1/2",
        "Out 3/4",
        "Send 1/2",
        "Out 1",
        "Out 2",
        "Out 3",
        "Out 4",
        "Send 1",
        "Send 2",
        "USB 5",
        "USB 6",
        "USB 7",
        "USB 8",
        "USB 5/6",
        "USB 7/8",
        "Row 3",
        "Row 4",
        "Rows 3/4",
        "Multi Out",
        "USB 3",
        "USB 4",
        "USB 3/4",
    ];
    VALUES
        .get(value as usize)
        .map(|item| (*item).into())
        .unwrap_or_else(|| format!("Output {value}"))
}

fn extract_xml(payload: &[u8]) -> Result<&[u8], StateDecodeError> {
    let first = payload
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(payload.len());
    if payload.get(first) == Some(&b'<') {
        return Ok(payload);
    }
    let mut offset = 0usize;
    while offset + 512 <= payload.len() {
        let name = tar_text(&payload[offset..offset + 100]);
        if name.is_empty() {
            break;
        }
        let size_text = tar_text(&payload[offset + 124..offset + 136]);
        let size = usize::from_str_radix(size_text.trim(), 8)
            .map_err(|_| StateDecodeError::CatalogArchive("invalid tar size".into()))?;
        let content = offset + 512;
        let end = content
            .checked_add(size)
            .filter(|end| *end <= payload.len())
            .ok_or_else(|| StateDecodeError::CatalogArchive("truncated tar member".into()))?;
        if name.ends_with(".xml") {
            return Ok(&payload[content..end]);
        }
        offset = content + size.div_ceil(512) * 512;
    }
    Err(StateDecodeError::CatalogArchive("no XML member".into()))
}
fn tar_text(value: &[u8]) -> String {
    String::from_utf8_lossy(
        &value[..value
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(value.len())],
    )
    .trim()
    .into()
}

fn parse_catalog(xml: &[u8]) -> Result<HashMap<u32, ModelInfo>, StateDecodeError> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut catalog = HashMap::new();
    let mut category = String::new();
    let mut category_hidden = false;
    let mut current: Option<u32> = None;
    let mut parameter_index = 0u32;
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) | Ok(Event::Empty(event)) => {
                let name = event.local_name();
                let attrs = event
                    .attributes()
                    .filter_map(Result::ok)
                    .filter_map(|attribute| {
                        let key = String::from_utf8_lossy(attribute.key.local_name().as_ref())
                            .into_owned();
                        let value = attribute.unescape_value().ok()?.into_owned();
                        Some((key, value))
                    })
                    .collect::<HashMap<_, _>>();
                if name.as_ref() == b"Category" {
                    category = attrs.get("name").cloned().unwrap_or_default();
                    category_hidden = attrs.contains_key("hidden");
                } else if name.as_ref() == b"Model" {
                    current = attrs.get("id").and_then(|value| value.parse::<u32>().ok());
                    parameter_index = 0;
                    if let Some(id) = current {
                        let model_name = attrs
                            .get("name")
                            .cloned()
                            .unwrap_or_else(|| format!("Model {id}"));
                        let lower = category.to_lowercase();
                        let kind = if lower.contains("amp") {
                            "amp"
                        } else if lower.contains("cab") || lower.contains("impulse") {
                            "cab"
                        } else if lower.contains("delay") {
                            "delay"
                        } else if lower.contains("reverb") {
                            "reverb"
                        } else if lower.contains("mod") || lower.contains("pitch") {
                            "mod"
                        } else if lower.contains("capture") {
                            "capture"
                        } else if lower.contains("input") {
                            "input"
                        } else if lower.contains("output") {
                            "output"
                        } else {
                            "utility"
                        };
                        catalog.insert(
                            id,
                            ModelInfo {
                                name: model_name,
                                category: category.clone(),
                                kind: kind.into(),
                                clone_id: attrs.get("clones").and_then(|value| value.parse().ok()),
                                hidden: category_hidden
                                    || attrs.contains_key("hidden")
                                    || attrs.contains_key("internal"),
                                based_on: attrs.get("basedOn").cloned().unwrap_or_default(),
                                ..Default::default()
                            },
                        );
                    }
                } else if name.as_ref() == b"Parameter" {
                    if let Some(model) = current.and_then(|id| catalog.get_mut(&id)) {
                        let replacement = attrs
                            .get("replaces")
                            .and_then(|value| value.parse::<u32>().ok());
                        let index = replacement.unwrap_or(parameter_index);
                        let kind = attrs.get("type").cloned().unwrap_or_else(|| "float".into());
                        let raw_name = attrs
                            .get("name")
                            .cloned()
                            .unwrap_or_else(|| format!("Parameter {index}"));
                        let minimum = attrs.get("min").and_then(|value| catalog_number(value));
                        let maximum = attrs.get("max").and_then(|value| catalog_number(value));
                        let options = split_text_list(attrs.get("stepNames"));
                        let x_values = number_list(attrs.get("xValues"));
                        let y_values = number_list(attrs.get("yValues"));
                        let scale_points =
                            if x_values.len() == y_values.len() && x_values.len() >= 2 {
                                x_values
                                    .into_iter()
                                    .zip(y_values)
                                    .map(|(normalized, real)| ScalePoint { normalized, real })
                                    .collect()
                            } else {
                                Vec::new()
                            };
                        let skew_raw = attrs.get("skew").map(String::as_str).unwrap_or("").trim();
                        let (value_scale, scale_exponent) = if !scale_points.is_empty() {
                            ("lookup".to_string(), None)
                        } else if !options.is_empty() {
                            ("options".to_string(), None)
                        } else if skew_raw == "LOG_SKEW" {
                            ("logarithmic".to_string(), None)
                        } else {
                            let skew = catalog_number(skew_raw).unwrap_or(1.0);
                            if (skew - 1.0).abs() <= f64::EPSILON {
                                ("linear".to_string(), None)
                            } else {
                                ("power".to_string(), Some(1.0 / skew))
                            }
                        };
                        let dummy =
                            kind.eq_ignore_ascii_case("empty") && raw_name.starts_with("DUMMY");
                        let scale_known = minimum.is_some()
                            && maximum.is_some()
                            && (value_scale != "logarithmic"
                                || minimum.is_some_and(|value| value > 0.0));
                        let display_position_raw =
                            attrs.get("displayPos").and_then(|value| value.parse().ok());
                        model.direct_parameters.push(ParameterSpec {
                            index,
                            name: raw_name.replace('_', " "),
                            r#type: kind.clone(),
                            minimum: if dummy { 0.0 } else { minimum.unwrap_or(0.0) },
                            maximum: if dummy { 1.0 } else { maximum.unwrap_or(1.0) },
                            scale_known: dummy || scale_known,
                            value_scale: if dummy {
                                "linear".into()
                            } else if scale_known {
                                value_scale
                            } else {
                                "unknown".into()
                            },
                            scale_exponent: if dummy { None } else { scale_exponent },
                            scale_points,
                            units: attrs.get("units").cloned().unwrap_or_default(),
                            steps: attrs
                                .get("steps")
                                .and_then(|value| value.parse().ok())
                                .filter(|value| *value > 0),
                            display_position: display_position_raw.unwrap_or(parameter_index),
                            display_position_raw,
                            screen_visible: true,
                            options,
                            hidden: attrs.contains_key("hidden") || dummy,
                            minimum_label: attrs.get("min_string").cloned(),
                            midpoint_label: attrs.get("mid_string").cloned(),
                            maximum_label: attrs.get("max_string").cloned(),
                            show_as_integer: attrs
                                .get("showAsInteger")
                                .is_some_and(|value| value.eq_ignore_ascii_case("true")),
                            expression_assignable: !attrs
                                .get("expAssignable")
                                .is_some_and(|value| value.eq_ignore_ascii_case("false")),
                            linked_scene_mode: attrs
                                .get("linkedSceneMode")
                                .and_then(|value| value.parse().ok()),
                            enable_when_on: attrs
                                .get("toggleOn")
                                .and_then(|value| value.parse().ok()),
                            enable_when_off: attrs
                                .get("toggleOff")
                                .and_then(|value| value.parse().ok()),
                            enable_when_steps: split_u32_list(attrs.get("toggleStep")),
                            replaces: replacement,
                        });
                        if replacement.is_none() {
                            parameter_index += 1;
                        }
                    }
                }
            }
            Ok(Event::End(event)) if event.local_name().as_ref() == b"Model" => current = None,
            Ok(Event::Eof) => break,
            Err(error) => return Err(StateDecodeError::CatalogXml(error.to_string())),
            _ => {}
        }
    }
    let ids = catalog.keys().copied().collect::<Vec<_>>();
    for id in ids {
        resolve_catalog_model(id, &mut catalog, &mut HashSet::new());
    }
    for (model_id, model) in &mut catalog {
        let has_explicit_layout = model
            .parameters
            .values()
            .any(|parameter| !parameter.hidden && parameter.display_position_raw.is_some());
        let mut implicit_position = 0;
        for parameter in model.parameters.values_mut() {
            let hidden = model.hidden || parameter.hidden;
            let trails = parameter.name.trim().eq_ignore_ascii_case("trails");
            parameter.screen_visible = !hidden
                && (!has_explicit_layout || parameter.display_position_raw.is_some() || trails);
            parameter.display_position =
                parameter.display_position_raw.unwrap_or(implicit_position);
            if *model_id == 4008 && parameter.index == 5 && parameter.display_position == 8 {
                parameter.display_position = 7;
            }
            parameter.hidden = hidden;
            if !hidden {
                implicit_position += 1;
            }
        }
    }
    Ok(catalog)
}

fn resolve_catalog_model(
    id: u32,
    catalog: &mut HashMap<u32, ModelInfo>,
    visiting: &mut HashSet<u32>,
) {
    if !visiting.insert(id) {
        return;
    }
    let clone_id = catalog.get(&id).and_then(|item| item.clone_id);
    if let Some(base) = clone_id {
        resolve_catalog_model(base, catalog, visiting);
        let inherited = catalog
            .get(&base)
            .map(|item| item.parameters.clone())
            .unwrap_or_default();
        if let Some(item) = catalog.get_mut(&id) {
            item.parameters = inherited;
        }
    }
    if let Some(item) = catalog.get_mut(&id) {
        let mut next = item
            .parameters
            .keys()
            .next_back()
            .map(|value| value + 1)
            .unwrap_or(0);
        for direct in item.direct_parameters.clone() {
            let target = direct.replaces.unwrap_or_else(|| {
                let value = next;
                next += 1;
                value
            });
            let mut resolved = direct;
            resolved.index = target;
            item.parameters.insert(target, resolved);
        }
    }
    visiting.remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::{
        binary_preset, chain, col_bypass, model, param, param_value, Bypass, Chain, ColBypass,
        Param, ParamValue, SceneBypass, StompModeAssignment,
    };

    fn numeric_param(index: u32, value: f32) -> Param {
        Param {
            index: Some(param::Index::Index(index)),
            param_values: vec![ParamValue {
                value: Some(param_value::Value::FloatValue(value)),
            }],
            ..Default::default()
        }
    }

    #[test]
    fn normalizes_full_preset_and_live_updates() {
        let mut midi_messages_general_v2 = vec![crate::proto::MidiMessageInfo::default(); 120];
        midi_messages_general_v2[12] = crate::proto::MidiMessageInfo {
            r#type: 1,
            channel: 3,
            param1: 10,
            param2: 64,
            param3: 0,
        };
        let preset = BinaryPreset {
            name: Some(binary_preset::Name::Name("Shared Decoder".into())),
            tempo: Some(binary_preset::Tempo::Tempo(99)),
            scene_labels: vec!["Clean".into()],
            scene_colors: vec![0xff00aa],
            chains: vec![Chain {
                row: Some(chain::Row::Row(0)),
                in_portid: Some(chain::InPortid::InPortid(1)),
                out_portid: Some(chain::OutPortid::OutPortid(2)),
                models: vec![Model {
                    hash: Some(model::Hash::Hash(1234)),
                    column: Some(model::Column::Column(3)),
                    params: vec![numeric_param(7, 0.25)],
                    bypass_expression: vec![crate::proto::Expression {
                        expression: 2,
                        expression_min: 0.0,
                        expression_max: 1.0,
                    }],
                    expression_bypass_info: vec![crate::proto::ExpressionBypassInfo {
                        r#type: 1,
                        invert: true,
                        delay_ms: 300,
                        latch_emulation: false,
                    }],
                    ..Default::default()
                }],
                input_control: vec![Model {
                    hash: Some(model::Hash::Hash(28_000)),
                    params: vec![numeric_param(0, 0.35)],
                    ..Default::default()
                }],
                output_control: vec![Model {
                    hash: Some(model::Hash::Hash(23_000)),
                    params: vec![numeric_param(1, 0.6)],
                    ..Default::default()
                }],
                mix_bypass: vec![SceneBypass { bypass: true }; 8],
                ..Default::default()
            }],
            bypass: vec![Bypass {
                row: Some(bypass::Row::Row(9)),
                col_bypass: vec![
                    ColBypass::default(),
                    ColBypass::default(),
                    ColBypass::default(),
                    ColBypass {
                        column: Some(col_bypass::Column::Column(7)),
                        scene_bypass: vec![SceneBypass { bypass: true }],
                        ..Default::default()
                    },
                ],
            }],
            stomp_mode_assignments: vec![StompModeAssignment {
                row: 0,
                column: 3,
                stomp_index: 4,
            }],
            single_stomp_labels: HashMap::from([(4, "Gate".into())]),
            stomp_is_momentary: HashMap::from([(4, true)]),
            midi_messages_general_v2,
            midi_messages: vec![crate::proto::MidiMessageInfo {
                r#type: 3,
                channel: 5,
                param1: 1,
                param2: 2,
                param3: 7,
            }],
            ..Default::default()
        };
        let raw = pa::RecallPresetMessage {
            preset: Some(pa::recall_preset_message::Preset::Preset(preset)),
            ..Default::default()
        }
        .encode_to_vec();
        let mut decoder = StateDecoder::new();
        let states = decoder.decode(15, &raw).unwrap();
        assert!(
            (decoder
                .lane_control_details(0, "inputGate")
                .unwrap()
                .parameters[0]
                .normalized_value
                .unwrap()
                - 0.35)
                .abs()
                < 1e-6
        );
        assert!(
            (decoder
                .lane_control_details(0, "laneOutput")
                .unwrap()
                .parameters[0]
                .normalized_value
                .unwrap()
                - 0.6)
                .abs()
                < 1e-6
        );
        assert_eq!(states[0].preset_name.as_deref(), Some("Shared Decoder"));
        assert_eq!(states[0].blocks.as_ref().unwrap()[0].column, 3);
        assert_eq!(states[0].blocks.as_ref().unwrap()[0].bypassed, Some(true));
        let bypass_expression = states[0].blocks.as_ref().unwrap()[0]
            .bypass_expression
            .as_ref()
            .unwrap();
        assert_eq!(bypass_expression.pedal, 2);
        assert_eq!(bypass_expression.mode, 1);
        assert!(bypass_expression.invert);
        assert_eq!(bypass_expression.delay_ms, 300);
        assert_eq!(
            states[0].blocks.as_ref().unwrap()[0].footswitch_order,
            Some(0)
        );
        assert_eq!(states[0].routes.as_ref().unwrap()[0].input, "In 1");
        assert!(states[0].routes.as_ref().unwrap()[0].split_muted);
        let footswitch = &states[0].footswitch_states.as_ref().unwrap()[4];
        assert!(footswitch.assigned);
        assert!(footswitch.momentary.unwrap());
        assert_eq!(footswitch.label.as_deref(), Some("Gate"));
        assert_eq!(states[0].midi_out.as_ref().unwrap()[0].source, 1);
        assert_eq!(
            states[0].midi_out.as_ref().unwrap()[0].messages[0].param1,
            10
        );
        assert_eq!(
            states[0].preset_load_midi_out.as_ref().unwrap()[0].param3,
            7
        );
        assert_eq!(
            decoder.block_details(0, 3).unwrap().parameters[0].normalized_value,
            Some(0.25)
        );

        let scene = pa::SceneMessage {
            selected_scene: Some(pa::scene_message::SelectedScene::SelectedScene(6)),
            ..Default::default()
        }
        .encode_to_vec();
        assert_eq!(decoder.decode(13, &scene).unwrap()[0].active_scene, Some(6));
        let dirty = pa::PresetDirtyMessage {
            is_dirty: true,
            ..Default::default()
        }
        .encode_to_vec();
        assert_eq!(decoder.decode(34, &dirty).unwrap()[0].dirty, Some(true));
    }

    #[test]
    fn normalized_json_matches_the_shared_typescript_contract() {
        let mode = pa::ModeMessage {
            mode: Some(pa::mode_message::Mode::Mode(6)),
            available_modes: Some(pa::mode_message::AvailableModes::AvailableModes(
                pa::AvailableModes {
                    modes: vec![0, 1, 6],
                },
            )),
            ..Default::default()
        };
        let states = StateDecoder::new()
            .decode(14, &mode.encode_to_vec())
            .unwrap();
        let json = serde_json::to_value(&states[0]).unwrap();
        assert_eq!(json["kind"], "mode");
        assert_eq!(json["mode"], "HYBRID");
        assert_eq!(json["modeSlots"][2]["label"], "SCENE / STOMP");
        assert!(json.get("activeScene").is_none());
    }

    #[test]
    fn decodes_physical_io_presence_from_native_io_settings() {
        let payload = pa::IoSettingsMessage {
            action: pa::message_action::Enum::Update as i32,
            settings: Some(pa::io_settings_message::Settings::Settings(
                pa::PortSettings {
                    in_port: vec![pa::InputPortSettings {
                        input_port_id: 1,
                        plugged: Some(pa::input_port_settings::Plugged::Plugged(true)),
                        ..Default::default()
                    }],
                    out_port: vec![pa::OutputPortSettings {
                        output_port_id: 4,
                        plugged: Some(pa::output_port_settings::Plugged::Plugged(false)),
                        ..Default::default()
                    }],
                    hp_port: Some(pa::port_settings::HpPort::HpPort(pa::HeadphonesSettings {
                        plugged: Some(pa::headphones_settings::Plugged::Plugged(true)),
                        ..Default::default()
                    })),
                    usb_port: Some(pa::port_settings::UsbPort::UsbPort(pa::UsbPortSettings {
                        plugged: Some(pa::usb_port_settings::Plugged::Plugged(true)),
                        ..Default::default()
                    })),
                    exp_port: vec![pa::ExpPortSettings {
                        exp_port_id: 0,
                        plugged: Some(pa::exp_port_settings::Plugged::Plugged(false)),
                        ..Default::default()
                    }],
                    ..Default::default()
                },
            )),
            ..Default::default()
        }
        .encode_to_vec();

        let states = StateDecoder::new().decode(3, &payload).unwrap();
        let ports = states[0].io_ports.as_ref().unwrap();
        assert_eq!(states[0].kind, "ioPorts");
        assert!(ports
            .iter()
            .any(|port| port.kind == "input" && port.id == 1 && port.plugged));
        assert!(ports
            .iter()
            .any(|port| port.kind == "output" && port.id == 4 && !port.plugged));
        assert!(ports
            .iter()
            .any(|port| port.kind == "headphones" && port.plugged));
        assert!(ports.iter().any(|port| port.kind == "usb" && port.plugged));
        assert!(ports
            .iter()
            .any(|port| port.kind == "expression" && port.label == "EXP 1"));
    }

    #[test]
    fn decodes_preset_folder_pushes_for_the_background_library() {
        let payload = pa::FileMessage {
            action: pa::message_action::Enum::Update as i32,
            folder: Some(pa::file_message::Folder::Folder(pa::FolderInfo {
                key: Some(pa::folder_info::Key::Key("/media/p4/Presets/Live".into())),
                name: Some(pa::folder_info::Name::Name("Live".into())),
                files: vec![pa::ProductData {
                    index: Some(pa::product_data::Index::Index(17)),
                    name: Some(pa::product_data::Name::Name("Direct Rust".into())),
                    instrument: Some(pa::product_data::Instrument::Instrument(1)),
                    ..Default::default()
                }],
                ..Default::default()
            })),
            ..Default::default()
        }
        .encode_to_vec();
        let folder = decode_preset_folder(&payload).unwrap().unwrap();
        assert_eq!(folder.key, "/media/p4/Presets/Live");
        assert_eq!(folder.files[0].position, 17);
        assert_eq!(folder.files[0].name, "Direct Rust");
    }

    #[test]
    fn model_repo_metadata_and_clone_replacements_drive_block_details() {
        let xml = br#"<Models><Category name="Drive">
          <Model id="100" name="Base Drive">
            <Parameter name="GAIN" type="float" min="0" max="10" displayPos="1" />
            <Parameter name="DUMMY SLOT" type="empty" hidden="true" />
            <Parameter name="RATE" type="float" min="0.1" max="10" skew="2" units="Hz" displayPos="3" min_string="Slow" max_string="Fast" expAssignable="false" linkedSceneMode="4" toggleOn="0" />
          </Model>
          <Model id="101" name="Child Drive" clones="100">
            <Parameter name="MODE" type="rotarySwitch" min="0" max="1" steps="2" stepNames="Off,On" displayPos="4" replaces="0" />
          </Model>
        </Category></Models>"#;
        let repo = pa::ModelRepoMessage {
            action: pa::message_action::Enum::Update as i32,
            request_id: None,
            model_repo_payload: Some(pa::model_repo_message::ModelRepoPayload::ModelRepoPayload(
                xml.to_vec(),
            )),
        };
        let catalog = parse_model_repo(&repo.encode_to_vec()).unwrap();
        assert_eq!(catalog.0.len(), 2);
        assert_eq!(catalog.0[&101].parameters[&0].name, "MODE");
        assert_eq!(catalog.0[&101].parameters[&0].options, ["Off", "On"]);

        let preset = BinaryPreset {
            name: Some(binary_preset::Name::Name("Catalog Test".into())),
            chains: vec![Chain {
                row: Some(chain::Row::Row(0)),
                models: vec![Model {
                    hash: Some(model::Hash::Hash(101)),
                    column: Some(model::Column::Column(2)),
                    params: vec![
                        Param {
                            index: Some(param::Index::Index(0)),
                            param_values: vec![ParamValue {
                                value: Some(param_value::Value::StringValue("On".into())),
                            }],
                            ..Default::default()
                        },
                        numeric_param(1, 0.0),
                        Param {
                            index: Some(param::Index::Index(2)),
                            param_values: vec![ParamValue {
                                value: Some(param_value::Value::FloatValue(0.5)),
                            }],
                            expression: Some(param::Expression::Expression(2)),
                            expression_min: Some(param::ExpressionMin::ExpressionMin(0.1)),
                            expression_max: Some(param::ExpressionMax::ExpressionMax(0.9)),
                            ..Default::default()
                        },
                    ],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let mut decoder = StateDecoder::new();
        decoder.install_catalog(catalog);
        decoder
            .decode(
                15,
                &pa::RecallPresetMessage {
                    preset: Some(pa::recall_preset_message::Preset::Preset(preset)),
                    ..Default::default()
                }
                .encode_to_vec(),
            )
            .unwrap();
        let details = decoder.block_details(0, 2).unwrap();
        assert_eq!(details.name, "Child Drive");
        assert_eq!(details.category, "Drive");
        assert_eq!(details.parameters.len(), 2);
        assert_eq!(details.parameters[0].display_position, 4);
        assert_eq!(details.parameters[0].normalized_value, Some(1.0));
        assert_eq!(details.parameters[0].wire_value_kind, "text");
        let rate = &details.parameters[1];
        assert_eq!(rate.value_scale, "power");
        assert_eq!(rate.scale_exponent, Some(0.5));
        assert_eq!(rate.display_precision, Some(2));
        assert_eq!(rate.display_value, "7.10");
        assert!(!rate.expression_assignable);
        assert_eq!(rate.linked_scene_mode, Some(4));
        assert_eq!(rate.expression, Some(2));
        assert_eq!(rate.expression_minimum, Some(0.1));
        assert_eq!(rate.expression_maximum, Some(0.9));
    }
}
