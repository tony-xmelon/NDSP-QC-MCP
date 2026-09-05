use crate::worker::DeviceController;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use qc_device_runtime::{
    generated_gateway,
    request::{
        self as runtime_request, finalize_device_backup, GatewayResponseProjection,
        GatewayTransaction, GatewayTransactionState, GatewayVerification, GatewayWritePlan,
        PlannedWrite, PresetMutationPlan,
    },
};
use qc_protocol::responses::decode_tempo_clock;
use qc_protocol::{domain, profile};
use qc_windows_midi::PerformanceMidi;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    jsonrpc: String,
    id: Value,
    method: String,
    #[serde(default = "empty_params")]
    params: Value,
}

fn empty_params() -> Value {
    json!({})
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
    let performance_midi = Mutex::new(PerformanceMidi::default());
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
        let response = handle(&controller, &performance_midi, request);
        let mut output = output
            .lock()
            .map_err(|_| "Native broker output lock was poisoned".to_string())?;
        write_response(&mut *output, &response)?;
    }
    Ok(())
}

fn handle(
    controller: &DeviceController,
    performance_midi: &Mutex<PerformanceMidi>,
    request: Request,
) -> Value {
    let id = request.id.clone();
    if request.jsonrpc != "2.0" || id.as_u64().is_none_or(|id| id == 0) {
        return error(id, -32600, "Invalid JSON-RPC request");
    }
    if !request.params.is_object() {
        return error(id, -32602, "JSON-RPC params must be an object");
    }
    if generated_gateway::broker_dispatch(&request.method).is_some() {
        if let Err(message) = generated_gateway::validate_params(&request.method, &request.params) {
            return error(id, -32602, &message);
        }
    }
    let result = match generated_gateway::broker_dispatch(&request.method) {
        Some(generated_gateway::BrokerDispatch::SystemStatus) => {
            let mut capabilities = vec!["nativeGateway"];
            capabilities.extend_from_slice(generated_gateway::CAPABILITIES);
            capabilities.push("hostMidiPerformance");
            Ok(json!({
                "platform": "Rust device gateway",
                "gatewayAvailable": true,
                "gatewayApiVersion": generated_gateway::API_VERSION,
                "capabilities": capabilities,
                "message": "Shared Rust QC engine active"
            }))
        }
        Some(generated_gateway::BrokerDispatch::Reconnect) => controller
            .reconnect()
            .map(|_| ready_connection_state(controller, "Quad Cortex handshake complete")),
        Some(generated_gateway::BrokerDispatch::ResetSession) => controller
            .reset_session()
            .map(|_| ready_connection_state(controller, "Communication session reset")),
        Some(generated_gateway::BrokerDispatch::Disconnect) => {
            controller.disconnect();
            Ok(connection_state(controller, "Quad Cortex session closed"))
        }
        // The native broker implements the generated gateway contract without
        // exposing raw HID/protobuf details to either client.
        Some(generated_gateway::BrokerDispatch::StateEvents) => {
            gateway_state_events(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::Snapshot) => controller
            .gateway_snapshot()
            .map(|snapshot| serde_json::to_value(snapshot).map_err(|error| error.to_string()))
            .unwrap_or_else(|| Err("No Quad Cortex preset has been synchronized yet".into())),
        Some(generated_gateway::BrokerDispatch::ListModels) => gateway_list_models(controller),
        Some(generated_gateway::BrokerDispatch::Identity) => gateway_identity(controller),
        Some(generated_gateway::BrokerDispatch::GatewayRead) => {
            execute_gateway_read(controller, &request.method, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::GatewayOperation) => {
            gateway_operation(controller, &request.params, &request.method)
        }
        Some(generated_gateway::BrokerDispatch::SetDeviceName) => {
            gateway_set_device_name(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::Undo) => gateway_history(controller, true),
        Some(generated_gateway::BrokerDispatch::Redo) => gateway_history(controller, false),
        Some(generated_gateway::BrokerDispatch::InhibitedModules) => {
            gateway_inhibited_modules(controller)
        }
        Some(generated_gateway::BrokerDispatch::PresetScreenshot) => {
            gateway_preset_screenshot(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::CaptureScreen) => {
            gateway_capture_screen(controller)
        }
        Some(generated_gateway::BrokerDispatch::TapScreen) => {
            gateway_tap_screen(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::TempoClock) => gateway_tempo_clock(controller),
        Some(generated_gateway::BrokerDispatch::SelectScene) => {
            gateway_select_scene(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::ToggleBypass) => {
            gateway_toggle_bypass(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::BlockDetails) => {
            gateway_block_details(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::LaneControlDetails) => {
            gateway_lane_control_details(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::PreviewParameter) => {
            gateway_parameter(controller, &request.params, true)
        }
        Some(generated_gateway::BrokerDispatch::SetParameter) => {
            gateway_parameter(controller, &request.params, false)
        }
        Some(generated_gateway::BrokerDispatch::PreviewLaneControlParameter) => {
            gateway_lane_control_parameter(controller, &request.params, true)
        }
        Some(generated_gateway::BrokerDispatch::SetLaneControlParameter) => {
            gateway_lane_control_parameter(controller, &request.params, false)
        }
        Some(generated_gateway::BrokerDispatch::SetLaneControlSceneMode) => {
            gateway_lane_control_scene_mode(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::ParameterAssignment) => {
            gateway_parameter_assignment(controller, &request.params, &request.method)
        }
        Some(generated_gateway::BrokerDispatch::SetTempo) => {
            gateway_set_tempo(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::SetMasterVolume) => {
            gateway_set_master_volume(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::MasterVolume) => gateway_master_volume(controller),
        Some(generated_gateway::BrokerDispatch::PerformanceMidi) => gateway_performance_midi(
            controller,
            performance_midi,
            &request.method,
            &request.params,
        ),
        Some(generated_gateway::BrokerDispatch::NavigateBank) => {
            gateway_navigate_bank(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::RecallPreset) => {
            gateway_recall_preset(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::ReloadPreset) => {
            gateway_reload_preset(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::ListPresetFolders) => {
            gateway_list_preset_folders(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::ListPresets) => {
            gateway_list_presets(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::ListPresetSlots) => {
            gateway_list_preset_slots(controller)
        }
        Some(generated_gateway::BrokerDispatch::SavePresetAs) => {
            gateway_save_preset_as(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::RenameCurrentPreset) => {
            gateway_rename_current_preset(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::CreateBackup) => {
            gateway_create_backup(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::CopyPreset) => {
            gateway_copy_preset(controller, &request.params)
        }
        Some(generated_gateway::BrokerDispatch::DuplicateSetlist) => {
            gateway_duplicate_setlist(controller, &request.params)
        }
        None if request.method == "device.status" => {
            serde_json::to_value(controller.status()).map_err(|error| error.to_string())
        }
        None if request.method == "device.raw.latest" => raw_latest(controller, &request.params),
        None if request.method == "device.raw.events" => raw_events(controller, &request.params),
        None if request.method == "device.state.events" => {
            state_events(controller, &request.params)
        }
        None if request.method == "device.state.blockDetails" => {
            state_block_details(controller, &request.params)
        }
        None if request.method == "device.command.scene" => {
            command_scene(controller, &request.params)
        }
        None if request.method == "device.command.bypass" => {
            command_bypass(controller, &request.params)
        }
        None if request.method == "device.command.parameter" => {
            command_parameter(controller, &request.params)
        }
        None if request.method == "device.command.tempo" => {
            command_tempo(controller, &request.params)
        }
        None if request.method == "device.command.operation" => {
            command_operation(controller, &request.params)
        }
        None if request.method == "device.raw.send" => raw_send(controller, &request.params),
        None if request.method == "device.raw.request" => raw_request(controller, &request.params),
        None => return error(id, -32601, &format!("Method not found: {}", request.method)),
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
    let status = controller.wait_for_ready(Duration::from_millis(profile::READY_WAIT_TIMEOUT_MS));
    if status.phase == "ready" {
        // USB synchronization and state decoding run on separate workers.
        // A successful reconnect must not return until the first decoded
        // preset is queryable by the very next gateway call.
        let _ = controller.wait_for_gateway_snapshot(Duration::from_secs(3), |_| true);
    }
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
    let messages = plan
        .operation
        .try_encode()
        .map_err(|error| error.to_string())?;
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

    let events = controller.subscribe_raw_events();
    for message in messages {
        controller.send_command(message)?;
    }
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match events.recv_timeout(remaining) {
            Ok(reply) if reply.message_type == plan.response_type => {
                if let Ok(value) = plan.projection.decode(&reply.payload) {
                    return Ok(value);
                }
            }
            Ok(_) => {}
            Err(_) => {
                return Err(format!(
                    "The Quad Cortex did not return a valid {method} reply within {} seconds",
                    timeout.as_secs()
                ));
            }
        }
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
    Ok(accepted_unverified(plan.detail))
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
    Ok(accepted_unverified(plan.detail))
}

fn gateway_tempo_clock(controller: &DeviceController) -> Result<Value, String> {
    let Some(raw) = controller.latest_message(profile::MESSAGE_TYPE_GLOBAL_TEMPO) else {
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

fn accepted_unverified(detail: impl Into<String>) -> Value {
    json!({
        "accepted": true,
        "verified": false,
        "verification": "accepted_unverified",
        "detail": detail.into()
    })
}

fn gateway_performance_midi(
    controller: &DeviceController,
    performance_midi: &Mutex<PerformanceMidi>,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    if !runtime_request::gateway_write_is_realtime(method) {
        return Err(format!(
            "{method} is not classified as a realtime gateway write"
        ));
    }
    let plan = plan_gateway_write(controller, method, params)?;
    let PlannedWrite::MidiControlChange { controller, value } = plan.write else {
        return Err(format!("{method} did not produce a host MIDI write"));
    };
    let endpoint = performance_midi
        .lock()
        .map_err(|_| "Performance MIDI lock was poisoned".to_string())?
        .send(controller, value)?;
    let mut result = accepted_unverified(format!(
        "{} immediately through {endpoint}; live USB state will reconcile the result.",
        plan.detail
    ));
    if let Some(object) = result.as_object_mut() {
        object.insert("immediate".into(), json!(true));
        object.insert("transport".into(), json!(endpoint));
    }
    Ok(result)
}

fn wait_for_transaction_event(
    controller: &DeviceController,
    events: &std::sync::mpsc::Receiver<crate::worker::DecodedStateFrame>,
    verification: GatewayVerification,
    after_sequence: u64,
    timeout: Duration,
) -> Option<qc_device_runtime::GatewaySnapshot> {
    let parameter_target = verification.parameter_target();
    let started = std::time::Instant::now();
    let transaction = GatewayTransaction::new(
        verification,
        u128::from(after_sequence),
        0,
        timeout.as_millis().min(u128::from(u64::MAX)) as u64,
    );
    loop {
        let now_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        let remaining = transaction.remaining_ms(now_ms);
        if remaining == 0 {
            return None;
        }
        let frame = events.recv_timeout(Duration::from_millis(remaining)).ok()?;
        let snapshot = controller.gateway_snapshot()?;
        let parameter_value = parameter_target.and_then(|(row, column, parameter_index)| {
            controller
                .block_details(row, column)
                .ok()
                .flatten()
                .and_then(|details| {
                    details
                        .parameters
                        .into_iter()
                        .find(|parameter| parameter.index == parameter_index)
                        .and_then(|parameter| parameter.normalized_value)
                })
        });
        let now_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        match transaction.state(
            &snapshot,
            parameter_value,
            u128::from(frame.sequence),
            now_ms,
        ) {
            GatewayTransactionState::Verified => return Some(snapshot),
            GatewayTransactionState::TimedOut => return None,
            GatewayTransactionState::Pending => {}
        }
    }
}

fn gateway_select_scene(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    gateway_operation(controller, params, "device.selectScene")
}

fn gateway_toggle_bypass(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    gateway_operation(controller, params, "device.toggleBypass")
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

fn lane_control_target(params: &Value) -> Result<(u32, &str), String> {
    let row = bounded_u32(params, "row", domain::GRID_ROWS - 1)?;
    let control = params
        .get("control")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "inputGate" | "laneOutput"))
        .ok_or_else(|| "control must be inputGate or laneOutput".to_string())?;
    Ok((row, control))
}

fn gateway_lane_control_details(
    controller: &DeviceController,
    params: &Value,
) -> Result<Value, String> {
    assert_expected_preset(controller, params)?;
    let (row, control) = lane_control_target(params)?;
    controller
        .lane_control_details(row, control)?
        .map(|details| serde_json::to_value(details).map_err(|error| error.to_string()))
        .unwrap_or_else(|| {
            Err(format!(
                "No {control} control is synchronized for row {}",
                row + 1
            ))
        })
}

fn gateway_lane_control_parameter(
    controller: &DeviceController,
    params: &Value,
    preview: bool,
) -> Result<Value, String> {
    assert_expected_preset(controller, params)?;
    let (row, control) = lane_control_target(params)?;
    let parameter_index = bounded_u32(params, "parameterIndex", u32::MAX)?;
    let before = controller
        .lane_control_details(row, control)?
        .ok_or_else(|| format!("No {control} control is synchronized for row {}", row + 1))?;
    let actual = before
        .parameters
        .iter()
        .find(|parameter| parameter.index == parameter_index)
        .and_then(|parameter| parameter.normalized_value);
    runtime_request::assert_expected_parameter(actual, params)?;
    let method = if preview {
        "device.previewLaneControlParameter"
    } else {
        "device.setLaneControlParameter"
    };
    let plan = plan_gateway_write(controller, method, params)?;
    if preview {
        execute_gateway_write(controller, &plan)?;
        let mut result = accepted_unverified(plan.detail);
        if let Some(object) = result.as_object_mut() {
            object.insert(
                "acceptedValue".into(),
                params.get("value").cloned().unwrap_or_else(|| json!(0.0)),
            );
        }
        return Ok(result);
    }
    let mut result = gateway_operation(controller, params, method)?;
    let details = controller
        .lane_control_details(row, control)?
        .ok_or_else(|| {
            "The write completed, but its lane control is absent from readback".to_string()
        })?;
    if let Some(object) = result.as_object_mut() {
        object.insert(
            "block".into(),
            serde_json::to_value(details).map_err(|error| error.to_string())?,
        );
    }
    Ok(result)
}

fn gateway_lane_control_scene_mode(
    controller: &DeviceController,
    params: &Value,
) -> Result<Value, String> {
    assert_expected_preset(controller, params)?;
    let (row, control) = lane_control_target(params)?;
    let parameter_index = bounded_u32(params, "parameterIndex", u32::MAX)?;
    let mut result = gateway_operation(controller, params, "device.setLaneControlSceneMode")?;
    let details = controller
        .lane_control_details(row, control)?
        .ok_or_else(|| {
            "The write completed, but its lane control is absent from readback".to_string()
        })?;
    let parameter = details
        .parameters
        .iter()
        .find(|item| item.index == parameter_index)
        .ok_or_else(|| {
            "The write completed, but its lane parameter is absent from readback".to_string()
        })?;
    let expected = params
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| "enabled must be true or false".to_string())?;
    if parameter.scene_mode != expected {
        return Err(format!(
            "Lane parameter scene behavior readback was {}, expected {expected}",
            parameter.scene_mode
        ));
    }
    if let Some(object) = result.as_object_mut() {
        object.insert(
            "block".into(),
            serde_json::to_value(details).map_err(|error| error.to_string())?,
        );
    }
    Ok(result)
}

fn gateway_parameter(
    controller: &DeviceController,
    params: &Value,
    preview: bool,
) -> Result<Value, String> {
    let row = bounded_u32(params, "row", domain::GRID_ROWS - 1)?;
    let column = bounded_u32(params, "column", domain::GRID_COLUMNS + 1)?;
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
    let value = params
        .get("value")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    if preview {
        execute_gateway_write(controller, &plan)?;
        let mut result = accepted_unverified(plan.detail);
        if let Some(object) = result.as_object_mut() {
            object.insert("acceptedValue".into(), json!(value));
        }
        Ok(result)
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
        let mut result = gateway_operation(controller, params, method)?;
        if let Some(object) = result.as_object_mut() {
            object.insert("block".into(), block);
        }
        Ok(result)
    }
}

fn gateway_parameter_assignment(
    controller: &DeviceController,
    params: &Value,
    method: &str,
) -> Result<Value, String> {
    let row = bounded_u32(params, "row", domain::GRID_ROWS - 1)?;
    let column = bounded_u32(params, "column", domain::GRID_COLUMNS + 1)?;
    let parameter_index = bounded_u32(params, "parameterIndex", u32::MAX)?;
    let mut result = gateway_operation(controller, params, method)?;
    let block = controller
        .block_details(row, column)?
        .ok_or_else(|| "The write completed, but its block is absent from readback".to_string())?;
    let parameter = block
        .parameters
        .iter()
        .find(|parameter| parameter.index == parameter_index)
        .ok_or_else(|| {
            "The write completed, but its parameter is absent from readback".to_string()
        })?;

    match method {
        "device.setParameterSceneMode" => {
            let expected = params
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| "enabled must be true or false".to_string())?;
            if parameter.scene_mode != expected {
                return Err(format!(
                    "Parameter scene behavior readback was {}, expected {expected}",
                    parameter.scene_mode
                ));
            }
        }
        "device.setParameterExpression" => {
            let expected_pedal = bounded_u32(params, "pedal", 2)? as i32;
            let actual_pedal = parameter.expression.unwrap_or(0);
            if actual_pedal != expected_pedal {
                return Err(format!(
                    "Parameter expression readback was pedal {actual_pedal}, expected {expected_pedal}"
                ));
            }
            if expected_pedal != 0 {
                let expected_minimum = normalized_f64(params, "minimum")?;
                let expected_maximum = normalized_f64(params, "maximum")?;
                let actual_minimum = parameter.expression_minimum.map(f64::from);
                let actual_maximum = parameter.expression_maximum.map(f64::from);
                let close = |actual: Option<f64>, expected: f64| {
                    actual.is_some_and(|value| (value - expected).abs() <= 0.001)
                };
                if !close(actual_minimum, expected_minimum)
                    || !close(actual_maximum, expected_maximum)
                {
                    return Err(format!(
                        "Parameter expression range readback was {:?}-{:?}, expected {expected_minimum}-{expected_maximum}",
                        actual_minimum, actual_maximum
                    ));
                }
            }
        }
        _ => return Err(format!("Unsupported parameter assignment method: {method}")),
    }

    if let Some(object) = result.as_object_mut() {
        object.insert(
            "block".into(),
            serde_json::to_value(block).map_err(|error| error.to_string())?,
        );
    }
    Ok(result)
}

fn gateway_set_tempo(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    gateway_operation(controller, params, "device.setTempo")
}

fn latest_master_volume(controller: &DeviceController) -> Option<f32> {
    controller
        .state_events_since(0, domain::STATE_EVENT_MAXIMUM_LIMIT)
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
    gateway_operation(controller, params, "device.setMasterVolume")
}

fn gateway_operation(
    controller: &DeviceController,
    params: &Value,
    method: &str,
) -> Result<Value, String> {
    let plan = plan_gateway_write(controller, method, params)?;
    let events = controller.subscribe_state_events();
    let after_sequence = controller.latest_state_sequence();
    execute_gateway_write(controller, &plan)?;
    if runtime_request::gateway_write_is_realtime(method) {
        return Ok(accepted_unverified(plan.detail));
    }
    if !plan.verification.requires_authoritative_readback() {
        let Some(read_method) = runtime_request::gateway_write_readback_method(method) else {
            return Ok(accepted_unverified(plan.detail));
        };
        let response = execute_gateway_read(controller, read_method, &json!({}))?;
        if !runtime_request::gateway_write_readback_matches(method, params, &response) {
            return Err(format!(
                "{} was sent, but correlated {read_method} readback did not match",
                plan.detail
            ));
        }
        return Ok(json!({
            "accepted": true,
            "verified": true,
            "verification": "authoritative_readback",
            "detail": plan.detail,
            "readback": response
        }));
    }
    if method == "device.copyScene" {
        // CorOS applies a scene copy asynchronously. An immediate preset READ
        // can return the pre-copy colors and no later snapshot, especially
        // when a second swap restores the first. Let that one transaction
        // settle before requesting its authoritative preset readback.
        thread::sleep(Duration::from_millis(250));
    }
    let request_id = next_request_id();
    request_command(
        controller,
        qc_protocol::commands::read_current_preset(request_id),
        15,
        Some(request_id),
        Duration::from_secs(15),
    )?;
    let snapshot = wait_for_transaction_event(
        controller,
        &events,
        plan.verification.clone(),
        after_sequence,
        Duration::from_secs(2),
    )
    .ok_or_else(|| {
        format!(
            "{} was sent, but authoritative preset readback did not confirm it",
            plan.detail
        )
    })?;
    let parameter_value =
        plan.verification
            .parameter_target()
            .and_then(|(row, column, parameter_index)| {
                controller
                    .block_details(row, column)
                    .ok()
                    .flatten()
                    .and_then(|details| {
                        details
                            .parameters
                            .into_iter()
                            .find(|parameter| parameter.index == parameter_index)
                            .and_then(|parameter| parameter.normalized_value)
                    })
            });
    if !plan.verification.matches(&snapshot, parameter_value) {
        return Err(format!(
            "{} was sent, but authoritative preset readback rejected it",
            plan.detail
        ));
    }
    Ok(json!({
        "accepted": true,
        "verified": true,
        "verification": "authoritative_readback",
        "detail": plan.detail,
        "snapshot": snapshot
    }))
}

fn wait_for_recovered_position(
    controller: &DeviceController,
    setlist_key: &str,
    position: u32,
    require_clean: bool,
) -> Option<qc_device_runtime::GatewaySnapshot> {
    let matches = |snapshot: &qc_device_runtime::GatewaySnapshot| {
        snapshot.setlist_key.trim_end_matches('/') == setlist_key.trim_end_matches('/')
            && snapshot.preset_position == position
            && (!require_clean || !snapshot.dirty)
    };
    controller
        .wait_for_gateway_snapshot(Duration::from_secs(4), matches)
        .filter(matches)
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
    let after_sequence = controller.latest_state_sequence();
    let verification = plan.verification();
    let confirm = || -> Result<qc_device_runtime::GatewaySnapshot, String> {
        if let Some(after) = wait_for_transaction_event(
            controller,
            &device_events,
            verification.clone(),
            after_sequence,
            Duration::from_millis(650),
        ) {
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
        wait_for_transaction_event(
            controller,
            &device_events,
            verification.clone(),
            after_sequence,
            Duration::from_millis(300),
        )
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
            controller.reset_session()?;
            let status = controller.wait_for_ready(Duration::from_secs(12));
            if status.phase != "ready" {
                return Err(format!(
                    "Preset recall required USB recovery, but reconnection ended in {}: {}",
                    status.phase, status.detail
                ));
            }
            // The original command may have been dropped by the wedged HID
            // channel rather than merely missing its unsolicited echo. Replay
            // the idempotent recall/reload once on the fresh session.
            controller.send_command(recall_message(next_request_id()))?;
            // wait_for_ready may observe the fresh handshake after its state
            // frame has already been published. The synchronized snapshot is
            // authoritative after a session reset, so inspect it before
            // waiting for another unsolicited position frame.
            let recovered = wait_for_recovered_position(
                controller,
                &plan.setlist_key,
                plan.position,
                plan.require_clean,
            )
            .ok_or_else(|| {
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
        let events = controller.subscribe_state_events();
        let before_sequence = controller.latest_state_sequence();
        execute_planned_write(controller, &stage.write)?;
        let verification = stage.verification;
        if !matches!(verification, GatewayVerification::None) {
            let after = wait_for_transaction_event(
                controller,
                &events,
                verification.clone(),
                before_sequence,
                Duration::from_millis(stage.timeout_ms),
            )
            .ok_or_else(|| {
                "The preset operation did not produce a verified device snapshot".to_string()
            })?;
            if !verification.matches(&after, None) {
                return Err(
                    "The preset operation completed, but live-state verification failed.".into(),
                );
            }
            observed = Some(after);
        }
        if stage.settle_ms > 0 {
            thread::sleep(Duration::from_millis(stage.settle_ms));
        }
    }
    let after = observed
        .or_else(|| controller.gateway_snapshot())
        .ok_or_else(|| "The preset operation produced no synchronized snapshot".to_string())?;
    for preset in &plan.saved_presets {
        controller.record_saved_preset(
            &preset.setlist_key,
            preset.position,
            &preset.name,
            preset.instrument,
        );
    }
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
    let raw = controller.create_backup(Duration::from_millis(profile::BACKUP_TOTAL_TIMEOUT_MS))?;
    finalize_device_backup(&raw, &name)
}

fn gateway_copy_preset(controller: &DeviceController, params: &Value) -> Result<Value, String> {
    execute_preset_mutation(
        controller,
        controller.plan_preset_mutation("device.copyPreset", params)?,
    )
}

fn gateway_duplicate_setlist(
    controller: &DeviceController,
    params: &Value,
) -> Result<Value, String> {
    execute_preset_mutation(
        controller,
        controller.plan_preset_mutation("device.duplicateSetlist", params)?,
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
    let after = optional_u64(params, "afterSequence")?.unwrap_or(0);
    let kind = params
        .get("messageType")
        .map(|_| message_type(params, "messageType"))
        .transpose()?;
    let limit = optional_bounded_u64(params, "limit", 1, domain::STATE_EVENT_MAXIMUM_LIMIT as u64)?
        .unwrap_or(domain::STATE_EVENT_DEFAULT_LIMIT as u64) as usize;
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
    let after = optional_u64(params, "afterSequence")?.unwrap_or(0);
    let limit = optional_bounded_u64(params, "limit", 1, domain::STATE_EVENT_MAXIMUM_LIMIT as u64)?
        .unwrap_or(domain::STATE_EVENT_DEFAULT_LIMIT as u64) as usize;
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

fn optional_u64(params: &Value, field: &str) -> Result<Option<u64>, String> {
    match params.get(field) {
        None => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("{field} must be a non-negative integer")),
    }
}

fn optional_bounded_u64(
    params: &Value,
    field: &str,
    minimum: u64,
    maximum: u64,
) -> Result<Option<u64>, String> {
    let Some(value) = optional_u64(params, field)? else {
        return Ok(None);
    };
    if !(minimum..=maximum).contains(&value) {
        return Err(format!(
            "{field} must be an integer from {minimum} through {maximum}"
        ));
    }
    Ok(Some(value))
}

fn normalized_f64(params: &Value, field: &str) -> Result<f64, String> {
    params
        .get(field)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
        .ok_or_else(|| format!("{field} must be a number from 0 through 1"))
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
    let request_id = optional_u64(params, "requestId")?;
    let timeout_ms = optional_bounded_u64(params, "timeoutMs", 1, 60_000)?.unwrap_or(10_000);
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
    if body.len() > qc_protocol::domain::IPC_MAX_FRAME_BYTES {
        return Err("Native broker response exceeds the IPC frame limit".into());
    }
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
    fn optional_event_and_raw_request_numbers_are_strictly_typed_and_bounded() {
        assert_eq!(optional_u64(&json!({}), "afterSequence"), Ok(None));
        assert_eq!(
            optional_u64(&json!({"afterSequence": 7}), "afterSequence"),
            Ok(Some(7))
        );
        for invalid in [json!(null), json!(-1), json!(1.5), json!("7"), json!(true)] {
            assert!(optional_u64(&json!({"afterSequence": invalid}), "afterSequence").is_err());
        }
        assert!(optional_bounded_u64(&json!({"limit": 0}), "limit", 1, 4096).is_err());
        assert!(optional_bounded_u64(&json!({"limit": 4097}), "limit", 1, 4096).is_err());
        assert_eq!(
            optional_bounded_u64(&json!({"timeoutMs": 60_000}), "timeoutMs", 1, 60_000),
            Ok(Some(60_000))
        );
    }

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
    fn request_envelope_rejects_unknown_fields_and_nonpositive_ids() {
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"system.status","extra":true}"#;
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(body);
        assert!(read_request(&mut frame.as_slice()).is_err());

        let controller = DeviceController::start_disconnected();
        let performance_midi = Mutex::new(PerformanceMidi::default());
        let response = handle(
            &controller,
            &performance_midi,
            Request {
                jsonrpc: "2.0".into(),
                id: json!(0),
                method: "system.status".into(),
                params: json!({}),
            },
        );
        assert_eq!(response["error"]["code"], -32600);
    }

    #[test]
    fn canonical_gateway_boundary_rejects_missing_extra_and_wrong_typed_arguments() {
        assert!(generated_gateway::validate_params("device.snapshot", &json!({})).is_ok());
        assert!(
            generated_gateway::validate_params("device.snapshot", &json!({"ignored": true}))
                .is_err()
        );
        assert!(generated_gateway::validate_params(
            "device.setTempo",
            &json!({
                "bpm": 120, "expectedTempo": 120, "expectedPresetName": "Clean"
            })
        )
        .is_ok());
        assert!(generated_gateway::validate_params(
            "device.setTempo",
            &json!({
                "bpm": true, "expectedTempo": 120, "expectedPresetName": "Clean"
            })
        )
        .is_err());
        assert!(generated_gateway::validate_params(
            "device.setTempo",
            &json!({
                "expectedTempo": 120, "expectedPresetName": "Clean"
            })
        )
        .is_err());
        assert!(generated_gateway::validate_params(
            "device.setInputPort",
            &json!({
                "inputPortId": 1, "levelDb": null, "impedance": null,
                "inputType": null, "groundLift": null
            })
        )
        .is_ok());
        assert!(generated_gateway::validate_params(
            "device.setInputPort",
            &json!({
                "inputPortId": 1, "levelDb": "12", "impedance": null,
                "inputType": null, "groundLift": null
            })
        )
        .is_err());
    }

    #[test]
    fn raw_message_types_are_bounded_to_registry() {
        assert!(message_type(&json!({"messageType": 1}), "messageType").is_ok());
        assert!(message_type(&json!({"messageType": 72}), "messageType").is_ok());
        assert!(message_type(&json!({"messageType": 0}), "messageType").is_err());
        assert!(message_type(&json!({"messageType": 73}), "messageType").is_err());
    }

    #[test]
    fn writes_without_a_readback_predicate_are_explicitly_unverified() {
        let result = accepted_unverified("Undo sent");
        assert_eq!(result["accepted"], true);
        assert_eq!(result["verified"], false);
        assert_eq!(result["verification"], "accepted_unverified");
        assert_eq!(result["detail"], "Undo sent");
    }

    #[test]
    fn system_status_identifies_the_rust_gateway_contract() {
        let controller = DeviceController::start_disconnected();
        assert_eq!(controller.status().phase, "disconnected");
        let performance_midi = Mutex::new(PerformanceMidi::default());
        let response = handle(
            &controller,
            &performance_midi,
            Request {
                jsonrpc: "2.0".into(),
                id: json!(1),
                method: "system.status".into(),
                params: json!({}),
            },
        );
        assert_eq!(response["result"]["platform"], "Rust device gateway");
        assert_eq!(
            response["result"]["gatewayApiVersion"],
            generated_gateway::API_VERSION
        );
        assert_eq!(response["result"]["gatewayAvailable"], true);
        for capability in generated_gateway::CAPABILITIES {
            assert!(response["result"]["capabilities"]
                .as_array()
                .expect("capability array")
                .iter()
                .any(|value| value == capability));
        }
    }
}
