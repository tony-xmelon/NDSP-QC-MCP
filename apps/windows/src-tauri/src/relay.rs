use qc_relay_client::{AccessMode, Client, ConnectionState, Credentials, DeviceAdapter};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

const CREDENTIAL_SERVICE: &str = "QC Control";
const CREDENTIAL_ACCOUNT: &str = "outbound-public-relay-v1";
const ACCESS_MODE_ACCOUNT: &str = "outbound-public-relay-access-v1";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub paired: bool,
    pub state: ConnectionState,
    pub access_mode: AccessMode,
    pub endpoint: Option<String>,
    pub device_id: Option<String>,
}

pub struct RelayBridge {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    stop: Mutex<Option<watch::Sender<bool>>>,
    state: Mutex<watch::Receiver<ConnectionState>>,
    access: watch::Sender<AccessMode>,
}

impl Default for RelayBridge {
    fn default() -> Self {
        let (_, state) = watch::channel(ConnectionState::Stopped);
        let (access, _) = watch::channel(AccessMode::Full);
        Self {
            task: Mutex::new(None),
            stop: Mutex::new(None),
            state: Mutex::new(state),
            access,
        }
    }
}

impl RelayBridge {
    pub fn status(&self) -> Result<RelayStatus, String> {
        let credential = load_credentials()?;
        let state = *self
            .state
            .lock()
            .map_err(|_| "Relay state lock was poisoned")?
            .borrow();
        Ok(RelayStatus {
            paired: credential.is_some(),
            state,
            access_mode: *self.access.borrow(),
            endpoint: credential.as_ref().map(|value| value.endpoint.clone()),
            device_id: credential.map(|value| value.device_id),
        })
    }

    pub fn start(&self, adapter: Arc<dyn DeviceAdapter>) -> Result<(), String> {
        let credentials =
            load_credentials()?.ok_or("Pair this computer with the public relay first")?;
        self.stop();
        let (state_tx, state_rx) = watch::channel(ConnectionState::Stopped);
        let (stop_tx, stop_rx) = watch::channel(false);
        *self
            .state
            .lock()
            .map_err(|_| "Relay state lock was poisoned")? = state_rx;
        *self
            .stop
            .lock()
            .map_err(|_| "Relay stop lock was poisoned")? = Some(stop_tx);
        let client = Client::new(
            credentials,
            adapter,
            state_tx,
            self.access.subscribe(),
            stop_rx,
        );
        let task = tauri::async_runtime::spawn(client.run());
        *self
            .task
            .lock()
            .map_err(|_| "Relay task lock was poisoned")? = Some(task);
        Ok(())
    }

    pub fn stop(&self) {
        if let Ok(mut stop) = self.stop.lock() {
            if let Some(sender) = stop.take() {
                sender.send_replace(true);
            }
        }
        if let Ok(mut task) = self.task.lock() {
            if let Some(handle) = task.take() {
                handle.abort();
            }
        }
    }

    pub fn set_access_mode(&self, mode: &str) -> Result<AccessMode, String> {
        let mode = AccessMode::parse(mode)?;
        store_access_mode(mode)?;
        self.access.send_replace(mode);
        Ok(mode)
    }

    pub fn restore_access_mode(&self) {
        self.access.send_replace(load_access_mode());
    }

    pub async fn pair(
        &self,
        endpoint: &str,
        pairing_code: &str,
        device_name: &str,
        adapter: Arc<dyn DeviceAdapter>,
    ) -> Result<RelayStatus, String> {
        let credentials = qc_relay_client::pair(endpoint, pairing_code, device_name).await?;
        store_credentials(&credentials)?;
        self.start(adapter)?;
        self.status()
    }

    pub fn unpair(&self) -> Result<RelayStatus, String> {
        self.stop();
        clear_credentials()?;
        self.status()
    }
}

impl Drop for RelayBridge {
    fn drop(&mut self) {
        self.stop();
    }
}

fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT)
        .map_err(|_| "Windows Credential Manager is unavailable".to_string())
}

fn access_mode_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, ACCESS_MODE_ACCOUNT)
        .map_err(|_| "Windows Credential Manager is unavailable".to_string())
}

fn load_access_mode() -> AccessMode {
    access_mode_entry()
        .and_then(|entry| {
            entry
                .get_password()
                .map_err(|_| "Relay access mode is not stored".to_string())
        })
        .ok()
        .and_then(|value| AccessMode::parse(&value).ok())
        .unwrap_or_default()
}

fn store_access_mode(mode: AccessMode) -> Result<(), String> {
    let value = match mode {
        AccessMode::Full => "full",
        AccessMode::Modify => "modify",
        AccessMode::Performance => "performance",
        AccessMode::ReadOnly => "read-only",
    };
    access_mode_entry()?
        .set_password(value)
        .map_err(|_| "Could not store the relay access mode in Windows Credential Manager".into())
}

fn load_credentials() -> Result<Option<Credentials>, String> {
    match credential_entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value).map(Some).map_err(|_| {
            "The stored public-relay credential is invalid; unpair and pair again".into()
        }),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => {
            Err("Could not read the public-relay credential from Windows Credential Manager".into())
        }
    }
}

fn store_credentials(credentials: &Credentials) -> Result<(), String> {
    let encoded = serde_json::to_string(credentials)
        .map_err(|_| "Could not encode the public-relay credential")?;
    credential_entry()?.set_password(&encoded).map_err(|_| {
        "Could not store the public-relay credential in Windows Credential Manager".into()
    })
}

fn clear_credentials() -> Result<(), String> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(
            "Could not remove the public-relay credential from Windows Credential Manager".into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_defaults_to_full_control() {
        let bridge = RelayBridge::default();
        assert_eq!(*bridge.access.borrow(), AccessMode::Full);
        assert_eq!(
            AccessMode::parse("read-only").unwrap(),
            AccessMode::ReadOnly
        );
        assert_eq!(
            AccessMode::parse("performance").unwrap(),
            AccessMode::Performance
        );
        assert_eq!(AccessMode::parse("modify").unwrap(), AccessMode::Modify);
        assert!(AccessMode::parse("write-mostly").is_err());
    }
}
