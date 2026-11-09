use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, State};

use crate::commands::import::ImportState;
use crate::engine::{Engine, RequestKey};
use crate::error::{AppError, Result};
use crate::open;
use crate::sources::{OpenOptions, SourceInfo};

/// Rows shown in the instant preview.
pub const PREVIEW_ROWS: usize = 1000;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("task failed: {e}")))?
}

/// Detects the format, sniffs CSV settings and lists the columns. A file
/// imported before comes back from the cache with its data ready; it is
/// then checked for edits in the background (`source-changed` if edited).
#[tauri::command]
pub async fn open_file(
    app: AppHandle,
    engine: State<'_, Arc<Engine>>,
    state: State<'_, Arc<ImportState>>,
    path: PathBuf,
    options: Option<OpenOptions>,
) -> Result<SourceInfo> {
    let engine = Arc::clone(&engine);
    let state = Arc::clone(&state);
    blocking(move || {
        let cache_state = Arc::clone(&state);
        open::info_then(
            &engine,
            &state.cache,
            &path,
            options.unwrap_or_default(),
            move |reopened| {
                std::thread::spawn(move || {
                    reopened.verify(&cache_state.cache, || {
                        let _ = app.emit("source-changed", &reopened.info.path);
                    });
                });
            },
        )
    })
    .await
}

/// First rows (from the cache, or read straight from the file), as Arrow IPC bytes.
#[tauri::command]
pub async fn preview_file(
    engine: State<'_, Arc<Engine>>,
    state: State<'_, Arc<ImportState>>,
    path: PathBuf,
    options: Option<OpenOptions>,
    request_id: Option<String>,
) -> Result<Response> {
    let engine = Arc::clone(&engine);
    let state = Arc::clone(&state);
    let key = RequestKey {
        group: Some(format!("preview:{}", path.display())),
        id: request_id,
    };
    let bytes = blocking(move || {
        open::preview(
            &engine,
            &state.cache,
            &path,
            options.unwrap_or_default(),
            &key,
        )
    })
    .await?;
    Ok(Response::new(bytes))
}
