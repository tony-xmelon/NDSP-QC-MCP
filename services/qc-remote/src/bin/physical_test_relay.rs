use qc_relay::{
    AppState, DeviceCredentialStore, OpaqueTokenIssuer, PairingManager, PrincipalId,
    PublicEndpointConfig, RelayHub, TlsTermination,
};
use qc_remote_service::application;
use serde_json::json;
use std::{env, fs, sync::Arc, time::Duration};

fn required(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("{name} is required"))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let public_url = required("QC_TEST_RELAY_PUBLIC_URL")?
        .trim_end_matches('/')
        .to_owned();
    let session_file = required("QC_TEST_RELAY_SESSION_FILE")?;
    let issuer_url = "https://physical-test-issuer.invalid";
    let principal = PrincipalId("physical-test".into());

    let bearer = Arc::new(OpaqueTokenIssuer::new());
    let bearer_token = bearer
        .provision_for_resource(
            principal.clone(),
            ["qc:control".into(), "qc:pair".into()],
            Duration::from_secs(6 * 60 * 60),
            issuer_url,
            public_url.clone(),
        )
        .await;
    let credentials = DeviceCredentialStore::new();
    let pairing = PairingManager::new(credentials.clone());
    let offer = pairing.create_offer(principal).await;
    let hub = RelayHub::new(credentials);
    let config = PublicEndpointConfig::new(
        &public_url,
        [issuer_url.into()],
        TlsTermination::TrustedProxy,
    )?;

    fs::write(
        &session_file,
        serde_json::to_vec_pretty(&json!({
            "publicUrl": public_url,
            "mcpEndpoint": format!("{public_url}/mcp"),
            "bearerToken": bearer_token,
            "pairingCode": offer.secret,
        }))?,
    )?;

    let app = application(AppState {
        config,
        bearer,
        pairing,
        hub,
    });
    let bind = env::var("QC_TEST_RELAY_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    println!("physical test relay listening on {bind}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}
