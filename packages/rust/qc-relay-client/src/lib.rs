use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashSet, VecDeque},
    sync::Arc,
    time::Duration,
};
use tokio::sync::watch;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};

pub use qc_relay_protocol::{
    DeviceError, DeviceFrame, BACKOFF_JITTER_MS, COMPLETED_REQUEST_CACHE_SIZE, DEVICE_CONNECT_PATH,
    DEVICE_PAIR_PATH, MAXIMUM_BACKOFF_EXPONENT, MAXIMUM_BACKOFF_SECONDS, MAXIMUM_FAILURE_COUNT,
    MAX_REQUEST_FRAME_BYTES, MAX_RESULT_FRAME_BYTES, MINIMUM_CREDENTIAL_LENGTH,
    PAIRING_CODE_MAXIMUM_LENGTH, PAIRING_CODE_MINIMUM_LENGTH, PROTOCOL_VERSION,
    READINESS_INTERVAL_MS,
};

mod generated_actions;

const ADAPTER_READY_TIMEOUT: Duration = Duration::from_secs(10);
const ADAPTER_INVOKE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const SOCKET_SEND_TIMEOUT: Duration = Duration::from_secs(15);
const SOCKET_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccessMode {
    #[default]
    Full,
    Modify,
    Performance,
    ReadOnly,
}

impl AccessMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            generated_actions::ACCESS_FULL => Ok(Self::Full),
            generated_actions::ACCESS_MODIFY => Ok(Self::Modify),
            generated_actions::ACCESS_PERFORMANCE => Ok(Self::Performance),
            generated_actions::ACCESS_READ_ONLY => Ok(Self::ReadOnly),
            _ => Err("Relay access mode must be read-only, performance, modify, or full".into()),
        }
    }

    fn permits(self, method: &str) -> bool {
        match self {
            Self::Full => generated_actions::contains(method),
            Self::Modify => {
                generated_actions::is_read_only(method)
                    || generated_actions::is_performance(method)
                    || generated_actions::is_modify(method)
            }
            Self::Performance => {
                generated_actions::is_read_only(method) || generated_actions::is_performance(method)
            }
            Self::ReadOnly => generated_actions::is_read_only(method),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    #[default]
    Stopped,
    Connecting,
    Connected,
    Reconnecting,
    PairingRequired,
    InvalidEndpoint,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub endpoint: String,
    pub device_credential: String,
    pub device_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingResponse {
    device_credential: String,
    device_id: String,
}

#[async_trait]
pub trait DeviceAdapter: Send + Sync + 'static {
    async fn ready(&self) -> bool;
    async fn invoke(&self, method: &str, params: Value) -> Result<Value, DeviceError>;
}

pub fn normalize_endpoint(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let parsed = Url::parse(trimmed).map_err(|_| "Relay endpoint is not a valid URL")?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Relay endpoint must be a plain HTTPS origin without credentials, query, or fragment"
                .into(),
        );
    }
    let mut normalized = parsed;
    let path = normalized.path().trim_end_matches('/').to_owned();
    normalized.set_path(&path);
    Ok(normalized.to_string().trim_end_matches('/').to_owned())
}

pub async fn pair(
    endpoint: &str,
    pairing_code: &str,
    device_name: &str,
) -> Result<Credentials, String> {
    let endpoint = normalize_endpoint(endpoint)?;
    let code = pairing_code.trim();
    let name = device_name.trim();
    if !(PAIRING_CODE_MINIMUM_LENGTH..=PAIRING_CODE_MAXIMUM_LENGTH).contains(&code.len())
        || name.is_empty()
    {
        return Err("A valid pairing code and device name are required".into());
    }
    let response = reqwest::Client::new()
        .post(format!("{endpoint}{DEVICE_PAIR_PATH}"))
        .json(&json!({"pairingCode": code, "deviceName": name, "protocol": PROTOCOL_VERSION}))
        .send()
        .await
        .map_err(|_| "Could not reach the public relay".to_string())?;
    if !response.status().is_success() {
        return Err("The public relay rejected the pairing code".into());
    }
    let receipt: PairingResponse = response
        .json()
        .await
        .map_err(|_| "The public relay returned an invalid pairing receipt".to_string())?;
    if receipt.device_credential.len() < MINIMUM_CREDENTIAL_LENGTH
        || receipt.device_id.trim().is_empty()
    {
        return Err("The public relay returned an invalid device credential".into());
    }
    Ok(Credentials {
        endpoint,
        device_credential: receipt.device_credential,
        device_id: receipt.device_id,
    })
}

pub struct Client {
    credentials: Credentials,
    adapter: Arc<dyn DeviceAdapter>,
    state: watch::Sender<ConnectionState>,
    access: watch::Receiver<AccessMode>,
    stop: watch::Receiver<bool>,
    completed: HashSet<String>,
    completed_order: VecDeque<String>,
}

impl Client {
    pub fn new(
        credentials: Credentials,
        adapter: Arc<dyn DeviceAdapter>,
        state: watch::Sender<ConnectionState>,
        access: watch::Receiver<AccessMode>,
        stop: watch::Receiver<bool>,
    ) -> Self {
        Self {
            credentials,
            adapter,
            state,
            access,
            stop,
            completed: HashSet::new(),
            completed_order: VecDeque::new(),
        }
    }

    pub async fn run(mut self) {
        let endpoint = match normalize_endpoint(&self.credentials.endpoint) {
            Ok(value) => value,
            Err(_) => {
                self.state.send_replace(ConnectionState::InvalidEndpoint);
                return;
            }
        };
        let ws_endpoint = format!(
            "wss://{}{}",
            endpoint.trim_start_matches("https://"),
            DEVICE_CONNECT_PATH
        );
        let mut failures = 0_u32;
        loop {
            if *self.stop.borrow() {
                self.state.send_replace(ConnectionState::Stopped);
                return;
            }
            self.state.send_replace(if failures == 0 {
                ConnectionState::Connecting
            } else {
                ConnectionState::Reconnecting
            });
            let mut request = match ws_endpoint.clone().into_client_request() {
                Ok(value) => value,
                Err(_) => {
                    self.state.send_replace(ConnectionState::InvalidEndpoint);
                    return;
                }
            };
            let credential = match format!("Bearer {}", self.credentials.device_credential).parse()
            {
                Ok(value) => value,
                Err(_) => {
                    self.state.send_replace(ConnectionState::PairingRequired);
                    return;
                }
            };
            request.headers_mut().insert("Authorization", credential);
            request.headers_mut().insert(
                "Sec-WebSocket-Protocol",
                HeaderValue::from_static(PROTOCOL_VERSION),
            );
            let connection = tokio::select! {
                result = tokio::time::timeout(SOCKET_CONNECT_TIMEOUT, connect_async(request)) => result,
                changed = self.stop.changed() => {
                    if changed.is_err() || *self.stop.borrow() {
                        self.state.send_replace(ConnectionState::Stopped);
                        return;
                    }
                    continue;
                }
            };
            match connection {
                Ok(Ok((socket, response))) => {
                    if response
                        .headers()
                        .get("Sec-WebSocket-Protocol")
                        .and_then(|value| value.to_str().ok())
                        != Some(PROTOCOL_VERSION)
                    {
                        self.state.send_replace(ConnectionState::InvalidEndpoint);
                        return;
                    }
                    failures = 0;
                    self.state.send_replace(ConnectionState::Connected);
                    if self.connected(socket).await.is_err() && !*self.stop.borrow() {
                        failures = 1;
                    }
                    if *self.state.borrow() == ConnectionState::PairingRequired {
                        return;
                    }
                }
                Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response)))
                    if matches!(response.status().as_u16(), 401 | 403) =>
                {
                    self.state.send_replace(ConnectionState::PairingRequired);
                    return;
                }
                Ok(Err(_)) | Err(_) => {
                    failures = failures.saturating_add(1).clamp(1, MAXIMUM_FAILURE_COUNT)
                }
            }
            if *self.stop.borrow() {
                self.state.send_replace(ConnectionState::Stopped);
                return;
            }
            self.state.send_replace(ConnectionState::Reconnecting);
            let base = 1_u64 << failures.min(MAXIMUM_BACKOFF_EXPONENT);
            let delay = Duration::from_millis(
                base.min(MAXIMUM_BACKOFF_SECONDS) * 1000
                    + rand::rng().random_range(0..BACKOFF_JITTER_MS),
            );
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                changed = self.stop.changed() => if changed.is_err() || *self.stop.borrow() { self.state.send_replace(ConnectionState::Stopped); return; }
            }
        }
    }

    async fn connected<S>(
        &mut self,
        socket: tokio_tungstenite::WebSocketStream<S>,
    ) -> Result<(), ()>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let (mut sink, mut stream) = socket.split();
        let mut readiness = tokio::time::interval(Duration::from_millis(READINESS_INTERVAL_MS));
        loop {
            tokio::select! {
                _ = readiness.tick() => {
                    let adapter = Arc::clone(&self.adapter);
                    let ready = tokio::select! {
                        result = tokio::time::timeout(ADAPTER_READY_TIMEOUT, adapter.ready()) => result.unwrap_or(false),
                        changed = self.stop.changed() => {
                            if changed.is_err() || *self.stop.borrow() {
                                let _ = send_close(&mut sink).await;
                                return Ok(());
                            }
                            false
                        }
                    };
                    let frame = DeviceFrame::Ready { protocol: PROTOCOL_VERSION.into(), usb_connected: ready };
                    if send_frame(&mut sink, &frame).await.is_err() { return Err(()); }
                }
                changed = self.stop.changed() => {
                    if changed.is_err() || *self.stop.borrow() {
                        let _ = send_close(&mut sink).await;
                        return Ok(());
                    }
                }
                message = stream.next() => match message {
                    Some(Ok(Message::Text(text))) if text.len() <= MAX_REQUEST_FRAME_BYTES => {
                        let DeviceFrame::Invoke { id, action: _, method, params } = serde_json::from_str(&text).map_err(|_| ())? else { return Err(()); };
                        let response = if id.is_empty() || id.len() > 128 {
                            DeviceFrame::Result { id, ok: false, result: None, error: Some(DeviceError::new("INVALID_REQUEST", "The request identifier is invalid", false)) }
                        } else if !self.completed.insert(id.clone()) {
                            DeviceFrame::Result { id, ok: false, result: None, error: Some(DeviceError::new("REPLAYED_REQUEST", "This request identifier was already processed", false)) }
                        } else {
                            self.completed_order.push_back(id.clone());
                            if self.completed_order.len() > COMPLETED_REQUEST_CACHE_SIZE { if let Some(old) = self.completed_order.pop_front() { self.completed.remove(&old); } }
                            let result = if !generated_actions::contains(&method) {
                                Err(DeviceError::new("METHOD_NOT_ALLOWED", "The requested method is not in the generated remote action contract", false))
                            } else if !self.access.borrow().permits(&method) {
                                Err(DeviceError::new("ACCESS_MODE_RESTRICTED", "The requested operation is outside this computer's remote access mode", false))
                            } else {
                                let adapter = Arc::clone(&self.adapter);
                                tokio::select! {
                                    result = tokio::time::timeout(
                                        ADAPTER_INVOKE_TIMEOUT,
                                        adapter.invoke(&method, params),
                                    ) => match result {
                                        Ok(result) => result,
                                        Err(_) => Err(DeviceError::new(
                                            "DEVICE_TIMEOUT",
                                            "The local device adapter did not complete the request before its deadline",
                                            true,
                                        )),
                                    },
                                    changed = self.stop.changed() => {
                                        if changed.is_err() || *self.stop.borrow() {
                                            let _ = send_close(&mut sink).await;
                                            return Ok(());
                                        }
                                        Err(DeviceError::new(
                                            "DEVICE_INTERRUPTED",
                                            "The local device request was interrupted",
                                            true,
                                        ))
                                    }
                                }
                            };
                            match result {
                                Ok(value) => DeviceFrame::Result { id, ok: true, result: Some(value), error: None },
                                Err(error) => DeviceFrame::Result { id, ok: false, result: None, error: Some(error) },
                            }
                        };
                        if send_frame(&mut sink, &response).await.is_err() { return Err(()); }
                    }
                    Some(Ok(Message::Ping(value))) => if send_message(&mut sink, Message::Pong(value)).await.is_err() { return Err(()); },
                    Some(Ok(Message::Close(Some(frame)))) if matches!(u16::from(frame.code), 4001 | 4003) => {
                        self.state.send_replace(ConnectionState::PairingRequired);
                        return Ok(());
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Err(()),
                    Some(Ok(Message::Text(_))) => { let _ = send_close(&mut sink).await; return Err(()); }
                    _ => {}
                }
            }
        }
    }
}

async fn send_frame<S>(sink: &mut S, frame: &DeviceFrame) -> Result<(), ()>
where
    S: futures_util::Sink<Message> + Unpin,
{
    let text = serde_json::to_string(frame).map_err(|_| ())?;
    if text.len() > MAX_RESULT_FRAME_BYTES {
        return Err(());
    }
    send_message(sink, Message::Text(text.into())).await
}

async fn send_message<S>(sink: &mut S, message: Message) -> Result<(), ()>
where
    S: futures_util::Sink<Message> + Unpin,
{
    tokio::time::timeout(SOCKET_SEND_TIMEOUT, sink.send(message))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

async fn send_close<S>(sink: &mut S) -> Result<(), ()>
where
    S: futures_util::Sink<Message> + Unpin,
{
    send_message(sink, Message::Close(None)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_policy_matches_mobile_security_boundary() {
        assert_eq!(
            normalize_endpoint(" https://relay.example.test/ ").unwrap(),
            "https://relay.example.test"
        );
        for invalid in [
            "http://relay.example.test",
            "https://token@relay.example.test",
            "https://relay.example.test/tenant",
            "https://relay.example.test?q=1",
        ] {
            assert!(normalize_endpoint(invalid).is_err());
        }
    }

    #[test]
    fn generated_policy_covers_reads_and_writes() {
        assert!(generated_actions::contains("device.snapshot"));
        assert!(generated_actions::contains("device.setChainSplit"));
        assert!(generated_actions::is_read_only("device.listModels"));
        assert!(AccessMode::Performance.permits("device.setTempo"));
        assert!(!AccessMode::Performance.permits("device.setParameter"));
        assert!(AccessMode::Modify.permits("device.setParameter"));
        assert!(!AccessMode::Modify.permits("device.setDeviceName"));
        assert!(AccessMode::Full.permits("device.setDeviceName"));
        assert!(!generated_actions::is_read_only("device.setTempo"));
        assert!(!generated_actions::contains("device.command.operation"));
    }
}
