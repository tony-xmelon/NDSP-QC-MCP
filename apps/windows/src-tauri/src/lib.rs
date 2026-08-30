use serde_json::{json, Value};
use std::io::{BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

struct GatewayProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Drop for GatewayProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl GatewayProcess {
    fn start() -> Result<Self, String> {
        let mut command = if let Ok(executable) = std::env::var("QC_GATEWAY_EXECUTABLE") {
            Command::new(executable)
        } else {
            let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .and_then(|path| path.parent())
                .and_then(|path| path.parent())
                .ok_or("Could not resolve the repository root")?
                .to_path_buf();
            let python = repository.join(".venv").join("Scripts").join("python.exe");
            let script = repository
                .join("services")
                .join("device-gateway")
                .join("main.py");
            if !python.is_file() {
                return Err(format!(
                    "Gateway Python runtime is missing: {}",
                    python.display()
                ));
            }
            if !script.is_file() {
                return Err(format!(
                    "Gateway entry point is missing: {}",
                    script.display()
                ));
            }
            let mut command = Command::new(python);
            command.arg(script);
            command
        };
        let mut child = command
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not start device gateway: {error}"))?;
        let stdin = child.stdin.take().ok_or("Gateway stdin was not created")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Gateway stdout was not created")?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        })
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        }))
        .map_err(|error| error.to_string())?;
        let length = u32::try_from(payload.len()).map_err(|_| "Gateway request is too large")?;
        self.stdin
            .write_all(&length.to_be_bytes())
            .map_err(|error| error.to_string())?;
        self.stdin
            .write_all(&payload)
            .map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())?;

        let mut header = [0_u8; 4];
        self.stdout
            .read_exact(&mut header)
            .map_err(|error| format!("Gateway closed: {error}"))?;
        let response_length = u32::from_be_bytes(header) as usize;
        if response_length == 0 || response_length > 16 * 1024 * 1024 {
            return Err(format!(
                "Gateway returned invalid frame length: {response_length}"
            ));
        }
        let mut response_payload = vec![0_u8; response_length];
        self.stdout
            .read_exact(&mut response_payload)
            .map_err(|error| error.to_string())?;
        let response: Value =
            serde_json::from_slice(&response_payload).map_err(|error| error.to_string())?;
        if response.get("id").and_then(Value::as_u64) != Some(id) {
            return Err("Gateway response did not match the request".into());
        }
        if let Some(error) = response.get("error") {
            return Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Gateway request failed")
                .into());
        }
        response
            .get("result")
            .cloned()
            .ok_or_else(|| "Gateway response has no result".into())
    }
}

#[derive(Default)]
struct Gateway {
    process: Option<GatewayProcess>,
}

impl Gateway {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if self.process.is_none() {
            self.process = Some(GatewayProcess::start()?);
        }
        self.process
            .as_mut()
            .expect("gateway process was initialized")
            .request(method, params)
    }

    fn restart(&mut self, method: &str) -> Result<Value, String> {
        self.process = None;
        self.request(method, json!({}))
    }
}

fn with_gateway(state: State<'_, Mutex<Gateway>>, method: &str) -> Result<Value, String> {
    state
        .lock()
        .map_err(|_| "Gateway session lock was poisoned".to_string())?
        .request(method, json!({}))
}

fn with_gateway_params(
    state: State<'_, Mutex<Gateway>>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    state
        .lock()
        .map_err(|_| "Gateway session lock was poisoned".to_string())?
        .request(method, params)
}

#[tauri::command]
fn runtime_status(state: State<'_, Mutex<Gateway>>) -> Result<Value, String> {
    with_gateway(state, "system.status")
}

#[tauri::command]
fn reconnect_device(state: State<'_, Mutex<Gateway>>) -> Result<Value, String> {
    with_gateway(state, "device.reconnect")
}

#[tauri::command]
fn reset_device_session(state: State<'_, Mutex<Gateway>>) -> Result<Value, String> {
    state
        .lock()
        .map_err(|_| "Gateway session lock was poisoned".to_string())?
        .restart("device.resetSession")
}

#[tauri::command]
fn current_snapshot(state: State<'_, Mutex<Gateway>>) -> Result<Value, String> {
    with_gateway(state, "device.snapshot")
}

#[tauri::command]
fn select_scene(
    state: State<'_, Mutex<Gateway>>,
    scene: u8,
    expected_preset_name: String,
) -> Result<Value, String> {
    with_gateway_params(
        state,
        "device.selectScene",
        json!({ "scene": scene, "expectedPresetName": expected_preset_name }),
    )
}

#[tauri::command]
fn toggle_bypass(
    state: State<'_, Mutex<Gateway>>,
    row: u8,
    column: u8,
    expected_scene: u8,
    expected_preset_name: String,
) -> Result<Value, String> {
    with_gateway_params(
        state,
        "device.toggleBypass",
        json!({
            "row": row,
            "column": column,
            "expectedScene": expected_scene,
            "expectedPresetName": expected_preset_name
        }),
    )
}

#[tauri::command]
fn show_tuner(state: State<'_, Mutex<Gateway>>, shown: bool) -> Result<Value, String> {
    with_gateway_params(state, "device.showTuner", json!({ "shown": shown }))
}

#[tauri::command]
fn show_gig_view(state: State<'_, Mutex<Gateway>>, shown: bool) -> Result<Value, String> {
    with_gateway_params(state, "device.showGigView", json!({ "shown": shown }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(Gateway::default()))
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            reconnect_device,
            reset_device_session,
            current_snapshot,
            select_scene,
            toggle_bypass,
            show_tuner,
            show_gig_view
        ])
        .run(tauri::generate_context!())
        .expect("error while running QC Voice Control");
}
