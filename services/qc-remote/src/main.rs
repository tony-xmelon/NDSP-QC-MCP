use qc_relay::{
    AppState, AuthorizationServerMetadata, DeviceCredentialStore, PairingManager,
    PublicEndpointConfig, RelayHub, TlsTermination,
};
use qc_remote_service::{application, IntrospectionValidator};
use std::{env, sync::Arc};

fn required(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("{name} is required"))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let resource = required("QC_RELAY_PUBLIC_URL")?;
    let issuer = required("QC_RELAY_ISSUER_URL")?;
    let metadata_url = format!("{}/.well-known/oauth-authorization-server", issuer.trim_end_matches('/'));
    let metadata = reqwest::get(&metadata_url).await?.error_for_status()?.json::<AuthorizationServerMetadata>().await?;
    if metadata.issuer != issuer {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "authorization-server metadata issuer mismatch: expected {issuer}, received {}",
                metadata.issuer
            ),
        )
        .into());
    }
    let config = PublicEndpointConfig::from_authorization_server_metadata(
        &resource, [metadata], TlsTermination::TrustedProxy,
    )?;
    let bearer = Arc::new(IntrospectionValidator::new(
        required("QC_RELAY_INTROSPECTION_URL")?,
        required("QC_RELAY_OAUTH_CLIENT_ID")?,
        required("QC_RELAY_OAUTH_CLIENT_SECRET")?,
    )?);
    let credentials = DeviceCredentialStore::new();
    let pairing = PairingManager::new(credentials.clone());
    let hub = RelayHub::new(credentials);
    let app = application(AppState { config, bearer, pairing, hub });
    let bind = env::var("QC_RELAY_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await?;
    Ok(())
}
