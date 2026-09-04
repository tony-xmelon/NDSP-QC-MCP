//! Minimal protobuf wire inspection used for request correlation before a
//! concrete message type is decoded.

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WireError {
    #[error("truncated protobuf varint")]
    TruncatedVarint,
    #[error("unsupported protobuf wire type {0}")]
    UnsupportedWire(u8),
    #[error("truncated protobuf field")]
    TruncatedField,
}

pub fn varint_field(payload: &[u8], wanted: u32) -> Result<Option<u64>, WireError> {
    let mut offset = 0;
    while offset < payload.len() {
        let tag = read_varint(payload, &mut offset)?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        if field == wanted && wire == 0 {
            return Ok(Some(read_varint(payload, &mut offset)?));
        }
        skip(payload, &mut offset, wire)?;
    }
    Ok(None)
}

fn read_varint(payload: &[u8], offset: &mut usize) -> Result<u64, WireError> {
    let mut value = 0_u64;
    for shift in (0..64).step_by(7) {
        let Some(byte) = payload.get(*offset).copied() else {
            return Err(WireError::TruncatedVarint);
        };
        *offset += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(WireError::TruncatedVarint)
}

fn skip(payload: &[u8], offset: &mut usize, wire: u8) -> Result<(), WireError> {
    let length = match wire {
        0 => {
            read_varint(payload, offset)?;
            return Ok(());
        }
        1 => 8,
        2 => read_varint(payload, offset)? as usize,
        5 => 4,
        other => return Err(WireError::UnsupportedWire(other)),
    };
    if payload.len().saturating_sub(*offset) < length {
        return Err(WireError::TruncatedField);
    }
    *offset += length;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locates_request_id_around_other_wire_types() {
        assert_eq!(
            varint_field(&[0x08, 0x01, 0x12, 0x02, 0xaa, 0xbb, 0x18, 0x2a], 3),
            Ok(Some(42))
        );
        assert_eq!(varint_field(&[0x08, 0x01], 2), Ok(None));
    }
}
