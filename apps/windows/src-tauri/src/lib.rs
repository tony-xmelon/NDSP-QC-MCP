use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use qc_device_runtime::request::plan_host_midi;
use qc_relay_client::{DeviceAdapter, DeviceError};
use qc_windows_midi::PerformanceMidi;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

mod chat;
mod generated_gateway;
mod relay;
use chat::{ChatBridge, ChatError, ChatRequest, ChatResponse, ChatSettings, ChatSettingsView};
use generated_gateway::rpc;
use relay::{RelayBridge, RelayStatus};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct GatewayProcess {
    child: Child,
    stdin: ChildStdin,
    responses: mpsc::Receiver<GatewayReaderMessage>,
    next_id: u64,
}

enum GatewayReaderMessage {
    Response(Value),
    Failed(String),
}

enum GatewayRequestFailure {
    Transport(String),
    Remote(String),
}

impl Drop for GatewayProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl GatewayProcess {
    fn start(event_tx: Option<mpsc::Sender<Value>>) -> Result<Self, String> {
        let executable_directory = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf));
        let mut command = if let Ok(executable) = std::env::var("QC_GATEWAY_EXECUTABLE") {
            Command::new(executable)
        } else {
            let executable = locate_native_broker(executable_directory.as_deref()).ok_or(
                "The Rust QC device runtime was not found. Build services/device-broker before starting the app.",
            )?;
            Command::new(executable)
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
        let (response_tx, responses) = mpsc::channel();
        std::thread::Builder::new()
            .name("qc-gateway-events".into())
            .spawn(move || {
                let mut stdout = BufReader::new(stdout);
                loop {
                    let message = (|| -> Result<Value, String> {
                        let mut header = [0_u8; 4];
                        stdout
                            .read_exact(&mut header)
                            .map_err(|error| format!("Gateway closed: {error}"))?;
                        let response_length = u32::from_be_bytes(header) as usize;
                        if response_length == 0
                            || response_length > qc_protocol::domain::IPC_MAX_FRAME_BYTES
                        {
                            return Err(format!(
                                "Gateway returned invalid frame length: {response_length}"
                            ));
                        }
                        let mut payload = vec![0_u8; response_length];
                        stdout
                            .read_exact(&mut payload)
                            .map_err(|error| error.to_string())?;
                        serde_json::from_slice(&payload).map_err(|error| error.to_string())
                    })();
                    match message {
                        Ok(value)
                            if value.get("method").and_then(Value::as_str)
                                == Some("device.stateFrame") =>
                        {
                            if let (Some(sender), Some(params)) =
                                (event_tx.as_ref(), value.get("params"))
                            {
                                let _ = sender.send(params.clone());
                            }
                        }
                        Ok(value) => {
                            if response_tx
                                .send(GatewayReaderMessage::Response(value))
                                .is_err()
                            {
                                return;
                            }
                        }
                        Err(error) => {
                            let _ = response_tx.send(GatewayReaderMessage::Failed(error));
                            return;
                        }
                    }
                }
            })
            .map_err(|error| format!("Could not start gateway event reader: {error}"))?;
        Ok(Self {
            child,
            stdin,
            responses,
            next_id: 1,
        })
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, GatewayRequestFailure> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        }))
        .map_err(|error| GatewayRequestFailure::Transport(error.to_string()))?;
        let length = u32::try_from(payload.len())
            .map_err(|_| GatewayRequestFailure::Transport("Gateway request is too large".into()))?;
        self.stdin
            .write_all(&length.to_be_bytes())
            .map_err(|error| GatewayRequestFailure::Transport(error.to_string()))?;
        self.stdin
            .write_all(&payload)
            .map_err(|error| GatewayRequestFailure::Transport(error.to_string()))?;
        self.stdin
            .flush()
            .map_err(|error| GatewayRequestFailure::Transport(error.to_string()))?;

        let response = match self.responses.recv() {
            Ok(GatewayReaderMessage::Response(value)) => value,
            Ok(GatewayReaderMessage::Failed(error)) => {
                return Err(GatewayRequestFailure::Transport(error));
            }
            Err(error) => return Err(GatewayRequestFailure::Transport(error.to_string())),
        };
        if response.get("id").and_then(Value::as_u64) != Some(id) {
            return Err(GatewayRequestFailure::Transport(
                "Gateway response did not match the request".into(),
            ));
        }
        if let Some(error) = response.get("error") {
            return Err(GatewayRequestFailure::Remote(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Gateway request failed")
                    .into(),
            ));
        }
        response.get("result").cloned().ok_or_else(|| {
            GatewayRequestFailure::Transport("Gateway response has no result".into())
        })
    }
}

fn locate_native_broker(executable_directory: Option<&Path>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(directory) = executable_directory {
        for name in [
            "qc-device-broker.exe",
            "qc-device-broker-x86_64-pc-windows-msvc.exe",
            "qc-device-broker-x86_64-pc-windows-gnu.exe",
        ] {
            candidates.push(directory.join(name));
        }
    }
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf);
    if let Some(repository) = repository {
        candidates.push(
            repository
                .join("services")
                .join("device-broker")
                .join("target")
                .join("release")
                .join("qc-device-broker.exe"),
        );
        candidates.push(
            repository
                .join("services")
                .join("device-broker")
                .join("target")
                .join("debug")
                .join("qc-device-broker.exe"),
        );
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn locate_media_tool(
    environment_name: &str,
    packaged_name: &str,
    path_name: &str,
) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(environment_name)
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    let mut candidates = Vec::new();
    if let Some(directory) = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
    {
        candidates.push(directory.join(format!("{packaged_name}.exe")));
    }
    let binaries = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    for suffix in ["", "-x86_64-pc-windows-msvc", "-x86_64-pc-windows-gnu"] {
        candidates.push(binaries.join(format!("{packaged_name}{suffix}.exe")));
    }
    if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
        return Some(path);
    }
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(path_name))
            .find(|candidate| candidate.is_file())
    })
}

fn validate_youtube_url(value: &str) -> Result<(), ChatError> {
    let parsed = reqwest::Url::parse(value)
        .map_err(|_| ChatError::new("invalid_request", "The reference URL is invalid.", false))?;
    if parsed.scheme() != "https" {
        return Err(ChatError::new(
            "invalid_request",
            "The YouTube reference must use HTTPS.",
            false,
        ));
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let allowed = host == "youtu.be"
        || host == "youtube.com"
        || host.ends_with(".youtube.com")
        || host == "youtube-nocookie.com"
        || host.ends_with(".youtube-nocookie.com");
    if !allowed {
        return Err(ChatError::new(
            "invalid_request",
            "Only public YouTube URLs are accepted by this tool.",
            false,
        ));
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceAudioAttachment {
    name: String,
    media_type: String,
    data: String,
}

#[derive(serde::Serialize)]
struct ReferenceAudioResult {
    detail: String,
    attachment: ReferenceAudioAttachment,
}

#[derive(Default)]
struct Gateway {
    process: Option<GatewayProcess>,
    connected: bool,
    voice_recognition_available: Option<bool>,
    voice_last_event: Option<String>,
    voice_event_at_unix: Option<u64>,
    event_tx: Option<mpsc::Sender<Value>>,
}

impl Gateway {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if self.process.is_none() {
            self.process = Some(GatewayProcess::start(self.event_tx.clone())?);
        }
        let result = self
            .process
            .as_mut()
            .expect("gateway process was initialized")
            .request(method, params);
        let (output, status) = match result {
            Ok(value) => {
                if method == rpc::DISCONNECT {
                    self.connected = false;
                } else if method.starts_with("device.") {
                    self.connected = true;
                }
                (Ok(value), "ok")
            }
            Err(GatewayRequestFailure::Remote(message)) => {
                if message.contains("No Quad Cortex session") {
                    self.connected = false;
                }
                (Err(message), "remote-error")
            }
            Err(GatewayRequestFailure::Transport(message)) => {
                self.process = None;
                self.connected = false;
                (
                    Err(format!(
                        "{message}. The failed command was not replayed; the communication session was cleared for a safe reconnect."
                    )),
                    "transport-error",
                )
            }
        };
        write_runtime_health(self, method, status);
        output
    }

    fn restart(&mut self, method: &str) -> Result<Value, String> {
        self.process = None;
        self.request(method, json!({}))
    }
}

fn runtime_health_path() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("QC Voice Control")
        .join("runtime-health.json")
}

fn runtime_health_document(gateway: &Gateway, method: &str, status: &str) -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "appPid": std::process::id(),
        "gatewayPid": gateway.process.as_ref().map(|process| process.child.id()),
        "connected": gateway.connected,
        "lastMethod": method,
        "lastStatus": status,
        "voiceRecognitionAvailable": gateway.voice_recognition_available,
        "voiceLastEvent": gateway.voice_last_event.as_deref(),
        "voiceEventAtUnix": gateway.voice_event_at_unix,
        "lastRequestAtUnix": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    })
}

fn write_runtime_health(gateway: &Gateway, method: &str, status: &str) {
    let path = runtime_health_path();
    let Some(directory) = path.parent() else {
        return;
    };
    if fs::create_dir_all(directory).is_err() {
        return;
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&runtime_health_document(gateway, method, status))
    {
        let _ = fs::write(path, bytes);
    }
}

#[tauri::command]
async fn report_voice_capability(app: AppHandle, available: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<Gateway>>();
        let mut gateway = state
            .lock()
            .map_err(|_| "Gateway session lock was poisoned".to_string())?;
        gateway.voice_recognition_available = Some(available);
        write_runtime_health(&gateway, "voice.capability", "ok");
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn report_voice_event(app: AppHandle, event: String) -> Result<(), String> {
    let normalized = normalize_voice_event(&event)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<Gateway>>();
        let mut gateway = state
            .lock()
            .map_err(|_| "Gateway session lock was poisoned".to_string())?;
        gateway.voice_last_event = Some(normalized);
        gateway.voice_event_at_unix = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        );
        write_runtime_health(&gateway, "voice.event", "ok");
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn chat_settings(state: State<'_, ChatBridge>) -> Result<ChatSettingsView, ChatError> {
    chat::settings(&state)
}

#[tauri::command]
fn update_chat_settings(
    state: State<'_, ChatBridge>,
    settings: ChatSettings,
) -> Result<ChatSettingsView, ChatError> {
    chat::update_settings(&state, settings)
}

#[tauri::command]
fn set_chat_api_key(
    state: State<'_, ChatBridge>,
    api_key: String,
) -> Result<ChatSettingsView, ChatError> {
    chat::set_api_key(&state, api_key)
}

#[tauri::command]
fn clear_chat_api_key(state: State<'_, ChatBridge>) -> Result<ChatSettingsView, ChatError> {
    chat::clear_api_key(&state)
}

#[tauri::command]
fn configure_google_oauth_app(
    state: State<'_, ChatBridge>,
    client_id: String,
    client_secret: String,
) -> Result<ChatSettingsView, ChatError> {
    chat::configure_google_oauth_app(&state, client_id, client_secret)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !is_allowed_external_url(&url) {
        return Err("That external address is not allowed.".into());
    }
    webbrowser::open(&url)
        .map(|_| ())
        .map_err(|_| "Could not open the system browser.".into())
}

#[tauri::command]
async fn open_google_subscription_setup(state: State<'_, ChatBridge>) -> Result<(), ChatError> {
    chat::open_google_subscription_setup(&state).await
}

#[tauri::command]
async fn connect_google_oauth(
    state: State<'_, ChatBridge>,
) -> Result<chat::GoogleOAuthResult, ChatError> {
    chat::connect_google_oauth(&state).await
}

#[tauri::command]
fn select_google_project(
    state: State<'_, ChatBridge>,
    project_id: String,
) -> Result<ChatSettingsView, ChatError> {
    chat::select_google_project(project_id)?;
    chat::settings(&state)
}

#[tauri::command]
fn disconnect_google_oauth(state: State<'_, ChatBridge>) -> Result<ChatSettingsView, ChatError> {
    chat::disconnect_google_oauth()?;
    chat::settings(&state)
}

fn is_allowed_external_url(url: &str) -> bool {
    const ALLOWED: [&str; 10] = [
        "https://antigravity.google/docs/cli/install/",
        "https://antigravity.google/pricing",
        "https://aistudio.google.com/app/apikey",
        "https://console.cloud.google.com/apis/credentials",
        "https://ai.google.dev/gemini-api/docs/api-key",
        "https://ai.google.dev/gemini-api/docs/pricing",
        "https://platform.openai.com/api-keys",
        "https://openai.com/api/pricing/",
        "https://platform.claude.com/settings/keys",
        "https://platform.claude.com/docs/en/about-claude/pricing",
    ];
    ALLOWED.contains(&url)
}

#[tauri::command]
async fn chat_with_model(
    state: State<'_, ChatBridge>,
    request: ChatRequest,
) -> Result<ChatResponse, ChatError> {
    chat::complete(&state, request).await
}

#[tauri::command]
async fn fetch_youtube_reference_audio(
    url: String,
    start_seconds: f64,
    duration_seconds: f64,
    user_confirmed_rights: bool,
) -> Result<ReferenceAudioResult, ChatError> {
    if !user_confirmed_rights {
        return Err(ChatError::new(
            "rights_confirmation_required",
            "Confirm that you own this media or have permission to copy it before fetching an excerpt.",
            false,
        ));
    }
    validate_youtube_url(&url)?;
    if !start_seconds.is_finite() || start_seconds < 0.0 {
        return Err(ChatError::new(
            "invalid_request",
            "The excerpt start must be zero or greater.",
            false,
        ));
    }
    if !duration_seconds.is_finite() || !(5.0..=120.0).contains(&duration_seconds) {
        return Err(ChatError::new(
            "invalid_request",
            "The excerpt duration must be from 5 through 120 seconds.",
            false,
        ));
    }

    let fetcher = locate_media_tool("QC_MEDIA_FETCH_EXECUTABLE", "qc-media-fetch", "yt-dlp.exe")
        .ok_or_else(|| {
            ChatError::new(
                "media_tool_unavailable",
                "The bundled YouTube media fetcher is unavailable.",
                false,
            )
        })?;
    let ffmpeg = locate_media_tool(
        "QC_MEDIA_FFMPEG_EXECUTABLE",
        "qc-media-ffmpeg",
        "ffmpeg.exe",
    )
    .ok_or_else(|| {
        ChatError::new(
            "media_tool_unavailable",
            "The bundled lossless media remuxer is unavailable.",
            false,
        )
    })?;
    let deno = locate_media_tool("QC_MEDIA_DENO_EXECUTABLE", "qc-media-deno", "deno.exe")
        .ok_or_else(|| {
            ChatError::new(
                "media_tool_unavailable",
                "The bundled YouTube stream resolver is unavailable.",
                false,
            )
        })?;

    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let output_directory =
        std::env::temp_dir().join(format!("qc-reference-audio-{}-{nonce}", std::process::id()));
    fs::create_dir(&output_directory).map_err(|_| {
        ChatError::new(
            "media_download",
            "Could not prepare temporary reference-audio storage.",
            false,
        )
    })?;
    let output_template = output_directory.join("reference.%(ext)s");
    let end_seconds = start_seconds + duration_seconds;
    let section = format!("*{start_seconds:.3}-{end_seconds:.3}");
    let runtime = format!("deno:{}", deno.to_string_lossy());
    let mut command = tokio::process::Command::new(fetcher);
    command
        .kill_on_drop(true)
        .args([
            "--ignore-config",
            "--no-playlist",
            "--no-progress",
            "--no-warnings",
            "--restrict-filenames",
            "--max-filesize",
            "32M",
            "--format",
            "bestaudio[acodec=opus][ext=webm]/bestaudio[acodec^=mp4a][ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=m4a]",
            "--download-sections",
        ])
        .arg(section)
        .arg("--js-runtimes")
        .arg(runtime)
        .arg("--ffmpeg-location")
        .arg(ffmpeg)
        .arg("--output")
        .arg(output_template)
        .arg("--")
        .arg(&url);

    let output = tokio::time::timeout(std::time::Duration::from_secs(180), command.output())
        .await
        .map_err(|_| {
            ChatError::new(
                "media_download_timeout",
                "The YouTube audio excerpt did not finish within three minutes.",
                true,
            )
        })?
        .map_err(|_| {
            ChatError::new(
                "media_download",
                "The YouTube media fetcher could not start.",
                true,
            )
        })?;
    if !output.status.success() {
        let _ = fs::remove_dir_all(&output_directory);
        return Err(ChatError::new(
            "media_download",
            "The public YouTube audio excerpt could not be fetched. The video may be unavailable, restricted, or require sign-in.",
            true,
        ));
    }

    let media_path = fs::read_dir(&output_directory)
        .map_err(|_| {
            ChatError::new(
                "media_download",
                "The downloaded excerpt could not be inspected.",
                false,
            )
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            matches!(
                path.extension()
                    .and_then(|value| value.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("webm" | "m4a")
            )
        })
        .ok_or_else(|| {
            ChatError::new(
                "media_download",
                "The fetcher produced no supported Opus/WebM or AAC/M4A audio file.",
                true,
            )
        })?;
    let media = fs::read(&media_path).map_err(|_| {
        ChatError::new(
            "media_download",
            "The downloaded audio excerpt could not be read.",
            false,
        )
    })?;
    let _ = fs::remove_dir_all(&output_directory);
    if media.is_empty() || media.len() > 32 * 1024 * 1024 {
        return Err(ChatError::new(
            "media_download",
            "The downloaded audio excerpt is empty or exceeds the 32 MB chat attachment limit.",
            false,
        ));
    }
    let extension = media_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("webm")
        .to_ascii_lowercase();
    let media_type = if extension == "m4a" {
        "audio/m4a"
    } else {
        "audio/webm"
    };
    Ok(ReferenceAudioResult {
        detail: format!(
            "Fetched and losslessly remuxed a {:.1}-second YouTube reference excerpt from {:.1}s as {} ({:.1} MB); it is attached for direct model analysis.",
            duration_seconds,
            start_seconds,
            if extension == "m4a" { "AAC/M4A" } else { "Opus/WebM" },
            media.len() as f64 / 1_048_576.0,
        ),
        attachment: ReferenceAudioAttachment {
            name: format!("youtube-reference-{:.0}-{:.0}.{extension}", start_seconds, end_seconds),
            media_type: media_type.into(),
            data: BASE64_STANDARD.encode(media),
        },
    })
}

#[tauri::command]
async fn chat_quota(state: State<'_, ChatBridge>) -> Result<chat::ChatQuota, ChatError> {
    chat::quota(&state).await
}

#[tauri::command]
async fn antigravity_models() -> Result<Vec<chat::AntigravityModel>, ChatError> {
    chat::antigravity_models().await
}

#[tauri::command]
async fn test_chat_connection(state: State<'_, ChatBridge>) -> Result<String, ChatError> {
    let request = ChatRequest {
        request_id: format!(
            "connection-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ),
        messages: vec![chat::ChatMessage {
            role: "user".into(),
            content: "Reply with exactly: QC model connection ready".into(),
            attachments: vec![],
        }],
        context: Value::Null,
        tools: vec![],
        instructions: Some("This is a connection test. Do not request a tool.".into()),
        max_output_tokens: Some(32),
    };
    let response = chat::complete(&state, request).await?;
    if response.text.trim().is_empty() {
        return Err(ChatError::new(
            "connection_test",
            "The provider accepted the request but returned no text.",
            true,
        ));
    }
    Ok(response.text)
}

#[tauri::command]
async fn warm_chat_provider(state: State<'_, ChatBridge>) -> Result<String, ChatError> {
    chat::warm(&state).await
}

#[tauri::command]
fn cancel_chat(state: State<'_, ChatBridge>, request_id: String) -> Result<bool, ChatError> {
    chat::cancel(&state, &request_id)
}

fn normalize_voice_event(event: &str) -> Result<String, String> {
    match event {
        "started"
        | "stop-requested"
        | "transcript-observed"
        | "transcript-ready"
        | "submitted"
        | "cancelled"
        | "unavailable"
        | "consent-declined"
        | "ended-without-transcript"
        | "start-error" => Ok(event.into()),
        value if value.starts_with("error:") => {
            let category = value.trim_start_matches("error:");
            Ok(match category {
                "audio-capture"
                | "language-not-supported"
                | "network"
                | "no-speech"
                | "not-allowed"
                | "service-not-allowed" => format!("error:{category}"),
                _ => "error:other".into(),
            })
        }
        _ => Err("Unsupported voice lifecycle event".into()),
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

fn try_with_gateway(
    state: State<'_, Mutex<Gateway>>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    state
        .try_lock()
        .map_err(|_| "Device transport is busy".to_string())?
        .request(method, params)
}

#[derive(Clone)]
struct WindowsRelayAdapter {
    app: AppHandle,
}

fn relay_device_error(message: String) -> DeviceError {
    let disconnected = message.contains("No Quad Cortex session")
        || message.contains("not connected")
        || message.contains("disconnected");
    DeviceError::new(
        if disconnected {
            "NOT_CONNECTED"
        } else {
            "DEVICE_ERROR"
        },
        message,
        disconnected,
    )
}

#[async_trait::async_trait]
impl DeviceAdapter for WindowsRelayAdapter {
    async fn ready(&self) -> bool {
        self.app
            .state::<Mutex<Gateway>>()
            .try_lock()
            .map(|gateway| gateway.connected)
            .unwrap_or(false)
    }

    async fn invoke(&self, method: &str, params: Value) -> Result<Value, DeviceError> {
        if matches!(
            method,
            rpc::PRESS_FOOTSWITCH | rpc::TAP_TEMPO | rpc::SELECT_MODE_SLOT
        ) {
            let plan = plan_host_midi(method, &params)
                .map_err(|message| DeviceError::new("INVALID_ARGUMENT", message, false))?;
            let app = self.app.clone();
            return tauri::async_runtime::spawn_blocking(move || {
                app.state::<Mutex<PerformanceMidi>>()
                    .lock()
                    .map_err(|_| "Performance MIDI lock was poisoned".to_string())?
                    .send(plan.controller, plan.value)
            })
            .await
            .map_err(|error| relay_device_error(error.to_string()))?
            .map(|endpoint| json!({"accepted": true, "immediate": true, "transport": endpoint}))
            .map_err(relay_device_error);
        }
        let app = self.app.clone();
        let method = method.to_owned();
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<Mutex<Gateway>>()
                .lock()
                .map_err(|_| "Gateway session lock was poisoned".to_string())?
                .request(&method, params)
        })
        .await
        .map_err(|error| relay_device_error(error.to_string()))?
        .map_err(relay_device_error)
    }
}

fn relay_adapter(app: &AppHandle) -> std::sync::Arc<dyn DeviceAdapter> {
    std::sync::Arc::new(WindowsRelayAdapter { app: app.clone() })
}

#[tauri::command]
fn relay_status(state: State<'_, RelayBridge>) -> Result<RelayStatus, String> {
    state.status()
}

#[tauri::command]
async fn pair_public_relay(
    app: AppHandle,
    state: State<'_, RelayBridge>,
    endpoint: String,
    pairing_code: String,
    device_name: Option<String>,
) -> Result<RelayStatus, String> {
    state
        .pair(
            &endpoint,
            &pairing_code,
            device_name.as_deref().unwrap_or("QC Control on Windows"),
            relay_adapter(&app),
        )
        .await
}

#[tauri::command]
fn start_public_relay(app: AppHandle, state: State<'_, RelayBridge>) -> Result<(), String> {
    state.start(relay_adapter(&app))
}

#[tauri::command]
fn unpair_public_relay(state: State<'_, RelayBridge>) -> Result<RelayStatus, String> {
    state.unpair()
}

#[tauri::command]
fn set_public_relay_access_mode(
    state: State<'_, RelayBridge>,
    mode: String,
) -> Result<RelayStatus, String> {
    state.set_access_mode(&mode)?;
    state.status()
}

async fn background_gateway_request(app: AppHandle, method: &'static str) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_gateway(app.state::<Mutex<Gateway>>(), method)
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn background_gateway_request_params(
    app: AppHandle,
    method: &'static str,
    params: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_gateway_params(app.state::<Mutex<Gateway>>(), method, params)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn runtime_status(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::RUNTIME_STATUS).await
}

#[tauri::command]
async fn reconnect_device(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::RECONNECT).await
}

#[tauri::command]
async fn reset_device_session(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Mutex<Gateway>>()
            .lock()
            .map_err(|_| "Gateway session lock was poisoned".to_string())?
            .restart(rpc::RESET_SESSION)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn disconnect_device(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::DISCONNECT).await
}

#[tauri::command]
async fn current_snapshot(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::CURRENT_SNAPSHOT).await
}

#[tauri::command]
async fn current_state_events(
    app: AppHandle,
    after_sequence: u64,
    limit: Option<u16>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        try_with_gateway(
            app.state::<Mutex<Gateway>>(),
            rpc::CURRENT_STATE_EVENTS,
            json!({ "afterSequence": after_sequence, "limit": limit.unwrap_or(256) }),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn current_tempo_clock(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        try_with_gateway(
            app.state::<Mutex<Gateway>>(),
            rpc::CURRENT_TEMPO_CLOCK,
            json!({}),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_models(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::LIST_MODELS).await
}

#[tauri::command]
async fn device_identity(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::IDENTITY).await
}

#[tauri::command]
async fn set_device_name(app: AppHandle, name: String) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::SET_DEVICE_NAME, json!({ "name": name })).await
}

#[tauri::command]
async fn undo_device(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::UNDO).await
}

#[tauri::command]
async fn redo_device(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::REDO).await
}

#[tauri::command]
async fn inhibited_modules(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::INHIBITED_MODULES).await
}

#[tauri::command]
async fn tuner_settings(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::TUNER_SETTINGS).await
}

#[tauri::command]
async fn general_settings(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::GENERAL_SETTINGS).await
}

#[tauri::command]
async fn io_settings(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::IO_SETTINGS).await
}

#[tauri::command]
async fn set_input_port(
    app: AppHandle,
    input_port_id: u32,
    level_db: Option<f64>,
    impedance: Option<f64>,
    input_type: Option<f64>,
    ground_lift: Option<f64>,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_INPUT_PORT,
        json!({
            "inputPortId": input_port_id,
            "levelDb": level_db,
            "impedance": impedance,
            "inputType": input_type,
            "groundLift": ground_lift,
        }),
    )
    .await
}

#[tauri::command]
async fn set_output_port(
    app: AppHandle,
    output_port_id: u32,
    level: Option<f64>,
    ground_lift: Option<f64>,
    mute: Option<bool>,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_OUTPUT_PORT,
        json!({
            "outputPortId": output_port_id,
            "level": level,
            "groundLift": ground_lift,
            "mute": mute,
        }),
    )
    .await
}

#[tauri::command]
async fn set_usb_port(
    app: AppHandle,
    level: Option<f64>,
    headphones_source: Option<f64>,
    dry_wet: Option<f64>,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_USB_PORT,
        json!({
            "level": level,
            "headphonesSource": headphones_source,
            "dryWet": dry_wet,
        }),
    )
    .await
}

#[tauri::command]
async fn set_midi_thru(app: AppHandle, enabled: bool) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::SET_MIDI_THRU, json!({ "enabled": enabled })).await
}

#[tauri::command]
async fn set_output_pairing(
    app: AppHandle,
    xlr12_linked: Option<bool>,
    out34_linked: Option<bool>,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_OUTPUT_PAIRING,
        json!({
            "xlr12Linked": xlr12_linked,
            "out34Linked": out34_linked,
        }),
    )
    .await
}

#[tauri::command]
async fn global_eq(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::GLOBAL_EQ).await
}

#[tauri::command]
async fn set_global_eq_bypassed(app: AppHandle, bypassed: bool) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_GLOBAL_EQ_BYPASSED,
        json!({
            "bypassed": bypassed,
        }),
    )
    .await
}

#[tauri::command]
async fn set_global_eq_band(
    app: AppHandle,
    band: u32,
    gain: Option<f64>,
    frequency: Option<f64>,
    q: Option<f64>,
    filter_type: Option<u32>,
    enabled: Option<bool>,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_GLOBAL_EQ_BAND,
        json!({
            "band": band, "gain": gain, "frequency": frequency, "q": q,
            "filterType": filter_type, "enabled": enabled,
        }),
    )
    .await
}

#[tauri::command]
async fn set_global_eq_output(
    app: AppHandle,
    level: Option<f64>,
    out12: Option<bool>,
    out34: Option<bool>,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_GLOBAL_EQ_OUTPUT,
        json!({
            "level": level, "out12": out12, "out34": out34,
        }),
    )
    .await
}

#[tauri::command]
async fn mode_cycle(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::MODE_CYCLE).await
}

#[tauri::command]
async fn set_mode_cycle(app: AppHandle, slots: Vec<u32>) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::SET_MODE_CYCLE, json!({ "slots": slots })).await
}

#[tauri::command]
async fn looper_status(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::LOOPER_STATUS).await
}

#[tauri::command]
async fn control_looper(
    app: AppHandle,
    command: String,
    value: Option<u32>,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::CONTROL_LOOPER,
        json!({
            "command": command, "value": value,
        }),
    )
    .await
}

#[tauri::command]
async fn recents(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::RECENTS).await
}

#[tauri::command]
async fn favorites(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::FAVORITES).await
}

#[tauri::command]
async fn set_favorite(app: AppHandle, name: String, folder_key: String, folder_name: String, is_factory: bool, favorite: bool) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::SET_FAVORITE, json!({
        "name": name, "folderKey": folder_key, "folderName": folder_name,
        "isFactory": is_factory, "favorite": favorite,
    })).await
}

#[tauri::command]
async fn pinned_models(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::PINNED_MODELS).await
}

#[tauri::command]
async fn set_model_pinned(app: AppHandle, model_id: u32, pinned: bool) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::SET_MODEL_PINNED, json!({ "modelId": model_id, "pinned": pinned })).await
}

#[tauri::command]
async fn captures(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::CAPTURES).await
}

#[tauri::command]
async fn load_capture(app: AppHandle, row: u32, column: u32, key: String, name: String, model_id: Option<u32>) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::LOAD_CAPTURE, json!({
        "row": row, "column": column, "key": key, "name": name, "modelId": model_id,
    })).await
}

#[tauri::command]
async fn irs(app: AppHandle, folder: Option<String>) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::IRS, json!({ "folder": folder })).await
}

#[tauri::command]
async fn load_ir(app: AppHandle, row: u32, column: u32, key: String, name: String, slot: u32, model_id: Option<u32>) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::LOAD_IR, json!({
        "row": row, "column": column, "key": key, "name": name,
        "slot": slot, "modelId": model_id,
    })).await
}

#[tauri::command]
async fn create_setlist(app: AppHandle, name: String) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::CREATE_SETLIST, json!({ "name": name })).await
}

#[tauri::command]
async fn delete_setlist(app: AppHandle, name: String) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::DELETE_SETLIST, json!({ "name": name })).await
}

#[tauri::command]
async fn delete_preset(app: AppHandle, setlist_key: String, name: String) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::DELETE_PRESET, json!({ "setlistKey": setlist_key, "name": name })).await
}

#[tauri::command]
async fn move_preset(app: AppHandle, setlist_key: String, name: String, position: u32) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::MOVE_PRESET, json!({
        "setlistKey": setlist_key, "name": name, "position": position,
    })).await
}

#[tauri::command]
async fn set_general_integer(app: AppHandle, setting: String, value: i32) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_GENERAL_INTEGER,
        json!({ "setting": setting, "value": value }),
    )
    .await
}

#[tauri::command]
async fn set_general_toggle(
    app: AppHandle,
    setting: String,
    enabled: bool,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_GENERAL_TOGGLE,
        json!({ "setting": setting, "enabled": enabled }),
    )
    .await
}

#[tauri::command]
async fn set_scene_bypass_behavior(app: AppHandle, behavior: String) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_SCENE_BYPASS_BEHAVIOR,
        json!({ "behavior": behavior }),
    )
    .await
}

#[tauri::command]
async fn set_master_volume_assignment(
    app: AppHandle,
    out12: bool,
    out34: bool,
    send12: bool,
    headphones: bool,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_MASTER_VOLUME_ASSIGNMENT,
        json!({ "out12": out12, "out34": out34, "send12": send12, "headphones": headphones }),
    )
    .await
}

#[tauri::command]
async fn set_global_bypass(app: AppHandle, cab: Vec<bool>, ir: Vec<bool>) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::SET_GLOBAL_BYPASS, json!({ "cab": cab, "ir": ir }))
        .await
}

#[tauri::command]
async fn preset_screenshot(
    app: AppHandle,
    folder_name: String,
    position: u32,
    is_factory: Option<bool>,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::PRESET_SCREENSHOT,
        json!({
            "folderName": folder_name,
            "position": position,
            "isFactory": is_factory.unwrap_or(false)
        }),
    )
    .await
}

#[tauri::command]
async fn capture_screen(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::CAPTURE_SCREEN).await
}

#[tauri::command]
async fn tap_screen(app: AppHandle, x: f64, y: f64) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::TAP_SCREEN, json!({ "x": x, "y": y })).await
}

#[tauri::command]
async fn select_scene(
    app: AppHandle,
    scene: u8,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SELECT_SCENE,
        json!({ "scene": scene, "expectedPresetName": expected_preset_name }),
    )
    .await
}

#[tauri::command]
async fn copy_scene(
    app: AppHandle,
    from_scene: u8,
    to_scene: u8,
    swap: bool,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::COPY_SCENE,
        json!({ "fromScene": from_scene, "toScene": to_scene, "swap": swap, "expectedPresetName": expected_preset_name }),
    )
    .await
}

#[tauri::command]
async fn set_scene_label(
    app: AppHandle,
    scene: u8,
    label: Option<String>,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_SCENE_LABEL,
        json!({ "scene": scene, "label": label, "expectedPresetName": expected_preset_name }),
    )
    .await
}

#[tauri::command]
async fn set_scene_color(
    app: AppHandle,
    scene: u8,
    color: u32,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_SCENE_COLOR,
        json!({ "scene": scene, "color": color, "expectedPresetName": expected_preset_name }),
    )
    .await
}

#[tauri::command]
async fn toggle_bypass(
    app: AppHandle,
    row: u8,
    column: u8,
    expected_scene: u8,
    expected_bypassed: bool,
    desired_bypassed: bool,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::TOGGLE_BYPASS,
        json!({
            "row": row,
            "column": column,
            "expectedScene": expected_scene,
            "expectedBypassed": expected_bypassed,
            "desiredBypassed": desired_bypassed,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn move_block(
    app: AppHandle,
    row: u8,
    from_column: u8,
    to_column: u8,
    expected_model_id: u32,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::MOVE_BLOCK,
        json!({
            "row": row,
            "fromColumn": from_column,
            "toColumn": to_column,
            "expectedModelId": expected_model_id,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn add_block(
    app: AppHandle,
    row: u8,
    column: u8,
    model_id: u32,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::ADD_BLOCK,
        json!({
            "row": row,
            "column": column,
            "modelId": model_id,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn remove_block(
    app: AppHandle,
    row: u8,
    column: u8,
    expected_model_id: u32,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::REMOVE_BLOCK,
        json!({
            "row": row,
            "column": column,
            "expectedModelId": expected_model_id,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn set_block_footswitch(
    app: AppHandle,
    row: u8,
    column: u8,
    footswitch: Option<u8>,
    expected_footswitch: Option<u8>,
    expected_model_id: u32,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_BLOCK_FOOTSWITCH,
        json!({
            "row": row,
            "column": column,
            "footswitch": footswitch,
            "expectedFootswitch": expected_footswitch,
            "expectedModelId": expected_model_id,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn set_stomp_momentary(
    app: AppHandle,
    footswitch: u8,
    momentary: bool,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_STOMP_MOMENTARY,
        json!({
            "footswitch": footswitch,
            "momentary": momentary,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn set_stomp_label(
    app: AppHandle,
    footswitch: u8,
    label: String,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_STOMP_LABEL,
        json!({
            "footswitch": footswitch,
            "label": label,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn set_midi_out(
    app: AppHandle,
    source: u8,
    messages: Vec<Value>,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_MIDI_OUT,
        json!({
            "source": source,
            "messages": messages,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn set_preset_load_midi_out(
    app: AppHandle,
    messages: Vec<Value>,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_PRESET_LOAD_MIDI_OUT,
        json!({
            "messages": messages,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn set_chain_input(
    app: AppHandle,
    row: u8,
    input_id: u8,
    expected_input_id: u8,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_CHAIN_INPUT,
        json!({
            "row": row,
            "inputId": input_id,
            "expectedInputId": expected_input_id,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn set_chain_output(
    app: AppHandle,
    row: u8,
    output_id: u8,
    expected_output_id: u8,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_CHAIN_OUTPUT,
        json!({
            "row": row,
            "outputId": output_id,
            "expectedOutputId": expected_output_id,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn set_chain_split(
    app: AppHandle,
    row: u8,
    split_column: Option<i8>,
    mix_column: Option<i8>,
    expected_split_column: Option<i8>,
    expected_mix_column: Option<i8>,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_CHAIN_SPLIT,
        json!({
            "row": row,
            "splitColumn": split_column,
            "mixColumn": mix_column,
            "expectedSplitColumn": expected_split_column,
            "expectedMixColumn": expected_mix_column,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn list_presets(
    app: AppHandle,
    refresh: bool,
    setlist_key: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_gateway_params(
            app.state::<Mutex<Gateway>>(),
            rpc::LIST_PRESETS,
            json!({ "refresh": refresh, "setlistKey": setlist_key }),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_preset_folders(app: AppHandle, refresh: bool) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_gateway_params(
            app.state::<Mutex<Gateway>>(),
            rpc::LIST_PRESET_FOLDERS,
            json!({ "refresh": refresh }),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn navigate_bank(
    app: AppHandle,
    direction: i8,
    expected_preset_name: String,
    expected_position: u16,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::NAVIGATE_BANK,
        json!({
            "direction": direction,
            "expectedPresetName": expected_preset_name,
            "expectedPosition": expected_position
        }),
    )
    .await
}

#[tauri::command]
async fn recall_preset(
    app: AppHandle,
    setlist_key: String,
    position: u16,
    expected_preset_name: String,
    expected_position: u16,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::RECALL_PRESET,
        json!({
            "setlistKey": setlist_key,
            "position": position,
            "expectedPresetName": expected_preset_name,
            "expectedPosition": expected_position
        }),
    )
    .await
}

#[tauri::command]
async fn reload_preset(
    app: AppHandle,
    expected_preset_name: String,
    expected_position: u16,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::RELOAD_PRESET,
        json!({
            "expectedPresetName": expected_preset_name,
            "expectedPosition": expected_position
        }),
    )
    .await
}

#[tauri::command]
async fn block_details(
    app: AppHandle,
    row: u8,
    column: u8,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::BLOCK_DETAILS,
        json!({
            "row": row,
            "column": column,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn lane_control_details(
    app: AppHandle,
    row: u8,
    control: String,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::LANE_CONTROL_DETAILS,
        json!({"row": row, "control": control, "expectedPresetName": expected_preset_name}),
    )
    .await
}

#[tauri::command]
async fn set_parameter(
    app: AppHandle,
    row: u8,
    column: u8,
    parameter_index: u16,
    value: f64,
    expected_value: f64,
    expected_scene: u8,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_PARAMETER,
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
    .await
}

#[tauri::command]
async fn set_parameter_scene_mode(
    app: AppHandle,
    row: u8,
    column: u8,
    parameter_index: u16,
    enabled: bool,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_PARAMETER_SCENE_MODE,
        json!({
            "row": row,
            "column": column,
            "parameterIndex": parameter_index,
            "enabled": enabled,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn set_lane_control_parameter(
    app: AppHandle,
    row: u8,
    control: String,
    parameter_index: u16,
    value: f64,
    expected_value: f64,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_LANE_CONTROL_PARAMETER,
        json!({"row": row, "control": control, "parameterIndex": parameter_index,
            "value": value, "expectedValue": expected_value,
            "expectedPresetName": expected_preset_name}),
    )
    .await
}

#[tauri::command]
async fn set_lane_control_scene_mode(
    app: AppHandle,
    row: u8,
    control: String,
    parameter_index: u16,
    enabled: bool,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_LANE_CONTROL_SCENE_MODE,
        json!({"row": row, "control": control, "parameterIndex": parameter_index,
            "enabled": enabled, "expectedPresetName": expected_preset_name}),
    )
    .await
}

#[tauri::command]
async fn set_parameter_expression(
    app: AppHandle,
    row: u8,
    column: u8,
    parameter_index: u16,
    pedal: u8,
    minimum: f64,
    maximum: f64,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_PARAMETER_EXPRESSION,
        json!({
            "row": row,
            "column": column,
            "parameterIndex": parameter_index,
            "pedal": pedal,
            "minimum": minimum,
            "maximum": maximum,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn set_expression_bypass(
    app: AppHandle,
    row: u8,
    column: u8,
    pedal: u8,
    mode: u8,
    invert: bool,
    delay_ms: u16,
    latch_emulation: bool,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_EXPRESSION_BYPASS,
        json!({
            "row": row, "column": column, "pedal": pedal, "mode": mode,
            "invert": invert, "delayMs": delay_ms, "latchEmulation": latch_emulation,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn preview_parameter(
    app: AppHandle,
    row: u8,
    column: u8,
    parameter_index: u16,
    value: f64,
    expected_scene: u8,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::PREVIEW_PARAMETER,
        json!({
            "row": row,
            "column": column,
            "parameterIndex": parameter_index,
            "value": value,
            "expectedScene": expected_scene,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn preview_lane_control_parameter(
    app: AppHandle,
    row: u8,
    control: String,
    parameter_index: u16,
    value: f64,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::PREVIEW_LANE_CONTROL_PARAMETER,
        json!({"row": row, "control": control, "parameterIndex": parameter_index,
            "value": value, "expectedPresetName": expected_preset_name}),
    )
    .await
}

#[tauri::command]
async fn set_tempo(
    app: AppHandle,
    bpm: u16,
    expected_tempo: u16,
    expected_preset_name: String,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_TEMPO,
        json!({
            "bpm": bpm,
            "expectedTempo": expected_tempo,
            "expectedPresetName": expected_preset_name
        }),
    )
    .await
}

#[tauri::command]
async fn set_master_volume(app: AppHandle, value: u8, expected_value: u8) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SET_MASTER_VOLUME,
        json!({ "value": value, "expectedValue": expected_value }),
    )
    .await
}

#[tauri::command]
async fn current_master_volume(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        try_with_gateway(
            app.state::<Mutex<Gateway>>(),
            rpc::CURRENT_MASTER_VOLUME,
            json!({}),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn press_footswitch(
    app: AppHandle,
    index: u8,
    expected_mode: String,
    expected_preset_name: String,
) -> Result<Value, String> {
    if u32::from(index) >= qc_protocol::domain::SCENE_COUNT {
        return Err("Footswitch index must be from 0 through 7 (A through H).".into());
    }
    if !matches!(
        expected_mode.as_str(),
        "PRESET" | "SCENE" | "STOMP" | "HYBRID"
    ) {
        return Err("The current footswitch mode is not valid.".into());
    }
    let plan = plan_host_midi("device.pressFootswitch", &json!({ "index": index }))?;
    let detail = plan.detail.clone();
    let endpoint = tauri::async_runtime::spawn_blocking(move || {
        app.state::<Mutex<PerformanceMidi>>()
            .lock()
            .map_err(|_| "Performance MIDI lock was poisoned".to_string())?
            .send(plan.controller, plan.value)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(json!({
        "detail": format!("{detail} immediately through {endpoint}; live USB state will reconcile the result."),
        "immediate": true,
        "expectedPresetName": expected_preset_name
    }))
}

#[tauri::command]
async fn tap_tempo(
    app: AppHandle,
    expected_mode: String,
    expected_preset_name: String,
) -> Result<Value, String> {
    if !matches!(
        expected_mode.as_str(),
        "PRESET" | "SCENE" | "STOMP" | "HYBRID"
    ) {
        return Err("The current footswitch mode is not valid.".into());
    }
    let plan = plan_host_midi("device.tapTempo", &json!({}))?;
    let detail = plan.detail.clone();
    let endpoint = tauri::async_runtime::spawn_blocking(move || {
        app.state::<Mutex<PerformanceMidi>>()
            .lock()
            .map_err(|_| "Performance MIDI lock was poisoned".to_string())?
            .send(plan.controller, plan.value)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(json!({
        "detail": format!("{detail} immediately through {endpoint}; live USB state will reconcile the result."),
        "immediate": true,
        "expectedMode": expected_mode,
        "expectedPresetName": expected_preset_name
    }))
}

#[tauri::command]
async fn select_mode_slot(
    app: AppHandle,
    slot: u8,
    expected_preset_name: String,
) -> Result<Value, String> {
    if slot > 2 {
        return Err("Mode slot must be A, B, or C.".into());
    }
    let plan = plan_host_midi("device.selectModeSlot", &json!({ "slot": slot }))?;
    let detail = plan.detail.clone();
    let endpoint = tauri::async_runtime::spawn_blocking(move || {
        app.state::<Mutex<PerformanceMidi>>()
            .lock()
            .map_err(|_| "Performance MIDI lock was poisoned".to_string())?
            .send(plan.controller, plan.value)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(json!({
        "detail": format!("{detail} immediately through {endpoint}; live USB state will reconcile the result."),
        "immediate": true,
        "expectedPresetName": expected_preset_name
    }))
}

#[tauri::command]
async fn list_preset_slots(app: AppHandle) -> Result<Value, String> {
    background_gateway_request(app, rpc::LIST_PRESET_SLOTS).await
}

#[tauri::command]
async fn save_preset_as(
    app: AppHandle,
    setlist_key: String,
    position: u16,
    name: String,
    expected_preset_name: String,
    expected_position: u16,
    confirm_overwrite: bool,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::SAVE_PRESET_AS,
        json!({
            "setlistKey": setlist_key,
            "position": position,
            "name": name,
            "expectedPresetName": expected_preset_name,
            "expectedPosition": expected_position,
            "confirmOverwrite": confirm_overwrite
        }),
    )
    .await
}

#[tauri::command]
async fn copy_preset(
    app: AppHandle,
    source_setlist_key: String,
    source_position: u16,
    source_name: String,
    destination_setlist_key: String,
    destination_position: u16,
    expected_preset_name: String,
    expected_position: u16,
    confirm_overwrite: bool,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::COPY_PRESET,
        json!({
            "sourceSetlistKey": source_setlist_key,
            "sourcePosition": source_position,
            "sourceName": source_name,
            "destinationSetlistKey": destination_setlist_key,
            "destinationPosition": destination_position,
            "expectedPresetName": expected_preset_name,
            "expectedPosition": expected_position,
            "confirmOverwrite": confirm_overwrite
        }),
    )
    .await
}

#[tauri::command]
async fn rename_current_preset(
    app: AppHandle,
    name: String,
    expected_preset_name: String,
    expected_position: u16,
    confirm_rename: bool,
) -> Result<Value, String> {
    background_gateway_request_params(
        app,
        rpc::RENAME_CURRENT_PRESET,
        json!({
            "name": name,
            "expectedPresetName": expected_preset_name,
            "expectedPosition": expected_position,
            "confirmRename": confirm_rename
        }),
    )
    .await
}

#[tauri::command]
async fn show_tuner(app: AppHandle, shown: bool) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::SHOW_TUNER, json!({ "shown": shown })).await
}

#[tauri::command]
async fn show_gig_view(app: AppHandle, shown: bool) -> Result<Value, String> {
    background_gateway_request_params(app, rpc::SHOW_GIG_VIEW, json!({ "shown": shown })).await
}

const MAX_WORKSPACE_BYTES: usize = 16 * 1024 * 1024;
const MAX_NATIVE_BACKUP_BYTES: usize = 32 * 1024 * 1024;

fn validate_native_backup(document: &Value) -> Result<(), String> {
    if !document.is_object()
        || document.get("type").and_then(Value::as_str) != Some("backup")
        || document.get("creator").and_then(Value::as_str) != Some("quad")
    {
        return Err("The device returned an unsupported native backup document".into());
    }
    let payload = document
        .get("payload")
        .and_then(Value::as_str)
        .ok_or("The native backup has no payload")?;
    if payload.is_empty() || payload.len() > MAX_NATIVE_BACKUP_BYTES {
        return Err("The native backup payload is empty or oversized".into());
    }
    let payload_hash = document
        .get("payload_hash")
        .and_then(Value::as_str)
        .ok_or("The native backup has no integrity identifier")?;
    if payload_hash.len() != 64 || !payload_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The native backup integrity identifier is malformed".into());
    }
    Ok(())
}

fn safe_backup_name(value: &str) -> String {
    let filtered: String = value
        .chars()
        .filter(|character| !character.is_control())
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
        "QC Device Backup".into()
    } else {
        trimmed.chars().take(80).collect()
    }
}

#[tauri::command]
async fn create_device_backup(app: AppHandle, name: String) -> Result<Value, String> {
    let clean_name = safe_backup_name(&name);
    let Some(path) = rfd::FileDialog::new()
        .add_filter("Quad Cortex Backup", &["json"])
        .set_file_name(format!("{clean_name}.json"))
        .save_file()
    else {
        return Ok(json!({ "cancelled": true }));
    };
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        != Some("json".into())
    {
        return Err("Quad Cortex backups must use the .json extension".into());
    }
    let document = background_gateway_request_params(
        app,
        rpc::CREATE_DEVICE_BACKUP,
        json!({ "name": clean_name }),
    )
    .await?;
    validate_native_backup(&document)?;
    let bytes = serde_json::to_vec(&document).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_NATIVE_BACKUP_BYTES {
        return Err("The native backup exceeds the 32 MiB safety limit".into());
    }
    fs::write(&path, bytes).map_err(|error| format!("Could not save native backup: {error}"))?;
    Ok(json!({
        "cancelled": false,
        "path": path.to_string_lossy(),
        "name": path.file_name().and_then(|value| value.to_str()).unwrap_or("QC Device Backup.json")
    }))
}

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

fn diagnostic_string(report: &Value, section: &str, key: &str, maximum: usize) -> String {
    report
        .get(section)
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .filter(|character| !character.is_control())
        .take(maximum)
        .collect()
}

fn redacted_diagnostics(report: &Value) -> Value {
    let events: Vec<Value> = report
        .get("events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(100)
        .filter_map(|entry| {
            let at: String = entry
                .get("at")?
                .as_str()?
                .chars()
                .filter(|character| !character.is_control())
                .take(40)
                .collect();
            let event = entry.get("event")?.as_str()?;
            const ALLOWED_EVENTS: &[&str] = &[
                "app-start",
                "runtime-ready",
                "connect-attempt",
                "connected",
                "connect-failed",
                "disconnected",
                "reset-attempt",
                "diagnostics-exported",
            ];
            ALLOWED_EVENTS
                .contains(&event)
                .then(|| json!({ "at": at, "event": event }))
        })
        .collect();

    json!({
        "format": "qc-voice-control-diagnostics-v1",
        "generatedAt": report.get("generatedAt").and_then(Value::as_str).unwrap_or(""),
        "appVersion": report.get("appVersion").and_then(Value::as_str).unwrap_or("unknown"),
        "runtime": {
            "platform": diagnostic_string(report, "runtime", "platform", 80),
            "gatewayAvailable": report.get("runtime").and_then(|value| value.get("gatewayAvailable")).and_then(Value::as_bool).unwrap_or(false)
        },
        "connection": {
            "phase": diagnostic_string(report, "connection", "phase", 32),
            "demo": report.get("connection").and_then(|value| value.get("demo")).and_then(Value::as_bool).unwrap_or(true)
        },
        "device": {
            "presetLocation": diagnostic_string(report, "device", "presetLocation", 8),
            "presetPosition": report.get("device").and_then(|value| value.get("presetPosition")).and_then(Value::as_u64).unwrap_or(0),
            "mode": diagnostic_string(report, "device", "mode", 16),
            "activeScene": report.get("device").and_then(|value| value.get("activeScene")).and_then(Value::as_u64).unwrap_or(0),
            "tempo": report.get("device").and_then(|value| value.get("tempo")).and_then(Value::as_u64).unwrap_or(0),
            "dirty": report.get("device").and_then(|value| value.get("dirty")).and_then(Value::as_bool).unwrap_or(false),
            "blockCount": report.get("device").and_then(|value| value.get("blockCount")).and_then(Value::as_u64).unwrap_or(0)
        },
        "events": events,
        "redaction": {
            "omitted": ["serial numbers", "MAC addresses", "usernames", "paths", "preset and setlist names", "conversation content"]
        }
    })
}

#[tauri::command]
fn export_diagnostics(report: Value) -> Result<Value, String> {
    let document = redacted_diagnostics(&report);
    let timestamp = chrono_free_timestamp();
    let Some(path) = rfd::FileDialog::new()
        .add_filter("QC Diagnostics", &["json"])
        .set_file_name(format!("QC Control Diagnostics {timestamp}.json"))
        .save_file()
    else {
        return Ok(json!({ "cancelled": true }));
    };
    let bytes = serde_json::to_vec_pretty(&document).map_err(|error| error.to_string())?;
    fs::write(&path, bytes).map_err(|error| format!("Could not export diagnostics: {error}"))?;
    Ok(json!({
        "cancelled": false,
        "path": path.to_string_lossy(),
        "name": path.file_name().and_then(|value| value.to_str()).unwrap_or("QC Control Diagnostics.json")
    }))
}

fn chrono_free_timestamp() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    seconds.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_audio_accepts_only_https_youtube_hosts() {
        assert!(validate_youtube_url("https://youtu.be/abc123").is_ok());
        assert!(validate_youtube_url("https://music.youtube.com/watch?v=abc123").is_ok());
        assert!(validate_youtube_url("http://youtube.com/watch?v=abc123").is_err());
        assert!(validate_youtube_url("https://youtube.com.example.test/watch?v=abc123").is_err());
        assert!(validate_youtube_url("https://example.test/watch?v=abc123").is_err());
    }

    #[test]
    fn external_browser_links_are_exactly_allowlisted() {
        assert!(is_allowed_external_url(
            "https://aistudio.google.com/app/apikey"
        ));
        assert!(!is_allowed_external_url(
            "https://aistudio.google.com/app/apikey?continue=https://evil.example"
        ));
        assert!(!is_allowed_external_url("https://evil.example"));
    }

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
    fn native_backup_validation_requires_the_qc_container_fields() {
        let valid = json!({
            "type": "backup",
            "creator": "quad",
            "payload": "AA==",
            "payload_hash": "0".repeat(64)
        });
        assert!(validate_native_backup(&valid).is_ok());
        assert!(validate_native_backup(&json!({ "type": "backup" })).is_err());
        assert_eq!(safe_backup_name("Band: Friday?"), "Band_ Friday_");
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
    fn diagnostics_are_allowlisted_and_redacted() {
        let report = json!({
            "generatedAt": "2026-08-30T17:00:00Z",
            "appVersion": "0.1.0",
            "runtime": { "platform": "Python gateway", "gatewayAvailable": true, "username": "secret" },
            "connection": { "phase": "ready", "demo": false, "detail": "C:\\Users\\secret" },
            "device": { "presetLocation": "6B", "presetPosition": 41, "mode": "STOMP", "activeScene": 0, "tempo": 45, "dirty": false, "blockCount": 18, "presetName": "private" },
            "events": [{ "at": "now", "event": "connected", "message": "private" }],
            "conversation": "private"
        });
        let safe = redacted_diagnostics(&report);
        let text = serde_json::to_string(&safe).expect("diagnostic JSON");
        assert!(!text.contains("secret"));
        assert!(!text.contains("private"));
        assert_eq!(safe["device"]["tempo"], 45);
        assert_eq!(safe["events"][0]["event"], "connected");
    }

    #[test]
    fn runtime_health_contains_only_operational_metadata() {
        let gateway = Gateway {
            process: None,
            connected: true,
            voice_recognition_available: Some(true),
            voice_last_event: Some("submitted".into()),
            voice_event_at_unix: Some(1),
            event_tx: None,
        };
        let health = runtime_health_document(&gateway, "device.snapshot", "ok");
        let keys = health
            .as_object()
            .expect("health object")
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            keys,
            [
                "appPid",
                "connected",
                "gatewayPid",
                "lastMethod",
                "lastRequestAtUnix",
                "lastStatus",
                "version",
                "voiceRecognitionAvailable",
                "voiceLastEvent",
                "voiceEventAtUnix",
            ]
            .into_iter()
            .map(str::to_string)
            .collect()
        );
        assert_eq!(health["connected"], true);
        assert_eq!(health["lastMethod"], "device.snapshot");
        assert_eq!(health["lastStatus"], "ok");
        assert_eq!(health["voiceRecognitionAvailable"], true);
        assert_eq!(health["voiceLastEvent"], "submitted");
    }

    #[test]
    fn voice_events_are_allowlisted_without_transcript_content() {
        assert_eq!(normalize_voice_event("started").unwrap(), "started");
        assert_eq!(
            normalize_voice_event("error:not-allowed").unwrap(),
            "error:not-allowed"
        );
        assert_eq!(
            normalize_voice_event("error:private transcript").unwrap(),
            "error:other"
        );
        assert!(normalize_voice_event("transcript:private words").is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (device_event_tx, device_event_rx) = mpsc::channel::<Value>();
    let gateway = Gateway {
        event_tx: Some(device_event_tx),
        ..Gateway::default()
    };
    tauri::Builder::default()
        .manage(Mutex::new(gateway))
        .manage(Mutex::new(PerformanceMidi::default()))
        .manage(ChatBridge::default())
        .manage(RelayBridge::default())
        .setup(move |app| {
            let handle = app.handle().clone();
            let relay = app.state::<RelayBridge>();
            relay.restore_access_mode();
            let _ = relay.start(relay_adapter(&handle));
            std::thread::Builder::new()
                .name("qc-window-events".into())
                .spawn(move || {
                    while let Ok(frame) = device_event_rx.recv() {
                        if handle.emit("qc-state-frame", frame).is_err() {
                            return;
                        }
                    }
                })
                .map_err(|error| error.to_string())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            relay_status,
            pair_public_relay,
            start_public_relay,
            unpair_public_relay,
            set_public_relay_access_mode,
            runtime_status,
            reconnect_device,
            reset_device_session,
            disconnect_device,
            current_snapshot,
            current_state_events,
            current_tempo_clock,
            list_models,
            device_identity,
            set_device_name,
            undo_device,
            redo_device,
            inhibited_modules,
            tuner_settings,
            general_settings,
            io_settings,
            set_input_port,
            set_output_port,
            set_usb_port,
            set_midi_thru,
            set_output_pairing,
            global_eq,
            set_global_eq_bypassed,
            set_global_eq_band,
            set_global_eq_output,
            mode_cycle,
            set_mode_cycle,
            looper_status,
            control_looper,
            recents,
            favorites,
            set_favorite,
            pinned_models,
            set_model_pinned,
            captures,
            load_capture,
            irs,
            load_ir,
            create_setlist,
            delete_setlist,
            delete_preset,
            move_preset,
            set_general_integer,
            set_general_toggle,
            set_scene_bypass_behavior,
            set_master_volume_assignment,
            set_global_bypass,
            preset_screenshot,
            capture_screen,
            tap_screen,
            select_scene,
            copy_scene,
            set_scene_label,
            set_scene_color,
            toggle_bypass,
            move_block,
            add_block,
            remove_block,
            set_block_footswitch,
            set_stomp_momentary,
            set_stomp_label,
            set_midi_out,
            set_preset_load_midi_out,
            set_chain_input,
            set_chain_output,
            set_chain_split,
            list_presets,
            list_preset_folders,
            navigate_bank,
            recall_preset,
            reload_preset,
            block_details,
            lane_control_details,
            preview_parameter,
            preview_lane_control_parameter,
            set_parameter,
            set_parameter_scene_mode,
            set_lane_control_parameter,
            set_lane_control_scene_mode,
            set_parameter_expression,
            set_expression_bypass,
            set_tempo,
            set_master_volume,
            current_master_volume,
            press_footswitch,
            tap_tempo,
            select_mode_slot,
            list_preset_slots,
            save_preset_as,
            copy_preset,
            rename_current_preset,
            show_tuner,
            show_gig_view,
            create_device_backup,
            save_workspace_as,
            save_workspace,
            open_workspace,
            export_diagnostics,
            report_voice_capability,
            report_voice_event,
            chat_settings,
            update_chat_settings,
            set_chat_api_key,
            clear_chat_api_key,
            configure_google_oauth_app,
            open_external_url,
            open_google_subscription_setup,
            connect_google_oauth,
            select_google_project,
            disconnect_google_oauth,
            chat_with_model,
            fetch_youtube_reference_audio,
            chat_quota,
            antigravity_models,
            test_chat_connection,
            warm_chat_provider,
            cancel_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running QC Control");
}
