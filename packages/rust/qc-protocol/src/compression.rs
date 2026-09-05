use crate::profile;
use flate2::read::GzDecoder;
use std::io::Read;
use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum InflateError {
    #[error("compressed QC payload exceeds the inflated-size limit")]
    Limit,
    #[error("compressed QC payload could not be decoded: {0}")]
    Decode(String),
}

/// Inflate a gzip-wrapped QC payload while enforcing the shared expanded-size
/// limit. Uncompressed payloads are returned unchanged.
pub(crate) fn maybe_gunzip(payload: &[u8]) -> Result<Vec<u8>, InflateError> {
    if !payload.starts_with(&[0x1f, 0x8b]) {
        return Ok(payload.to_vec());
    }
    let mut decoded = Vec::new();
    GzDecoder::new(payload)
        .take(profile::MAX_INFLATED_BYTES as u64 + 1)
        .read_to_end(&mut decoded)
        .map_err(|error| InflateError::Decode(error.to_string()))?;
    if decoded.len() > profile::MAX_INFLATED_BYTES {
        return Err(InflateError::Limit);
    }
    Ok(decoded)
}
