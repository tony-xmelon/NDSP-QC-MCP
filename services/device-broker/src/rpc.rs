use crate::worker::DeviceController;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use qc_device_runtime::request::{
    self as runtime_request, finalize_device_backup, GatewayResponseProjection,
    GatewayVerification, GatewayWritePlan, PlannedWrite, PresetMutationPlan,
};
use qc_protocol::domain;
use qc_protocol::responses::decode_tempo_clock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
struct Request {
    jsonrpc: String,
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawMessage {
    sequence: u64,
    message_type: u16,
    payload_base64: String,
    received_at_unix_ms: u128,
}

pub fn serve_stdio(controller: DeviceController) -> Result<(), String> {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let output = Arc::new(Mutex::new(io::stdout()));
    let event_output = Arc::clone(&output);
    let events = controller.subscribe_state_events();
    thread::Builder::new()
        .name("qc-native-events".into())
        .spawn(move || {
            while let Ok(frame) = events.recv() {
                let notification = json!({
                    "jsonrpc": "2.0",
                    "method": "device.stateFrame",
                    "params": frame
                });
                let Ok(mut output) = event_output.lock() else {
                    return;
                };
                if write_response(&mut *output, &notification).is_err() {
                    return;
                }
            }
        })
        .map_err(|error| format!("Could not start native event stream: {error}"))?;
    while let Some(request) = read_request(&mut input)? {
        let response = handle(&controller, request);
        let mut output = output
            .lock()
            .map_err(|_| "Native broker output lock was poisoned".to_string())?;
        write_response(&mut *output, &response)?;
    }
    Ok(())
}

fn handle(controller: &DeviceController, request: Request) -> Value {
    let id = request.id.clone();
    if request.jsonrpc != "2.0" || !(id.is_u64() || id.is_i64()) {
        return error(id, -32600, "Invalid JSON-RPC request");
    }
    if !request.params.is_null() && !request.params.is_object() {
        return error(id, -32602, "JSON-RPC params must be an object");
    }
    let result = match request.method.as_str() {
        "system.status" => Ok(json!({
            "platform": "Rust device gateway",
            "gatewayAvailable": true,
            "gatewayApiVersion": 2,
            "capabilities": ["nativeGateway", "nativeBroker", "modelRepoParameterMetadata", "nativeStateEvents", "nativeDeviceIdentity", "nativeRemoteScreen"],
            "message": "Shared Rust QC engine active"
        })),
        "device.status" => {
            serde_json::to_value(controller.status()).map_err(|error| error.to_string())
        }
        "device.reconnect" => {
            controller.reconnect();
            Ok(ready_connection_state(
                controller,
                "Quad Cortex handshake complete",
            ))
        }
        "device.resetSession" => {
            controller.reconnect();
            Ok(ready_connection_state(
                controller,
                "Communication session reset",
            ))
        }
        "device.disconnect" => {
            controller.disconnect();
            Ok(connection_state(controller, "Quad Cortex session closed"))
        }
        // The native broker implements the generated gateway contract without
        // exposing raw HID/protobuf details to either client.
        "device.stateEvents" => gateway_state_events(controller, &request.params),
        "device.snapshot" => controller
            .gateway_snapshot()
            .map(|snapshot| serde_json::to_value(snapshot).map_err(|error| error.to_string()))
            .unwrap_or_else(|| Err("No Quad Cortex preset has been synchronized yet".into())),
        "device.listModels" => gateway_list_models(controller),
        "device.identity" => gateway_identity(controller),
        "device.setDeviceName" => gateway_set_device_name(controller, &request.params),
        "device.undo" => gateway_history(controller, true),
        "device.redo" => gateway_history(controller, false),
        "device.inhibitedModules" => gateway_inhibited_modules(controller),
        "device.presetScreenshot" => gateway_preset_screenshot(controller, &request.params),
        "device.captureScreen" => gateway_capture_screen(controller),
        "device.tapScreen" => gateway_tap_screen(controller, &request.params),
        "device.tempoClock" => gateway_tempo_clock(controller),
        "device.selectScene" => gateway_select_scene(controller, &request.params),
        "device.toggleBypass" => gateway_toggle_bypass(controller, &request.params),
        "device.blockDetails" => gateway_block_details(controller, &request.params),
        "device.previewParameter" => gateway_parameter(controller, &request.params, true),
        "device.setParameter" => gateway_parameter(controller, &request.params, false),
        "device.setTempo" => gateway_set_tempo(controller, &request.params),
        "device.setMasterVolume" => gateway_set_master_volume(controller, &request.params),
        "device.masterVolume" => gateway_master_volume(controller),
        "device.addBlock" => gateway_operation(controller, &request.params, "device.addBlock"),
        "device.removeBlock" => {
            gateway_operation(controller, &request.params, "device.removeBlock")
        }
        "device.moveBlock" => gateway_operation(controller, &request.params, "device.moveBlock"),
        "device.setBlockFootswitch" => {
            gateway_operation(controller, &request.params, "device.setBlockFootswitch")
        }
        "device.setChainInput" => {
            gateway_operation(controller, &request.params, "device.setChainInput")
        }
        "device.setChainOutput" => {
            gateway_operation(controller, &request.params, "device.setChainOutput")
        }
        "device.setChainSplit" => {
            gateway_operation(controller, &request.params, "device.setChainSplit")
        }
        "device.navigateBank" => gateway_navigate_bank(controller, &request.params),
        "device.recallPreset" => gateway_recall_preset(controller, &request.params),
        "device.reloadPreset" => gateway_reload_preset(controller, &request.params),
        "device.listPresetFolders" => gateway_list_preset_folders(controller, &request.params),
        "device.listPresets" => gateway_list_presets(controller, &request.params),
        "device.listPresetSlots" => gateway_list_preset_slots(controller),
        "device.savePresetAs" => gateway_save_preset_as(controller, &request.params),
        "device.renameCurrentPreset" => gateway_rename_current_preset(controller, &request.params),
        "device.createBackup" => gateway_create_backup(controller, &request.params),
        "device.copyPreset" => gateway_copy_preset(controller, &request.params),
        "device.showTuner" => gateway_visibility(controller, &request.params, true),
        "device.showGigView" => gateway_visibility(controller, &request.params, false),
        "device.raw.latest" => raw_latest(controller, &request.params),
        "device.raw.events" => raw_events(controller, &request.params),
        "device.state.events" => state_events(controller, &request.params),
        "device.state.blockDetails" => state_block_details(controller, &request.params),
        "device.command.scene" => command_scene(controller, &request.params),
        "device.command.bypass" => command_bypass(controller, &request.params),
        "device.command.parameter" => command_parameter(controller, &request.params),
        "device.command.tempo" => command_tempo(controller, &request.params),
        "device.command.operation" => command_operation(controller, &request.params),
        "device.raw.send" => raw_send(controller, &request.params),
        "device.raw.request" => raw_request(controller, &request.params),
        _ => return error(id, -32601, &format!("Method not found: {}", request.method)),
    };
    match result {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err(message) => error(id, -32010, &message),
    }
}

fn connection_state(controller: &DeviceController, detail: &str) -> Value {
    let status = controller.status();
    json!({
        "phase": status.phase,
        "detail": detail,
        "lastSync": status.connected_at_unix_ms,
        "demo": false
    })
}

fn ready_connection_state(controller: &DeviceController, detail: &str) -> Value {
    let status = controller.wait_for_ready(Duration::from_secs(35));
    json!({
        "phase": status.phase,
        "detail": if status.phase == "ready" { detail } else { &status.detail },
        "lastSync": status.connected_at_unix_ms,
        "demo": false
    })
}

fn gateway_state_events(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let frames = state_events(controller, params)?;
    Ok(json!({"native": true, "frames": frames}))
}

fn gateway_list_models(controller: &DeviceController) -> Result<Value, String> {
    serde_json::to_value(controller.list_models()?).map_err(|error| error.to_string())
}

fn next_request_id() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
}

fn request_command(
    controller: &DeviceController,
    command: qc_protocol::commands::OutboundMessage,
    expected_type: u16,
    request_id: Option<u64>,
    timeout: Duration,
) -> Result<crate::usb::IncomingMessage, String> {
    controller.request(
        command.message_type,
        command.payload,
        expected_type,
        request_id,
        timeout,
    )
}

fn execute_gateway_read(
    controller: &DeviceController,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    let plan = runtime_request::plan_gateway_read(method, params, next_request_id())?;
    let timeout = Duration::from_millis(plan.timeout_ms);
    let messages = plan.operation.encode();
    if let GatewayResponseProjection::PresetScreenshot { request_id, .. } = &plan.projection {
        let mut messages = messages.into_iter();
        let message = messages
            .next()
            .ok_or_else(|| "The correlated QC read produced no request message".to_string())?;
        if messages.next().is_some() {
            return Err("The correlated QC read produced multiple request messages".into());
        }
        let reply = request_command(
            controller,
            message,
            plan.response_type,
            Some(*request_id),
            timeout,
        )?;
        return plan.projection.decode(&reply.payload);
    }

    let after_sequence = controller.event_cursor();
    for message in messages {
        controller.send_command(message)?;
    }
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(value) = controller
            .events_since(after_sequence, Some(plan.response_type), 256)
            .into_iter()
            .find_map(|reply| plan.projection.decode(&reply.payload).ok())
        {
            return Ok(value);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "The Quad Cortex did not return a valid {method} reply within {} seconds",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn gateway_identity(controller: &DeviceController) -> Result<Value, String> {
    execute_gateway_read(controller, "device.identity", &Value::Null)
}

fn gateway_set_device_name(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let plan = plan_gateway_write(controller, "device.setDeviceName", params)?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    execute_gateway_write(controller, &plan)?;
    let identity = gateway_identity(controller)?;
    if identity.get("customName").and_then(Value::as_str) != Some(name) {
        return Err("The Quad Cortex did not confirm the requested device name".into());
    }
    Ok(json!({"detail": format!("Device name changed to {name}"), "identity": identity}))
}

fn gateway_history(controller: &DeviceController, undo: bool) -> Result<Value, String> {
    let method = if undo { "device.undo" } else { "device.redo" };
    let plan = plan_gateway_write(controller, method, &Value::Null)?;
    execute_gateway_write(controller, &plan)?;
    Ok(json!({
        "detail": plan.detail,
        "immediate": true,
    }))
}

fn gateway_inhibited_modules(controller: &DeviceController) -> Result<Value, String> {
    execute_gateway_read(controller, "device.inhibitedModules", &Value::Null)
}

fn gateway_preset_screenshot(
    controller: &DeviceController,
    params: &Value,
) -> Result<Value, String> {
    execute_gateway_read(controller, "device.presetScreenshot", params)
}

fn gateway_capture_screen(controller: &DeviceController) -> Result<Value, String> {
    execute_gateway_read(controller, "device.captureScreen", &Value::Null)
}

fn gateway_tap_screen(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    gateway_capture_screen(controller)?;
    let plan = plan_gateway_write(controller, "device.tapScreen", params)?;
    execute_gateway_write(controller, &plan)?;
    Ok(json!({"detail": plan.detail, "immediate": true}))
}

fn gateway_tempo_clock(controller: &DeviceController) -> Result<Value, String> {
    let Some(raw) = controller.latest_message(33) else {
        return Ok(json!({"available": false}));
    };
    let Some(status) = decode_tempo_clock(raw.payload.as_slice())
        .map_err(|error| format!("Could not decode the cached tempo clock: {error}"))?
    else {
        return Ok(json!({"available": false}));
    };
    Ok(json!({
        "available": true,
        "sequence": raw.sequence,
        "receivedAtUnixMs": raw.received_at_unix_ms,
        "currentBeat": status.current_beat,
        "currentBar": status.current_bar,
        "currentTick": status.current_tick
    }))
}

fn assert_expected_preset(controller: &DeviceController, params: &Value) -> Result<(), String> {
    let snapshot = controller.gateway_snapshot();
    runtime_request::assert_expected_preset(snapshot.as_ref(), params)
}

fn plan_gateway_write(
    controller: &DeviceController,
    method: &str,
    params: &Value,
) -> Result<GatewayWritePlan, String> {
    let snapshot = controller.gateway_snapshot();
    runtime_request::plan_gateway_write(method, params, snapshot.as_ref())
}

fn execute_gateway_write(
    controller: &DeviceController,
    plan: &GatewayWritePlan,
) -> Result<(), String> {
    execute_planned_write(controller, &plan.write)
}

fn execute_planned_write(
    controller: &DeviceController,
    write: &PlannedWrite,
) -> Result<(), String> {
    match write {
        PlannedWrite::HidCommand(command) => controller.send_command(command.clone().encode()),
        PlannedWrite::HidOperation(operation) => controller.send_operation(operation.clone()),
        PlannedWrite::MidiControlChange { .. } => {
            Err("Host MIDI must be executed by the native application transport".into())
        }
    }
}

fn gateway_select_scene(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let plan = plan_gateway_write(controller, "device.selectScene", params)?;
    execute_gateway_write(controller, &plan)?;
    Ok(json!({"detail": plan.detail}))
}

fn gateway_toggle_bypass(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let plan = plan_gateway_write(controller, "device.toggleBypass", params)?;
    execute_gateway_write(controller, &plan)?;
    Ok(json!({"detail": plan.detail}))
}

fn gateway_block_details(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    assert_expected_preset(controller, params)?;
    let details = state_block_details(controller, params)?;
    if details.is_null() {
        Err("No block exists at that grid position".into())
    } else {
        Ok(details)
    }
}

fn gateway_parameter(
    controller: &DeviceController,
    params: &Value,
    preview: bool,
) -> Result<Value, String> {
    let row = bounded_u32(params, "row", domain::GRID_ROWS - 1)?;
    let column = bounded_u32(params, "column", domain::GRID_COLUMNS - 1)?;
    let parameter_index = bounded_u32(params, "parameterIndex", u32::MAX)?;
    let before = controller
        .block_details(row, column)?
        .ok_or_else(|| "No block exists at that grid position".to_string())?;
    let actual = before
        .parameters
        .iter()
        .find(|parameter| parameter.index == parameter_index)
        .and_then(|parameter| parameter.normalized_value);
    runtime_request::assert_expected_parameter(actual, params)?;
    let method = if preview {
        "device.previewParameter"
    } else {
        "device.setParameter"
    };
    let plan = plan_gateway_write(controller, method, params)?;
    execute_gateway_write(controller, &plan)?;
    let value = params
        .get("value")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    if preview {
        Ok(json!({"detail": plan.detail, "acceptedValue": value}))
    } else {
        // Return the latest local view immediately, patched with the accepted
        // value.  Waiting for a USB round-trip here made sliders visibly lag;
        // the timestamped device echo still supersedes this optimistic value.
        let mut block = serde_json::to_value(before).map_err(|error| error.to_string())?;
        if let Some(parameters) = block.get_mut("parameters").and_then(Value::as_array_mut) {
            if let Some(parameter) = parameters.iter_mut().find(|parameter| {
                parameter.get("index").and_then(Value::as_u64) == Some(parameter_index as u64)
            }) {
                if let Some(object) = parameter.as_object_mut() {
                    object.insert("normalizedValue".into(), json!(value));
                }
            }
        }
        Ok(json!({"detail": plan.detail, "block": block}))
    }
}

fn gateway_set_tempo(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let plan = plan_gateway_write(controller, "device.setTempo", params)?;
    execute_gateway_write(controller, &plan)?;
    Ok(json!({"detail": plan.detail}))
}

fn latest_master_volume(controller: &DeviceController) -> Option<f32> {
    controller
        .state_events_since(0, 4096)
        .into_iter()
        .rev()
        .flat_map(|frame| frame.states.into_iter().rev())
        .find_map(|state| state.master_volume)
}

fn gateway_master_volume(controller: &DeviceController) -> Result<Value, String> {
    let value = latest_master_volume(controller)
        .ok_or_else(|| "The Quad Cortex has not reported Master Volume yet".to_string())?;
    Ok(json!({"value": (value.clamp(0.0, 1.0) * 100.0).round() as u32}))
}

fn gateway_set_master_volume(
    controller: &DeviceController,
    params: &Value,
) -> Result<Value, String> {
    let plan = plan_gateway_write(controller, "device.setMasterVolume", params)?;
    execute_gateway_write(controller, &plan)?;
    Ok(json!({"detail": plan.detail}))
}

fn gateway_operation(
    controller: &DeviceController,
    params: &Value,
    method: &str,
) -> Result<Value, String> {
    let plan = plan_gateway_write(controller, method, params)?;
    execute_gateway_write(controller, &plan)?;
    Ok(json!({"detail": plan.detail}))
}

fn gateway_visibility(
    controller: &DeviceController,
    params: &Value,
    tuner: bool,
) -> Result<Value, String> {
    let method = if tuner {
        "device.showTuner"
    } else {
        "device.showGigView"
    };
    let plan = plan_gateway_write(controller, method, params)?;
    execute_gateway_write(controller, &plan)?;
    Ok(json!({"detail": plan.detail}))
}

fn execute_preset_recall(
    controller: &DeviceController,
    plan: runtime_request::PresetRecallPlan,
) -> Result<Value, String> {
    let recall_message = |request_id| {
        qc_protocol::commands::setlist_position_with_request_id(
            plan.setlist_key.clone(),
            plan.position,
            plan.setlist_key.starts_with("/opt/"),
            Some(request_id),
        )
    };
    let target_matches = |snapshot: &qc_device_runtime::GatewaySnapshot| {
        snapshot.setlist_key.trim_end_matches('/') == plan.setlist_key.trim_end_matches('/')
            && snapshot.preset_position == plan.position
            && (!plan.require_clean || !snapshot.dirty)
    };
    let device_events = controller.subscribe_state_events();
    let wait_for_event = |timeout: Duration,
                          predicate: &dyn Fn(&qc_device_runtime::GatewaySnapshot) -> bool|
     -> Option<qc_device_runtime::GatewaySnapshot> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() || device_events.recv_timeout(remaining).is_err() {
                return None;
            }
            if let Some(snapshot) = controller
                .gateway_snapshot()
                .filter(|value| predicate(value))
            {
                return Some(snapshot);
            }
        }
    };
    let confirm = || -> Result<qc_device_runtime::GatewaySnapshot, String> {
        if let Some(after) = wait_for_event(Duration::from_millis(650), &|snapshot| {
            plan.matches(snapshot)
        }) {
            return Ok(after);
        }

        // Some CorOS builds apply a recall but omit its unsolicited position
        // push. Ask for the current address using the QC's correlated READ;
        // this does not reload the preset and the reply also feeds the normal
        // state decoder, keeping the UI and hardware authoritative together.
        let request_id = next_request_id();
        let readback = qc_protocol::commands::read_setlist_position(request_id);
        request_command(
            controller,
            readback,
            2,
            Some(request_id),
            Duration::from_secs(1),
        )?;
        wait_for_event(Duration::from_millis(300), &|snapshot| {
            plan.matches(snapshot)
        })
        .ok_or_else(|| "The QC position readback did not reach the state engine".to_string())
    };

    controller.send_command(recall_message(next_request_id()))?;
    let after = match confirm() {
        Ok(after) if plan.matches(&after) => after,
        _ => {
            // If neither the pushed position nor a correlated READ arrives,
            // the QC's HID command channel is wedged even though its stream
            // can still look connected. Closing that session flushes any
            // accepted recall; the fresh handshake then reads the real slot.
            controller.reconnect();
            let status = controller.wait_for_ready(Duration::from_secs(12));
            if status.phase != "ready" {
                return Err(format!(
                    "Preset recall required USB recovery, but reconnection ended in {}: {}",
                    status.phase, status.detail
                ));
            }
            let recovered =
                wait_for_event(Duration::from_secs(2), &target_matches).ok_or_else(|| {
                    "The recovered QC session did not publish its active position".to_string()
                })?;
            if target_matches(&recovered) {
                recovered
            } else {
                return Err(format!(
                    "Preset recall targeted slot {}, but recovered device readback remained on slot {}.",
                    plan.position, recovered.preset_position
                ));
            }
        }
    };
    if !target_matches(&after) {
        return Err(format!(
            "Preset recall targeted slot {}, but live device readback remained on slot {}.",
            plan.position, after.preset_position
        ));
    }
    Ok(json!({"detail": plan.detail, "snapshot": after}))
}

fn gateway_recall_preset(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let snapshot = controller.gateway_snapshot();
    let plan =
        runtime_request::plan_preset_recall("device.recallPreset", params, snapshot.as_ref())?;
    execute_preset_recall(controller, plan)
}

fn gateway_navigate_bank(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let snapshot = controller.gateway_snapshot();
    let plan =
        runtime_request::plan_preset_recall("device.navigateBank", params, snapshot.as_ref())?;
    execute_preset_recall(controller, plan)
}

fn gateway_reload_preset(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let snapshot = controller.gateway_snapshot();
    let plan =
        runtime_request::plan_preset_recall("device.reloadPreset", params, snapshot.as_ref())?;
    execute_preset_recall(controller, plan)
}

fn maybe_refresh_library(controller: &DeviceController, params: &Value) -> Result<(), String> {
    if params
        .get("refresh")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        controller.refresh_preset_library()?;
    }
    Ok(())
}

fn gateway_list_preset_folders(
    controller: &DeviceController,
    params: &Value,
) -> Result<Value, String> {
    if controller.preset_folders().is_empty() {
        controller.refresh_preset_library()?;
    } else {
        maybe_refresh_library(controller, params)?;
    }
    let folders = controller.preset_folders();
    let loading = folders.is_empty();
    Ok(json!({"folders": folders, "loading": loading}))
}

fn gateway_list_presets(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let key = params
        .get("setlistKey")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| {
            controller
                .gateway_snapshot()
                .map(|snapshot| snapshot.setlist_key)
        })
        .filter(|key| !key.is_empty())
        .ok_or_else(|| "No active preset setlist has been synchronized".to_string())?;
    if params
        .get("refresh")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || controller.preset_list(&key).is_none()
    {
        controller.refresh_preset_library()?;
    }
    if let Some(list) = controller.preset_list(&key) {
        let mut value = serde_json::to_value(list).map_err(|error| error.to_string())?;
        value["loading"] = Value::Bool(false);
        return Ok(value);
    }
    let snapshot = controller
        .gateway_snapshot()
        .ok_or_else(|| "No Quad Cortex preset has been synchronized yet".to_string())?;
    let setlist_name = key.trim_end_matches('/').rsplit('/').next().unwrap_or(&key);
    Ok(json!({
        "setlistKey": key,
        "setlistName": setlist_name,
        "currentPosition": snapshot.preset_position,
        "presets": [],
        "folders": controller.preset_folders(),
        "loading": true
    }))
}

fn gateway_list_preset_slots(controller: &DeviceController) -> Result<Value, String> {
    let snapshot = controller
        .gateway_snapshot()
        .ok_or_else(|| "No Quad Cortex preset has been synchronized yet".to_string())?;
    if let Some(slots) = controller.preset_slots()? {
        return serde_json::to_value(slots).map_err(|error| error.to_string());
    }
    controller.refresh_preset_library()?;
    if controller
        .wait_for_preset_list(&snapshot.setlist_key, Duration::from_secs(25))
        .is_none()
    {
        return Err("The active preset slots did not finish loading".into());
    }
    controller
        .preset_slots()?
        .map(|slots| serde_json::to_value(slots).map_err(|error| error.to_string()))
        .unwrap_or_else(|| Err("The active preset slots did not finish loading".into()))
}

fn execute_preset_mutation(
    controller: &DeviceController,
    plan: PresetMutationPlan,
) -> Result<Value, String> {
    let mut observed = None;
    for stage in plan.stages {
        let before_revision = controller
            .gateway_snapshot()
            .map(|snapshot| snapshot.preset_revision)
            .unwrap_or_default();
        execute_planned_write(controller, &stage.write)?;
        let verification = stage.verification;
        let after = controller
            .wait_for_gateway_snapshot(Duration::from_millis(stage.timeout_ms), |snapshot| {
                let fresh = !matches!(verification, GatewayVerification::Preset { .. })
                    || snapshot.preset_revision > before_revision;
                fresh && verification.matches(snapshot, None)
            })
            .ok_or_else(|| {
                "The preset operation did not produce a verified device snapshot".to_string()
            })?;
        let fresh = !matches!(verification, GatewayVerification::Preset { .. })
            || after.preset_revision > before_revision;
        if !fresh || !verification.matches(&after, None) {
            return Err(
                "The preset operation completed, but live-state verification failed.".into(),
            );
        }
        observed = Some(after);
    }
    let after = observed.ok_or_else(|| "The preset operation contained no stages".to_string())?;
    controller.record_saved_preset(
        &plan.setlist_key,
        plan.position,
        &plan.saved_name,
        plan.instrument,
    );
    Ok(json!({
        "detail": plan.detail,
        "savedName": plan.saved_name,
        "snapshot": after,
    }))
}

fn gateway_save_preset_as(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    execute_preset_mutation(
        controller,
        controller.plan_preset_mutation("device.savePresetAs", params)?,
    )
}

fn gateway_rename_current_preset(
    controller: &DeviceController,
    params: &Value,
) -> Result<Value, String> {
    execute_preset_mutation(
        controller,
        controller.plan_preset_mutation("device.renameCurrentPreset", params)?,
    )
}

fn gateway_create_backup(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let name = required_text(params, "name")?;
    let raw = controller.create_backup(Duration::from_secs(60))?;
    finalize_device_backup(&raw, &name)
}

fn gateway_copy_preset(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    execute_preset_mutation(
        controller,
        controller.plan_preset_mutation("device.copyPreset", params)?,
    )
}

fn message_type(params: &Value, field: &str) -> Result<u16, String> {
    let raw = params
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{field} must be an integer from 1 through 72"))?;
    let value = u16::try_from(raw).map_err(|_| format!("{field} is outside the u16 range"))?;
    if !(1..=72).contains(&value) {
        return Err(format!("{field} must be an integer from 1 through 72"));
    }
    Ok(value)
}

fn payload(params: &Value) -> Result<Vec<u8>, String> {
    let encoded = params
        .get("payloadBase64")
        .and_then(Value::as_str)
        .ok_or_else(|| "payloadBase64 must be a Base64 string".to_string())?;
    BASE64
        .decode(encoded)
        .map_err(|_| "payloadBase64 is not valid Base64".to_string())
}

fn raw_latest(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let kind = message_type(params, "messageType")?;
    Ok(match controller.latest_message(kind) {
        Some(message) => serde_json::to_value(RawMessage {
            sequence: message.sequence,
            message_type: message.message_type,
            payload_base64: BASE64.encode(message.payload),
            received_at_unix_ms: message.received_at_unix_ms,
        })
        .map_err(|error| error.to_string())?,
        None => Value::Null,
    })
}

fn raw_events(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let after = params
        .get("afterSequence")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let kind = params
        .get("messageType")
        .map(|_| message_type(params, "messageType"))
        .transpose()?;
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(256)
        .clamp(1, 4096) as usize;
    let messages = controller
        .events_since(after, kind, limit)
        .into_iter()
        .map(|message| RawMessage {
            sequence: message.sequence,
            message_type: message.message_type,
            payload_base64: BASE64.encode(message.payload),
            received_at_unix_ms: message.received_at_unix_ms,
        })
        .collect::<Vec<_>>();
    serde_json::to_value(messages).map_err(|error| error.to_string())
}

fn state_events(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let after = params
        .get("afterSequence")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(256)
        .clamp(1, 4096) as usize;
    serde_json::to_value(controller.state_events_since(after, limit))
        .map_err(|error| error.to_string())
}

fn state_block_details(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let row = bounded_u32(params, "row", domain::GRID_ROWS - 1)?;
    let column = bounded_u32(params, "column", domain::GRID_COLUMNS - 1)?;
    serde_json::to_value(controller.block_details(row, column)?).map_err(|error| error.to_string())
}

fn bounded_u32(params: &Value, field: &str, maximum: u32) -> Result<u32, String> {
    runtime_request::bounded_u32(params, field, maximum)
}

fn command_scene(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let plan = plan_gateway_write(controller, "device.command.scene", params)?;
    execute_gateway_write(controller, &plan)?;
    Ok(json!({"accepted": true}))
}

fn command_bypass(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let plan = plan_gateway_write(controller, "device.command.bypass", params)?;
    execute_gateway_write(controller, &plan)?;
    Ok(json!({"accepted": true}))
}

fn command_parameter(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let plan = plan_gateway_write(controller, "device.command.parameter", params)?;
    execute_gateway_write(controller, &plan)?;
    Ok(json!({"accepted": true}))
}

fn command_tempo(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let plan = plan_gateway_write(controller, "device.command.tempo", params)?;
    execute_gateway_write(controller, &plan)?;
    Ok(json!({"accepted": true}))
}

fn required_text(params: &Value, field: &str) -> Result<String, String> {
    runtime_request::required_text(params, field)
}

fn command_operation(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let plan = plan_gateway_write(controller, "device.command.operation", params)?;
    execute_gateway_write(controller, &plan)?;
    Ok(json!({"accepted": true}))
}

fn raw_send(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let kind = message_type(params, "messageType")?;
    controller.send(kind, payload(params)?)?;
    Ok(json!({"accepted": true}))
}

fn raw_request(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    let kind = message_type(params, "messageType")?;
    let expected = params
        .get("expectedType")
        .map(|_| message_type(params, "expectedType"))
        .transpose()?
        .unwrap_or(kind);
    let request_id = params.get("requestId").and_then(Value::as_u64);
    let timeout_ms = params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(10_000)
        .clamp(1, 60_000);
    let message = controller.request(
        kind,
        payload(params)?,
        expected,
        request_id,
        Duration::from_millis(timeout_ms),
    )?;
    serde_json::to_value(RawMessage {
        sequence: message.sequence,
        message_type: message.message_type,
        payload_base64: BASE64.encode(message.payload),
        received_at_unix_ms: message.received_at_unix_ms,
    })
    .map_err(|error| error.to_string())
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn read_request(input: &mut impl Read) -> Result<Option<Request>, String> {
    let mut header = [0_u8; 4];
    let mut read = 0;
    while read < header.len() {
        match input.read(&mut header[read..]) {
            Ok(0) if read == 0 => return Ok(None),
            Ok(0) => return Err("Incomplete native broker frame header".into()),
            Ok(count) => read += count,
            Err(error) => return Err(format!("Could not read native broker input: {error}")),
        }
    }
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > qc_protocol::domain::IPC_MAX_FRAME_BYTES {
        return Err(format!("Invalid native broker frame length: {length}"));
    }
    let mut body = vec![0_u8; length];
    input
        .read_exact(&mut body)
        .map_err(|error| format!("Incomplete native broker frame: {error}"))?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| format!("Invalid native broker JSON: {error}"))
}

fn write_response(output: &mut impl Write, response: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(response).map_err(|error| error.to_string())?;
    let length =
        u32::try_from(body.len()).map_err(|_| "Native broker response is too large".to_string())?;
    output
        .write_all(&length.to_be_bytes())
        .map_err(|error| error.to_string())?;
    output.write_all(&body).map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_reads_one_request() {
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"system.status"}"#;
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(body);
        let request = read_request(&mut frame.as_slice()).unwrap().unwrap();
        assert_eq!(request.method, "system.status");
        assert_eq!(request.id, 1);
    }

    #[test]
    fn raw_message_types_are_bounded_to_registry() {
        assert!(message_type(&json!({"messageType": 1}), "messageType").is_ok());
        assert!(message_type(&json!({"messageType": 72}), "messageType").is_ok());
        assert!(message_type(&json!({"messageType": 0}), "messageType").is_err());
        assert!(message_type(&json!({"messageType": 73}), "messageType").is_err());
    }

    #[test]
    fn system_status_identifies_the_rust_gateway_contract() {
        let controller = DeviceController::start();
        let response = handle(
            &controller,
            Request {
                jsonrpc: "2.0".into(),
                id: json!(1),
                method: "system.status".into(),
                params: json!({}),
            },
        );
        assert_eq!(response["result"]["platform"], "Rust device gateway");
        assert_eq!(response["result"]["gatewayApiVersion"], 2);
        assert_eq!(response["result"]["gatewayAvailable"], true);
    }
}
