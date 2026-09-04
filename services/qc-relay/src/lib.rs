//! Authentication, pairing, and device-session routing for the public QC relay.
//!
//! This crate deliberately operates on allowlisted QC intents. It does not expose
//! HID, protobuf, arbitrary gateway RPC, or provider credentials.

pub mod auth;
mod generated_actions;
pub mod pairing;
pub mod protocol;
pub mod relay;
pub mod web;

pub use auth::{AccessPrincipal, BearerTokenValidator, OpaqueTokenIssuer, PrincipalId};
pub use pairing::{DeviceCredential, DeviceCredentialStore, DeviceId, PairingManager};
pub use protocol::{
    ActionPolicy, ConfirmationProof, DeviceFrame, InvokeRequest, PrincipalInvokeRequest,
};
pub use relay::{DeviceConnection, RelayError, RelayHub};
pub use web::{
    router, AppState, AuthorizationServerMetadata, PublicEndpointConfig, TlsTermination,
};
