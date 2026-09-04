use async_trait::async_trait;
use qc_remote_mcp::{ACTIONS, BackendError, PrincipalRoute, QcBackend, QcMcp};
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct RecordingBackend(Mutex<Vec<(&'static str, Map<String, Value>)>>);

#[async_trait]
impl QcBackend for RecordingBackend {
    async fn request(
        &self,
        _: &PrincipalRoute,
        rpc: &'static str,
        params: Map<String, Value>,
    ) -> Result<Value, BackendError> {
        self.0.lock().unwrap().push((rpc, params.clone()));
        Ok(json!({"method":rpc,"params":params}))
    }
}

fn server() -> (QcMcp, Arc<RecordingBackend>) {
    let backend = Arc::new(RecordingBackend::default());
    (QcMcp::new(backend.clone()), backend)
}

fn route() -> PrincipalRoute {
    PrincipalRoute::new("user-1", "device-1")
}

#[test]
fn static_map_has_exact_contract_names_and_rpcs() {
    let contract: Value =
        serde_json::from_str(include_str!("../../../contracts/qc-actions.v1.json")).unwrap();
    let expected: Vec<_> = contract["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| (a["name"].as_str().unwrap(), a["rpc"].as_str().unwrap()))
        .collect();
    let actual: Vec<_> = ACTIONS.iter().map(|a| (a.name, a.rpc)).collect();
    assert_eq!(actual, expected);

    for (spec, action) in ACTIONS.iter().zip(contract["actions"].as_array().unwrap()) {
        let contract_properties = action["properties"].as_object().unwrap();
        let actual_properties = spec
            .properties
            .iter()
            .map(|property| property.name)
            .collect::<std::collections::HashSet<_>>();
        let expected_properties = contract_properties
            .keys()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            actual_properties, expected_properties,
            "property drift for {}",
            spec.name
        );
        let actual_required = spec
            .properties
            .iter()
            .filter(|property| property.required)
            .map(|property| property.name)
            .collect::<std::collections::HashSet<_>>();
        let expected_required = action["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            actual_required, expected_required,
            "required-field drift for {}",
            spec.name
        );
        let classification = match spec.classification {
            qc_remote_mcp::Classification::Read => "read",
            qc_remote_mcp::Classification::LiveWrite => "live-write",
            qc_remote_mcp::Classification::PersistentWrite => "persistent-write",
            qc_remote_mcp::Classification::RiskyWrite => "risky-write",
        };
        assert_eq!(
            classification,
            action["classification"].as_str().unwrap(),
            "classification drift for {}",
            spec.name
        );
    }
}

#[test]
fn surface_has_only_intent_tools_and_three_resources() {
    let (server, _) = server();
    let tools = server.tools();
    assert_eq!(tools.len(), ACTIONS.len());
    assert!(
        tools
            .iter()
            .all(|t| !t.name.contains("raw") && !t.name.contains("protobuf"))
    );
    assert_eq!(
        tools
            .iter()
            .find(|t| t.name == "get_current_preset")
            .unwrap()
            .annotations
            .as_ref()
            .unwrap()
            .read_only_hint,
        Some(true)
    );
    assert_eq!(
        tools
            .iter()
            .find(|t| t.name == "copy_preset")
            .unwrap()
            .annotations
            .as_ref()
            .unwrap()
            .destructive_hint,
        Some(true)
    );
}

#[tokio::test]
async fn expected_state_and_parameter_translation_match_python_oracle() {
    let (server, backend) = server();
    server
        .execute(
            &route(),
            "set_parameter",
            Some(
                json!({
                    "row":2,"column":3,"parameter_index":7,"value":0.75,"expected_value":0.5,
                    "expected_scene":4,"expected_preset_name":"Lead"
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        )
        .await
        .unwrap();
    let calls = backend.0.lock().unwrap();
    assert_eq!(calls[0].0, "device.setParameter");
    assert_eq!(calls[0].1["parameterIndex"], 7);
    assert_eq!(calls[0].1["expectedPresetName"], "Lead");
}

#[tokio::test]
async fn invalid_state_and_unconfirmed_writes_never_reach_backend() {
    let (server, backend) = server();
    assert!(
        server
            .execute(
                &route(),
                "select_scene",
                Some(
                    json!({"scene":2,"expected_preset_name":""})
                        .as_object()
                        .unwrap()
                        .clone()
                )
            )
            .await
            .is_err()
    );
    assert!(
        server
            .execute(
                &route(),
                "set_master_volume",
                Some(
                    json!({"value":80,"expected_value":50,"confirm_risky_operation":false})
                        .as_object()
                        .unwrap()
                        .clone()
                )
            )
            .await
            .is_err()
    );
    assert!(
        server
            .execute(
                &route(),
                "copy_preset",
                Some(
                    json!({
                        "source_setlist_key":"user","source_position":1,"source_name":"A",
                        "destination_setlist_key":"user","destination_position":2,
                        "expected_preset_name":"A","expected_position":1,"confirm_overwrite":true,
                        "confirm_persistent_write":false
                    })
                    .as_object()
                    .unwrap()
                    .clone()
                )
            )
            .await
            .is_err()
    );
    assert!(backend.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn persistent_confirmation_is_consumed_not_forwarded() {
    let (server, backend) = server();
    server
        .execute(
            &route(),
            "rename_current_preset",
            Some(
                json!({
                    "new_name":"New name","expected_preset_name":"Clean","expected_position":4,
                    "confirm_persistent_write":true
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        )
        .await
        .unwrap();
    let calls = backend.0.lock().unwrap();
    assert_eq!(calls[0].1["name"], "New name");
    assert_eq!(calls[0].1["confirmRename"], true);
    assert!(!calls[0].1.contains_key("confirmPersistentWrite"));
}

#[tokio::test]
async fn model_query_is_not_forwarded_to_parameterless_gateway_method() {
    let (server, backend) = server();
    server
        .execute(
            &route(),
            "list_models",
            Some(json!({"query":"delay"}).as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    let calls = backend.0.lock().unwrap();
    assert_eq!(calls[0].0, "device.listModels");
    assert!(calls[0].1.is_empty());
}

#[tokio::test]
async fn preview_expected_value_is_validated_but_not_forwarded() {
    let (server, backend) = server();
    server
        .execute(
            &route(),
            "preview_parameter",
            Some(
                json!({
                    "row":0,"column":1,"parameter_index":2,"value":0.6,
                    "expected_value":0.4,"expected_scene":1,"expected_preset_name":"Test"
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        )
        .await
        .unwrap();
    let calls = backend.0.lock().unwrap();
    assert_eq!(calls[0].0, "device.previewParameter");
    assert!(!calls[0].1.contains_key("expectedValue"));
    assert_eq!(calls[0].1["parameterIndex"], 2);
}

#[tokio::test]
async fn newer_device_actions_enforce_confirmation_and_screen_bounds() {
    let (server, backend) = server();

    assert!(
        server
            .execute(
                &route(),
                "set_device_name",
                Some(
                    json!({"name":"Stage QC","confirm_persistent_write":false})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .is_err()
    );
    assert!(
        server
            .execute(
                &route(),
                "tap_screen",
                Some(
                    json!({"x":800,"y":100,"confirm_risky_operation":true})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .is_err()
    );
    assert!(backend.0.lock().unwrap().is_empty());

    server
        .execute(
            &route(),
            "tap_screen",
            Some(
                json!({"x":799,"y":479,"confirm_risky_operation":true})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    let calls = backend.0.lock().unwrap();
    assert_eq!(calls[0].0, "device.tapScreen");
    assert_eq!(
        calls[0].1,
        json!({"x":799,"y":479}).as_object().unwrap().clone()
    );
}

#[tokio::test]
async fn midi_out_messages_are_bounded_and_forwarded_without_schema_drift() {
    let (server, backend) = server();
    let invalid = json!({
        "source": 0,
        "messages": [{"type":1,"channel":17,"param1":0,"param2":0,"param3":0}],
        "expected_preset_name": "Test"
    });
    assert!(
        server
            .execute(
                &route(),
                "set_midi_out",
                Some(invalid.as_object().unwrap().clone()),
            )
            .await
            .is_err()
    );
    assert!(backend.0.lock().unwrap().is_empty());

    let messages = json!([{"type":1,"channel":16,"param1":119,"param2":1,"param3":0}]);
    server
        .execute(
            &route(),
            "set_midi_out",
            Some(
                json!({"source":0,"messages":messages,"expected_preset_name":"Test"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    let calls = backend.0.lock().unwrap();
    assert_eq!(calls[0].0, "device.setMidiOut");
    assert_eq!(calls[0].1["messages"], messages);
    assert_eq!(calls[0].1["expectedPresetName"], "Test");
}

#[tokio::test]
async fn read_only_device_introspection_maps_to_new_gateway_rpcs() {
    let (server, backend) = server();
    server
        .execute(&route(), "get_device_identity", None)
        .await
        .unwrap();
    server
        .execute(&route(), "get_inhibited_modules", None)
        .await
        .unwrap();
    server
        .execute(&route(), "capture_screen", None)
        .await
        .unwrap();
    let calls = backend.0.lock().unwrap();
    assert_eq!(
        calls.iter().map(|call| call.0).collect::<Vec<_>>(),
        [
            "device.identity",
            "device.inhibitedModules",
            "device.captureScreen"
        ]
    );
}

#[tokio::test]
async fn nullable_grid_guards_are_forwarded_instead_of_dropped() {
    let (server, backend) = server();
    server
        .execute(
            &route(),
            "set_chain_split",
            Some(
                json!({
                    "row":1,"split_column":null,"mix_column":null,
                    "expected_split_column":2,"expected_mix_column":-1,
                    "expected_preset_name":"Clean"
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        )
        .await
        .unwrap();
    let calls = backend.0.lock().unwrap();
    assert_eq!(calls[0].0, "device.setChainSplit");
    assert!(calls[0].1.contains_key("splitColumn"));
    assert!(calls[0].1["splitColumn"].is_null());
    assert_eq!(calls[0].1["expectedMixColumn"], -1);
}

#[tokio::test]
async fn scene_management_validates_and_preserves_nullable_labels() {
    let (server, backend) = server();
    server
        .execute(
            &route(),
            "set_scene_label",
            Some(
                json!({"scene":2,"label":null,"expected_preset_name":"Lead"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    {
        let calls = backend.0.lock().unwrap();
        assert_eq!(calls[0].0, "device.setSceneLabel");
        assert!(calls[0].1.contains_key("label"));
        assert!(calls[0].1["label"].is_null());
    }

    assert!(
        server
            .execute(
                &route(),
                "copy_scene",
                Some(
                    json!({"from_scene":3,"to_scene":3,"swap":false,"expected_preset_name":"Lead"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .is_err()
    );
}
