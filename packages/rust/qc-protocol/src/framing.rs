//! Quad Cortex HID report framing.

use crate::profile;
use thiserror::Error;

pub const REPORT_BODY_SIZE: usize = 128;
pub const REPORT_SIZE: usize = REPORT_BODY_SIZE + 1;
pub const OUT_REPORT_ID: u8 = 0x02;
pub const IN_REPORT_ID: u8 = 0x01;
pub const FLAG_FIRST: u8 = 0x40;
pub const FLAG_LAST: u8 = 0x80;
pub const CHUNK_SIZE: usize = REPORT_BODY_SIZE - 2;
pub const TRAILER_SIZE: usize = 8;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("at least one HID report is required")]
    Empty,
    #[error("HID report is too short")]
    ShortReport,
    #[error("first HID report has no FIRST flag")]
    MissingFirst,
    #[error("final HID report has no LAST flag")]
    MissingLast,
    #[error("report declares more data than it contains")]
    InvalidLength,
    #[error("logical message is shorter than the QC trailer")]
    MissingTrailer,
    #[error("logical message exceeds the shared QC frame-size limit")]
    TooLarge,
}

pub fn encode(message_type: u16, payload: &[u8]) -> Vec<[u8; REPORT_SIZE]> {
    let mut body = Vec::with_capacity(payload.len() + TRAILER_SIZE);
    body.extend_from_slice(payload);
    body.extend_from_slice(&message_type.to_le_bytes());
    body.extend_from_slice(&[0; TRAILER_SIZE - 2]);

    body.chunks(CHUNK_SIZE)
        .enumerate()
        .map(|(index, chunk)| {
            let mut report = [0_u8; REPORT_SIZE];
            report[0] = OUT_REPORT_ID;
            report[1] = chunk.len() as u8;
            report[2] = (if index == 0 { FLAG_FIRST } else { 0 })
                | (if (index + 1) * CHUNK_SIZE >= body.len() {
                    FLAG_LAST
                } else {
                    0
                });
            report[3..3 + chunk.len()].copy_from_slice(chunk);
            report
        })
        .collect()
}

pub fn is_complete(reports: &[Vec<u8>]) -> Result<bool, FrameError> {
    let Some(last) = reports.last() else {
        return Ok(false);
    };
    if last.len() < 3 {
        return Err(FrameError::ShortReport);
    }
    Ok(last[2] & FLAG_LAST != 0)
}

pub fn decode(reports: &[Vec<u8>]) -> Result<(u16, Vec<u8>), FrameError> {
    if reports.len() > profile::MAX_FRAME_BYTES / CHUNK_SIZE + 1 {
        return Err(FrameError::TooLarge);
    }
    let Some(first) = reports.first() else {
        return Err(FrameError::Empty);
    };
    let Some(last) = reports.last() else {
        return Err(FrameError::Empty);
    };
    if first.len() < 3 || last.len() < 3 {
        return Err(FrameError::ShortReport);
    }
    if first[2] & FLAG_FIRST == 0 {
        return Err(FrameError::MissingFirst);
    }
    if last[2] & FLAG_LAST == 0 {
        return Err(FrameError::MissingLast);
    }

    let mut body = Vec::new();
    for report in reports {
        if report.len() < 3 {
            return Err(FrameError::ShortReport);
        }
        let length = report[1] as usize;
        if length > CHUNK_SIZE || report.len() < 3 + length {
            return Err(FrameError::InvalidLength);
        }
        if body.len().saturating_add(length) > profile::MAX_FRAME_BYTES + TRAILER_SIZE {
            return Err(FrameError::TooLarge);
        }
        body.extend_from_slice(&report[3..3 + length]);
    }
    if body.len() < TRAILER_SIZE {
        return Err(FrameError::MissingTrailer);
    }
    let trailer = body.split_off(body.len() - TRAILER_SIZE);
    Ok((u16::from_le_bytes([trailer[0], trailer[1]]), body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    #[test]
    fn matches_cortex_control_version_read_capture() {
        let expected = hex("020ac008030a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000");
        assert_eq!(encode(10, &[0x08, 0x03])[0].as_slice(), expected.as_slice());
        assert_eq!(decode(&[expected]).unwrap(), (10, vec![0x08, 0x03]));
    }

    #[test]
    fn matches_cortex_control_scene_update_capture() {
        let payload = hex("0801100b1801");
        let expected = hex("020ec00801100b18010d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000");
        assert_eq!(encode(13, &payload)[0].as_slice(), expected.as_slice());
    }

    #[test]
    fn single_report_round_trip() {
        let reports = encode(13, &[8, 1, 24, 3]);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0][0], OUT_REPORT_ID);
        assert_eq!(reports[0][2], FLAG_FIRST | FLAG_LAST);
        let decoded =
            decode(&reports.iter().map(|item| item.to_vec()).collect::<Vec<_>>()).unwrap();
        assert_eq!(decoded, (13, vec![8, 1, 24, 3]));
    }

    #[test]
    fn multi_report_round_trip() {
        let payload = vec![0x5a; CHUNK_SIZE * 3 + 17];
        let reports = encode(51, &payload);
        assert_eq!(reports.len(), 4);
        assert_eq!(reports[0][2], FLAG_FIRST);
        assert_eq!(reports[1][2], 0);
        assert_eq!(reports[3][2], FLAG_LAST);
        let decoded =
            decode(&reports.iter().map(|item| item.to_vec()).collect::<Vec<_>>()).unwrap();
        assert_eq!(decoded, (51, payload));
    }

    #[test]
    fn malformed_sequences_are_rejected() {
        assert_eq!(decode(&[]), Err(FrameError::Empty));
        let mut report = encode(1, &[])[0].to_vec();
        report[2] &= !FLAG_FIRST;
        assert_eq!(decode(&[report]), Err(FrameError::MissingFirst));
    }
}
