use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::generated_actions::ACTIONS;
pub use qc_relay_protocol::{
    DeviceError, DeviceFrame, MAX_REQUEST_FRAME_BYTES, MAX_RESULT_FRAME_BYTES, PROTOCOL_VERSION,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionClass {
    Read,
    LiveWrite,
    RiskyWrite,
    PersistentWrite,
}

#[derive(Clone, Copy, Debug)]
pub struct ActionPolicy {
    pub name: &'static str,
    pub rpc: &'static str,
    pub class: ActionClass,
    pub required_argument_confirmations: &'static [&'static str],
}

impl ActionPolicy {
    pub fn find(name: &str) -> Option<&'static Self> {
        ACTIONS.iter().find(|action| action.name == name)
    }
    pub fn requires_confirmation(&self) -> bool {
        matches!(
            self.class,
            ActionClass::RiskyWrite | ActionClass::PersistentWrite
        )
    }

    pub fn find_rpc(rpc: &str) -> Option<&'static Self> {
        ACTIONS.iter().find(|action| action.rpc == rpc)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ConfirmationProof {
    pub approved: bool,
    /// Human-readable provenance supplied by the MCP host, never a provider token.
    pub source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct InvokeRequest {
    pub device_id: crate::pairing::DeviceId,
    pub action: String,
    #[serde(default)]
    pub arguments: Value,
    #[serde(default)]
    pub confirmation: Option<ConfirmationProof>,
}

/// MCP-facing request form. Device selection is derived from the authenticated
/// principal and is never delegated to model-supplied arguments.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PrincipalInvokeRequest {
    pub action: String,
    #[serde(default)]
    pub arguments: Value,
    #[serde(default)]
    pub confirmation: Option<ConfirmationProof>,
}
