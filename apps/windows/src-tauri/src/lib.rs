use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    platform: &'static str,
    gateway_available: bool,
    message: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionState {
    phase: &'static str,
    detail: &'static str,
    demo: bool,
}

#[tauri::command]
fn runtime_status() -> RuntimeStatus {
    RuntimeStatus {
        platform: "Windows / Tauri 2",
        gateway_available: false,
        message: "Desktop shell active — device gateway is not packaged in this slice.",
    }
}

#[tauri::command]
fn reconnect_device() -> Result<ConnectionState, String> {
    Err("The device gateway is not packaged yet. Demo state remains read-only.".into())
}

#[tauri::command]
fn reset_device_session() -> Result<ConnectionState, String> {
    Err("There is no gateway session to reset. Hardware state was not changed.".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            reconnect_device,
            reset_device_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running QC Voice Control");
}
