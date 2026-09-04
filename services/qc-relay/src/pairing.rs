use crate::auth::{digest, random_secret, PrincipalId};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::Mutex;

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DeviceId(pub String);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeviceCredential {
    pub device_id: DeviceId,
    pub principal_id: PrincipalId,
    pub expires_at: SystemTime,
}

#[derive(Clone, Debug, Serialize)]
pub struct PairingOffer {
    pub secret: String,
    pub expires_at: SystemTime,
}

#[derive(Clone, Debug, Serialize)]
pub struct PairingReceipt {
    pub device_token: String,
    pub principal_id: PrincipalId,
    pub expires_at: SystemTime,
}

#[derive(Clone, Debug, thiserror::Error, Eq, PartialEq)]
pub enum PairingError {
    #[error("pairing secret is invalid or expired")]
    InvalidOrExpired,
    #[error("pairing secret was already redeemed")]
    Replayed,
    #[error("too many pairing attempts")]
    RateLimited,
    #[error("device credential is invalid, expired, or revoked")]
    InvalidDeviceCredential,
    #[error("device is not paired to this principal")]
    WrongPrincipal,
}

#[derive(Clone)]
pub struct DeviceCredentialStore {
    inner: Arc<Mutex<CredentialState>>,
}

#[derive(Default)]
struct CredentialState {
    tokens: HashMap<[u8; 32], CredentialRecord>,
    devices: HashMap<DeviceId, DeviceGrant>,
}

#[derive(Clone)]
struct CredentialRecord {
    credential: DeviceCredential,
    revoked: bool,
}

#[derive(Clone)]
struct DeviceGrant {
    principal_id: PrincipalId,
    revoked: bool,
}

impl Default for DeviceCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

impl DeviceCredentialStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(CredentialState::default())),
        }
    }

    async fn issue(
        &self,
        device_id: DeviceId,
        principal_id: PrincipalId,
        ttl: Duration,
    ) -> PairingReceipt {
        let token = random_secret("qcdt_");
        let credential = DeviceCredential {
            device_id: device_id.clone(),
            principal_id: principal_id.clone(),
            expires_at: SystemTime::now() + ttl,
        };
        let mut state = self.inner.lock().await;
        // Re-pairing invalidates every older credential for this stable device id.
        for record in state.tokens.values_mut() {
            if record.credential.device_id == device_id {
                record.revoked = true;
            }
        }
        state.devices.insert(
            device_id,
            DeviceGrant {
                principal_id: principal_id.clone(),
                revoked: false,
            },
        );
        state.tokens.insert(
            digest(&token),
            CredentialRecord {
                credential: credential.clone(),
                revoked: false,
            },
        );
        PairingReceipt {
            device_token: token,
            principal_id,
            expires_at: credential.expires_at,
        }
    }

    pub async fn validate(&self, token: &str) -> Result<DeviceCredential, PairingError> {
        let state = self.inner.lock().await;
        let record = state
            .tokens
            .get(&digest(token))
            .ok_or(PairingError::InvalidDeviceCredential)?;
        let grant = state
            .devices
            .get(&record.credential.device_id)
            .ok_or(PairingError::InvalidDeviceCredential)?;
        if record.revoked
            || grant.revoked
            || record.credential.expires_at <= SystemTime::now()
            || grant.principal_id != record.credential.principal_id
        {
            return Err(PairingError::InvalidDeviceCredential);
        }
        Ok(record.credential.clone())
    }

    pub async fn authorize(
        &self,
        principal: &PrincipalId,
        device: &DeviceId,
    ) -> Result<(), PairingError> {
        let state = self.inner.lock().await;
        let grant = state
            .devices
            .get(device)
            .ok_or(PairingError::WrongPrincipal)?;
        if grant.revoked || &grant.principal_id != principal {
            return Err(PairingError::WrongPrincipal);
        }
        Ok(())
    }

    pub async fn revoke_device(
        &self,
        principal: &PrincipalId,
        device: &DeviceId,
    ) -> Result<(), PairingError> {
        let mut state = self.inner.lock().await;
        let grant = state
            .devices
            .get_mut(device)
            .ok_or(PairingError::WrongPrincipal)?;
        if &grant.principal_id != principal {
            return Err(PairingError::WrongPrincipal);
        }
        grant.revoked = true;
        for record in state.tokens.values_mut() {
            if &record.credential.device_id == device {
                record.revoked = true;
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct PairingManager {
    inner: Arc<Mutex<PairingState>>,
    credentials: DeviceCredentialStore,
    offer_ttl: Duration,
    credential_ttl: Duration,
    max_attempts: usize,
    attempt_window: Duration,
}

#[derive(Default)]
struct PairingState {
    offers: HashMap<[u8; 32], OfferRecord>,
    consumed: HashMap<[u8; 32], Instant>,
    attempts: HashMap<String, VecDeque<Instant>>,
}

struct OfferRecord {
    principal_id: PrincipalId,
    expires_at: Instant,
}

impl PairingManager {
    pub fn new(credentials: DeviceCredentialStore) -> Self {
        Self {
            inner: Arc::new(Mutex::new(PairingState::default())),
            credentials,
            offer_ttl: Duration::from_secs(300),
            credential_ttl: Duration::from_secs(60 * 60 * 24 * 90),
            max_attempts: 8,
            attempt_window: Duration::from_secs(60),
        }
    }

    pub fn with_limits(
        mut self,
        offer_ttl: Duration,
        credential_ttl: Duration,
        max_attempts: usize,
        attempt_window: Duration,
    ) -> Self {
        self.offer_ttl = offer_ttl;
        self.credential_ttl = credential_ttl;
        self.max_attempts = max_attempts;
        self.attempt_window = attempt_window;
        self
    }

    pub async fn create_offer(&self, principal_id: PrincipalId) -> PairingOffer {
        let secret = random_secret("qcpair_");
        let now = Instant::now();
        let wall_expires_at = SystemTime::now() + self.offer_ttl;
        self.inner.lock().await.offers.insert(
            digest(&secret),
            OfferRecord {
                principal_id,
                expires_at: now + self.offer_ttl,
            },
        );
        PairingOffer {
            secret,
            expires_at: wall_expires_at,
        }
    }

    pub async fn redeem(
        &self,
        secret: &str,
        device_id: DeviceId,
        rate_key: &str,
    ) -> Result<PairingReceipt, PairingError> {
        let hashed = digest(secret);
        let principal_id = {
            let mut state = self.inner.lock().await;
            let now = Instant::now();
            state.consumed.retain(|_, until| *until > now);
            let attempts = state.attempts.entry(rate_key.to_owned()).or_default();
            while attempts
                .front()
                .is_some_and(|at| now.duration_since(*at) >= self.attempt_window)
            {
                attempts.pop_front();
            }
            if attempts.len() >= self.max_attempts {
                return Err(PairingError::RateLimited);
            }
            attempts.push_back(now);
            if state.consumed.contains_key(&hashed) {
                return Err(PairingError::Replayed);
            }
            let offer = state
                .offers
                .remove(&hashed)
                .ok_or(PairingError::InvalidOrExpired)?;
            if offer.expires_at <= now {
                return Err(PairingError::InvalidOrExpired);
            }
            state.consumed.insert(hashed, offer.expires_at);
            offer.principal_id
        };
        Ok(self
            .credentials
            .issue(device_id, principal_id, self.credential_ttl)
            .await)
    }

    pub fn credentials(&self) -> &DeviceCredentialStore {
        &self.credentials
    }
}
