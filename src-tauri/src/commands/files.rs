use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;
use tauri::ipc::Response;

use crate::engine::{Engine, RequestKey};
use crate::error::{AppError, Result};
use crate::sources::{OpenOptions, Source, SourceInfo};

/// Rows shown in the instant preview.
pub const PREVIEW_ROWS: usize = 1000;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("task failed: {e}")))?
}

/// Detects the format, sniffs CSV settings and lists the columns.
#[tauri::command]
pub async fn open_file(
    engine: State<'_, Arc<Engine>>,
    path: PathBuf,
    options: Option<OpenOptions>,
) -> Result<SourceInfo> {
    let engine = Arc::clone(&engine);
    blocking(move || {
        Source::new(&path, options.unwrap_or_default())?
            .resolve_dialect(&engine)?
            .inspect(&engine)
    })
    .await
}

/// First rows read straight from the file (no import), as Arrow IPC bytes.
#[tauri::command]
pub async fn preview_file(
    engine: State<'_, Arc<Engine>>,
    path: PathBuf,
    options: Option<OpenOptions>,
    request_id: Option<String>,
) -> Result<Response> {
    let engine = Arc::clone(&engine);
    let key = RequestKey {
        group: Some(format!("preview:{}", path.display())),
        id: request_id,
    };
    let bytes = blocking(move || {
        Source::new(&path, options.unwrap_or_default())?
            .resolve_dialect(&engine)?
            .preview_ipc(&engine, PREVIEW_ROWS, &key)
    })
    .await?;
    Ok(Response::new(bytes))
}
