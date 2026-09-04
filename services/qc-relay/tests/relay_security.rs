use qc_relay::{
    auth::{AuthError, BearerTokenValidator},
    pairing::{DeviceId, PairingError},
    protocol::{ConfirmationProof, DeviceFrame, InvokeRequest, PrincipalInvokeRequest},
    DeviceCredentialStore, OpaqueTokenIssuer, PairingManager, PrincipalId, RelayError, RelayHub,
};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn opaque_tokens_expire_revoke_and_enforce_scope() {
    let issuer = OpaqueTokenIssuer::new();
    let token = issuer
        .provision(
            PrincipalId("alice".into()),
            ["qc:control".into()],
            Duration::from_secs(60),
        )
        .await;
    let principal = issuer.validate(&token).await.unwrap();
    assert_eq!(principal.subject, PrincipalId("alice".into()));
    assert!(principal.has_scope("qc:control"));
    assert!(issuer.revoke(&token).await);
    assert_eq!(
        issuer.validate(&token).await.unwrap_err(),
        AuthError::Revoked
    );
}

#[tokio::test]
async fn pairing_is_one_time_rate_limited_and_revocable() {
    let credentials = DeviceCredentialStore::new();
    let pairing = PairingManager::new(credentials.clone()).with_limits(
        Duration::from_secs(60),
        Duration::from_secs(60),
        2,
        Duration::from_secs(60),
    );
    let offer = pairing.create_offer(PrincipalId("alice".into())).await;
    let receipt = pairing
        .redeem(&offer.secret, DeviceId("phone-a".into()), "198.51.100.7")
        .await
        .unwrap();
    assert_eq!(
        pairing
            .redeem(&offer.secret, DeviceId("phone-b".into()), "198.51.100.8")
            .await
            .unwrap_err(),
        PairingError::Replayed
    );
    let credential = credentials.validate(&receipt.device_token).await.unwrap();
    credentials
        .revoke_device(&PrincipalId("alice".into()), &credential.device_id)
        .await
        .unwrap();
    assert_eq!(
        credentials
            .validate(&receipt.device_token)
            .await
            .unwrap_err(),
        PairingError::InvalidDeviceCredential
    );

    for _ in 0..2 {
        assert_eq!(
            pairing
                .redeem("bad", DeviceId("x".into()), "203.0.113.1")
                .await
                .unwrap_err(),
            PairingError::InvalidOrExpired
        );
    }
    assert_eq!(
        pairing
            .redeem("bad", DeviceId("x".into()), "203.0.113.1")
            .await
            .unwrap_err(),
        PairingError::RateLimited
    );
}

async fn paired(
    name: &str,
    device: &str,
    credentials: &DeviceCredentialStore,
    pairing: &PairingManager,
) -> (PrincipalId, qc_relay::DeviceCredential) {
    let principal = PrincipalId(name.into());
    let offer = pairing.create_offer(principal.clone()).await;
    let receipt = pairing
        .redeem(&offer.secret, DeviceId(device.into()), name)
        .await
        .unwrap();
    (
        principal,
        credentials.validate(&receipt.device_token).await.unwrap(),
    )
}

#[tokio::test]
async fn routes_calls_only_to_the_owning_principal_and_correlates_results() {
    let credentials = DeviceCredentialStore::new();
    let pairing = PairingManager::new(credentials.clone());
    let (alice, alice_device) = paired("alice", "phone-a", &credentials, &pairing).await;
    let (bob, _) = paired("bob", "phone-b", &credentials, &pairing).await;
    let hub = RelayHub::with_timeout(credentials, Duration::from_secs(1));
    let mut connection = hub.connect(alice_device).await;
    connection.set_ready(true);

    let forbidden = hub
        .invoke(
            &bob,
            InvokeRequest {
                device_id: DeviceId("phone-a".into()),
                action: "get_current_preset".into(),
                arguments: json!({}),
                confirmation: None,
            },
        )
        .await;
    assert_eq!(forbidden.unwrap_err(), RelayError::Forbidden);

    let caller = {
        let hub = hub.clone();
        let alice = alice.clone();
        tokio::spawn(async move {
            hub.invoke(
                &alice,
                InvokeRequest {
                    device_id: DeviceId("phone-a".into()),
                    action: "get_current_preset".into(),
                    arguments: json!({}),
                    confirmation: None,
                },
            )
            .await
        })
    };
    let DeviceFrame::Invoke {
        id, action, method, ..
    } = connection.outbound.recv().await.unwrap()
    else {
        panic!()
    };
    assert_eq!(action, "get_current_preset");
    assert_eq!(method, "device.snapshot");
    connection
        .accept(DeviceFrame::Result {
            id,
            ok: true,
            result: Some(json!({"preset":"Clean"})),
            error: None,
        })
        .await;
    assert_eq!(caller.await.unwrap().unwrap(), json!({"preset":"Clean"}));
}

#[tokio::test]
async fn reconnect_can_reach_a_connected_phone_while_usb_is_not_ready() {
    let credentials = DeviceCredentialStore::new();
    let pairing = PairingManager::new(credentials.clone());
    let (alice, credential) = paired("alice", "phone-a", &credentials, &pairing).await;
    let hub = RelayHub::with_timeout(credentials, Duration::from_secs(1));
    let mut connection = hub.connect(credential).await;

    assert_eq!(
        hub.active_device_for_principal(&alice).await.unwrap_err(),
        RelayError::DeviceOffline
    );
    assert_eq!(
        hub.connected_device_for_principal(&alice).await.unwrap(),
        DeviceId("phone-a".into())
    );
    assert_eq!(
        hub.dispatch_validated_rpc(
            &alice,
            DeviceId("phone-a".into()),
            "device.snapshot",
            json!({}),
        )
        .await
        .unwrap_err(),
        RelayError::DeviceOffline
    );

    let caller = {
        let hub = hub.clone();
        let alice = alice.clone();
        tokio::spawn(async move {
            hub.dispatch_validated_rpc(
                &alice,
                DeviceId("phone-a".into()),
                "device.reconnect",
                json!({}),
            )
            .await
        })
    };
    let DeviceFrame::Invoke { id, method, .. } = connection.outbound.recv().await.unwrap() else {
        panic!()
    };
    assert_eq!(method, "device.reconnect");
    connection
        .accept(DeviceFrame::Result {
            id,
            ok: true,
            result: Some(json!({"connected": true})),
            error: None,
        })
        .await;
    assert_eq!(caller.await.unwrap().unwrap(), json!({"connected": true}));
}

#[tokio::test]
async fn backup_can_outlive_the_ordinary_relay_request_window() {
    let credentials = DeviceCredentialStore::new();
    let pairing = PairingManager::new(credentials.clone());
    let (principal, credential) = paired("alice", "phone-a", &credentials, &pairing).await;
    let device = DeviceId("phone-a".into());
    let hub = RelayHub::with_timeout(credentials, Duration::from_millis(20));
    let mut phone = hub.connect(credential).await;
    phone.set_ready(true);

    let responder = tokio::spawn(async move {
        let DeviceFrame::Invoke { id, method, .. } = phone.outbound.recv().await.unwrap() else {
            panic!("invoke expected");
        };
        assert_eq!(method, "device.createBackup");
        tokio::time::sleep(Duration::from_millis(40)).await;
        phone
            .accept(DeviceFrame::Result {
                id,
                ok: true,
                result: Some(json!({"type": "qc-backup"})),
                error: None,
            })
            .await;
    });

    let result = hub
        .dispatch_validated_rpc(
            &principal,
            device,
            "device.createBackup",
            json!({"name": "test", "confirmPersistentWrite": true}),
        )
        .await
        .unwrap();
    assert_eq!(result["type"], "qc-backup");
    responder.await.unwrap();
}

#[tokio::test]
async fn reconnect_replaces_old_session_and_fails_pending_requests() {
    let credentials = DeviceCredentialStore::new();
    let pairing = PairingManager::new(credentials.clone());
    let (alice, credential) = paired("alice", "phone-a", &credentials, &pairing).await;
    let hub = RelayHub::with_timeout(credentials, Duration::from_secs(1));
    let mut old = hub.connect(credential.clone()).await;
    old.set_ready(true);
    let pending = {
        let hub = hub.clone();
        tokio::spawn(async move {
            hub.invoke(
                &alice,
                InvokeRequest {
                    device_id: DeviceId("phone-a".into()),
                    action: "get_current_preset".into(),
                    arguments: json!({}),
                    confirmation: None,
                },
            )
            .await
        })
    };
    old.outbound.recv().await.unwrap();
    let _new = hub.connect(credential).await;
    assert_eq!(
        pending.await.unwrap().unwrap_err(),
        RelayError::Disconnected
    );
    old.disconnect().await; // Must not remove the replacement session.
}

#[tokio::test]
async fn risky_and_persistent_actions_require_layered_confirmation() {
    let credentials = DeviceCredentialStore::new();
    let pairing = PairingManager::new(credentials.clone());
    let (alice, credential) = paired("alice", "phone-a", &credentials, &pairing).await;
    let hub = RelayHub::with_timeout(credentials, Duration::from_millis(20));
    let connection = hub.connect(credential).await;
    connection.set_ready(true);
    let base = InvokeRequest {
        device_id: DeviceId("phone-a".into()),
        action: "set_master_volume".into(),
        arguments: json!({"confirm_risky_operation":true}),
        confirmation: None,
    };
    assert_eq!(
        hub.invoke(&alice, base).await.unwrap_err(),
        RelayError::ConfirmationRequired
    );
    let missing_field = InvokeRequest {
        device_id: DeviceId("phone-a".into()),
        action: "save_preset_as".into(),
        arguments: json!({}),
        confirmation: Some(ConfirmationProof {
            approved: true,
            source: "ChatGPT confirmation".into(),
        }),
    };
    assert_eq!(
        hub.invoke(&alice, missing_field).await.unwrap_err(),
        RelayError::ConfirmationArgumentRequired("confirm_overwrite".into())
    );
}

#[tokio::test]
async fn principal_routing_refuses_ambiguous_active_devices() {
    let credentials = DeviceCredentialStore::new();
    let pairing = PairingManager::new(credentials.clone());
    let (alice, first) = paired("alice", "phone-a", &credentials, &pairing).await;
    let (_, second) = paired("alice", "phone-b", &credentials, &pairing).await;
    let hub = RelayHub::new(credentials);
    let first_connection = hub.connect(first).await;
    let second_connection = hub.connect(second).await;
    first_connection.set_ready(true);
    second_connection.set_ready(true);
    let error = hub
        .invoke_for_principal(
            &alice,
            PrincipalInvokeRequest {
                action: "get_current_preset".into(),
                arguments: json!({}),
                confirmation: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error, RelayError::AmbiguousDevice);
}
