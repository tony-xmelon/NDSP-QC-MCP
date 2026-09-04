//! Platform-neutral QC domain state used by both desktop and mobile hosts.
//! USB/HID ownership and host UI IPC remain in their platform adapters.

use qc_protocol::state::{
    FootswitchState, GridBlock, GridRoute, IoPortState, MidiOutMessage, MidiOutSource, ModeSlot,
    PresetFolderListing, StateUpdate,
};
use serde::Serialize;
use std::collections::HashMap;

pub mod request;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetEntry {
    pub position: u32,
    pub location: String,
    pub name: String,
    pub instrument: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetFolder {
    pub key: String,
    pub name: String,
    pub is_factory: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetList {
    pub setlist_key: String,
    pub setlist_name: String,
    pub current_position: i32,
    pub presets: Vec<PresetEntry>,
    pub folders: Vec<PresetFolder>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetSlot {
    pub position: u32,
    pub location: String,
    pub name: String,
    pub occupied: bool,
    pub instrument: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetSlotList {
    pub setlist_key: String,
    pub setlist_name: String,
    pub current_position: u32,
    pub slots: Vec<PresetSlot>,
}

#[derive(Debug, Default)]
pub struct PresetLibrary {
    listings: HashMap<String, PresetFolderListing>,
}

fn slot_name(position: u32) -> String {
    format!(
        "{}{}",
        position / 8 + 1,
        (b'A' + (position % 8) as u8) as char
    )
}

impl PresetLibrary {
    pub fn clear(&mut self) {
        self.listings.clear();
    }

    pub fn ingest(&mut self, listing: PresetFolderListing) {
        let key = listing.key.trim_end_matches('/').to_string();
        let replace = self
            .listings
            .get(&key)
            .is_none_or(|existing| listing.files.len() >= existing.files.len());
        if replace {
            self.listings.insert(key, listing);
        }
    }

    pub fn folders(&self) -> Vec<PresetFolder> {
        let mut folders = self
            .listings
            .values()
            .filter(|folder| {
                let key = folder.key.trim_end_matches('/');
                key == "/opt/neuraldsp/Factory Library"
                    || key
                        .rsplit_once('/')
                        .is_some_and(|(parent, _)| parent == "/media/p4/Presets")
            })
            .map(|folder| PresetFolder {
                key: folder.key.clone(),
                name: folder.name.clone(),
                is_factory: folder.is_factory
                    || folder.key.trim_end_matches('/') == "/opt/neuraldsp/Factory Library",
            })
            .collect::<Vec<_>>();
        folders.sort_by(|left, right| {
            left.is_factory.cmp(&right.is_factory).then_with(|| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            })
        });
        folders
    }

    pub fn list(&self, setlist_key: &str, active: &GatewaySnapshot) -> Option<PresetList> {
        let listing = self.listings.get(setlist_key.trim_end_matches('/'))?;
        let by_position = listing
            .files
            .iter()
            .map(|file| (file.position, file))
            .collect::<HashMap<_, _>>();
        let presets = (0..256)
            .map(|position| {
                let file = by_position.get(&position);
                PresetEntry {
                    position,
                    location: slot_name(position),
                    name: file
                        .filter(|file| !file.name.is_empty())
                        .map(|file| file.name.clone())
                        .unwrap_or_else(|| "Unsaved".into()),
                    instrument: file.map(|file| file.instrument).unwrap_or(0),
                }
            })
            .collect();
        Some(PresetList {
            setlist_key: listing.key.clone(),
            setlist_name: listing.name.clone(),
            current_position: if active.setlist_key.trim_end_matches('/')
                == setlist_key.trim_end_matches('/')
            {
                active.preset_position as i32
            } else {
                -1
            },
            presets,
            folders: self.folders(),
        })
    }

    pub fn slots(&self, active: &GatewaySnapshot) -> Option<PresetSlotList> {
        let list = self.list(&active.setlist_key, active)?;
        Some(PresetSlotList {
            setlist_key: list.setlist_key,
            setlist_name: list.setlist_name,
            current_position: active.preset_position,
            slots: list
                .presets
                .into_iter()
                .map(|entry| PresetSlot {
                    position: entry.position,
                    location: entry.location,
                    occupied: entry.name != "Unsaved",
                    name: if entry.name == "Unsaved" {
                        String::new()
                    } else {
                        entry.name
                    },
                    instrument: entry.instrument,
                })
                .collect(),
        })
    }

    pub fn writable_slots(
        &self,
        active: &GatewaySnapshot,
    ) -> Result<Option<PresetSlotList>, String> {
        if active.setlist_key.starts_with("/opt/") {
            return Err(
                "Factory Library is read-only. Recall a user setlist before saving.".into(),
            );
        }
        Ok(self.slots(active))
    }

    pub fn entry(&self, setlist_key: &str, position: u32) -> Option<PresetEntry> {
        let listing = self.listings.get(setlist_key.trim_end_matches('/'))?;
        let file = listing
            .files
            .iter()
            .find(|file| file.position == position)?;
        (!file.name.is_empty()).then(|| PresetEntry {
            position,
            location: slot_name(position),
            name: file.name.clone(),
            instrument: file.instrument,
        })
    }

    pub fn record_saved(&mut self, setlist_key: &str, position: u32, name: &str, instrument: i32) {
        let Some(listing) = self.listings.get_mut(setlist_key.trim_end_matches('/')) else {
            return;
        };
        if let Some(file) = listing
            .files
            .iter_mut()
            .find(|file| file.position == position)
        {
            file.name = name.into();
            file.instrument = instrument;
        } else {
            listing.files.push(qc_protocol::state::PresetFileListing {
                position,
                name: name.into(),
                instrument,
            });
            listing.files.sort_by_key(|file| file.position);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySnapshot {
    pub device_name: String,
    pub preset_name: String,
    pub preset_location: String,
    pub preset_position: u32,
    pub setlist_key: String,
    pub setlist_name: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_slots: Option<Vec<ModeSlot>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footswitch_modes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footswitch_states: Option<Vec<FootswitchState>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub midi_out: Option<Vec<MidiOutSource>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_load_midi_out: Option<Vec<MidiOutMessage>>,
    pub active_scene: u32,
    pub scenes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_colors: Option<Vec<String>>,
    pub blocks: Vec<GridBlock>,
    pub routes: Vec<GridRoute>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub io_ports: Option<Vec<IoPortState>>,
    pub tempo: u32,
    pub tempo_led_enabled: bool,
    pub master_volume: u32,
    pub dirty: bool,
    #[serde(skip)]
    pub has_preset: bool,
    #[serde(skip)]
    pub position_revision: u64,
    #[serde(skip)]
    pub preset_revision: u64,
}

impl Default for GatewaySnapshot {
    fn default() -> Self {
        Self {
            device_name: "Quad Cortex".into(),
            preset_name: "Unsaved".into(),
            preset_location: "1A".into(),
            preset_position: 0,
            setlist_key: String::new(),
            setlist_name: String::new(),
            mode: "STOMP".into(),
            mode_slots: None,
            footswitch_modes: None,
            footswitch_states: None,
            midi_out: None,
            preset_load_midi_out: None,
            active_scene: 0,
            scenes: (b'A'..=b'H')
                .map(|letter| format!("Scene {}", letter as char))
                .collect(),
            scene_colors: None,
            blocks: Vec::new(),
            routes: Vec::new(),
            io_ports: None,
            tempo: 120,
            tempo_led_enabled: false,
            master_volume: 0,
            dirty: false,
            has_preset: false,
            position_revision: 0,
            preset_revision: 0,
        }
    }
}

impl GatewaySnapshot {
    pub fn apply(&mut self, state: &StateUpdate) {
        match state.kind.as_str() {
            "scene" => self.active_scene = state.active_scene.unwrap_or(self.active_scene),
            "dirty" => self.dirty = state.dirty.unwrap_or(self.dirty),
            "master" => {
                if let Some(value) = state.master_volume {
                    self.master_volume = (value.clamp(0.0, 1.0) * 100.0).round() as u32;
                }
            }
            "mode" => {
                if let Some(value) = &state.mode {
                    self.mode.clone_from(value);
                }
                if state.mode_slots.is_some() {
                    self.mode_slots.clone_from(&state.mode_slots);
                }
                if state.footswitch_modes.is_some() {
                    self.footswitch_modes.clone_from(&state.footswitch_modes);
                }
            }
            "sceneLabel" => {
                if let (Some(index), Some(label)) = (state.index, &state.label) {
                    if let Some(current) = self.scenes.get_mut(index as usize) {
                        current.clone_from(label);
                    }
                }
            }
            "sceneColor" => {
                if let (Some(index), Some(color)) = (state.index, &state.color) {
                    let colors = self
                        .scene_colors
                        .get_or_insert_with(|| vec![String::new(); 8]);
                    if let Some(current) = colors.get_mut(index as usize) {
                        current.clone_from(color);
                    }
                }
            }
            "position" => {
                self.position_revision = self.position_revision.wrapping_add(1);
                if let Some(position) = state.position {
                    self.preset_position = position;
                    self.preset_location = format!(
                        "{}{}",
                        position / 8 + 1,
                        (b'A' + (position % 8) as u8) as char
                    );
                }
                if let Some(key) = &state.setlist_key {
                    self.setlist_key.clone_from(key);
                    self.setlist_name = key
                        .trim_end_matches('/')
                        .rsplit('/')
                        .next()
                        .unwrap_or_default()
                        .into();
                }
            }
            "preset" => {
                self.has_preset = true;
                self.preset_revision = self.preset_revision.wrapping_add(1);
                if !state.catalog_refresh.unwrap_or(false) {
                    self.dirty = false;
                }
                if let Some(value) = &state.preset_name {
                    self.preset_name = if value.is_empty() {
                        "Unsaved".into()
                    } else {
                        value.clone()
                    };
                }
                if let Some(value) = state.tempo {
                    self.tempo = value;
                }
                if let Some(value) = state.tempo_led_enabled {
                    self.tempo_led_enabled = value;
                }
                if let Some(value) = &state.scenes {
                    self.scenes.clone_from(value);
                }
                if let Some(value) = &state.scene_colors {
                    self.scene_colors = Some(value.clone());
                }
                if let Some(value) = &state.footswitch_states {
                    self.footswitch_states = Some(value.clone());
                }
                if let Some(value) = &state.midi_out {
                    self.midi_out = Some(value.clone());
                }
                if let Some(value) = &state.preset_load_midi_out {
                    self.preset_load_midi_out = Some(value.clone());
                }
                if let Some(value) = &state.blocks {
                    self.blocks.clone_from(value);
                }
                if let Some(value) = &state.routes {
                    self.routes.clone_from(value);
                }
            }
            "tempo" => {
                if let Some(value) = state.tempo {
                    self.tempo = value;
                }
                if let Some(value) = state.tempo_led_enabled {
                    self.tempo_led_enabled = value;
                }
            }
            "ioPorts" => {
                if let Some(updates) = &state.io_ports {
                    let ports = self.io_ports.get_or_insert_with(Vec::new);
                    for update in updates {
                        if let Some(current) = ports
                            .iter_mut()
                            .find(|port| port.kind == update.kind && port.id == update.id)
                        {
                            current.clone_from(update);
                        } else {
                            ports.push(update.clone());
                        }
                    }
                }
            }
            "bypass" => {
                if let (Some(row), Some(column), Some(bypassed)) =
                    (state.row, state.column, state.bypassed)
                {
                    if let Some(block) = self
                        .blocks
                        .iter_mut()
                        .find(|block| block.row == row && block.column == column)
                    {
                        block.bypassed = Some(bypassed);
                    }
                }
            }
            "bypassBatch" => {
                for update in state.bypass_updates.iter().flatten() {
                    if let Some(block) = self
                        .blocks
                        .iter_mut()
                        .find(|block| block.row == update.row && block.column == update.column)
                    {
                        block.bypassed = Some(update.bypassed);
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduces_native_updates_to_the_app_snapshot_contract() {
        let mut snapshot = GatewaySnapshot::default();
        let mut position = StateUpdate::empty("position");
        position.position = Some(17);
        position.setlist_key = Some("/media/p4/Presets/Live/".into());
        snapshot.apply(&position);
        let mut preset = StateUpdate::empty("preset");
        preset.preset_name = Some("Direct Rust".into());
        preset.tempo = Some(96);
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

    #[test]
    fn preserves_a_nonempty_guard_name_for_unsaved_presets() {
        let mut snapshot = GatewaySnapshot::default();
        let mut preset = StateUpdate::empty("preset");
        preset.preset_name = Some(String::new());
        snapshot.apply(&preset);

        assert_eq!(snapshot.preset_name, "Unsaved");
    }

    #[test]
    fn merges_partial_io_pushes_without_losing_other_port_states() {
        let mut snapshot = GatewaySnapshot::default();
        let mut inputs = StateUpdate::empty("ioPorts");
        inputs.io_ports = Some(vec![IoPortState {
            kind: "input".into(),
            id: 1,
            label: "In 1".into(),
            plugged: true,
        }]);
        snapshot.apply(&inputs);

        let mut output = StateUpdate::empty("ioPorts");
        output.io_ports = Some(vec![IoPortState {
            kind: "output".into(),
            id: 4,
            label: "Out 1".into(),
            plugged: false,
        }]);
        snapshot.apply(&output);

        let ports = snapshot.io_ports.as_ref().unwrap();
        assert_eq!(ports.len(), 2);
        assert!(ports
            .iter()
            .any(|port| port.kind == "input" && port.plugged));
        assert!(ports
            .iter()
            .any(|port| port.kind == "output" && !port.plugged));
    }

    #[test]
    fn preset_library_expands_device_listings_to_all_qc_slots() {
        let mut library = PresetLibrary::default();
        library.ingest(PresetFolderListing {
            key: "/media/p4/Presets/Live".into(),
            name: "Live".into(),
            is_factory: false,
            files: vec![qc_protocol::state::PresetFileListing {
                position: 17,
                name: "Direct Rust".into(),
                instrument: 1,
            }],
        });
        let snapshot = GatewaySnapshot {
            setlist_key: "/media/p4/Presets/Live".into(),
            preset_position: 17,
            ..GatewaySnapshot::default()
        };
        let list = library.list(&snapshot.setlist_key, &snapshot).unwrap();
        assert_eq!(list.presets.len(), 256);
        assert_eq!(list.presets[17].location, "3B");
        assert_eq!(list.presets[17].name, "Direct Rust");
        assert_eq!(list.current_position, 17);
    }

    #[test]
    fn writable_preset_slots_reject_the_factory_library_once() {
        let library = PresetLibrary::default();
        let factory = GatewaySnapshot {
            setlist_key: "/opt/neuraldsp/Factory Library".into(),
            ..GatewaySnapshot::default()
        };
        assert!(library.writable_slots(&factory).is_err());
    }
}
