use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::engine::Engine;
use crate::error::{AppError, Result};
use crate::export::convert::{self, ConvertOutcome, ConvertRequest, DataFile};
use crate::export::{self, ExportOutcome, ExportRequest, Exports};

/// Writes a view to a file. Emits `export-progress` events tagged with
/// `job_id`.
#[tauri::command]
pub async fn export_view(
    app: AppHandle,
    engine: State<'_, Arc<Engine>>,
    exports: State<'_, Arc<Exports>>,
    request: ExportRequest,
    job_id: String,
) -> Result<ExportOutcome> {
    let engine = Arc::clone(&engine);
    let exports = Arc::clone(&exports);
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |p| {
            let _ = app.emit("export-progress", p);
        };
        let out = export::export(&engine, &exports, &request, &job_id, &emit);
        if let Err(e) = engine.release_memory() {
            tracing::warn!("could not release memory after export: {e}");
        }
        out
    })
    .await
    .map_err(|e| AppError::Internal(format!("task failed: {e}")))?
}

#[tauri::command]
pub fn cancel_export(exports: State<'_, Arc<Exports>>, job_id: String) -> bool {
    exports.cancel(&job_id)
}

/// The data files of a folder that can be converted.
#[tauri::command]
pub fn list_data_files(folder: std::path::PathBuf) -> Result<Vec<DataFile>> {
    convert::list_data_files(&folder)
}

/// Converts files to another format, one after another. Emits
/// `convert-progress` events tagged with `job_id`; cancel with
/// `cancel_export`.
#[tauri::command]
pub async fn convert_files(
    app: AppHandle,
    engine: State<'_, Arc<Engine>>,
    exports: State<'_, Arc<Exports>>,
    request: ConvertRequest,
    job_id: String,
) -> Result<ConvertOutcome> {
    let engine = Arc::clone(&engine);
    let exports = Arc::clone(&exports);
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |p| {
            let _ = app.emit("convert-progress", p);
        };
        let out = convert::convert(&engine, &exports, &request, &job_id, &emit);
        if let Err(e) = engine.release_memory() {
            tracing::warn!("could not release memory after converting: {e}");
        }
        out
    })
    .await
    .map_err(|e| AppError::Internal(format!("task failed: {e}")))?
}
