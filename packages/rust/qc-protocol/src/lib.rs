//! Native protocol primitives shared by QC Control's Windows host and broker.
//!
//! The protobuf schema and framing are derived from the MIT-licensed
//! `pyquadcortex` 0.40.0 reference implementation. See
//! `PYQUADCORTEX-LICENSE.txt` and `SCHEMA-SOURCE.md`.

pub mod commands;
pub mod domain;
pub mod framing;
pub mod generated_payloads;
pub mod profile;
pub mod responses;
pub mod session;
pub mod state;
pub mod wire;

pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/qc_protocol.rs"));
}
