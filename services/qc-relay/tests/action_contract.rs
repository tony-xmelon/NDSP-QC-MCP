use qc_relay::protocol::{ActionClass, ACTIONS};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
};

#[derive(Deserialize)]
struct Contract {
    actions: Vec<ContractAction>,
}

#[derive(Deserialize)]
struct ContractAction {
    name: String,
    rpc: String,
    classification: String,
}

#[derive(Deserialize)]
struct GatewayContract {
    methods: Vec<GatewayMethod>,
}

#[derive(Deserialize)]
struct GatewayMethod {
    rpc: String,
}

#[test]
fn relay_allowlist_matches_the_shared_action_contract() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contracts/qc-actions.v1.json");
    let contract: Contract = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let relay = ACTIONS
        .iter()
        .map(|action| (action.name, action))
        .collect::<HashMap<_, _>>();
    assert_eq!(relay.len(), contract.actions.len() + 1);
    assert_eq!(relay.get("get_status").unwrap().rpc, "system.status");
    for action in contract.actions {
        let policy = relay
            .get(action.name.as_str())
            .unwrap_or_else(|| panic!("missing relay policy for {}", action.name));
        assert_eq!(policy.rpc, action.rpc);
        let classification = match policy.class {
            ActionClass::Read => "read",
            ActionClass::LiveWrite => "live-write",
            ActionClass::RiskyWrite => "risky-write",
            ActionClass::PersistentWrite => "persistent-write",
        };
        assert_eq!(classification, action.classification);
    }
}

#[test]
fn full_control_contract_covers_every_gateway_method() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let actions: Contract = serde_json::from_str(
        &fs::read_to_string(root.join("contracts/qc-actions.v1.json")).unwrap(),
    )
    .unwrap();
    let gateway: GatewayContract = serde_json::from_str(
        &fs::read_to_string(root.join("contracts/gateway-methods.v1.json")).unwrap(),
    )
    .unwrap();
    let covered = std::iter::once("system.status")
        .chain(actions
        .actions
        .iter()
        .map(|action| action.rpc.as_str()))
        .collect::<HashSet<_>>();
    let missing = gateway
        .methods
        .iter()
        .map(|method| method.rpc.as_str())
        .filter(|rpc| !covered.contains(rpc))
        .collect::<Vec<_>>();
    assert!(
        missing.is_empty(),
        "gateway RPCs missing from MCP action contract: {missing:?}"
    );
}
