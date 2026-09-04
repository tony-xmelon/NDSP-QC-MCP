use async_trait::async_trait;
use serde_json::{Map, Value};
use std::sync::Arc;
use thiserror::Error;

/// Sanitized authorization result inserted into Axum request extensions by the
/// relay. It contains routing identifiers, never bearer tokens or provider secrets.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrincipalRoute {
    pub principal_id: Arc<str>,
    pub device_id: Arc<str>,
}

impl PrincipalRoute {
    pub fn new(principal_id: impl Into<Arc<str>>, device_id: impl Into<Arc<str>>) -> Self {
        Self {
            principal_id: principal_id.into(),
            device_id: device_id.into(),
        }
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct BackendError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl BackendError {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "device_unavailable",
            message: message.into(),
            retryable: true,
        }
    }
}

/// Implemented by the authenticated relay layer. One backend instance MUST be
/// scoped to exactly one authenticated principal/device route.
#[async_trait]
pub trait QcBackend: Send + Sync + 'static {
    async fn request(
        &self,
        route: &PrincipalRoute,
        rpc: &'static str,
        params: Map<String, Value>,
    ) -> Result<Value, BackendError>;
}
