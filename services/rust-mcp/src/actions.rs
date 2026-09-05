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
    VisibleString {
        max_chars: usize,
    },
    NullableString,
    NullableInteger {
        min: i64,
        max: Option<i64>,
    },
    NullableBoolean,
    NullableNumber {
        min: f64,
        max: Option<f64>,
    },
    NullableStringEnum(&'static [&'static str]),
    NullableStringArray {
        max_items: usize,
        values: &'static [&'static str],
    },
    Boolean,
    Integer {
        min: i64,
        max: Option<i64>,
    },
    Number {
        min: f64,
        max: Option<f64>,
    },
    MidiMessages,
    StringEnum(&'static [&'static str]),
    BooleanRows,
    IntegerArray {
        min: i64,
        max: i64,
        min_items: usize,
        max_items: usize,
        unique: bool,
    },
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

include!("generated_actions.rs");

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
                .idempotent(read_only)
                .open_world(false),
        )
    }
}

fn schema_for(kind: Kind) -> Value {
    match kind {
        Kind::String => json!({"type":"string","minLength":1}),
        Kind::VisibleString { max_chars } => {
            json!({"type":"string","minLength":1,"maxLength":max_chars,"pattern":"^[^\\u0000-\\u001F\\u007F]*$"})
        }
        Kind::NullableString => json!({"type":["string","null"]}),
        Kind::NullableInteger { min, max } => ranged_schema(["integer", "null"], min, max),
        Kind::NullableBoolean => json!({"type":["boolean","null"]}),
        Kind::NullableNumber { min, max } => ranged_number_schema(["number", "null"], min, max),
        Kind::NullableStringEnum(values) => {
            json!({"type":["string","null"],"enum":values.iter().map(|value| Value::String((*value).into())).chain(std::iter::once(Value::Null)).collect::<Vec<_>>()})
        }
        Kind::NullableStringArray { max_items, values } => {
            json!({"type":["array","null"],"maxItems":max_items,"items":{"type":"string","enum":values}})
        }
        Kind::Boolean => json!({"type":"boolean"}),
        Kind::Integer { min, max } => ranged_schema("integer", min, max),
        Kind::Number { min, max } => ranged_number_schema("number", min, max),
        Kind::MidiMessages => {
            json!({"type":"array","maxItems":12,"items":{"type":"object","additionalProperties":false,"properties":{"type":{"type":"integer","minimum":1,"maximum":3},"channel":{"type":"integer","minimum":1,"maximum":16},"param1":{"type":"integer","minimum":0,"maximum":127},"param2":{"type":"integer","minimum":0,"maximum":127},"param3":{"type":"integer","minimum":0,"maximum":127}},"required":["type","channel","param1","param2","param3"]}})
        }
        Kind::StringEnum(values) => json!({"type":"string","enum":values}),
        Kind::BooleanRows => {
            json!({"type":"array","minItems":4,"maxItems":4,"items":{"type":"boolean"}})
        }
        Kind::IntegerArray {
            min,
            max,
            min_items,
            max_items,
            unique,
        } => {
            json!({"type":"array","minItems":min_items,"maxItems":max_items,"uniqueItems":unique,"items":{"type":"integer","minimum":min,"maximum":max}})
        }
    }
}

fn ranged_schema(type_name: impl serde::Serialize, min: i64, max: Option<i64>) -> Value {
    let mut schema = json!({"type":type_name,"minimum":min});
    if let Some(max) = max {
        schema["maximum"] = json!(max);
    }
    schema
}

fn ranged_number_schema(type_name: impl serde::Serialize, min: f64, max: Option<f64>) -> Value {
    let mut schema = json!({"type":type_name,"minimum":min});
    if let Some(max) = max {
        schema["maximum"] = json!(max);
    }
    schema
}
