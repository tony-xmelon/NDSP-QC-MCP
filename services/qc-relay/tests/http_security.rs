use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use qc_relay::{
    router, AppState, AuthorizationServerMetadata, DeviceCredentialStore, OpaqueTokenIssuer,
    PairingManager, PrincipalId, PublicEndpointConfig, RelayHub, TlsTermination,
};
use std::{sync::Arc, time::Duration};
use tower::ServiceExt;

fn app() -> axum::Router {
    let credentials = DeviceCredentialStore::new();
    let pairing = PairingManager::new(credentials.clone());
    router(AppState {
        config: PublicEndpointConfig::new(
            "https://relay.example.test",
            ["https://issuer.example.test".into()],
            TlsTermination::TrustedProxy,
        )
        .unwrap(),
        bearer: Arc::new(OpaqueTokenIssuer::new()),
        pairing,
        hub: RelayHub::new(credentials),
    })
}

#[tokio::test]
async fn rejects_insecure_public_configuration() {
    assert!(PublicEndpointConfig::new(
        "http://relay.example.test",
        ["https://issuer.example.test".into()],
        TlsTermination::Direct
    )
    .is_err());
    assert!(PublicEndpointConfig::from_authorization_server_metadata(
        "https://relay.example.test",
        [AuthorizationServerMetadata {
            issuer: "https://issuer.example.test".into(),
            code_challenge_methods_supported: vec!["plain".into()],
        }],
        TlsTermination::Direct,
    )
    .is_err());
}

#[tokio::test]
async fn metadata_is_public_but_control_is_not() {
    let metadata = app()
        .oneshot(
            Request::builder()
                .uri("/.well-known/oauth-protected-resource")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(metadata.status(), StatusCode::OK);
    let control = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/control/invoke")
                .header("content-type", "application/json")
                .header("x-forwarded-proto", "https")
                .body(Body::from(
                    r#"{"device_id":"x","action":"get_current_preset"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(control.status(), StatusCode::UNAUTHORIZED);
    let challenge = control
        .headers()
        .get("www-authenticate")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(challenge.contains(
        "resource_metadata=\"https://relay.example.test/.well-known/oauth-protected-resource\""
    ));
    assert!(challenge.contains("scope=\"qc:control\""));
}

#[tokio::test]
async fn trusted_proxy_mode_rejects_non_https_requests_before_auth() {
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/pairing/offers")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED);
}

#[tokio::test]
async fn enforces_exact_issuer_audience_and_scope_claims() {
    let issuer = OpaqueTokenIssuer::new();
    let wrong_audience = issuer
        .provision_for_resource(
            PrincipalId("alice".into()),
            ["qc:pair".into()],
            Duration::from_secs(60),
            "https://issuer.example.test",
            "https://other.example.test/",
        )
        .await;
    let credentials = DeviceCredentialStore::new();
    let state = AppState {
        config: PublicEndpointConfig::new(
            "https://relay.example.test",
            ["https://issuer.example.test".into()],
            TlsTermination::TrustedProxy,
        )
        .unwrap(),
        bearer: Arc::new(issuer.clone()),
        pairing: PairingManager::new(credentials.clone()),
        hub: RelayHub::new(credentials),
    };
    let response = router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/pairing/offers")
                .header("authorization", format!("Bearer {wrong_audience}"))
                .header("x-forwarded-proto", "https")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}
