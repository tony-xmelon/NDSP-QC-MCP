use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::sync::RwLock;

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PrincipalId(pub String);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccessPrincipal {
    pub subject: PrincipalId,
    pub issuer: String,
    pub audience: String,
    pub scopes: Vec<String>,
    pub expires_at: SystemTime,
}

impl AccessPrincipal {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|candidate| candidate == scope)
    }
}

#[derive(Clone, Debug, thiserror::Error, Eq, PartialEq)]
pub enum AuthError {
    #[error("invalid bearer token")]
    Invalid,
    #[error("bearer token expired")]
    Expired,
    #[error("bearer token revoked")]
    Revoked,
    #[error("required scope is missing")]
    MissingScope,
}

#[async_trait]
pub trait BearerTokenValidator: Send + Sync + 'static {
    /// Cryptographically validates a token and returns trusted claims. The
    /// resource server independently enforces issuer, audience, scope and expiry.
    async fn validate(&self, token: &str) -> Result<AccessPrincipal, AuthError>;
}

#[derive(Clone)]
pub struct OpaqueTokenIssuer {
    records: Arc<RwLock<HashMap<[u8; 32], TokenRecord>>>,
}

#[derive(Clone)]
struct TokenRecord {
    principal: AccessPrincipal,
    revoked: bool,
}

impl Default for OpaqueTokenIssuer {
    fn default() -> Self {
        Self::new()
    }
}

impl OpaqueTokenIssuer {
    pub fn new() -> Self {
        Self {
            records: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Provisions a high-entropy local token. The cleartext value is returned once;
    /// only its SHA-256 digest is retained.
    pub async fn provision(
        &self,
        subject: PrincipalId,
        scopes: impl IntoIterator<Item = String>,
        ttl: Duration,
    ) -> String {
        self.provision_for_resource(
            subject,
            scopes,
            ttl,
            "https://local-issuer.invalid",
            "https://local-resource.invalid",
        )
        .await
    }

    pub async fn provision_for_resource(
        &self,
        subject: PrincipalId,
        scopes: impl IntoIterator<Item = String>,
        ttl: Duration,
        issuer: impl Into<String>,
        audience: impl Into<String>,
    ) -> String {
        let token = random_secret("qcrt_");
        let principal = AccessPrincipal {
            subject,
            issuer: issuer.into(),
            audience: audience.into(),
            scopes: scopes.into_iter().collect(),
            expires_at: SystemTime::now() + ttl,
        };
        self.records.write().await.insert(
            digest(&token),
            TokenRecord {
                principal,
                revoked: false,
            },
        );
        token
    }

    pub async fn revoke(&self, token: &str) -> bool {
        let mut records = self.records.write().await;
        match records.get_mut(&digest(token)) {
            Some(record) => {
                record.revoked = true;
                true
            }
            None => false,
        }
    }
}

#[async_trait]
impl BearerTokenValidator for OpaqueTokenIssuer {
    async fn validate(&self, token: &str) -> Result<AccessPrincipal, AuthError> {
        let record = self
            .records
            .read()
            .await
            .get(&digest(token))
            .cloned()
            .ok_or(AuthError::Invalid)?;
        if record.revoked {
            return Err(AuthError::Revoked);
        }
        if record.principal.expires_at <= SystemTime::now() {
            return Err(AuthError::Expired);
        }
        Ok(record.principal)
    }
}

pub(crate) fn random_secret(prefix: &str) -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub(crate) fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}
