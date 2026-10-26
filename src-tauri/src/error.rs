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
            AppError::Internal(_) => "internal",
        }
    }
}

impl From<duckdb::Error> for AppError {
    fn from(err: duckdb::Error) -> Self {
        let msg = err.to_string();
        // DuckDB reports interrupts as "INTERRUPT Error: Interrupted!".
        if msg.contains("Interrupted") {
            AppError::Cancelled
        } else {
            AppError::Query(msg)
        }
    }
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

pub type Result<T, E = AppError> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;

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
