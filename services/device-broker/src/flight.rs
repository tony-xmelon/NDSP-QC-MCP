use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_ENTRIES: usize = 256;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FlightEntry {
    at_unix_ms: u128,
    #[serde(default)]
    process_id: u32,
    event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_type: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    report_count: Option<usize>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FlightDocument {
    version: u8,
    entries: VecDeque<FlightEntry>,
}

/// A bounded, payload-free record of the messages most recently sent to the QC.
/// It is persisted after every entry so a device-side hang does not erase the
/// evidence needed to identify the final operation.
pub struct FlightRecorder {
    path: Option<PathBuf>,
    document: FlightDocument,
    last_persisted_at: Instant,
}

impl FlightRecorder {
    pub fn open_default() -> Self {
        let path = std::env::var_os("QC_FLIGHT_RECORDER_PATH")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("LOCALAPPDATA").map(|root| {
                    PathBuf::from(root)
                        .join("QC Control")
                        .join("device-flight-recorder.json")
                })
            });
        Self::open(path)
    }

    fn open(path: Option<PathBuf>) -> Self {
        let document = path
            .as_deref()
            .and_then(|path| fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<FlightDocument>(&bytes).ok())
            .unwrap_or_else(|| FlightDocument {
                version: 1,
                entries: VecDeque::new(),
            });
        Self {
            path,
            document,
            last_persisted_at: Instant::now(),
        }
    }

    pub fn event(&mut self, event: impl Into<String>) {
        self.push(FlightEntry {
            at_unix_ms: now_unix_ms(),
            process_id: std::process::id(),
            event: event.into(),
            message_type: None,
            report_count: None,
        });
    }

    pub fn outbound(&mut self, message_type: u16, report_count: usize) {
        self.push(FlightEntry {
            at_unix_ms: now_unix_ms(),
            process_id: std::process::id(),
            event: "outbound".into(),
            message_type: Some(message_type),
            report_count: Some(report_count),
        });
    }

    pub fn inbound(&mut self, message_type: u16, report_count: usize) {
        self.push(FlightEntry {
            at_unix_ms: now_unix_ms(),
            process_id: std::process::id(),
            event: "inbound".into(),
            message_type: Some(message_type),
            report_count: Some(report_count),
        });
    }

    fn push(&mut self, entry: FlightEntry) {
        self.document.entries.push_back(entry);
        while self.document.entries.len() > MAX_ENTRIES {
            self.document.entries.pop_front();
        }
        // Rewriting the bounded JSON document synchronously for every 129-byte
        // HID report used to stretch Cortex Control's initialization burst by
        // hundreds of milliseconds. Keep recording in memory on the realtime
        // path and checkpoint at most once per second; Drop performs a final
        // flush on orderly shutdown.
        if self.last_persisted_at.elapsed() >= Duration::from_secs(1) {
            self.persist();
            self.last_persisted_at = Instant::now();
        }
    }

    fn persist(&self) {
        let Some(path) = self.path.as_deref() else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(document) = serde_json::to_vec_pretty(&self.document) {
            let _ = fs::write(path, document);
        }
    }

    #[cfg(test)]
    fn for_test() -> Self {
        Self::open(None)
    }
}

impl Drop for FlightRecorder {
    fn drop(&mut self) {
        self.persist();
    }
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorder_is_bounded_and_contains_no_payload_field() {
        let mut recorder = FlightRecorder::for_test();
        for message_type in 0..(MAX_ENTRIES + 20) {
            recorder.outbound(message_type as u16, 1);
        }
        assert_eq!(recorder.document.entries.len(), MAX_ENTRIES);
        assert!(recorder
            .document
            .entries
            .iter()
            .all(|entry| entry.process_id > 0));
        let json = serde_json::to_value(&recorder.document).unwrap();
        assert!(json.to_string().find("payload").is_none());
        assert_eq!(json["entries"][0]["messageType"], 20);
    }

    #[test]
    fn recorder_captures_inbound_frame_size_without_payload_data() {
        let mut recorder = FlightRecorder::for_test();
        recorder.inbound(40, 1191);
        let json = serde_json::to_value(&recorder.document).unwrap();
        assert_eq!(json["entries"][0]["event"], "inbound");
        assert_eq!(json["entries"][0]["messageType"], 40);
        assert_eq!(json["entries"][0]["reportCount"], 1191);
        assert!(json.to_string().find("payload").is_none());
    }

    #[test]
    fn recorder_flushes_on_drop() {
        let path = std::env::temp_dir().join(format!(
            "qc-flight-recorder-{}-{}.json",
            std::process::id(),
            now_unix_ms()
        ));
        {
            let mut recorder = FlightRecorder::open(Some(path.clone()));
            recorder.event("physical-transfer-test");
            recorder.inbound(40, 1191);
        }
        let document: FlightDocument =
            serde_json::from_slice(&fs::read(&path).expect("flight record persisted"))
                .expect("flight record is valid JSON");
        assert_eq!(document.entries.len(), 2);
        assert_eq!(document.entries[1].message_type, Some(40));
        let _ = fs::remove_file(path);
    }
}
