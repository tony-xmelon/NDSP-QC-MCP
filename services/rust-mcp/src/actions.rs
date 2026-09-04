use rmcp::model::{JsonObject, Tool, ToolAnnotations};
use serde_json::{Map, Value, json};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Classification {
    Read,
    LiveWrite,
    PersistentWrite,
    RiskyWrite,
}

#[derive(Clone, Copy, Debug)]
pub enum Kind {
    String,
    VisibleString { max_chars: usize },
    NullableString,
    NullableInteger { min: i64, max: Option<i64> },
    Boolean,
    Integer { min: i64, max: Option<i64> },
    Number { min: f64, max: Option<f64> },
    MidiMessages,
}

#[derive(Clone, Copy, Debug)]
pub struct Property {
    pub name: &'static str,
    pub kind: Kind,
    pub required: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct ActionSpec {
    pub name: &'static str,
    pub rpc: &'static str,
    pub classification: Classification,
    pub description: &'static str,
    pub properties: &'static [Property],
}

macro_rules! p {
    ($name:literal, $kind:expr) => {
        Property {
            name: $name,
            kind: $kind,
            required: true,
        }
    };
    (? $name:literal, $kind:expr) => {
        Property {
            name: $name,
            kind: $kind,
            required: false,
        }
    };
}
const TEXT: Kind = Kind::String;
const BOOL: Kind = Kind::Boolean;
const UINT: Kind = Kind::Integer { min: 0, max: None };
const GRID_ROW: Kind = Kind::Integer {
    min: 0,
    max: Some(3),
};
const GRID_COLUMN: Kind = Kind::Integer {
    min: 0,
    max: Some(7),
};
const PARAMETER_COLUMN: Kind = Kind::Integer {
    min: 0,
    max: Some(9),
};
const SCENE: Kind = Kind::Integer {
    min: 0,
    max: Some(7),
};
const TEMPO: Kind = Kind::Integer {
    min: 40,
    max: Some(240),
};
const PERCENT: Kind = Kind::Integer {
    min: 0,
    max: Some(100),
};
const NORMALIZED: Kind = Kind::Number {
    min: 0.0,
    max: Some(1.0),
};
const PEDAL: Kind = Kind::Integer {
    min: 1,
    max: Some(2),
};
const EXPRESSION_SWITCH_MODE: Kind = Kind::Integer {
    min: 0,
    max: Some(2),
};
const BYPASS_DELAY: Kind = Kind::Integer {
    min: 0,
    max: Some(5000),
};

// Static output of contracts/qc-actions.v1.json plus safety fields retained from the
// Python compatibility oracle. A parity test prevents silent drift.
pub static ACTIONS: &[ActionSpec] = &[
    ActionSpec {
        name: "reconnect_device",
        rpc: "device.reconnect",
        classification: Classification::RiskyWrite,
        description: "Reconnect the native Quad Cortex transport after explicit confirmation.",
        properties: &[p!("confirm_risky_operation", BOOL)],
    },
    ActionSpec {
        name: "reset_device_session",
        rpc: "device.resetSession",
        classification: Classification::RiskyWrite,
        description: "Reset and re-synchronize the native Quad Cortex communication session after explicit confirmation.",
        properties: &[p!("confirm_risky_operation", BOOL)],
    },
    ActionSpec {
        name: "disconnect_device",
        rpc: "device.disconnect",
        classification: Classification::RiskyWrite,
        description: "Close the native Quad Cortex transport after explicit confirmation.",
        properties: &[p!("confirm_risky_operation", BOOL)],
    },
    ActionSpec {
        name: "get_current_preset",
        rpc: "device.snapshot",
        classification: Classification::Read,
        description: "Read the authoritative current preset, scene, tempo and Grid state.",
        properties: &[],
    },
    ActionSpec {
        name: "get_state_events",
        rpc: "device.stateEvents",
        classification: Classification::Read,
        description: "Read native state frames after a sequence cursor.",
        properties: &[p!("after_sequence", UINT), p!("limit", UINT)],
    },
    ActionSpec {
        name: "get_tempo_clock",
        rpc: "device.tempoClock",
        classification: Classification::Read,
        description: "Read the most recent native metronome beat, bar and tick state.",
        properties: &[],
    },
    ActionSpec {
        name: "get_block_details",
        rpc: "device.blockDetails",
        classification: Classification::Read,
        description: "Read live parameters for one occupied Grid block.",
        properties: &[
            p!("row", GRID_ROW),
            p!("column", PARAMETER_COLUMN),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "get_lane_control_details",
        rpc: "device.laneControlDetails",
        classification: Classification::Read,
        description: "Read the Input Gate or Lane Output parameters attached to a signal row.",
        properties: &[
            p!("row", GRID_ROW),
            p!("control", TEXT),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "list_models",
        rpc: "device.listModels",
        classification: Classification::Read,
        description: "Find installed block models and their numeric IDs.",
        properties: &[p!("query", Kind::NullableString)],
    },
    ActionSpec {
        name: "list_presets",
        rpc: "device.listPresets",
        classification: Classification::Read,
        description: "List presets in a setlist, optionally refreshing the device index.",
        properties: &[p!("refresh", BOOL), p!("setlist_key", Kind::NullableString)],
    },
    ActionSpec {
        name: "list_preset_folders",
        rpc: "device.listPresetFolders",
        classification: Classification::Read,
        description: "List preset folders and setlists, optionally refreshing the device index.",
        properties: &[p!("refresh", BOOL)],
    },
    ActionSpec {
        name: "list_preset_slots",
        rpc: "device.listPresetSlots",
        classification: Classification::Read,
        description: "List preset destinations and their occupancy before a persistent write.",
        properties: &[],
    },
    ActionSpec {
        name: "get_master_volume",
        rpc: "device.masterVolume",
        classification: Classification::Read,
        description: "Read the authoritative master output volume.",
        properties: &[],
    },
    ActionSpec {
        name: "get_device_identity",
        rpc: "device.identity",
        classification: Classification::Read,
        description: "Read the connected Quad Cortex serial number, firmware version, type and custom name.",
        properties: &[],
    },
    ActionSpec {
        name: "get_inhibited_modules",
        rpc: "device.inhibitedModules",
        classification: Classification::Read,
        description: "Read the authoritative Global Gate and Global EQ inhibition state.",
        properties: &[],
    },
    ActionSpec {
        name: "get_tuner_settings",
        rpc: "device.tunerSettings",
        classification: Classification::Read,
        description: "Read the tuner input, mute preference, and reference pitch without engaging it.",
        properties: &[],
    },
    ActionSpec {
        name: "get_preset_screenshot",
        rpc: "device.presetScreenshot",
        classification: Classification::Read,
        description: "Read the PNG thumbnail stored for a preset.",
        properties: &[
            p!("folder_name", TEXT),
            p!("position", UINT),
            p!("is_factory", BOOL),
        ],
    },
    ActionSpec {
        name: "capture_screen",
        rpc: "device.captureScreen",
        classification: Classification::Read,
        description: "Capture the current Quad Cortex touchscreen as a PNG image.",
        properties: &[],
    },
    ActionSpec {
        name: "preview_parameter",
        rpc: "device.previewParameter",
        classification: Classification::LiveWrite,
        description: "Preview a block parameter value without waiting for device verification.",
        properties: &[
            p!("row", GRID_ROW),
            p!("column", PARAMETER_COLUMN),
            p!("parameter_index", UINT),
            p!("value", NORMALIZED),
            p!("expected_value", NORMALIZED),
            p!("expected_scene", SCENE),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "preview_lane_control_parameter",
        rpc: "device.previewLaneControlParameter",
        classification: Classification::LiveWrite,
        description: "Preview an Input Gate or Lane Output parameter without waiting for device verification.",
        properties: &[
            p!("row", GRID_ROW),
            p!("control", TEXT),
            p!("parameter_index", UINT),
            p!("value", NORMALIZED),
            p!("expected_value", NORMALIZED),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "create_device_backup",
        rpc: "device.createBackup",
        classification: Classification::PersistentWrite,
        description: "Create a complete local device backup after explicit confirmation.",
        properties: &[
            p!("name", Kind::VisibleString { max_chars: 64 }),
            p!("confirm_persistent_write", BOOL),
        ],
    },
    ActionSpec {
        name: "set_device_name",
        rpc: "device.setDeviceName",
        classification: Classification::PersistentWrite,
        description: "Change the Quad Cortex custom name after explicit confirmation.",
        properties: &[
            p!("name", Kind::VisibleString { max_chars: 64 }),
            p!("confirm_persistent_write", BOOL),
        ],
    },
    ActionSpec {
        name: "undo_device",
        rpc: "device.undo",
        classification: Classification::RiskyWrite,
        description: "Undo the most recent device edit after explicit confirmation.",
        properties: &[p!("confirm_risky_operation", BOOL)],
    },
    ActionSpec {
        name: "redo_device",
        rpc: "device.redo",
        classification: Classification::RiskyWrite,
        description: "Redo the most recently undone device edit after explicit confirmation.",
        properties: &[p!("confirm_risky_operation", BOOL)],
    },
    ActionSpec {
        name: "tap_screen",
        rpc: "device.tapScreen",
        classification: Classification::RiskyWrite,
        description: "Tap an exact touchscreen pixel after reviewing a fresh screen capture and explicitly confirming the action.",
        properties: &[
            p!(
                "x",
                Kind::Integer {
                    min: 0,
                    max: Some(799)
                }
            ),
            p!(
                "y",
                Kind::Integer {
                    min: 0,
                    max: Some(479)
                }
            ),
            p!("confirm_risky_operation", BOOL),
        ],
    },
    ActionSpec {
        name: "select_scene",
        rpc: "device.selectScene",
        classification: Classification::LiveWrite,
        description: "Immediately select a performance scene, numbered 0 through 7.",
        properties: &[p!("scene", SCENE), p!("expected_preset_name", TEXT)],
    },
    ActionSpec {
        name: "copy_scene",
        rpc: "device.copyScene",
        classification: Classification::LiveWrite,
        description: "Copy or swap two scenes in the current preset and verify the resulting scene state.",
        properties: &[
            p!("from_scene", SCENE),
            p!("to_scene", SCENE),
            p!("swap", BOOL),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_scene_label",
        rpc: "device.setSceneLabel",
        classification: Classification::LiveWrite,
        description: "Set or clear the label of one scene in the current preset.",
        properties: &[
            p!("scene", SCENE),
            p!("label", Kind::NullableString),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_scene_color",
        rpc: "device.setSceneColor",
        classification: Classification::LiveWrite,
        description: "Set the display color of one scene in the current preset.",
        properties: &[
            p!("scene", SCENE),
            p!(
                "color",
                Kind::Integer {
                    min: 0,
                    max: Some(u32::MAX as i64)
                }
            ),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "press_footswitch",
        rpc: "device.pressFootswitch",
        classification: Classification::LiveWrite,
        description: "Press a physical Quad Cortex footswitch by its stable hardware index.",
        properties: &[
            p!(
                "index",
                Kind::Integer {
                    min: 0,
                    max: Some(10)
                }
            ),
            p!("expected_mode", TEXT),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "tap_tempo",
        rpc: "device.tapTempo",
        classification: Classification::LiveWrite,
        description: "Tap the dedicated Quad Cortex tempo control through its official MIDI command.",
        properties: &[p!("expected_mode", TEXT), p!("expected_preset_name", TEXT)],
    },
    ActionSpec {
        name: "navigate_bank",
        rpc: "device.navigateBank",
        classification: Classification::LiveWrite,
        description: "Immediately navigate one performance bank down (-1) or up (1).",
        properties: &[
            p!(
                "direction",
                Kind::Integer {
                    min: -1,
                    max: Some(1)
                }
            ),
            p!("expected_preset_name", TEXT),
            p!("expected_position", UINT),
        ],
    },
    ActionSpec {
        name: "show_tuner",
        rpc: "device.showTuner",
        classification: Classification::LiveWrite,
        description: "Show or hide the tuner.",
        properties: &[p!("shown", BOOL)],
    },
    ActionSpec {
        name: "show_gig_view",
        rpc: "device.showGigView",
        classification: Classification::LiveWrite,
        description: "Show or hide Gig View.",
        properties: &[p!("shown", BOOL)],
    },
    ActionSpec {
        name: "select_mode_slot",
        rpc: "device.selectModeSlot",
        classification: Classification::LiveWrite,
        description: "Select device-configured performance Mode Slot A, B, or C.",
        properties: &[
            p!(
                "slot",
                Kind::Integer {
                    min: 0,
                    max: Some(2)
                }
            ),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_master_volume",
        rpc: "device.setMasterVolume",
        classification: Classification::RiskyWrite,
        description: "Set master output volume after explicit user confirmation and stale-value validation.",
        properties: &[
            p!("value", PERCENT),
            p!("expected_value", PERCENT),
            p!("confirm_risky_operation", BOOL),
        ],
    },
    ActionSpec {
        name: "recall_preset",
        rpc: "device.recallPreset",
        classification: Classification::LiveWrite,
        description: "Immediately recall a preset by setlist key and position.",
        properties: &[
            p!("setlist_key", TEXT),
            p!("position", UINT),
            p!("expected_preset_name", TEXT),
            p!("expected_position", UINT),
        ],
    },
    ActionSpec {
        name: "reload_preset",
        rpc: "device.reloadPreset",
        classification: Classification::RiskyWrite,
        description: "Discard unsaved edits and reload the active preset after explicit host confirmation.",
        properties: &[
            p!("expected_preset_name", TEXT),
            p!("expected_position", UINT),
            p!("confirm_risky_operation", BOOL),
        ],
    },
    ActionSpec {
        name: "set_tempo",
        rpc: "device.setTempo",
        classification: Classification::LiveWrite,
        description: "Immediately set performance tempo from 40 through 240 BPM.",
        properties: &[
            p!("bpm", TEMPO),
            p!("expected_tempo", TEMPO),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_bypass",
        rpc: "device.toggleBypass",
        classification: Classification::LiveWrite,
        description: "Immediately enable or bypass one Grid block and verify device readback.",
        properties: &[
            p!("row", GRID_ROW),
            p!("column", GRID_COLUMN),
            p!("desired_bypassed", BOOL),
            p!("expected_bypassed", BOOL),
            p!("expected_scene", SCENE),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_parameter",
        rpc: "device.setParameter",
        classification: Classification::LiveWrite,
        description: "Immediately set a writable block parameter to an exact display-unit value; QC Control converts and verifies it.",
        properties: &[
            p!("row", GRID_ROW),
            p!("column", PARAMETER_COLUMN),
            p!("parameter_index", UINT),
            p!("value", NORMALIZED),
            p!("expected_value", NORMALIZED),
            p!("expected_scene", SCENE),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_parameter_scene_mode",
        rpc: "device.setParameterSceneMode",
        classification: Classification::LiveWrite,
        description: "Enable or disable per-scene storage for a block parameter and verify device readback.",
        properties: &[
            p!("row", GRID_ROW),
            p!("column", PARAMETER_COLUMN),
            p!("parameter_index", UINT),
            p!("enabled", BOOL),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_parameter_expression",
        rpc: "device.setParameterExpression",
        classification: Classification::LiveWrite,
        description: "Assign EXP 1 or EXP 2 to a block parameter, or clear it with pedal 0, preserving the requested heel and toe range.",
        properties: &[
            p!("row", GRID_ROW),
            p!("column", PARAMETER_COLUMN),
            p!("parameter_index", UINT),
            p!(
                "pedal",
                Kind::Integer {
                    min: 0,
                    max: Some(2)
                }
            ),
            p!("minimum", NORMALIZED),
            p!("maximum", NORMALIZED),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_lane_control_parameter",
        rpc: "device.setLaneControlParameter",
        classification: Classification::LiveWrite,
        description: "Set an Input Gate or Lane Output parameter with stale-value and preset guards.",
        properties: &[
            p!("row", GRID_ROW),
            p!("control", TEXT),
            p!("parameter_index", UINT),
            p!("value", NORMALIZED),
            p!("expected_value", NORMALIZED),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_lane_control_scene_mode",
        rpc: "device.setLaneControlSceneMode",
        classification: Classification::LiveWrite,
        description: "Enable or disable per-scene storage for an Input Gate or Lane Output parameter and verify readback.",
        properties: &[
            p!("row", GRID_ROW),
            p!("control", TEXT),
            p!("parameter_index", UINT),
            p!("enabled", BOOL),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_expression_bypass",
        rpc: "device.setExpressionBypass",
        classification: Classification::LiveWrite,
        description: "Assign EXP 1 or EXP 2 to a block bypass with switch mode, inversion, delay and latch emulation.",
        properties: &[
            p!("row", GRID_ROW),
            p!("column", GRID_COLUMN),
            p!("pedal", PEDAL),
            p!("mode", EXPRESSION_SWITCH_MODE),
            p!("invert", BOOL),
            p!("delay_ms", BYPASS_DELAY),
            p!("latch_emulation", BOOL),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "move_block",
        rpc: "device.moveBlock",
        classification: Classification::LiveWrite,
        description: "Move an existing Grid block to an empty column in the same row with model and preset guards.",
        properties: &[
            p!("row", GRID_ROW),
            p!("from_column", GRID_COLUMN),
            p!("to_column", GRID_COLUMN),
            p!("expected_model_id", UINT),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "add_block",
        rpc: "device.addBlock",
        classification: Classification::LiveWrite,
        description: "Add an installed model to an empty Grid cell and verify the resulting block.",
        properties: &[
            p!("row", GRID_ROW),
            p!("column", GRID_COLUMN),
            p!("model_id", UINT),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "remove_block",
        rpc: "device.removeBlock",
        classification: Classification::LiveWrite,
        description: "Remove a Grid block after validating its model and active preset.",
        properties: &[
            p!("row", GRID_ROW),
            p!("column", GRID_COLUMN),
            p!("expected_model_id", UINT),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_block_footswitch",
        rpc: "device.setBlockFootswitch",
        classification: Classification::LiveWrite,
        description: "Assign or clear a Grid block footswitch with preset, model and assignment guards.",
        properties: &[
            p!("row", GRID_ROW),
            p!("column", GRID_COLUMN),
            p!(
                "footswitch",
                Kind::NullableInteger {
                    min: 0,
                    max: Some(7)
                }
            ),
            p!(
                "expected_footswitch",
                Kind::NullableInteger {
                    min: 0,
                    max: Some(7)
                }
            ),
            p!("expected_model_id", UINT),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_stomp_momentary",
        rpc: "device.setStompMomentary",
        classification: Classification::LiveWrite,
        description: "Set a single-block STOMP footswitch to momentary or latching behavior and verify device readback.",
        properties: &[
            p!("footswitch", SCENE),
            p!("momentary", BOOL),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_stomp_label",
        rpc: "device.setStompLabel",
        classification: Classification::LiveWrite,
        description: "Set the visible label of a STOMP footswitch using the device's correct single- or multi-assignment storage.",
        properties: &[
            p!("footswitch", SCENE),
            p!("label", Kind::VisibleString { max_chars: 32 }),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_midi_out",
        rpc: "device.setMidiOut",
        classification: Classification::LiveWrite,
        description: "Replace up to 12 MIDI Out messages for a footswitch or expression-pedal source in the current preset.",
        properties: &[
            p!(
                "source",
                Kind::Integer {
                    min: 0,
                    max: Some(9)
                }
            ),
            p!("messages", Kind::MidiMessages),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_preset_load_midi_out",
        rpc: "device.setPresetLoadMidiOut",
        classification: Classification::LiveWrite,
        description: "Replace the MIDI Out messages sent when the current preset loads.",
        properties: &[
            p!("messages", Kind::MidiMessages),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_chain_input",
        rpc: "device.setChainInput",
        classification: Classification::LiveWrite,
        description: "Change a signal-row input after validating the current route and preset.",
        properties: &[
            p!("row", GRID_ROW),
            p!("input_id", UINT),
            p!("expected_input_id", UINT),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_chain_output",
        rpc: "device.setChainOutput",
        classification: Classification::LiveWrite,
        description: "Change a signal-row output after validating the current route and preset.",
        properties: &[
            p!("row", GRID_ROW),
            p!("output_id", UINT),
            p!("expected_output_id", UINT),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "set_chain_split",
        rpc: "device.setChainSplit",
        classification: Classification::LiveWrite,
        description: "Set or clear a signal-row split and rejoin with complete stale-route guards.",
        properties: &[
            p!("row", GRID_ROW),
            p!(
                "split_column",
                Kind::NullableInteger {
                    min: -1,
                    max: Some(7)
                }
            ),
            p!(
                "mix_column",
                Kind::NullableInteger {
                    min: -1,
                    max: Some(7)
                }
            ),
            p!(
                "expected_split_column",
                Kind::NullableInteger {
                    min: -1,
                    max: Some(7)
                }
            ),
            p!(
                "expected_mix_column",
                Kind::NullableInteger {
                    min: -1,
                    max: Some(7)
                }
            ),
            p!("expected_preset_name", TEXT),
        ],
    },
    ActionSpec {
        name: "save_preset_as",
        rpc: "device.savePresetAs",
        classification: Classification::PersistentWrite,
        description: "Save the current preset to a reviewed device slot with explicit overwrite confirmation.",
        properties: &[
            p!("setlist_key", TEXT),
            p!("position", UINT),
            p!("name", TEXT),
            p!("expected_preset_name", TEXT),
            p!("expected_position", UINT),
            p!("confirm_overwrite", BOOL),
            p!("confirm_persistent_write", BOOL),
        ],
    },
    ActionSpec {
        name: "rename_current_preset",
        rpc: "device.renameCurrentPreset",
        classification: Classification::PersistentWrite,
        description: "Rename the active stored preset after explicit confirmation.",
        properties: &[
            p!("new_name", TEXT),
            p!("expected_preset_name", TEXT),
            p!("expected_position", UINT),
            p!("confirm_persistent_write", BOOL),
        ],
    },
    ActionSpec {
        name: "copy_preset",
        rpc: "device.copyPreset",
        classification: Classification::PersistentWrite,
        description: "Copy a device preset to a reviewed destination with explicit overwrite confirmation.",
        properties: &[
            p!("source_setlist_key", TEXT),
            p!("source_position", UINT),
            p!("source_name", TEXT),
            p!("destination_setlist_key", TEXT),
            p!("destination_position", UINT),
            p!("expected_preset_name", TEXT),
            p!("expected_position", UINT),
            p!("confirm_overwrite", BOOL),
            p!("confirm_persistent_write", BOOL),
        ],
    },
];

impl ActionSpec {
    pub fn tool(&self) -> Tool {
        let mut properties = Map::new();
        let mut required = Vec::new();
        for property in self.properties {
            properties.insert(property.name.into(), schema_for(property.kind));
            if property.required {
                required.push(Value::String(property.name.into()));
            }
        }
        let schema = json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
            .as_object().expect("object schema").clone();
        let (read_only, destructive) = match self.classification {
            Classification::Read => (true, false),
            Classification::LiveWrite => (false, false),
            Classification::PersistentWrite | Classification::RiskyWrite => (false, true),
        };
        Tool::new(self.name, self.description, Arc::<JsonObject>::new(schema)).with_annotations(
            ToolAnnotations::new()
                .read_only(read_only)
                .destructive(destructive)
                .idempotent(false)
                .open_world(false),
        )
    }
}

fn schema_for(kind: Kind) -> Value {
    match kind {
        Kind::String => json!({"type":"string","minLength":1}),
        Kind::VisibleString { max_chars } => json!({
            "type":"string", "minLength":1, "maxLength":max_chars,
            "pattern":"^[^\\u0000-\\u001F\\u007F]*$"
        }),
        Kind::NullableString => json!({"type":["string","null"]}),
        Kind::NullableInteger { min, max } => {
            let mut s = json!({"type":["integer","null"],"minimum":min});
            if let Some(max) = max {
                s["maximum"] = json!(max);
            }
            s
        }
        Kind::Boolean => json!({"type":"boolean"}),
        Kind::Integer { min, max } => {
            let mut s = json!({"type":"integer","minimum":min});
            if let Some(max) = max {
                s["maximum"] = json!(max);
            }
            s
        }
        Kind::Number { min, max } => {
            let mut s = json!({"type":"number","minimum":min});
            if let Some(max) = max {
                s["maximum"] = json!(max);
            }
            s
        }
        Kind::MidiMessages => json!({
            "type":"array", "maxItems":12,
            "items": {
                "type":"object", "additionalProperties":false,
                "properties": {
                    "type":{"type":"integer","minimum":1,"maximum":3},
                    "channel":{"type":"integer","minimum":1,"maximum":16},
                    "param1":{"type":"integer","minimum":0,"maximum":127},
                    "param2":{"type":"integer","minimum":0,"maximum":127},
                    "param3":{"type":"integer","minimum":0,"maximum":127}
                },
                "required":["type","channel","param1","param2","param3"]
            }
        }),
    }
}
