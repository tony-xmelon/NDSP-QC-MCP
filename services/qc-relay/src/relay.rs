use crate::{
    auth::PrincipalId,
    pairing::{DeviceCredential, DeviceCredentialStore, DeviceId},
    protocol::{ActionPolicy, DeviceFrame, InvokeRequest, PrincipalInvokeRequest},
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use uuid::Uuid;

#[derive(Clone, Debug, thiserror::Error, Eq, PartialEq)]
pub enum RelayError {
    #[error("unknown QC action")]
    UnknownAction,
    #[error("explicit host confirmation is required")]
    ConfirmationRequired,
    #[error("confirmation argument `{0}` must be true")]
    ConfirmationArgumentRequired(String),
    #[error("device is not paired to this principal")]
    Forbidden,
    #[error("paired device is offline")]
    DeviceOffline,
    #[error("more than one paired device is active; select a configured primary device")]
    AmbiguousDevice,
    #[error("device disconnected while processing the request")]
    Disconnected,
    #[error("device request timed out")]
    Timeout,
    #[error("device rejected request: {0}")]
    Device(String),
}

#[derive(Clone)]
pub struct RelayHub {
    inner: Arc<HubInner>,
}

struct HubInner {
    credentials: DeviceCredentialStore,
    connections: RwLock<HashMap<DeviceId, Arc<Session>>>,
    timeout: Duration,
}

struct Session {
    id: Uuid,
    principal_id: PrincipalId,
    ready: AtomicBool,
    outbound: mpsc::Sender<DeviceFrame>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, RelayError>>>>,
}

pub struct DeviceConnection {
    hub: RelayHub,
    device_id: DeviceId,
    session: Arc<Session>,
    pub outbound: mpsc::Receiver<DeviceFrame>,
}

impl RelayHub {
    pub fn new(credentials: DeviceCredentialStore) -> Self {
        // Native backups may legitimately take the full 60-second device
        // window. Keep one bounded relay window that also covers reconnect
        // synchronization without racing either native host.
        Self::with_timeout(credentials, Duration::from_secs(75))
    }
    pub fn with_timeout(credentials: DeviceCredentialStore, timeout: Duration) -> Self {
        Self {
            inner: Arc::new(HubInner {
                credentials,
                connections: RwLock::new(HashMap::new()),
                timeout,
            }),
        }
    }

    pub async fn connect(&self, credential: DeviceCredential) -> DeviceConnection {
        let (tx, rx) = mpsc::channel(32);
        let session = Arc::new(Session {
            id: Uuid::new_v4(),
            principal_id: credential.principal_id,
            ready: AtomicBool::new(false),
            outbound: tx,
            pending: Mutex::new(HashMap::new()),
        });
        if let Some(old) = self
            .inner
            .connections
            .write()
            .await
            .insert(credential.device_id.clone(), session.clone())
        {
            fail_all(&old, RelayError::Disconnected).await;
        }
        DeviceConnection {
            hub: self.clone(),
            device_id: credential.device_id,
            session,
            outbound: rx,
        }
    }

    pub async fn invoke(
        &self,
        principal: &PrincipalId,
        request: InvokeRequest,
    ) -> Result<Value, RelayError> {
        self.inner
            .credentials
            .authorize(principal, &request.device_id)
            .await
            .map_err(|_| RelayError::Forbidden)?;
        let policy = ActionPolicy::find(&request.action).ok_or(RelayError::UnknownAction)?;
        if policy.requires_confirmation()
            && !request
                .confirmation
                .as_ref()
                .is_some_and(|proof| proof.approved && !proof.source.trim().is_empty())
        {
            return Err(RelayError::ConfirmationRequired);
        }
        for field in policy.required_argument_confirmations {
            if request.arguments.get(field).and_then(Value::as_bool) != Some(true) {
                return Err(RelayError::ConfirmationArgumentRequired(
                    (*field).to_owned(),
                ));
            }
        }
        self.dispatch_policy(principal, request.device_id, policy, request.arguments)
            .await
    }

    /// Dispatches an RPC already validated by the Rust MCP safety layer. This is
    /// for an in-process `QcBackend` adapter only and is not exposed as an HTTP
    /// route. RPC names are still reverse-checked against the intent allowlist.
    pub async fn dispatch_validated_rpc(
        &self,
        principal: &PrincipalId,
        device_id: DeviceId,
        rpc: &str,
        arguments: Value,
    ) -> Result<Value, RelayError> {
        let policy = ActionPolicy::find_rpc(rpc).ok_or(RelayError::UnknownAction)?;
        self.inner
            .credentials
            .authorize(principal, &device_id)
            .await
            .map_err(|_| RelayError::Forbidden)?;
        self.dispatch_policy(principal, device_id, policy, arguments)
            .await
    }

    async fn dispatch_policy(
        &self,
        principal: &PrincipalId,
        device_id: DeviceId,
        policy: &'static ActionPolicy,
        arguments: Value,
    ) -> Result<Value, RelayError> {
        let session = self
            .inner
            .connections
            .read()
            .await
            .get(&device_id)
            .cloned()
            .ok_or(RelayError::DeviceOffline)?;
        if &session.principal_id != principal {
            return Err(RelayError::Forbidden);
        }
        if !session.ready.load(Ordering::Acquire)
            && !matches!(policy.rpc, "device.reconnect" | "device.resetSession")
        {
            return Err(RelayError::DeviceOffline);
        }
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        session.pending.lock().await.insert(id.clone(), tx);
        let frame = DeviceFrame::Invoke {
            id: id.clone(),
            action: policy.name.to_owned(),
            method: policy.rpc.to_owned(),
            params: arguments,
        };
        if session.outbound.send(frame).await.is_err() {
            session.pending.lock().await.remove(&id);
            return Err(RelayError::Disconnected);
        }
        // Backups are progress-checked by the native host and can legitimately
        // outlive the ordinary request window. Keep the shorter deadline for
        // every other action so a disconnected device still fails promptly.
        let request_timeout = if policy.rpc == "device.createBackup" {
            self.inner.timeout.max(Duration::from_secs(195))
        } else {
            self.inner.timeout
        };
        match tokio::time::timeout(request_timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RelayError::Disconnected),
            Err(_) => {
                session.pending.lock().await.remove(&id);
                Err(RelayError::Timeout)
            }
        }
    }

    pub async fn invoke_for_principal(
        &self,
        principal: &PrincipalId,
        request: PrincipalInvokeRequest,
    ) -> Result<Value, RelayError> {
        let device_id = self.active_device_for_principal(principal).await?;
        self.invoke(
            principal,
            InvokeRequest {
                device_id,
                action: request.action,
                arguments: request.arguments,
                confirmation: request.confirmation,
            },
        )
        .await
    }

    pub async fn active_device_for_principal(
        &self,
        principal: &PrincipalId,
    ) -> Result<DeviceId, RelayError> {
        self.device_for_principal(principal, true).await
    }

    pub async fn connected_device_for_principal(
        &self,
        principal: &PrincipalId,
    ) -> Result<DeviceId, RelayError> {
        self.device_for_principal(principal, false).await
    }

    async fn device_for_principal(
        &self,
        principal: &PrincipalId,
        require_ready: bool,
    ) -> Result<DeviceId, RelayError> {
        let devices = self
            .inner
            .connections
            .read()
            .await
            .iter()
            .filter(|(_, session)| {
                &session.principal_id == principal
                    && (!require_ready || session.ready.load(Ordering::Acquire))
            })
            .map(|(device, _)| device.clone())
            .collect::<Vec<_>>();
        match devices.as_slice() {
            [] => Err(RelayError::DeviceOffline),
            [device] => Ok(device.clone()),
            _ => Err(RelayError::AmbiguousDevice),
        }
    }
}

impl DeviceConnection {
    pub fn set_ready(&self, ready: bool) {
        self.session.ready.store(ready, Ordering::Release);
    }

    pub async fn accept(&self, frame: DeviceFrame) {
        let (id, result) = match frame {
            DeviceFrame::Result {
                id,
                ok: true,
                result,
                ..
            } => (id, Ok(result.unwrap_or(Value::Null))),
            DeviceFrame::Result {
                id,
                ok: false,
                error,
                ..
            } => {
                let message = error
                    .map(|error| format!("{}: {}", error.code, error.message))
                    .unwrap_or_else(|| "unspecified device error".into());
                (id, Err(RelayError::Device(message)))
            }
            DeviceFrame::Ready { usb_connected, .. } => {
                self.set_ready(usb_connected);
                return;
            }
            DeviceFrame::Invoke { .. } => return,
        };
        if let Some(sender) = self.session.pending.lock().await.remove(&id) {
            let _ = sender.send(result);
        }
    }

    pub async fn disconnect(self) {
        let mut connections = self.hub.inner.connections.write().await;
        if connections
            .get(&self.device_id)
            .is_some_and(|active| active.id == self.session.id)
        {
            connections.remove(&self.device_id);
        }
        drop(connections);
        fail_all(&self.session, RelayError::Disconnected).await;
    }
}

async fn fail_all(session: &Session, error: RelayError) {
    for (_, pending) in session.pending.lock().await.drain() {
        let _ = pending.send(Err(error.clone()));
    }
}
