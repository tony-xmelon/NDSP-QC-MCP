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
    tungstenite::{client::IntoClientRequest, Message},
};

pub use qc_relay_protocol::{
    DeviceError, DeviceFrame, MAX_REQUEST_FRAME_BYTES, MAX_RESULT_FRAME_BYTES, PROTOCOL_VERSION,
};

mod generated_actions;

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
            "full" => Ok(Self::Full),
            "modify" => Ok(Self::Modify),
            "performance" => Ok(Self::Performance),
            "read-only" => Ok(Self::ReadOnly),
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
    if !(6..=128).contains(&code.len()) || name.is_empty() {
        return Err("A valid pairing code and device name are required".into());
    }
    let response = reqwest::Client::new()
        .post(format!("{endpoint}/v1/device/pair"))
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
    if receipt.device_credential.len() < 24 || receipt.device_id.trim().is_empty() {
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
            "wss://{}/v1/device/connect",
            endpoint.trim_start_matches("https://")
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
                PROTOCOL_VERSION.parse().expect("static protocol header"),
            );
            match connect_async(request).await {
                Ok((socket, response)) => {
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
                Err(tokio_tungstenite::tungstenite::Error::Http(response))
                    if matches!(response.status().as_u16(), 401 | 403) =>
                {
                    self.state.send_replace(ConnectionState::PairingRequired);
                    return;
                }
                Err(_) => failures = failures.saturating_add(1).max(1),
            }
            if *self.stop.borrow() {
                self.state.send_replace(ConnectionState::Stopped);
                return;
            }
            self.state.send_replace(ConnectionState::Reconnecting);
            let base = 1_u64 << failures.min(6);
            let delay =
                Duration::from_millis(base.min(60) * 1000 + rand::rng().random_range(0..1000));
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
        let mut readiness = tokio::time::interval(Duration::from_secs(1));
        let mut completed = HashSet::new();
        let mut completed_order = VecDeque::new();
        loop {
            tokio::select! {
                _ = readiness.tick() => {
                    let frame = DeviceFrame::Ready { protocol: PROTOCOL_VERSION.into(), usb_connected: self.adapter.ready().await };
                    if send_frame(&mut sink, &frame).await.is_err() { return Err(()); }
                }
                changed = self.stop.changed() => {
                    if changed.is_err() || *self.stop.borrow() {
                        let _ = sink.send(Message::Close(None)).await;
                        return Ok(());
                    }
                }
                message = stream.next() => match message {
                    Some(Ok(Message::Text(text))) if text.len() <= MAX_REQUEST_FRAME_BYTES => {
                        let DeviceFrame::Invoke { id, action: _, method, params } = serde_json::from_str(&text).map_err(|_| ())? else { return Err(()); };
                        let response = if !completed.insert(id.clone()) {
                            DeviceFrame::Result { id, ok: false, result: None, error: Some(DeviceError::new("REPLAYED_REQUEST", "This request identifier was already processed", false)) }
                        } else {
                            completed_order.push_back(id.clone());
                            if completed_order.len() > 512 { if let Some(old) = completed_order.pop_front() { completed.remove(&old); } }
                            let result = if !generated_actions::contains(&method) {
                                Err(DeviceError::new("METHOD_NOT_ALLOWED", "The requested method is not in the generated remote action contract", false))
                            } else if !self.access.borrow().permits(&method) {
                                Err(DeviceError::new("ACCESS_MODE_RESTRICTED", "The requested operation is outside this computer's remote access mode", false))
                            } else { self.adapter.invoke(&method, params).await };
                            match result {
                                Ok(value) => DeviceFrame::Result { id, ok: true, result: Some(value), error: None },
                                Err(error) => DeviceFrame::Result { id, ok: false, result: None, error: Some(error) },
                            }
                        };
                        if send_frame(&mut sink, &response).await.is_err() { return Err(()); }
                    }
                    Some(Ok(Message::Ping(value))) => if sink.send(Message::Pong(value)).await.is_err() { return Err(()); },
                    Some(Ok(Message::Close(Some(frame)))) if matches!(u16::from(frame.code), 4001 | 4003) => {
                        self.state.send_replace(ConnectionState::PairingRequired);
                        return Ok(());
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Err(()),
                    Some(Ok(Message::Text(_))) => { let _ = sink.send(Message::Close(None)).await; return Err(()); }
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
    sink.send(Message::Text(text.into())).await.map_err(|_| ())
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
