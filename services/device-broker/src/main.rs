use qc_device_broker::{usb, worker::DeviceController};
use serde::Serialize;
use std::collections::BTreeMap;
use std::time::Instant;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    present: bool,
    connected: bool,
    synchronized: bool,
    handshake_ms: Option<u128>,
    observed_message_counts: BTreeMap<u16, usize>,
    active_preset_name: Option<String>,
    detail: String,
}

fn probe() -> ProbeResult {
    let started = Instant::now();
    let mut session = qc_protocol::session::SessionMachine::new(0);
    match usb::QcUsb::connect(&mut session, &started) {
        Ok(connection) => ProbeResult {
            present: true,
            connected: true,
            synchronized: connection.synchronized,
            handshake_ms: Some(started.elapsed().as_millis()),
            observed_message_counts: connection.message_counts.into_iter().collect(),
            active_preset_name: connection
                .latest_messages
                .get(&15)
                .and_then(|message| usb::preset_name(&message.payload)),
            detail: if connection.synchronized {
                "Active preset received"
            } else {
                "Handshake complete; active preset still pending"
            }
            .into(),
        },
        Err(usb::UsbError::NotAvailable) => ProbeResult {
            present: false,
            connected: false,
            synchronized: false,
            handshake_ms: None,
            observed_message_counts: BTreeMap::new(),
            active_preset_name: None,
            detail: "Quad Cortex is not currently enumerable".into(),
        },
        Err(error) => ProbeResult {
            present: true,
            connected: false,
            synchronized: false,
            handshake_ms: Some(started.elapsed().as_millis()),
            observed_message_counts: BTreeMap::new(),
            active_preset_name: None,
            detail: error.to_string(),
        },
    }
}

fn main() {
    if std::env::args().any(|argument| argument == "--stdio") {
        if let Err(error) =
            qc_device_broker::rpc::serve_stdio(DeviceController::start_disconnected())
        {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().any(|argument| argument == "--verify-live") {
        let controller = DeviceController::start();
        let initial = controller.wait_for_ready(std::time::Duration::from_millis(
            qc_protocol::profile::READY_WAIT_TIMEOUT_MS,
        ));
        let Some(original) = initial.active_scene else {
            println!(
                "{}",
                serde_json::json!({"verified": false, "detail": "QC did not report an active scene", "initial": initial})
            );
            std::process::exit(1);
        };
        let target = (original + 1) % 8;
        if let Err(error) = controller.switch_scene(target) {
            println!(
                "{}",
                serde_json::json!({"verified": false, "detail": error, "initial": initial})
            );
            std::process::exit(1);
        }
        let changed = controller.wait_for_scene(target, std::time::Duration::from_secs(3));
        let changed_ok = changed.active_scene == Some(target);
        let restored_ok = if controller.switch_scene(original).is_ok() {
            controller
                .wait_for_scene(original, std::time::Duration::from_secs(3))
                .active_scene
                == Some(original)
        } else {
            false
        };
        println!(
            "{}",
            serde_json::json!({
                "verified": changed_ok && restored_ok,
                "preset": initial.active_preset_name,
                "originalScene": original,
                "targetScene": target,
                "deviceEchoedTarget": changed_ok,
                "restoredOriginal": restored_ok,
                "handshakeMs": initial.handshake_ms
            })
        );
        if !(changed_ok && restored_ok) {
            std::process::exit(1)
        }
        return;
    }
    if std::env::args().any(|argument| argument == "--probe") {
        println!(
            "{}",
            serde_json::to_string(&probe()).expect("probe result serializes")
        );
        return;
    }
    let controller = DeviceController::start();
    let status = controller.wait_for_ready(std::time::Duration::from_millis(
        qc_protocol::profile::READY_WAIT_TIMEOUT_MS,
    ));
    println!(
        "{}",
        serde_json::to_string(&status).expect("broker status serializes")
    );
}
