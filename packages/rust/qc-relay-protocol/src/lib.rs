use serde::{Deserialize, Serialize};
use serde_json::Value;

mod generated_profile;
pub use generated_profile::*;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DeviceError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

impl DeviceError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DeviceFrame {
    Ready {
        protocol: String,
        #[serde(rename = "usbConnected")]
        usb_connected: bool,
    },
    Invoke {
        id: String,
        action: String,
        method: String,
        #[serde(default)]
        params: Value,
    },
    Result {
        id: String,
        ok: bool,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        error: Option<DeviceError>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_match_existing_android_and_server_protocol() {
        let ready = serde_json::to_value(DeviceFrame::Ready {
            protocol: PROTOCOL_VERSION.into(),
            usb_connected: true,
        })
        .unwrap();
        assert_eq!(
            ready,
            serde_json::json!({
                "type": "ready", "protocol": "qc-relay.v1", "usbConnected": true
            })
        );
        let invoke: DeviceFrame = serde_json::from_value(serde_json::json!({
            "type": "invoke", "id": "1", "action": "get_current_preset",
            "method": "device.snapshot", "params": {}
        }))
        .unwrap();
        assert!(
            matches!(invoke, DeviceFrame::Invoke { method, .. } if method == "device.snapshot")
        );
    }
}
