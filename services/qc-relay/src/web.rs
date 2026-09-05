use crate::{
    auth::{AccessPrincipal, BearerTokenValidator},
    pairing::{DeviceId, PairingError, PairingManager},
    protocol::{
        DeviceFrame, PrincipalInvokeRequest, DEVICE_CONNECT_PATH, DEVICE_PAIR_PATH,
        MAX_REQUEST_FRAME_BYTES, MAX_RESULT_FRAME_BYTES, PROTOCOL_VERSION,
    },
    relay::{RelayError, RelayHub},
};
use axum::{
    extract::{
        ws::{Message, WebSocket},
        ConnectInfo, DefaultBodyLimit, State, WebSocketUpgrade,
    },
    http::{
        header::{AUTHORIZATION, WWW_AUTHENTICATE},
        HeaderMap, HeaderValue, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{net::SocketAddr, sync::Arc};
use url::Url;

#[derive(Clone, Copy, Debug)]
pub enum TlsTermination {
    Direct,
    TrustedProxy,
}

#[derive(Clone, Debug)]
pub struct PublicEndpointConfig {
    pub resource: Url,
    /// Lexically exact OAuth resource identifier used for `resource` and `aud`.
    pub resource_identifier: String,
    pub authorization_servers: Vec<Url>,
    /// Lexically exact issuer identifiers; URL parsing must not add/remove `/`.
    pub authorization_server_issuers: Vec<String>,
    pub tls_termination: TlsTermination,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AuthorizationServerMetadata {
    pub issuer: String,
    #[serde(default)]
    pub code_challenge_methods_supported: Vec<String>,
}

impl PublicEndpointConfig {
    pub fn new(
        resource: &str,
        authorization_servers: impl IntoIterator<Item = String>,
        tls_termination: TlsTermination,
    ) -> Result<Self, String> {
        let resource_identifier = resource.to_owned();
        let resource = Url::parse(&resource_identifier).map_err(|error| error.to_string())?;
        if resource.scheme() != "https" {
            return Err("public relay resource URL must use https".into());
        }
        let authorization_server_issuers = authorization_servers.into_iter().collect::<Vec<_>>();
        let authorization_servers = authorization_server_issuers
            .iter()
            .map(|value| Url::parse(value).map_err(|error| error.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        if authorization_servers.is_empty()
            || authorization_servers
                .iter()
                .any(|url| url.scheme() != "https")
        {
            return Err("at least one https authorization server is required".into());
        }
        Ok(Self {
            resource,
            resource_identifier,
            authorization_servers,
            authorization_server_issuers,
            tls_termination,
        })
    }

    /// Builds configuration from fetched authorization-server metadata and
    /// refuses issuers that do not advertise OAuth 2.1 S256 PKCE.
    pub fn from_authorization_server_metadata(
        resource: &str,
        servers: impl IntoIterator<Item = AuthorizationServerMetadata>,
        tls_termination: TlsTermination,
    ) -> Result<Self, String> {
        let servers = servers.into_iter().collect::<Vec<_>>();
        if servers.iter().any(|server| {
            !server
                .code_challenge_methods_supported
                .iter()
                .any(|method| method == "S256")
        }) {
            return Err("every authorization server must advertise S256 PKCE".into());
        }
        Self::new(
            resource,
            servers.into_iter().map(|server| server.issuer),
            tls_termination,
        )
    }
}

#[derive(Clone)]
pub struct AppState {
    pub config: PublicEndpointConfig,
    pub bearer: Arc<dyn BearerTokenValidator>,
    pub pairing: PairingManager,
    pub hub: RelayHub,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/.well-known/oauth-protected-resource", get(metadata))
        .route("/v1/pairing/offers", post(create_pairing))
        .route("/v1/pairing/redeem", post(redeem_pairing))
        .route(DEVICE_PAIR_PATH, post(pair_device))
        .route("/v1/devices/revoke", post(revoke_device))
        .route("/v1/control/invoke", post(invoke))
        .route(DEVICE_CONNECT_PATH, get(connect_device))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_FRAME_BYTES))
        .with_state(state)
}

async fn metadata(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "resource": state.config.resource_identifier,
        "authorization_servers": state.config.authorization_server_issuers,
        "bearer_methods_supported": ["header"],
        "scopes_supported": ["qc:control", "qc:pair"]
    }))
}

async fn principal(
    headers: &HeaderMap,
    state: &AppState,
    scope: &str,
) -> Result<AccessPrincipal, ApiError> {
    enforce_proxy_https(headers, &state.config)?;
    let challenge = || ApiError::Unauthorized {
        resource: state.config.resource_identifier.clone(),
        scope: scope.to_owned(),
    };
    let value = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(challenge)?;
    let token = value
        .strip_prefix("Bearer ")
        .filter(|value| !value.is_empty())
        .ok_or_else(challenge)?;
    let principal = state
        .bearer
        .validate(token)
        .await
        .map_err(|_| challenge())?;
    if principal.expires_at <= std::time::SystemTime::now()
        || principal.audience != state.config.resource_identifier
        || !state
            .config
            .authorization_server_issuers
            .iter()
            .any(|issuer| issuer == &principal.issuer)
        || !principal.has_scope(scope)
    {
        return Err(challenge());
    }
    Ok(principal)
}

fn enforce_proxy_https(headers: &HeaderMap, config: &PublicEndpointConfig) -> Result<(), ApiError> {
    if matches!(config.tls_termination, TlsTermination::TrustedProxy)
        && headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            != Some("https")
    {
        return Err(ApiError::HttpsRequired);
    }
    Ok(())
}

async fn create_pairing(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = principal(&headers, &state, "qc:pair").await?;
    let offer = state.pairing.create_offer(user.subject).await;
    Ok(Json(serde_json::to_value(offer).unwrap()))
}

#[derive(Deserialize)]
struct RedeemBody {
    secret: String,
    device_id: DeviceId,
}

async fn redeem_pairing(
    State(state): State<AppState>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<RedeemBody>,
) -> Result<Json<Value>, ApiError> {
    enforce_proxy_https(&headers, &state.config)?;
    let receipt = state
        .pairing
        .redeem(&body.secret, body.device_id, &address.ip().to_string())
        .await
        .map_err(ApiError::Pairing)?;
    Ok(Json(serde_json::to_value(receipt).unwrap()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicePairBody {
    pairing_code: String,
    device_name: String,
    protocol: String,
}

async fn pair_device(
    State(state): State<AppState>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<DevicePairBody>,
) -> Result<Json<Value>, ApiError> {
    enforce_proxy_https(&headers, &state.config)?;
    if body.protocol != PROTOCOL_VERSION || body.device_name.trim().is_empty() {
        return Err(ApiError::BadProtocol);
    }
    // Device IDs are server-generated so user-supplied names cannot collide across principals.
    let device_id = DeviceId(uuid::Uuid::new_v4().to_string());
    let receipt = state
        .pairing
        .redeem(
            &body.pairing_code,
            device_id.clone(),
            &address.ip().to_string(),
        )
        .await
        .map_err(ApiError::Pairing)?;
    Ok(Json(
        json!({ "deviceCredential": receipt.device_token, "deviceId": device_id }),
    ))
}

#[derive(Deserialize)]
struct RevokeBody {
    device_id: DeviceId,
}

async fn revoke_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RevokeBody>,
) -> Result<StatusCode, ApiError> {
    let user = principal(&headers, &state, "qc:pair").await?;
    state
        .pairing
        .credentials()
        .revoke_device(&user.subject, &body.device_id)
        .await
        .map_err(ApiError::Pairing)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn invoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PrincipalInvokeRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = principal(&headers, &state, "qc:control").await?;
    let result = state
        .hub
        .invoke_for_principal(&user.subject, body)
        .await
        .map_err(ApiError::Relay)?;
    Ok(Json(result))
}

async fn connect_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    enforce_proxy_https(&headers, &state.config)?;
    let unauthorized = || ApiError::Unauthorized {
        resource: state.config.resource_identifier.clone(),
        scope: "qc:device".to_owned(),
    };
    let value = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(unauthorized)?;
    let token = value.strip_prefix("Bearer ").ok_or_else(unauthorized)?;
    let supports_protocol = headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|item| item.trim() == PROTOCOL_VERSION));
    if !supports_protocol {
        return Err(ApiError::BadProtocol);
    }
    let credential = state
        .pairing
        .credentials()
        .validate(token)
        .await
        .map_err(ApiError::Pairing)?;
    Ok(ws
        .protocols([PROTOCOL_VERSION])
        .on_upgrade(move |socket| device_socket(socket, state.hub, credential))
        .into_response())
}

async fn device_socket(
    socket: WebSocket,
    hub: RelayHub,
    credential: crate::pairing::DeviceCredential,
) {
    let mut connection = hub.connect(credential).await;
    let (mut sink, mut stream) = socket.split();
    loop {
        tokio::select! {
            outbound = connection.outbound.recv() => match outbound {
                Some(frame) => match serde_json::to_string(&frame) {
                    Ok(text) if text.len() <= MAX_REQUEST_FRAME_BYTES => if sink.send(Message::Text(text.into())).await.is_err() { break; },
                    Err(_) => break,
                    _ => break,
                },
                None => break,
            },
            inbound = stream.next() => match inbound {
                Some(Ok(Message::Text(text))) if text.len() <= MAX_RESULT_FRAME_BYTES => match serde_json::from_str::<DeviceFrame>(&text) {
                    Ok(frame @ DeviceFrame::Result { .. }) => connection.accept(frame).await,
                    Ok(frame @ DeviceFrame::Ready { .. }) => connection.accept(frame).await,
                    _ => break,
                },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
    connection.disconnect().await;
}

#[derive(Debug)]
enum ApiError {
    Unauthorized { resource: String, scope: String },
    HttpsRequired,
    BadProtocol,
    Pairing(PairingError),
    Relay(RelayError),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let challenge = match &self {
            Self::Unauthorized { resource, scope } => Some(format!("Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource\", scope=\"{}\"", resource.trim_end_matches('/'), scope)),
            _ => None,
        };
        let (status, code) = match self {
            Self::Unauthorized { .. } => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::HttpsRequired => (StatusCode::UPGRADE_REQUIRED, "https_required"),
            Self::BadProtocol => (StatusCode::BAD_REQUEST, "unsupported_protocol"),
            Self::Pairing(PairingError::RateLimited) => {
                (StatusCode::TOO_MANY_REQUESTS, "rate_limited")
            }
            Self::Pairing(PairingError::WrongPrincipal) | Self::Relay(RelayError::Forbidden) => {
                (StatusCode::FORBIDDEN, "forbidden")
            }
            Self::Pairing(_) => (StatusCode::UNAUTHORIZED, "invalid_pairing"),
            Self::Relay(RelayError::UnknownAction) => (StatusCode::BAD_REQUEST, "unknown_action"),
            Self::Relay(RelayError::InvalidArguments) => (StatusCode::BAD_REQUEST, "invalid_arguments"),
            Self::Relay(
                RelayError::ConfirmationRequired | RelayError::ConfirmationArgumentRequired(_),
            ) => (StatusCode::PRECONDITION_REQUIRED, "confirmation_required"),
            Self::Relay(RelayError::DeviceOffline | RelayError::Disconnected) => {
                (StatusCode::SERVICE_UNAVAILABLE, "device_offline")
            }
            Self::Relay(RelayError::AmbiguousDevice) => (StatusCode::CONFLICT, "ambiguous_device"),
            Self::Relay(RelayError::Timeout) => (StatusCode::GATEWAY_TIMEOUT, "device_timeout"),
            Self::Relay(RelayError::Device(_)) => (StatusCode::BAD_GATEWAY, "device_error"),
        };
        let mut response = (status, Json(json!({ "error": code }))).into_response();
        if let Some(value) = challenge.and_then(|value| HeaderValue::from_str(&value).ok()) {
            response.headers_mut().insert(WWW_AUTHENTICATE, value);
        }
        response
    }
}
