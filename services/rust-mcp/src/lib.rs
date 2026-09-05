mod actions;
mod backend;
mod generated_instructions;
mod generated_result_kinds;
mod server;

pub use actions::{ACTIONS, ActionSpec, Classification};
pub use backend::{BackendError, PrincipalRoute, QcBackend};
pub use generated_instructions::MCP_INSTRUCTIONS;
pub use server::{QcMcp, mcp_router, mcp_router_with_allowed_hosts};
