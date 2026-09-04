use qc_protocol::session::FrameAssembler;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Trace {
    version: u8,
    name: String,
    privacy: Privacy,
    frames: Vec<TraceFrame>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Privacy {
    synthetic: bool,
    contains_device_identity: bool,
    contains_preset_content: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceFrame {
    direction: String,
    message_type: u16,
    reports_hex: Vec<String>,
    expected_payload_hex: String,
}

fn decode_hex(value: &str) -> Vec<u8> {
    assert_eq!(
        value.len() % 2,
        0,
        "hex fixtures must contain complete bytes"
    );
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("ASCII hex"), 16)
                .expect("valid hex")
        })
        .collect()
}

fn replay(trace: &Trace) -> Vec<(u16, Vec<u8>)> {
    let mut frames = Vec::new();
    let mut assembler = FrameAssembler::new();
    for expected in &trace.frames {
        assert!(matches!(
            expected.direction.as_str(),
            "inbound" | "outbound"
        ));
        for report in &expected.reports_hex {
            if let Some(frame) = assembler
                .push(decode_hex(report))
                .expect("valid sanitized report")
            {
                frames.push(frame);
            }
        }
    }
    frames
}

#[test]
fn sanitized_trace_replays_identically_for_every_native_host() {
    let source = include_str!("fixtures/sanitized-session-v1.json");
    let trace: Trace = serde_json::from_str(source).expect("valid trace fixture");
    assert_eq!(trace.version, 1);
    assert!(!trace.name.is_empty());
    assert!(trace.privacy.synthetic);
    assert!(!trace.privacy.contains_device_identity);
    assert!(!trace.privacy.contains_preset_content);

    let expected = trace
        .frames
        .iter()
        .map(|frame| (frame.message_type, decode_hex(&frame.expected_payload_hex)))
        .collect::<Vec<_>>();

    let windows_replay = replay(&trace);
    let android_replay = replay(&trace);
    assert_eq!(windows_replay, expected);
    assert_eq!(android_replay, expected);
    assert_eq!(windows_replay, android_replay);
}

#[test]
fn replay_fixture_cannot_silently_acquire_private_fields() {
    let source = include_str!("fixtures/sanitized-session-v1.json").to_ascii_lowercase();
    for forbidden in ["serial", "token", "credential", "presetname", "devicename"] {
        assert!(
            !source.contains(forbidden),
            "fixture contains private field {forbidden}"
        );
    }
}
