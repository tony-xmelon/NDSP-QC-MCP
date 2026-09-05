use async_trait::async_trait;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header::{AUTHORIZATION, WWW_AUTHENTICATE}, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use qc_relay::{
    AccessPrincipal, AppState, BearerTokenValidator, PrincipalId, PublicEndpointConfig, RelayError, RelayHub,
    TlsTermination,
};
use qc_remote_mcp::{BackendError, PrincipalRoute, QcBackend, QcMcp};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::{sync::Arc, time::{Duration, SystemTime, UNIX_EPOCH}};

#[derive(Clone)]
pub struct RelayBackend { hub: RelayHub }

impl RelayBackend { pub fn new(hub: RelayHub) -> Self { Self { hub } } }

#[async_trait]
impl QcBackend for RelayBackend {
    async fn request(&self, route: &PrincipalRoute, rpc: &'static str, params: Map<String, Value>) -> Result<Value, BackendError> {
        let principal = PrincipalId(route.principal_id.to_string());
        let device = if matches!(rpc, "device.reconnect" | "device.resetSession") {
            self.hub.connected_device_for_principal(&principal).await
        } else {
            self.hub.active_device_for_principal(&principal).await
        }
        .map_err(map_relay_error)?;
        self.hub.dispatch_validated_rpc(&principal, device, rpc, Value::Object(params)).await.map_err(map_relay_error)
    }
}

fn backend_error(code: &'static str, message: impl Into<String>, retryable: bool) -> BackendError {
    BackendError { code, message: message.into(), retryable }
}

fn map_relay_error(error: RelayError) -> BackendError {
    if matches!(error, RelayError::Device(_)) {
        return backend_error("device_error", "The paired device rejected the request", false);
    }
    let (code, retryable) = match error {
        RelayError::DeviceOffline | RelayError::Disconnected | RelayError::Timeout => ("device_unavailable", true),
        RelayError::Forbidden => ("forbidden", false),
        RelayError::AmbiguousDevice => ("ambiguous_device", false),
        RelayError::ConfirmationRequired | RelayError::ConfirmationArgumentRequired(_) => ("confirmation_required", false),
        RelayError::UnknownAction => ("unsupported_action", false),
        RelayError::InvalidArguments => ("invalid_arguments", false),
        RelayError::Device(_) => unreachable!("device errors are sanitized above"),
    };
    backend_error(code, error.to_string(), retryable)
}

#[derive(Clone)]
struct McpAuthState {
    config: PublicEndpointConfig,
    bearer: Arc<dyn BearerTokenValidator>,
}

pub fn application(state: AppState) -> Router {
    let backend = Arc::new(RelayBackend::new(state.hub.clone()));
    let auth_state = McpAuthState { config: state.config.clone(), bearer: state.bearer.clone() };
    let host = state.config.resource.host_str().expect("validated public relay URL");
    let mut allowed_hosts = vec![host.to_owned()];
    let port = state.config.resource.port_or_known_default().unwrap_or(443);
    allowed_hosts.push(format!("{host}:{port}"));
    let mcp = qc_remote_mcp::mcp_router_with_allowed_hosts(
        move || Ok(QcMcp::new(backend.clone())),
        allowed_hosts,
    )
        .route_layer(middleware::from_fn_with_state(auth_state, authenticate_mcp));
    qc_relay::router(state).merge(mcp)
}

async fn authenticate_mcp(
    State(state): State<McpAuthState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    if matches!(state.config.tls_termination, TlsTermination::TrustedProxy)
        && request.headers().get("x-forwarded-proto").and_then(|v| v.to_str().ok()) != Some("https") {
        return (StatusCode::UPGRADE_REQUIRED, "https_required").into_response();
    }
    let token = request.headers().get(AUTHORIZATION).and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let principal = match token {
        Some(token) => state.bearer.validate(token).await.ok(),
        None => None,
    };
    let valid = principal.filter(|principal| {
        principal.expires_at > SystemTime::now()
            && principal.audience == state.config.resource_identifier
            && principal.has_scope("qc:control")
            && state.config.authorization_server_issuers.iter().any(|issuer| issuer == &principal.issuer)
    });
    let Some(principal) = valid else { return mcp_unauthorized(&state.config); };
    request.extensions_mut().insert(PrincipalRoute::new(principal.subject.0, "auto"));
    next.run(request).await
}

fn mcp_unauthorized(config: &PublicEndpointConfig) -> Response {
    let mut response = (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    let challenge = format!(
        "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource\", scope=\"qc:control\"",
        config.resource_identifier.trim_end_matches('/')
    );
    if let Ok(value) = HeaderValue::from_str(&challenge) { response.headers_mut().insert(WWW_AUTHENTICATE, value); }
    response
}

#[derive(Clone)]
pub struct IntrospectionValidator {
    client: reqwest::Client,
    endpoint: String,
    client_id: String,
    client_secret: String,
}

impl IntrospectionValidator {
    pub fn new(endpoint: String, client_id: String, client_secret: String) -> Result<Self, String> {
        if !endpoint.starts_with("https://") { return Err("OAuth introspection endpoint must use HTTPS".into()); }
        Ok(Self { client: reqwest::Client::new(), endpoint, client_id, client_secret })
    }
}

#[derive(Deserialize)]
struct IntrospectionResponse {
    active: bool,
    sub: Option<String>,
    iss: Option<String>,
    aud: Option<Value>,
    exp: Option<u64>,
    #[serde(default)] scope: String,
}

#[async_trait]
impl BearerTokenValidator for IntrospectionValidator {
    async fn validate(&self, token: &str) -> Result<AccessPrincipal, qc_relay::auth::AuthError> {
        let result = self.client.post(&self.endpoint)
            .basic_auth(&self.client_id, Some(&self.client_secret))
            .form(&[("token", token)])
            .send().await.map_err(|_| qc_relay::auth::AuthError::Invalid)?
            .error_for_status().map_err(|_| qc_relay::auth::AuthError::Invalid)?
            .json::<IntrospectionResponse>().await.map_err(|_| qc_relay::auth::AuthError::Invalid)?;
        if !result.active { return Err(qc_relay::auth::AuthError::Invalid); }
        let subject = result.sub.filter(|v| !v.trim().is_empty()).ok_or(qc_relay::auth::AuthError::Invalid)?;
        let issuer = result.iss.ok_or(qc_relay::auth::AuthError::Invalid)?;
        let audience = match result.aud {
            Some(Value::String(value)) => value,
            Some(Value::Array(values)) if values.len() == 1 => values[0].as_str().unwrap_or_default().to_owned(),
            _ => return Err(qc_relay::auth::AuthError::Invalid),
        };
        let exp = result.exp.ok_or(qc_relay::auth::AuthError::Invalid)?;
        let expires_at = UNIX_EPOCH.checked_add(Duration::from_secs(exp)).ok_or(qc_relay::auth::AuthError::Invalid)?;
        if expires_at <= SystemTime::now() { return Err(qc_relay::auth::AuthError::Expired); }
        Ok(AccessPrincipal {
            subject: PrincipalId(subject), issuer, audience,
            scopes: result.scope.split_ascii_whitespace().map(str::to_owned).collect(),
            expires_at,
        })
    }
}
