use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::commands::view::ViewReady;
use crate::compare::{CompareSpec, Comparison};
use crate::engine::{Engine, RequestKey};
use crate::error::{AppError, Result};

/// Compares dataset `left_id` (the old version) with `right_id` by the
/// key columns: the differing rows as a new dataset (written to a session
/// table in the background, announced with `view-ready`) and the counts.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn compare_files(
    app: AppHandle,
    engine: State<'_, Arc<Engine>>,
    left_id: String,
    right_id: String,
    spec: CompareSpec,
    request_id: Option<String>,
    group: Option<String>,
) -> Result<Comparison> {
    let started = std::time::Instant::now();
    let engine = Arc::clone(&engine);
    let key = RequestKey {
        id: request_id,
        group,
    };
    let out = {
        let engine = Arc::clone(&engine);
        tauri::async_runtime::spawn_blocking(move || {
            engine.compare(&left_id, &right_id, &spec, &key)
        })
        .await
        .map_err(|e| AppError::Internal(format!("compare task failed: {e}")))??
    };
    let id = out.dataset.id.clone();
    tauri::async_runtime::spawn_blocking(move || match engine.materialize_view(&id) {
        Ok(true) => {
            let ready = ViewReady {
                dataset_id: id,
                elapsed_ms: started.elapsed().as_millis() as u64,
            };
            let _ = app.emit("view-ready", ready);
            if let Err(e) = engine.release_memory() {
                tracing::warn!("could not release memory after a comparison: {e}");
            }
        }
        Ok(false) | Err(AppError::Cancelled) => {}
        Err(e) => tracing::warn!("could not write comparison {id}: {e}"),
    });
    Ok(out)
}

/// The comparison's differing rows as one query over both files' readers.
#[tauri::command]
pub fn compare_sql(
    engine: State<'_, Arc<Engine>>,
    left_id: String,
    right_id: String,
    spec: CompareSpec,
    left_reader: String,
    right_reader: String,
) -> Result<String> {
    engine.compare_sql(&left_id, &right_id, &spec, &left_reader, &right_reader)
}
