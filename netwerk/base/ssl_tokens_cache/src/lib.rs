/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use log::warn;
use nsstring::nsCString;
use rustc_hash::FxHashSet as HashSet;
use serde::{Deserialize, Serialize};
use static_assertions::const_assert;
use std::ffi::c_void;
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::sync::Mutex;

/// Callback type for [`ssl_tokens_cache_read`].
pub type SslTokensReadCallback =
    unsafe extern "C" fn(ctx: *mut c_void, record: *const SslTokensPersistedRecordFfi);

/// FFI-safe representation of one persisted token record.
/// Cert chain data is excluded — see `PersistedRecord` for rationale.
#[repr(C)]
pub struct SslTokensPersistedRecordFfi {
    pub id: u64,
    pub key: nsCString,
    pub expiration_time: PrTime,
    pub token: *const u8,
    pub token_len: usize,
    pub ev_status: u8,
    pub ct_status: u16,
    pub overridable_error: u8,
}

/// Certificate chain fields (`server_cert`, `succeeded_chain`,
/// `handshake_certs`) are intentionally excluded — a new TLS handshake
/// delivers fresh cert data, so the storage cost (~8–10 KB
/// per record) is not worthwhile.
#[derive(Clone, Serialize, Deserialize)]
#[expect(
    clippy::unsafe_derive_deserialize,
    reason = "from_ffi is unrelated to deserialization"
)]
struct PersistedRecord {
    id: u64,
    key: Vec<u8>,
    expiration_time: PrTime,
    token: Vec<u8>,
    ev_status: u8,
    ct_status: u16,
    overridable_error: u8,
}

impl PersistedRecord {
    /// Constructs a `PersistedRecord` from an FFI struct, ignoring cert chains.
    ///
    /// # Safety
    ///
    /// `token` must be valid for `token_len` bytes.
    unsafe fn from_ffi(ffi: &SslTokensPersistedRecordFfi) -> Self {
        let key = ffi.key.as_ref().to_vec();
        // SAFETY: token is valid for token_len bytes.
        let token = unsafe { std::slice::from_raw_parts(ffi.token, ffi.token_len) }.to_vec();
        Self {
            id: ffi.id,
            key,
            expiration_time: ffi.expiration_time,
            token,
            ev_status: ffi.ev_status,
            ct_status: ffi.ct_status,
            overridable_error: ffi.overridable_error,
        }
    }

    /// Constructs a stack-allocated `SslTokensPersistedRecordFfi` that borrows
    /// from `self` and passes it to `f`. The FFI struct must not escape `f`.
    fn with_ffi<F: FnOnce(&SslTokensPersistedRecordFfi)>(&self, f: F) {
        let ffi = SslTokensPersistedRecordFfi {
            id: self.id,
            key: nsCString::from(&self.key[..]),
            expiration_time: self.expiration_time,
            token: self.token.as_ptr(),
            token_len: self.token.len(),
            ev_status: self.ev_status,
            ct_status: self.ct_status,
            overridable_error: self.overridable_error,
        };
        f(&ffi);
    }
}

struct SslTokensState {
    records: Vec<PersistedRecord>,
}

static STATE: Mutex<SslTokensState> = Mutex::new(SslTokensState {
    records: Vec::new(),
});

/// Microseconds since the Unix epoch, matching the C++ `PRTime` type.
type PrTime = i64;

const MAGIC: [u8; 4] = *b"STCF";
const VERSION: u8 = 1;
/// Derived from the header layout: magic(4) + version(1).
/// Integrity is provided by the Adler-32 embedded in the zlib stream.
const HEADER_SIZE: usize = MAGIC.len() + size_of::<u8>();
const_assert!(HEADER_SIZE == 5);
/// Maximum allowed size for the compressed body and decompressed payload.
const MAX_PAYLOAD_SIZE: usize = 16 * 1024 * 1024;

#[derive(Debug)]
enum ParseError {
    BadMagic,
    BadVersion,
    Truncated,
}

fn to_file_bytes(records: &[PersistedRecord], magic: [u8; 4]) -> Vec<u8> {
    let record_bytes = bincode::serialize(records).unwrap_or_default();
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    _ = enc.write_all(&record_bytes);
    let body = enc.finish().unwrap_or_default();
    let mut out = Vec::with_capacity(HEADER_SIZE + body.len());
    out.extend_from_slice(&magic);
    out.push(VERSION);
    out.extend_from_slice(&body);
    out
}

fn from_file_bytes(
    data: &[u8],
    expected_magic: [u8; 4],
) -> Result<Vec<PersistedRecord>, ParseError> {
    // Destructure the fixed header in one slice pattern — avoids repeated indexing.
    let Some(([magic @ .., version], body)) = data.split_first_chunk::<HEADER_SIZE>() else {
        return Err(ParseError::Truncated);
    };
    if magic != &expected_magic {
        return Err(ParseError::BadMagic);
    }
    if *version != VERSION {
        return Err(ParseError::BadVersion);
    }
    // Reject implausibly large compressed bodies before allocating.
    if body.len() > MAX_PAYLOAD_SIZE {
        return Err(ParseError::Truncated);
    }
    // ZlibDecoder verifies the Adler-32 checksum embedded in the zlib stream.
    let mut record_bytes = Vec::new();
    ZlibDecoder::new(body)
        .take(MAX_PAYLOAD_SIZE as u64 + 1)
        .read_to_end(&mut record_bytes)
        .map_err(|_| ParseError::Truncated)?;
    if record_bytes.len() > MAX_PAYLOAD_SIZE {
        return Err(ParseError::Truncated);
    }
    bincode::deserialize::<Vec<PersistedRecord>>(&record_bytes).map_err(|_| ParseError::Truncated)
}

/// Reads `bin_path`, falling back to `bin_path.with_extension("tmp")` if the
/// canonical file is absent (crash-mid-rename recovery). Discards a stale .tmp
/// when the .bin is present. Returns `(data, loaded_from_tmp)` or `None`.
fn read_file_with_tmp_fallback(bin_path: &Path) -> Option<(Vec<u8>, bool)> {
    let tmp_path = bin_path.with_extension("tmp");
    std::fs::read(bin_path)
        .map(|data| {
            _ = std::fs::remove_file(&tmp_path);
            (data, false)
        })
        .or_else(|_| std::fs::read(&tmp_path).map(|data| (data, true)))
        .ok()
}

fn write_atomically(buf: &[u8], bin_path: &Path) -> std::io::Result<()> {
    let tmp_path = bin_path.with_extension("tmp");
    let mut f = std::fs::File::create(&tmp_path)?;
    f.write_all(buf)?;
    f.sync_all()?;
    std::fs::rename(tmp_path, bin_path)
}

/// Builds a `HashSet` from a raw `(ptr, count)` pair.
///
/// # Safety
///
/// `ids` must point to `count` valid `u64` values if `count > 0`.
unsafe fn id_set_from_raw(ids: *const u64, count: usize) -> HashSet<u64> {
    if count == 0 {
        return HashSet::default();
    }
    // SAFETY: ids points to count valid u64 values.
    unsafe { std::slice::from_raw_parts(ids, count) }
        .iter()
        .copied()
        .collect()
}

/// Calls `callback` for each non-expired record, passing a stack-allocated FFI
/// struct. The pointer passed to the callback is only valid during the call.
///
/// # Safety
///
/// `callback` must be a valid function pointer. `ctx` must remain valid for the
/// duration of this call.
unsafe fn dispatch_records(
    records: &[PersistedRecord],
    now: PrTime,
    callback: SslTokensReadCallback,
    ctx: *mut c_void,
) {
    for rec in records.iter().filter(|r| r.expiration_time > now) {
        // SAFETY: callback is a valid function pointer and ctx is caller-managed.
        rec.with_ffi(|ffi| unsafe { callback(ctx, &raw const *ffi) });
    }
}

fn with_state<F: FnOnce(&mut SslTokensState)>(f: F) {
    if let Ok(mut state) = STATE.lock() {
        f(&mut state);
    }
}

/// Appends a record to the in-memory shadow copy.
///
/// # Safety
///
/// All pointer fields in `record` must be valid for their associated length
/// fields for the duration of this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ssl_tokens_cache_append(record: *const SslTokensPersistedRecordFfi) {
    // SAFETY: caller guarantees record and all pointer fields are valid.
    let rec = unsafe { PersistedRecord::from_ffi(&*record) };
    with_state(|state| state.records.push(rec));
}

/// Filters to `valid_ids`, serializes, and writes to disk atomically.
///
/// # Safety
///
/// If `valid_id_count > 0`, `valid_ids` must point to `valid_id_count` valid
/// `u64` values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ssl_tokens_cache_write(
    path: &nsCString,
    valid_ids: *const u64,
    valid_id_count: usize,
) {
    let Ok(path_str) = std::str::from_utf8(path.as_ref()) else {
        return;
    };

    // SAFETY: valid_ids points to valid_id_count valid u64 values.
    let ids = unsafe { id_set_from_raw(valid_ids, valid_id_count) };

    // Serialize while holding the lock (fast, no I/O), then write outside it.
    let buf = {
        let Ok(state) = STATE.lock() else { return };
        to_file_bytes(
            &state
                .records
                .iter()
                .filter(|r| ids.contains(&r.id))
                .cloned()
                .collect::<Vec<_>>(),
            MAGIC,
        )
    };

    if let Err(e) = write_atomically(&buf, Path::new(path_str)) {
        warn!("SslTokensCache: write failed: {e}");
    }
}

/// Reads the persisted file and calls `callback` for each valid record.
///
/// # Safety
///
/// `callback` must be a valid function pointer. `ctx` must remain valid for
/// the duration of this call. The `callback` is invoked with a pointer to a
/// stack-allocated FFI struct; the pointer is only valid inside the callback.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ssl_tokens_cache_read(
    path: &nsCString,
    now: PrTime,
    callback: SslTokensReadCallback,
    ctx: *mut c_void,
) {
    let Ok(path_str) = std::str::from_utf8(path.as_ref()) else {
        return;
    };

    let bin_path = Path::new(path_str);
    let Some((data, loaded_from_tmp)) = read_file_with_tmp_fallback(bin_path) else {
        return;
    };

    let records = match from_file_bytes(&data, MAGIC) {
        Ok(r) => r,
        Err(e) => {
            let bad = if loaded_from_tmp {
                bin_path.with_extension("tmp")
            } else {
                bin_path.to_path_buf()
            };
            warn!(
                "SslTokensCache: parse error ({e:?}), discarding {}",
                bad.display()
            );
            _ = std::fs::remove_file(&bad);
            return;
        }
    };

    if loaded_from_tmp {
        _ = std::fs::rename(bin_path.with_extension("tmp"), bin_path);
    }

    // SAFETY: callback and ctx are valid for the duration of this call.
    unsafe {
        dispatch_records(&records, now, callback, ctx);
    }
}

/// Removes the record with the given `id` from the in-memory shadow.
///
/// Called when a token is consumed by `Get()` or evicted, to keep the shadow
/// in sync without waiting for the next write.
///
/// # Safety
///
/// This function is safe to call from any thread with no preconditions.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ssl_tokens_cache_remove(id: u64) {
    with_state(|state| state.records.retain(|r| r.id != id));
}

/// Clears all in-memory state.
///
/// # Safety
///
/// This function is safe to call from any thread with no preconditions.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ssl_tokens_cache_clear() {
    with_state(|state| state.records.clear());
}

/// Retains only records whose id is in `valid_ids`, discarding the rest.
///
/// Called after `RemoveByOriginAttributesPattern` to keep the shadow in sync
/// with the C++ cache for all origin-attribute dimensions, not just partitionKey.
///
/// # Safety
///
/// `valid_ids` must point to `valid_id_count` valid `u64` values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ssl_tokens_cache_retain_only(
    valid_ids: *const u64,
    valid_id_count: usize,
) {
    // SAFETY: valid_ids points to valid_id_count valid u64 values.
    let ids = unsafe { id_set_from_raw(valid_ids, valid_id_count) };
    with_state(|state| state.records.retain(|r| ids.contains(&r.id)));
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn make_record(id: u64, key: &str, token: &[u8], expiration_time: i64) -> PersistedRecord {
        PersistedRecord {
            id,
            key: key.as_bytes().to_vec(),
            expiration_time,
            token: token.to_vec(),
            ev_status: 0,
            ct_status: 0,
            overridable_error: 0,
        }
    }

    // --- to_file_bytes / from_file_bytes ---

    #[test]
    fn round_trip_empty() {
        let records = from_file_bytes(&to_file_bytes(&[], MAGIC), MAGIC).expect("valid file bytes");
        assert!(records.is_empty());
    }

    #[test]
    fn round_trip_records() {
        let input = vec![
            make_record(1, "example.com:443", b"token1", i64::MAX),
            make_record(2, "other.net:443", b"tok2", 9999),
        ];
        let output =
            from_file_bytes(&to_file_bytes(&input, MAGIC), MAGIC).expect("valid file bytes");
        assert_eq!(output.len(), 2);
        assert_eq!(output[0].key, b"example.com:443");
        assert_eq!(output[0].token, b"token1");
        assert_eq!(output[1].id, 2);
    }

    #[test]
    fn bad_magic() {
        let bytes = to_file_bytes(&[], MAGIC);
        assert!(matches!(
            from_file_bytes(&bytes, *b"XXXX"),
            Err(ParseError::BadMagic)
        ));
    }

    #[test]
    fn bad_version() {
        let mut bytes = to_file_bytes(&[], MAGIC);
        bytes[4] = VERSION.wrapping_add(1);
        assert!(matches!(
            from_file_bytes(&bytes, MAGIC),
            Err(ParseError::BadVersion)
        ));
    }

    #[test]
    fn corrupt_body() {
        // Corrupt the last byte of the zlib body — zlib's Adler-32 detects it.
        let mut bytes = to_file_bytes(&[], MAGIC);
        *bytes.last_mut().expect("non-empty") ^= 0xFF;
        assert!(matches!(
            from_file_bytes(&bytes, MAGIC),
            Err(ParseError::Truncated)
        ));
    }

    #[test]
    fn truncated() {
        assert!(matches!(
            from_file_bytes(&[0u8; 4], MAGIC),
            Err(ParseError::Truncated)
        ));
    }

    // --- read_file_with_tmp_fallback ---

    #[test]
    fn fallback_bin_exists() -> TestResult {
        let dir = tempfile::tempdir()?;
        let bin = dir.path().join("cache.bin");
        let tmp_path = dir.path().join("cache.tmp");
        std::fs::write(&bin, b"bin")?;
        std::fs::write(&tmp_path, b"tmp")?;

        let (data, from_tmp) = read_file_with_tmp_fallback(&bin).expect("bin present");
        assert_eq!(data, b"bin");
        assert!(!from_tmp);
        assert!(!tmp_path.exists()); // stale .tmp deleted
        Ok(())
    }

    #[test]
    fn fallback_only_tmp_exists() -> TestResult {
        let dir = tempfile::tempdir()?;
        let bin = dir.path().join("cache.bin");
        std::fs::write(bin.with_extension("tmp"), b"recovered")?;

        let (data, from_tmp) = read_file_with_tmp_fallback(&bin).expect("tmp present");
        assert_eq!(data, b"recovered");
        assert!(from_tmp);
        Ok(())
    }

    #[test]
    fn fallback_neither_exists() -> TestResult {
        let dir = tempfile::tempdir()?;
        assert!(read_file_with_tmp_fallback(&dir.path().join("cache.bin")).is_none());
        Ok(())
    }

    // --- write_atomically ---

    #[test]
    fn write_atomically_leaves_no_tmp() -> TestResult {
        let dir = tempfile::tempdir()?;
        let bin = dir.path().join("cache.bin");
        write_atomically(b"hello", &bin)?;
        assert_eq!(std::fs::read(&bin)?, b"hello");
        assert!(!bin.with_extension("tmp").exists());
        Ok(())
    }

    #[test]
    fn write_atomically_round_trip_with_fallback() -> TestResult {
        let dir = tempfile::tempdir()?;
        let bin = dir.path().join("cache.bin");
        let records = vec![make_record(1, "a.com:443", b"tok", i64::MAX)];
        write_atomically(&to_file_bytes(&records, MAGIC), &bin)?;
        let (data, from_tmp) = read_file_with_tmp_fallback(&bin).expect("bin present");
        assert!(!from_tmp);
        let out = from_file_bytes(&data, MAGIC).expect("valid file bytes");
        assert_eq!(out[0].key, b"a.com:443");
        Ok(())
    }
}
