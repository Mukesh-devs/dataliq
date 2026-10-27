use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::engine::Engine;
use crate::error::{AppError, Result};
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
