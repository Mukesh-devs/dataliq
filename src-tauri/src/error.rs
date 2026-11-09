//! Error types. Errors that reach the UI are serialized as
//! `{ "kind": "...", "message": "..." }` with a plain, helpful message.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// A query failed inside DuckDB (syntax error, missing column, bad file…).
    #[error("{0}")]
    Query(String),
    /// The query was cancelled by the user or replaced by a newer request.
    #[error("The query was cancelled.")]
    Cancelled,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("Settings file is invalid: {0}")]
    Settings(String),
    /// Not enough free disk space to import into the cache.
    #[error("Not enough free disk space to import this file: about {} needed, {} free. You can read it directly from the file instead (slower), or free up space.", human(*needed), human(*available))]
    LowDisk { needed: u64, available: u64 },
    /// Not enough free space where an export, a conversion or a sort writes.
    #[error("Not enough free disk space to {what}: about {} needed, {} free{where_}. {fix}", human(*needed), human(*available))]
    NoSpace {
        what: String,
        needed: u64,
        available: u64,
        /// " on the drive of …" (or empty).
        where_: String,
        fix: String,
    },
    /// A query needed more memory than DuckDB may use (and couldn't spill).
    #[error("This needed more memory than DataLiq may use{}. Raise the memory limit in Settings › Memory and speed, filter the rows first, or choose fewer columns.", limit.map(|l| format!(" ({})", human(l))).unwrap_or_default())]
    OutOfMemory { limit: Option<u64> },
    /// The temporary folder filled up while a query used it for data that
    /// didn't fit in memory.
    #[error(
        "The temporary folder ran out of space while this query used the disk for data that didn't fit in memory. Free up space there, choose another temporary folder in Settings › Memory and speed, or raise the memory limit."
    )]
    SpillDiskFull,
    /// Unexpected internal error (a bug). Logged with details.
    #[error("Something went wrong: {0}")]
    Internal(String),
}

impl AppError {
    /// Stable machine-readable kind for the frontend.
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Query(_) => "query",
            AppError::Cancelled => "cancelled",
            AppError::Io(_) => "io",
            AppError::Settings(_) => "settings",
            AppError::LowDisk { .. } => "low-disk",
            AppError::NoSpace { .. } => "no-space",
            AppError::OutOfMemory { .. } => "out-of-memory",
            AppError::SpillDiskFull => "spill-full",
            AppError::Internal(_) => "internal",
        }
    }
}

impl From<duckdb::Error> for AppError {
    fn from(err: duckdb::Error) -> Self {
        engine_error(err.to_string())
    }
}

/// A DuckDB error message as an [`AppError`]: interrupts are cancels, and
/// running out of memory or of temporary disk space get plain words and a fix.
pub fn engine_error(msg: String) -> AppError {
    // DuckDB reports interrupts as "INTERRUPT Error: Interrupted!".
    if msg.contains("Interrupted") {
        return AppError::Cancelled;
    }
    let lower = msg.to_lowercase();
    // DuckDB follows an out-of-memory error with tips that name the
    // temporary folder; what happened is said on the first line.
    let first = lower.lines().next().unwrap_or_default();
    if lower.contains("no space left on device") || first.contains("max_temp_directory_size") {
        return AppError::SpillDiskFull;
    }
    if first.contains("out of memory error") {
        return AppError::OutOfMemory {
            limit: memory_limit_in(&msg),
        };
    }
    AppError::Query(msg)
}

/// The limit in DuckDB's "(6.9 GiB/7.4 GiB used)".
fn memory_limit_in(msg: &str) -> Option<u64> {
    let end = msg.find(" used)")?;
    let start = msg[..end].rfind('/')? + 1;
    crate::engine::parse_size(&msg[start..end])
}

impl From<arrow::error::ArrowError> for AppError {
    fn from(err: arrow::error::ArrowError) -> Self {
        AppError::Internal(format!("Arrow encoding failed: {err}"))
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

fn human(bytes: u64) -> String {
    let gb = bytes as f64 / (1u64 << 30) as f64;
    if gb >= 1.0 {
        format!("{gb:.1} GB")
    } else {
        format!("{:.0} MB", bytes as f64 / (1u64 << 20) as f64)
    }
}

pub type Result<T, E = AppError> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_out_of_memory_or_temp_space_reads_plainly() {
        let e = engine_error(
            "Out of Memory Error: failed to allocate data of size 16.0 MiB (6.9 GiB/7.4 GiB used)"
                .into(),
        );
        assert_eq!(e.kind(), "out-of-memory");
        assert!(e.to_string().contains("(7.4 GB)"), "{e}");
        assert!(e.to_string().contains("Settings › Memory and speed"));
        let e = engine_error("Out of Memory Error: could not allocate block".into());
        assert!(matches!(e, AppError::OutOfMemory { limit: None }));
        assert!(!e.to_string().contains("()"));
        for raw in [
            "IO Error: Could not write file \"/tmp/x.block\": No space left on device",
            "Out of Memory Error: failed to offload data block (7 GiB/7 GiB used). This limit was \
             set by the 'max_temp_directory_size' setting.",
        ] {
            assert_eq!(engine_error(raw.into()).kind(), "spill-full", "{raw}");
        }
        assert!(matches!(
            engine_error("INTERRUPT Error: Interrupted!".into()),
            AppError::Cancelled
        ));
        assert_eq!(engine_error("Binder Error: x".into()).kind(), "query");
    }

    #[test]
    fn serializes_kind_and_message() {
        let json = serde_json::to_string(&AppError::Query("no such table: x".into())).unwrap();
        assert_eq!(json, r#"{"kind":"query","message":"no such table: x"}"#);
        let json = serde_json::to_string(&AppError::Cancelled).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"cancelled","message":"The query was cancelled."}"#
        );
    }
}
