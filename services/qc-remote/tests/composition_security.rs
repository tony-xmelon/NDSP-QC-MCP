use axum::{body::Body, http::{Request, StatusCode}};
use qc_relay::{
    AppState, DeviceCredentialStore, DeviceFrame, DeviceId, OpaqueTokenIssuer, PairingManager,
    PrincipalId, PublicEndpointConfig, RelayHub, TlsTermination,
};
use qc_remote_mcp::{PrincipalRoute, QcMcp};
use qc_remote_service::{application, RelayBackend};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tower::ServiceExt;

async fn app_and_token(audience: &str) -> (axum::Router, String) {
    let issuer = Arc::new(OpaqueTokenIssuer::new());
    let token = issuer.provision_for_resource(
        PrincipalId("user-a".into()),
        ["qc:control".into(), "qc:pair".into()],
        Duration::from_secs(60),
        "https://auth.example.test",
        audience,
    ).await;
    let credentials = DeviceCredentialStore::new();
    let state = AppState {
        config: PublicEndpointConfig::new(
            "https://relay.example.test",
            ["https://auth.example.test".into()],
            TlsTermination::TrustedProxy,
        ).unwrap(),
        bearer: issuer,
        pairing: PairingManager::new(credentials.clone()),
        hub: RelayHub::new(credentials),
    };
    (application(state), token)
}

#[tokio::test]
async fn mcp_is_never_available_without_oauth() {
    let (app, _) = app_and_token("https://relay.example.test").await;
    let response = app.oneshot(Request::builder()
        .method("POST").uri("/mcp")
        .header("x-forwarded-proto", "https")
        .body(Body::from("{}" )).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(response.headers().get("www-authenticate").unwrap().to_str().unwrap()
        .contains("/.well-known/oauth-protected-resource"));
}

#[tokio::test]
async fn mcp_rejects_a_token_minted_for_another_resource() {
    let (app, token) = app_and_token("https://other.example.test/").await;
    let response = app.oneshot(Request::builder()
        .method("POST").uri("/mcp")
        .header("x-forwarded-proto", "https")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from("{}" )).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn valid_oauth_reaches_rmcp_instead_of_auth_rejection() {
    let (app, token) = app_and_token("https://relay.example.test").await;
    let response = app.oneshot(Request::builder()
        .method("POST").uri("/mcp")
        .header("x-forwarded-proto", "https")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from("{}" )).unwrap()).await.unwrap();
    assert_ne!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn validated_mcp_call_round_trips_through_the_paired_phone() {
    let credentials = DeviceCredentialStore::new();
    let pairing = PairingManager::new(credentials.clone());
    let principal = PrincipalId("user-a".into());
    let offer = pairing.create_offer(principal.clone()).await;
    let receipt = pairing.redeem(&offer.secret, DeviceId("phone-a".into()), "test-ip").await.unwrap();
    let credential = credentials.validate(&receipt.device_token).await.unwrap();
    let hub = RelayHub::new(credentials);
    let mut phone = hub.connect(credential).await;
    phone.set_ready(true);
    let responder = tokio::spawn(async move {
        let DeviceFrame::Invoke { id, action, method, .. } = phone.outbound.recv().await.unwrap() else { panic!("invoke expected") };
        assert_eq!(action, "get_current_preset");
        assert_eq!(method, "device.snapshot");
        phone.accept(DeviceFrame::Result {
            id,
            ok: true,
            result: Some(json!({
                "deviceName": "Test QC",
                "presetName": "Relay Clean",
                "presetLocation": "1A",
                "presetPosition": 0,
                "setlistKey": "factory",
                "setlistName": "Factory",
                "mode": "PRESET",
                "activeScene": 0,
                "scenes": ["A", "B", "C", "D", "E", "F", "G", "H"],
                "blocks": [],
                "routes": [],
                "tempo": 120,
                "masterVolume": 50.0,
                "dirty": false
            })),
            error: None,
        }).await;
    });
    let mcp = QcMcp::new(Arc::new(RelayBackend::new(hub)));
    let result = mcp.execute(
        &PrincipalRoute::new("user-a", "auto"),
        "get_current_preset",
        None,
    ).await.unwrap();
    assert_eq!(result["presetName"], "Relay Clean");
    responder.await.unwrap();
}
