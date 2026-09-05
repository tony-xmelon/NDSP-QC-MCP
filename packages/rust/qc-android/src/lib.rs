use jni::objects::{JByteArray, JClass, JString};
use jni::sys::{jbyteArray, jint, jlong, jstring};
use jni::JNIEnv;
use qc_device_runtime::request::{
    assert_expected_parameter, finalize_device_backup, gateway_write_is_realtime,
    gateway_write_readback_method, gateway_write_retryable, merge_expected_state,
    plan_gateway_read, plan_gateway_write, plan_preset_mutation, plan_preset_recall,
    GatewayReadPlan, GatewayResponseProjection, GatewayTransaction, GatewayTransactionState,
    GatewayVerification, PlannedWrite, PresetMutationPlan,
};
use qc_device_runtime::{GatewaySnapshot, PresetLibrary};
use qc_protocol::commands::{self, OutboundMessage};
use qc_protocol::framing;
use qc_protocol::responses::{decode_tempo_clock, BackupAssembler};
use qc_protocol::session::{FrameAssembler, SessionMachine};
use qc_protocol::state::decode_preset_folder;
use qc_protocol::state::{parse_model_repo, StateDecoder};
use serde_json::Value;
use std::collections::HashMap;
use std::ptr;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

struct DecoderHandle {
    state: Mutex<StateDecoder>,
    snapshot: Mutex<GatewaySnapshot>,
    presets: Mutex<PresetLibrary>,
    frames: Mutex<FrameAssembler>,
    session: Mutex<SessionMachine>,
    backup: Mutex<BackupAssembler>,
}

fn handles() -> &'static Mutex<HashMap<jlong, Arc<DecoderHandle>>> {
    static HANDLES: OnceLock<Mutex<HashMap<jlong, Arc<DecoderHandle>>>> = OnceLock::new();
    HANDLES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn handle(value: jlong) -> Result<Arc<DecoderHandle>, String> {
    if value <= 0 {
        return Err("native QC decoder handle is invalid".into());
    }
    handles()
        .lock()
        .map_err(|_| "native QC handle registry lock was poisoned".to_string())?
        .get(&value)
        .cloned()
        .ok_or_else(|| "native QC decoder handle is closed".to_string())
}

fn register_handle() -> jlong {
    static NEXT_HANDLE: AtomicI64 = AtomicI64::new(1);
    let decoder = Arc::new(DecoderHandle {
        state: Mutex::new(StateDecoder::new()),
        snapshot: Mutex::new(GatewaySnapshot::default()),
        presets: Mutex::new(PresetLibrary::default()),
        frames: Mutex::new(FrameAssembler::new()),
        session: Mutex::new(SessionMachine::new(0)),
        backup: Mutex::new(BackupAssembler::default()),
    });
    let value = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    match handles().lock() {
        Ok(mut registry) if value > 0 => {
            registry.insert(value, decoder);
            value
        }
        _ => 0,
    }
}

fn unregister_handle(value: jlong) {
    if let Ok(mut registry) = handles().lock() {
        registry.remove(&value);
    }
}

fn json_result(env: &mut JNIEnv, result: Result<String, String>) -> jstring {
    match result {
        Ok(value) => env
            .new_string(value)
            .map(|value| value.into_raw())
            .unwrap_or(ptr::null_mut()),
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            ptr::null_mut()
        }
    }
}

fn bytes_result(env: &mut JNIEnv, result: Result<Vec<u8>, String>) -> jbyteArray {
    match result {
        Ok(value) => env
            .byte_array_from_slice(&value)
            .map(|value| value.into_raw())
            .unwrap_or(ptr::null_mut()),
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeMergeExpectedState(
    mut env: JNIEnv,
    _class: JClass,
    params_json: JString,
    expected_json: JString,
) -> jstring {
    let result = (|| {
        let params: Value = serde_json::from_str(
            &env.get_string(&params_json)
                .map_err(|error| error.to_string())?
                .to_string_lossy(),
        )
        .map_err(|error| error.to_string())?;
        let expected: Value = serde_json::from_str(
            &env.get_string(&expected_json)
                .map_err(|error| error.to_string())?
                .to_string_lossy(),
        )
        .map_err(|error| error.to_string())?;
        serde_json::to_string(&merge_expected_state(&params, &expected))
            .map_err(|error| error.to_string())
    })();
    json_result(&mut env, result)
}

fn message_envelope(messages: Vec<OutboundMessage>) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    result.extend_from_slice(
        &u32::try_from(messages.len())
            .map_err(|_| "too many outbound QC messages".to_string())?
            .to_le_bytes(),
    );
    for message in messages {
        result.extend_from_slice(&message.message_type.to_le_bytes());
        result.extend_from_slice(
            &u32::try_from(message.payload.len())
                .map_err(|_| "outbound QC message is too large".to_string())?
                .to_le_bytes(),
        );
        result.extend_from_slice(&message.payload);
    }
    Ok(result)
}

fn gateway_write_envelope(
    detail: &str,
    verification: &GatewayVerification,
    retryable: bool,
    realtime: bool,
    write: PlannedWrite,
) -> Result<Vec<u8>, String> {
    let detail = detail.as_bytes();
    let verification = serde_json::to_vec(verification).map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    result.extend_from_slice(
        &u32::try_from(detail.len())
            .map_err(|_| "gateway write detail is too large".to_string())?
            .to_le_bytes(),
    );
    result.extend_from_slice(detail);
    result.extend_from_slice(
        &u32::try_from(verification.len())
            .map_err(|_| "gateway verification descriptor is too large".to_string())?
            .to_le_bytes(),
    );
    result.extend_from_slice(&verification);
    let (lane, controller, value, messages) = match write {
        PlannedWrite::HidCommand(command) => (0_u8, 0_u8, 0_u8, vec![command.encode()]),
        PlannedWrite::HidOperation(operation) => (
            0,
            0,
            0,
            operation.try_encode().map_err(|error| error.to_string())?,
        ),
        PlannedWrite::MidiControlChange { controller, value } => (1, controller, value, Vec::new()),
    };
    result.extend_from_slice(&[
        lane,
        controller,
        value,
        u8::from(retryable),
        u8::from(realtime),
    ]);
    result.extend_from_slice(&message_envelope(messages)?);
    Ok(result)
}

fn planned_messages(write: PlannedWrite) -> Result<Vec<OutboundMessage>, String> {
    Ok(match write {
        PlannedWrite::HidCommand(command) => vec![command.encode()],
        PlannedWrite::HidOperation(operation) => {
            operation.try_encode().map_err(|error| error.to_string())?
        }
        PlannedWrite::MidiControlChange { .. } => Vec::new(),
    })
}

fn gateway_workflow_envelope(plan: PresetMutationPlan) -> Result<Vec<u8>, String> {
    let detail = plan.detail.as_bytes();
    let completion = serde_json::to_vec(&serde_json::json!({
        "savedName": plan.saved_name,
        "setlistKey": plan.setlist_key,
        "position": plan.position,
        "instrument": plan.instrument,
        "savedPresets": plan.saved_presets,
    }))
    .map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    result.extend_from_slice(
        &u32::try_from(detail.len())
            .map_err(|_| "gateway workflow detail is too large".to_string())?
            .to_le_bytes(),
    );
    result.extend_from_slice(detail);
    result.extend_from_slice(
        &u32::try_from(completion.len())
            .map_err(|_| "gateway workflow completion metadata is too large".to_string())?
            .to_le_bytes(),
    );
    result.extend_from_slice(&completion);
    result.extend_from_slice(
        &u32::try_from(plan.stages.len())
            .map_err(|_| "gateway workflow has too many stages".to_string())?
            .to_le_bytes(),
    );
    for stage in plan.stages {
        result.extend_from_slice(&stage.timeout_ms.to_le_bytes());
        result.extend_from_slice(&stage.settle_ms.to_le_bytes());
        let verification =
            serde_json::to_vec(&stage.verification).map_err(|error| error.to_string())?;
        result.extend_from_slice(
            &u32::try_from(verification.len())
                .map_err(|_| "gateway verification descriptor is too large".to_string())?
                .to_le_bytes(),
        );
        result.extend_from_slice(&verification);
        result.extend_from_slice(&message_envelope(planned_messages(stage.write)?)?);
    }
    Ok(result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeRecordSavedPreset(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
    setlist_key: JString,
    position: jint,
    name: JString,
    instrument: jint,
) {
    let result = (|| {
        let setlist_key = env
            .get_string(&setlist_key)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let name = env
            .get_string(&name)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let position = u32::try_from(position)
            .map_err(|_| "preset position must be non-negative".to_string())?;
        handle(value)?
            .presets
            .lock()
            .map_err(|_| "native QC preset library lock was poisoned".to_string())?
            .record_saved(&setlist_key, position, &name, instrument);
        Ok::<_, String>(())
    })();
    if let Err(error) = result {
        let _ = env.throw_new("java/lang/IllegalStateException", error);
    }
}

fn gateway_read_envelope(plan: GatewayReadPlan) -> Result<Vec<u8>, String> {
    let projection = serde_json::to_vec(&plan.projection).map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    result.extend_from_slice(&plan.response_type.to_le_bytes());
    result.extend_from_slice(&plan.timeout_ms.to_le_bytes());
    result.extend_from_slice(
        &u32::try_from(projection.len())
            .map_err(|_| "gateway response projection is too large".to_string())?
            .to_le_bytes(),
    );
    result.extend_from_slice(&projection);
    result.extend_from_slice(&message_envelope(
        plan.operation
            .try_encode()
            .map_err(|error| error.to_string())?,
    )?);
    Ok(result)
}

fn unsigned(args: &Value, name: &str) -> Result<u32, String> {
    args.get(name)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| format!("{name} must be a non-negative integer"))
}

fn text_arg(args: &Value, name: &str) -> Result<String, String> {
    args.get(name)
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| format!("{name} must be a string"))
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeEncodeCommand(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
    command: JString,
    args_json: JString,
) -> jbyteArray {
    let result = (|| {
        let native = handle(value)?;
        let command = env
            .get_string(&command)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let args_json = env
            .get_string(&args_json)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let args: Value = serde_json::from_str(&args_json).map_err(|error| error.to_string())?;
        let messages = match command.as_str() {
            "reset" => vec![commands::reset_comms(
                args.get("requestId")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "requestId must be a non-negative integer".to_string())?,
                text_arg(&args, "sessionId")?,
            )],
            "initialize" => commands::initialization(),
            "read" => vec![commands::read(
                u16::try_from(unsigned(&args, "messageType")?)
                    .map_err(|_| "messageType is out of range".to_string())?,
            )],
            "readCurrentPreset" => vec![commands::read_current_preset(
                args.get("requestId")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "requestId must be a non-negative integer".to_string())?,
            )],
            "keepalive" => vec![commands::keepalive()],
            "backup" => {
                native
                    .backup
                    .lock()
                    .map_err(|_| "native QC backup lock was poisoned".to_string())?
                    .reset();
                vec![commands::create_local_backup()]
            }
            other => return Err(format!("unknown native QC command: {other}")),
        };
        message_envelope(messages)
    })();
    bytes_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativePlanGatewayWrite(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
    method: JString,
    args_json: JString,
) -> jbyteArray {
    let result = (|| {
        let native = handle(value)?;
        let method = env
            .get_string(&method)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let args_json = env
            .get_string(&args_json)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let args: Value = serde_json::from_str(&args_json).map_err(|error| error.to_string())?;
        if method == "device.setParameter" {
            let row = unsigned(&args, "row")?;
            let column = unsigned(&args, "column")?;
            let parameter_index = unsigned(&args, "parameterIndex")?;
            let actual = native
                .state
                .lock()
                .map_err(|_| "native QC state lock was poisoned".to_string())?
                .block_details(row, column)
                .and_then(|details| {
                    details
                        .parameters
                        .into_iter()
                        .find(|parameter| parameter.index == parameter_index)
                        .and_then(|parameter| parameter.normalized_value)
                });
            assert_expected_parameter(actual, &args)?;
        }
        let snapshot = native
            .snapshot
            .lock()
            .map_err(|_| "native QC snapshot lock was poisoned".to_string())?;
        let (detail, verification, write) = match method.as_str() {
            "device.recallPreset" | "device.navigateBank" | "device.reloadPreset" => {
                let plan = plan_preset_recall(&method, &args, Some(&snapshot))?;
                (
                    plan.detail.clone(),
                    plan.verification(),
                    PlannedWrite::HidCommand(plan.command),
                )
            }
            _ => {
                let plan = plan_gateway_write(&method, &args, Some(&snapshot))?;
                (plan.detail, plan.verification, plan.write)
            }
        };
        gateway_write_envelope(
            &detail,
            &verification,
            gateway_write_retryable(&method),
            gateway_write_is_realtime(&method),
            write,
        )
    })();
    bytes_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativePlanGatewayWorkflow(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
    method: JString,
    args_json: JString,
) -> jbyteArray {
    let result = (|| {
        let native = handle(value)?;
        let method = env
            .get_string(&method)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let args_json = env
            .get_string(&args_json)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let args: Value = serde_json::from_str(&args_json).map_err(|error| error.to_string())?;
        let snapshot = native
            .snapshot
            .lock()
            .map_err(|_| "native QC snapshot lock was poisoned".to_string())?;
        let presets = native
            .presets
            .lock()
            .map_err(|_| "native QC preset library lock was poisoned".to_string())?;
        let plan = plan_preset_mutation(&method, &args, Some(&snapshot), &presets)?;
        gateway_workflow_envelope(plan)
    })();
    bytes_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativePlanGatewayRead(
    mut env: JNIEnv,
    _class: JClass,
    method: JString,
    args_json: JString,
    request_id: jlong,
) -> jbyteArray {
    let result = (|| {
        let method = env
            .get_string(&method)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let args_json = env
            .get_string(&args_json)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let args: Value = serde_json::from_str(&args_json).map_err(|error| error.to_string())?;
        let request_id =
            u64::try_from(request_id).map_err(|_| "request id must be non-negative".to_string())?;
        gateway_read_envelope(plan_gateway_read(&method, &args, request_id)?)
    })();
    bytes_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeDecodeGatewayResponse(
    mut env: JNIEnv,
    _class: JClass,
    projection_json: JString,
    payload: JByteArray,
) -> jstring {
    let result = (|| {
        let projection_json = env
            .get_string(&projection_json)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let projection: GatewayResponseProjection =
            serde_json::from_str(&projection_json).map_err(|error| error.to_string())?;
        let payload = env
            .convert_byte_array(payload)
            .map_err(|error| error.to_string())?;
        let value = projection.decode(&payload)?;
        serde_json::to_string(&value).map_err(|error| error.to_string())
    })();
    json_result(&mut env, result)
}

/// 0 = pending, 1 = verified, 2 = timed out. Freshness, matching, and timeout
/// are evaluated by the same runtime used by the Windows broker.
#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeGatewayTransactionState(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
    verification_json: JString,
    after_sequence: jlong,
    deadline_ms: jlong,
    observation_sequence: jlong,
    now_ms: jlong,
) -> jint {
    let result = (|| {
        let native = handle(value)?;
        let verification_json = env
            .get_string(&verification_json)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let verification: GatewayVerification =
            serde_json::from_str(&verification_json).map_err(|error| error.to_string())?;
        let parameter_value =
            if let Some((row, column, parameter_index)) = verification.parameter_target() {
                native
                    .state
                    .lock()
                    .map_err(|_| "native QC state lock was poisoned".to_string())?
                    .block_details(row, column)
                    .and_then(|details| {
                        details
                            .parameters
                            .into_iter()
                            .find(|parameter| parameter.index == parameter_index)
                            .and_then(|parameter| parameter.normalized_value)
                    })
            } else {
                None
            };
        let snapshot = native
            .snapshot
            .lock()
            .map_err(|_| "native QC snapshot lock was poisoned".to_string())?;
        let transaction = GatewayTransaction::new(
            verification,
            after_sequence.max(0) as u128,
            0,
            deadline_ms.max(0) as u64,
        );
        Ok::<_, String>(transaction.state(
            &snapshot,
            parameter_value,
            observation_sequence.max(0) as u128,
            now_ms.max(0) as u64,
        ))
    })();
    match result {
        Ok(GatewayTransactionState::Pending) => 0,
        Ok(GatewayTransactionState::Verified) => 1,
        Ok(GatewayTransactionState::TimedOut) => 2,
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            2
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeGatewayReadbackMatches(
    mut env: JNIEnv,
    _class: JClass,
    method: JString,
    params_json: JString,
    response_json: JString,
) -> jint {
    let result = (|| {
        let method = env
            .get_string(&method)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let params: Value = serde_json::from_str(
            &env.get_string(&params_json)
                .map_err(|error| error.to_string())?
                .to_string_lossy(),
        )
        .map_err(|error| error.to_string())?;
        let response: Value = serde_json::from_str(
            &env.get_string(&response_json)
                .map_err(|error| error.to_string())?
                .to_string_lossy(),
        )
        .map_err(|error| error.to_string())?;
        Ok::<_, String>(qc_device_runtime::request::gateway_write_readback_matches(
            &method, &params, &response,
        ))
    })();
    match result {
        Ok(true) => 1,
        Ok(false) => 0,
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalArgumentException", error);
            0
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeGatewayWriteReadbackMethod(
    mut env: JNIEnv,
    _class: JClass,
    method: JString,
) -> jstring {
    let result = env
        .get_string(&method)
        .map_err(|error| error.to_string())
        .map(|method| {
            gateway_write_readback_method(&method.to_string_lossy())
                .unwrap_or("")
                .to_string()
        });
    json_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeEncodeFrame(
    mut env: JNIEnv,
    _class: JClass,
    message_type: jint,
    payload: JByteArray,
) -> jbyteArray {
    let result = (|| {
        let message_type =
            u16::try_from(message_type).map_err(|_| "invalid QC message type".to_string())?;
        let payload = env
            .convert_byte_array(payload)
            .map_err(|error| error.to_string())?;
        Ok(framing::encode(message_type, &payload)
            .into_iter()
            .flatten()
            .collect())
    })();
    bytes_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativePushReport(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
    report: JByteArray,
) -> jbyteArray {
    let result = (|| {
        let report = env
            .convert_byte_array(report)
            .map_err(|error| error.to_string())?;
        let Some((message_type, payload)) = handle(value)?
            .frames
            .lock()
            .map_err(|_| "native QC frame lock was poisoned".to_string())?
            .push(report)
            .map_err(|error| format!("invalid QC frame: {error}"))?
        else {
            return Ok(Vec::new());
        };
        let mut result = Vec::with_capacity(payload.len() + 2);
        result.extend_from_slice(&message_type.to_le_bytes());
        result.extend_from_slice(&payload);
        Ok(result)
    })();
    bytes_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeReportSize(
    _env: JNIEnv,
    _class: JClass,
) -> jint {
    framing::REPORT_SIZE as jint
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeOutboundReportId(
    _env: JNIEnv,
    _class: JClass,
) -> jint {
    framing::OUT_REPORT_ID as jint
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeInboundReportId(
    _env: JNIEnv,
    _class: JClass,
) -> jint {
    framing::IN_REPORT_ID as jint
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeCreate(
    _env: JNIEnv,
    _class: JClass,
) -> jlong {
    register_handle()
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeTempoClock(
    mut env: JNIEnv,
    _class: JClass,
    payload: JByteArray,
) -> jstring {
    let result = (|| {
        let bytes = env
            .convert_byte_array(payload)
            .map_err(|error| error.to_string())?;
        serde_json::to_string(&decode_tempo_clock(&bytes).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    })();
    json_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeConsumeBackupChunk(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
    payload: JByteArray,
    name: JString,
) -> jstring {
    let result = (|| {
        let native = handle(value)?;
        let bytes = env
            .convert_byte_array(payload)
            .map_err(|error| error.to_string())?;
        let name = env
            .get_string(&name)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let (complete, started, chunks, ignored_prefix_chunks, ignored_prefix_terminators) = {
            let mut assembler = native
                .backup
                .lock()
                .map_err(|_| "native QC backup lock was poisoned".to_string())?;
            let complete = assembler.push(&bytes).map_err(|error| error.to_string())?;
            (
                complete,
                assembler.started(),
                assembler.chunks(),
                assembler.ignored_prefix_chunks(),
                assembler.ignored_prefix_terminators(),
            )
        };
        let backup = complete
            .map(|raw| finalize_device_backup(&raw, &name))
            .transpose()?;
        serde_json::to_string(&serde_json::json!({
            "complete": backup.is_some(),
            "backup": backup,
            "started": started,
            "chunks": chunks,
            "ignoredPrefixChunks": ignored_prefix_chunks,
            "ignoredPrefixTerminators": ignored_prefix_terminators,
        }))
        .map_err(|error| error.to_string())
    })();
    json_result(&mut env, result)
}

fn with_session(value: jlong, action: impl FnOnce(&mut SessionMachine) -> jint) -> jint {
    let Ok(handle) = handle(value) else {
        return -3;
    };
    handle
        .session
        .lock()
        .map(|mut session| action(&mut session))
        .unwrap_or(-3)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeSessionOpened(
    _env: JNIEnv,
    _class: JClass,
    value: jlong,
    now_ms: jlong,
) {
    let _ = with_session(value, |session| {
        session.transport_opened(now_ms.max(0) as u64);
        0
    });
}

/// 1 = numbered HID report, 0 = body-only, -1 = wait, -2 = timed out.
#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeNextHandshakeAttempt(
    _env: JNIEnv,
    _class: JClass,
    value: jlong,
    now_ms: jlong,
) -> jint {
    with_session(value, |session| {
        let now = now_ms.max(0) as u64;
        if session.handshake_timed_out(now) {
            -2
        } else {
            session
                .next_handshake_attempt(now)
                .map(|attempt| if attempt.include_report_id { 1 } else { 0 })
                .unwrap_or(-1)
        }
    })
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeSessionHandshakeComplete(
    _env: JNIEnv,
    _class: JClass,
    value: jlong,
    now_ms: jlong,
) {
    let _ = with_session(value, |session| {
        session.handshake_completed(now_ms.max(0) as u64, false);
        0
    });
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeSessionStateObserved(
    _env: JNIEnv,
    _class: JClass,
    value: jlong,
    now_ms: jlong,
    preset_synchronized: jint,
) {
    let _ = with_session(value, |session| {
        session.state_observed(now_ms.max(0) as u64, preset_synchronized != 0);
        0
    });
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeSessionShouldKeepalive(
    _env: JNIEnv,
    _class: JClass,
    value: jlong,
    now_ms: jlong,
) -> jint {
    with_session(value, |session| {
        session.keepalive_due(now_ms.max(0) as u64) as jint
    })
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeSessionOutbound(
    _env: JNIEnv,
    _class: JClass,
    value: jlong,
    now_ms: jlong,
) {
    let _ = with_session(value, |session| {
        session.outbound(now_ms.max(0) as u64);
        0
    });
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeSessionDisconnected(
    _env: JNIEnv,
    _class: JClass,
    value: jlong,
    now_ms: jlong,
) {
    let _ = with_session(value, |session| {
        session.disconnect(now_ms.max(0) as u64, false);
        0
    });
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeReset(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
) {
    let Ok(handle) = handle(value) else {
        let _ = env.throw_new(
            "java/lang/IllegalStateException",
            "native QC decoder handle is closed",
        );
        return;
    };
    match handle.state.lock() {
        Ok(mut decoder) => decoder.reset(),
        Err(_) => {
            let _ = env.throw_new(
                "java/lang/IllegalStateException",
                "native QC decoder lock was poisoned",
            );
        }
    }
    if let Ok(mut frames) = handle.frames.lock() {
        frames.reset();
    }
    if let Ok(mut snapshot) = handle.snapshot.lock() {
        *snapshot = GatewaySnapshot::default();
    }
    if let Ok(mut presets) = handle.presets.lock() {
        presets.clear();
    }
    if let Ok(mut backup) = handle.backup.lock() {
        backup.reset();
    };
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeDestroy(
    _env: JNIEnv,
    _class: JClass,
    value: jlong,
) {
    unregister_handle(value);
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeDecode(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
    message_type: i32,
    payload: JByteArray,
) -> jstring {
    let result = (|| {
        let native = handle(value)?;
        let bytes = env
            .convert_byte_array(payload)
            .map_err(|error| error.to_string())?;
        if message_type == 4 {
            if let Some(listing) =
                decode_preset_folder(&bytes).map_err(|error| error.to_string())?
            {
                native
                    .presets
                    .lock()
                    .map_err(|_| "native QC preset library lock was poisoned".to_string())?
                    .ingest(listing);
            }
            return Ok("[]".to_string());
        }
        let states = {
            let mut decoder = native
                .state
                .lock()
                .map_err(|_| "native QC decoder lock was poisoned".to_string())?;
            decoder
                .decode(
                    u16::try_from(message_type)
                        .map_err(|_| "invalid QC message type".to_string())?,
                    &bytes,
                )
                .map_err(|error| error.to_string())?
        };
        {
            let mut snapshot = native
                .snapshot
                .lock()
                .map_err(|_| "native QC snapshot lock was poisoned".to_string())?;
            for state in &states {
                snapshot.apply(state);
            }
        }
        serde_json::to_string(&states).map_err(|error| error.to_string())
    })();
    json_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeInstallModelRepo(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
    payload: JByteArray,
) -> jstring {
    let result = (|| {
        let native = handle(value)?;
        // Parsing intentionally happens before the decoder lock. Hot state can
        // continue to flow while the metadata executor expands the catalog.
        let bytes = env
            .convert_byte_array(payload)
            .map_err(|error| error.to_string())?;
        let catalog = parse_model_repo(&bytes).map_err(|error| error.to_string())?;
        let states = {
            let mut decoder = native
                .state
                .lock()
                .map_err(|_| "native QC decoder lock was poisoned".to_string())?;
            decoder.install_catalog(catalog)
        };
        {
            let mut snapshot = native
                .snapshot
                .lock()
                .map_err(|_| "native QC snapshot lock was poisoned".to_string())?;
            for state in &states {
                snapshot.apply(state);
            }
        }
        serde_json::to_string(&states).map_err(|error| error.to_string())
    })();
    json_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeSnapshot(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
) -> jstring {
    let result = (|| {
        let native = handle(value)?;
        let snapshot = native
            .snapshot
            .lock()
            .map_err(|_| "native QC snapshot lock was poisoned".to_string())?;
        serde_json::to_string(&*snapshot).map_err(|error| error.to_string())
    })();
    json_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeBlockDetails(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
    row: i32,
    column: i32,
) -> jstring {
    let result = (|| {
        let native = handle(value)?;
        let decoder = native
            .state
            .lock()
            .map_err(|_| "native QC decoder lock was poisoned".to_string())?;
        let details = decoder
            .block_details(
                u32::try_from(row).map_err(|_| "invalid row".to_string())?,
                u32::try_from(column).map_err(|_| "invalid column".to_string())?,
            )
            .ok_or_else(|| "There is no block in that Grid position.".to_string())?;
        serde_json::to_string(&details).map_err(|error| error.to_string())
    })();
    json_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeLaneControlDetails(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
    row: i32,
    control: JString,
) -> jstring {
    let result = (|| {
        let native = handle(value)?;
        let control = String::from(
            env.get_string(&control)
                .map_err(|error| error.to_string())?,
        );
        let decoder = native
            .state
            .lock()
            .map_err(|_| "native QC decoder lock was poisoned".to_string())?;
        let details = decoder
            .lane_control_details(
                u32::try_from(row).map_err(|_| "invalid row".to_string())?,
                &control,
            )
            .ok_or_else(|| "There is no matching lane control on that row.".to_string())?;
        serde_json::to_string(&details).map_err(|error| error.to_string())
    })();
    json_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeModelCount(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
) -> jint {
    let Ok(native) = handle(value) else {
        let _ = env.throw_new(
            "java/lang/IllegalStateException",
            "native QC decoder handle is closed",
        );
        return 0;
    };
    let result = match native.state.lock() {
        Ok(decoder) => decoder.model_count().min(i32::MAX as usize) as jint,
        Err(_) => {
            let _ = env.throw_new(
                "java/lang/IllegalStateException",
                "native QC decoder lock was poisoned",
            );
            0
        }
    };
    result
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativeModelList(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
) -> jstring {
    let result = (|| {
        let native = handle(value)?;
        let decoder = native
            .state
            .lock()
            .map_err(|_| "native QC decoder lock was poisoned".to_string())?;
        serde_json::to_string(&decoder.model_list()).map_err(|error| error.to_string())
    })();
    json_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativePresetFolders(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
) -> jstring {
    let result = (|| {
        let native = handle(value)?;
        let presets = native
            .presets
            .lock()
            .map_err(|_| "native QC preset library lock was poisoned".to_string())?;
        serde_json::to_string(&serde_json::json!({"folders": presets.folders()}))
            .map_err(|error| error.to_string())
    })();
    json_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativePresetList(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
    setlist_key: JString,
) -> jstring {
    let result = (|| {
        let native = handle(value)?;
        let key = env
            .get_string(&setlist_key)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let snapshot = native
            .snapshot
            .lock()
            .map_err(|_| "native QC snapshot lock was poisoned".to_string())?;
        let presets = native
            .presets
            .lock()
            .map_err(|_| "native QC preset library lock was poisoned".to_string())?;
        let list = presets
            .list(&key, &snapshot)
            .ok_or_else(|| format!("No preset listing is available for {key:?}"))?;
        serde_json::to_string(&list).map_err(|error| error.to_string())
    })();
    json_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_qccontrol_mobile_QcNativeStateDecoder_nativePresetSlots(
    mut env: JNIEnv,
    _class: JClass,
    value: jlong,
) -> jstring {
    let result = (|| {
        let native = handle(value)?;
        let snapshot = native
            .snapshot
            .lock()
            .map_err(|_| "native QC snapshot lock was poisoned".to_string())?;
        let presets = native
            .presets
            .lock()
            .map_err(|_| "native QC preset library lock was poisoned".to_string())?;
        let slots = presets
            .writable_slots(&snapshot)?
            .ok_or_else(|| "The active preset slots are not loaded".to_string())?;
        serde_json::to_string(&slots).map_err(|error| error.to_string())
    })();
    json_result(&mut env, result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registered_handles_make_destroy_idempotent_and_keep_in_flight_calls_alive() {
        let value = register_handle();
        assert!(value > 0);
        let in_flight = handle(value).expect("registered handle");

        unregister_handle(value);
        unregister_handle(value);

        assert!(handle(value).is_err());
        assert_eq!(
            in_flight.state.lock().expect("decoder lock").model_count(),
            0
        );
    }

    #[test]
    fn invalid_handles_are_rejected_without_dereferencing_foreign_memory() {
        assert!(handle(0).is_err());
        assert!(handle(-1).is_err());
        assert!(handle(i64::MAX).is_err());
    }

    #[test]
    fn gateway_write_envelope_exposes_shared_realtime_completion_policy() {
        let detail = "Scene A sent";
        let envelope = gateway_write_envelope(
            detail,
            &GatewayVerification::Scene { scene: 0 },
            true,
            true,
            PlannedWrite::MidiControlChange {
                controller: 35,
                value: 127,
            },
        )
        .expect("gateway envelope");

        let detail_length = u32::from_le_bytes(envelope[0..4].try_into().unwrap()) as usize;
        assert_eq!(detail_length, detail.len());
        let verification_length_offset = 4 + detail_length;
        let verification_length = u32::from_le_bytes(
            envelope[verification_length_offset..verification_length_offset + 4]
                .try_into()
                .unwrap(),
        ) as usize;
        let lane_offset = verification_length_offset + 4 + verification_length;

        assert_eq!(&envelope[lane_offset..lane_offset + 5], &[1, 35, 127, 1, 1]);
        assert_eq!(
            u32::from_le_bytes(
                envelope[lane_offset + 5..lane_offset + 9]
                    .try_into()
                    .unwrap()
            ),
            0
        );
    }
}
