use serde_json::{json, Value};
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
            let executable_directory = std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(Path::to_path_buf));
            let packaged = executable_directory
                .as_deref()
                .and_then(locate_packaged_gateway);
            if let Some(executable) = packaged {
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
            }
        };
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
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

fn locate_packaged_gateway(executable_directory: &Path) -> Option<PathBuf> {
    [
        "qc-device-gateway.exe",
        "qc-device-gateway-x86_64-pc-windows-msvc.exe",
    ]
    .into_iter()
    .map(|name| executable_directory.join(name))
    .find(|path| path.is_file())
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
    expected_bypassed: bool,
    desired_bypassed: bool,
    expected_preset_name: String,
) -> Result<Value, String> {
    with_gateway_params(
        state,
        "device.toggleBypass",
        json!({
            "row": row,
            "column": column,
            "expectedScene": expected_scene,
            "expectedBypassed": expected_bypassed,
            "desiredBypassed": desired_bypassed,
            "expectedPresetName": expected_preset_name
        }),
    )
}

#[tauri::command]
fn list_presets(state: State<'_, Mutex<Gateway>>, refresh: bool) -> Result<Value, String> {
    with_gateway_params(state, "device.listPresets", json!({ "refresh": refresh }))
}

#[tauri::command]
fn navigate_bank(
    state: State<'_, Mutex<Gateway>>,
    direction: i8,
    expected_preset_name: String,
    expected_position: u16,
) -> Result<Value, String> {
    with_gateway_params(
        state,
        "device.navigateBank",
        json!({
            "direction": direction,
            "expectedPresetName": expected_preset_name,
            "expectedPosition": expected_position
        }),
    )
}

#[tauri::command]
fn recall_preset(
    state: State<'_, Mutex<Gateway>>,
    setlist_key: String,
    position: u16,
    expected_preset_name: String,
    expected_position: u16,
) -> Result<Value, String> {
    with_gateway_params(
        state,
        "device.recallPreset",
        json!({
            "setlistKey": setlist_key,
            "position": position,
            "expectedPresetName": expected_preset_name,
            "expectedPosition": expected_position
        }),
    )
}

#[tauri::command]
fn reload_preset(
    state: State<'_, Mutex<Gateway>>,
    expected_preset_name: String,
    expected_position: u16,
) -> Result<Value, String> {
    with_gateway_params(
        state,
        "device.reloadPreset",
        json!({
            "expectedPresetName": expected_preset_name,
            "expectedPosition": expected_position
        }),
    )
}

#[tauri::command]
fn block_details(
    state: State<'_, Mutex<Gateway>>,
    row: u8,
    column: u8,
    expected_preset_name: String,
) -> Result<Value, String> {
    with_gateway_params(
        state,
        "device.blockDetails",
        json!({
            "row": row,
            "column": column,
            "expectedPresetName": expected_preset_name
        }),
    )
}

#[tauri::command]
fn set_parameter(
    state: State<'_, Mutex<Gateway>>,
    row: u8,
    column: u8,
    parameter_index: u16,
    value: f64,
    expected_value: f64,
    expected_scene: u8,
    expected_preset_name: String,
) -> Result<Value, String> {
    with_gateway_params(
        state,
        "device.setParameter",
        json!({
            "row": row,
            "column": column,
            "parameterIndex": parameter_index,
            "value": value,
            "expectedValue": expected_value,
            "expectedScene": expected_scene,
            "expectedPresetName": expected_preset_name
        }),
    )
}

#[tauri::command]
fn set_tempo(
    state: State<'_, Mutex<Gateway>>,
    bpm: u16,
    expected_tempo: u16,
    expected_preset_name: String,
) -> Result<Value, String> {
    with_gateway_params(
        state,
        "device.setTempo",
        json!({
            "bpm": bpm,
            "expectedTempo": expected_tempo,
            "expectedPresetName": expected_preset_name
        }),
    )
}

#[tauri::command]
fn list_preset_slots(state: State<'_, Mutex<Gateway>>) -> Result<Value, String> {
    with_gateway(state, "device.listPresetSlots")
}

#[tauri::command]
fn save_preset_as(
    state: State<'_, Mutex<Gateway>>,
    setlist_key: String,
    position: u16,
    name: String,
    expected_preset_name: String,
    expected_position: u16,
    confirm_overwrite: bool,
) -> Result<Value, String> {
    with_gateway_params(
        state,
        "device.savePresetAs",
        json!({
            "setlistKey": setlist_key,
            "position": position,
            "name": name,
            "expectedPresetName": expected_preset_name,
            "expectedPosition": expected_position,
            "confirmOverwrite": confirm_overwrite
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

const MAX_WORKSPACE_BYTES: usize = 16 * 1024 * 1024;

fn validate_workspace(document: &Value) -> Result<(), String> {
    if !document.is_object() || document.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported or invalid QC workspace document".into());
    }
    if !document.get("snapshot").is_some_and(Value::is_object) {
        return Err("Workspace document has no normalized snapshot".into());
    }
    Ok(())
}

fn validate_workspace_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Workspace path must be absolute".into());
    }
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        != Some("qcw".into())
    {
        return Err("Workspace files must use the .qcw extension".into());
    }
    Ok(())
}

fn write_workspace(path: &Path, document: &Value) -> Result<Value, String> {
    validate_workspace(document)?;
    validate_workspace_path(path)?;
    let bytes = serde_json::to_vec_pretty(document).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_WORKSPACE_BYTES {
        return Err("Workspace exceeds the 16 MiB size limit".into());
    }
    fs::write(path, bytes).map_err(|error| format!("Could not save workspace: {error}"))?;
    Ok(json!({
        "cancelled": false,
        "path": path.to_string_lossy(),
        "name": path.file_name().and_then(|value| value.to_str()).unwrap_or("workspace.qcw")
    }))
}

fn safe_workspace_name(value: &str) -> String {
    let filtered: String = value
        .chars()
        .map(|character| {
            if r#"<>:"/\|?*"#.contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = filtered.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        "QC Workspace".into()
    } else {
        trimmed.chars().take(80).collect()
    }
}

#[tauri::command]
fn save_workspace_as(document: Value, suggested_name: String) -> Result<Value, String> {
    validate_workspace(&document)?;
    let file_name = format!("{}.qcw", safe_workspace_name(&suggested_name));
    let Some(path) = rfd::FileDialog::new()
        .add_filter("QC Workspace", &["qcw"])
        .set_file_name(file_name)
        .save_file()
    else {
        return Ok(json!({ "cancelled": true }));
    };
    write_workspace(&path, &document)
}

#[tauri::command]
fn save_workspace(path: String, document: Value) -> Result<Value, String> {
    write_workspace(Path::new(&path), &document)
}

#[tauri::command]
fn open_workspace() -> Result<Value, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("QC Workspace", &["qcw"])
        .pick_file()
    else {
        return Ok(json!({ "cancelled": true }));
    };
    validate_workspace_path(&path)?;
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Could not inspect workspace: {error}"))?;
    if metadata.len() as usize > MAX_WORKSPACE_BYTES {
        return Err("Workspace exceeds the 16 MiB size limit".into());
    }
    let bytes = fs::read(&path).map_err(|error| format!("Could not open workspace: {error}"))?;
    let document: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid workspace JSON: {error}"))?;
    validate_workspace(&document)?;
    Ok(json!({
        "cancelled": false,
        "path": path.to_string_lossy(),
        "name": path.file_name().and_then(|value| value.to_str()).unwrap_or("workspace.qcw"),
        "document": document
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_validation_requires_version_and_snapshot() {
        assert!(validate_workspace(&json!({ "version": 1, "snapshot": {} })).is_ok());
        assert!(validate_workspace(&json!({ "version": 2, "snapshot": {} })).is_err());
        assert!(validate_workspace(&json!({ "version": 1 })).is_err());
    }

    #[test]
    fn workspace_file_name_removes_windows_path_characters() {
        assert_eq!(safe_workspace_name("6B ICFTF: #22?"), "6B ICFTF_ #22_");
        assert_eq!(safe_workspace_name("..."), "QC Workspace");
    }

    #[test]
    fn workspace_round_trips_on_disk() {
        let path = std::env::temp_dir().join(format!(
            "qc-workspace-test-{}-{}.qcw",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        let document = json!({ "version": 1, "snapshot": { "presetName": "Test" } });
        let result = write_workspace(&path, &document).expect("workspace write");
        assert_eq!(result["cancelled"], false);
        let loaded: Value = serde_json::from_slice(&fs::read(&path).expect("workspace read"))
            .expect("workspace JSON");
        assert_eq!(loaded, document);
        fs::remove_file(&path).expect("workspace cleanup");
    }

    #[test]
    fn packaged_gateway_is_found_beside_the_app() {
        let directory = std::env::temp_dir().join(format!(
            "qc-sidecar-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        fs::create_dir(&directory).expect("sidecar test directory");
        let sidecar = directory.join("qc-device-gateway.exe");
        fs::write(&sidecar, b"test").expect("sidecar test file");
        assert_eq!(locate_packaged_gateway(&directory), Some(sidecar.clone()));
        fs::remove_file(&sidecar).expect("sidecar test file cleanup");
        fs::remove_dir(&directory).expect("sidecar test directory cleanup");
    }
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
            list_presets,
            navigate_bank,
            recall_preset,
            reload_preset,
            block_details,
            set_parameter,
            set_tempo,
            list_preset_slots,
            save_preset_as,
            show_tuner,
            show_gig_view,
            save_workspace_as,
            save_workspace,
            open_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running QC Voice Control");
}
