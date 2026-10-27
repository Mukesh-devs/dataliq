use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::engine::{Engine, RequestKey};
use crate::error::{AppError, Result};
use crate::view::{ColumnHistogram, ColumnProfile, OpenedView, ValueList, ViewSpec};

/// Sent as `view-ready` when a view has been written out in full (all its
/// pages are fast; a sorted view's middle rows are available).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewReady {
    pub dataset_id: String,
    /// Time from the open_view call until the full view was written.
    pub elapsed_ms: u64,
}

/// Opens a filtered/sorted view of a dataset as a new pageable dataset.
/// A newer request in the same `group` (one per tab) cancels an older one.
/// Views that still need writing out finish in the background and announce
/// it with a `view-ready` event.
#[tauri::command]
pub async fn open_view(
    app: AppHandle,
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    spec: ViewSpec,
    request_id: Option<String>,
    group: Option<String>,
) -> Result<OpenedView> {
    let started = std::time::Instant::now();
    let engine = Arc::clone(&engine);
    let key = RequestKey {
        id: request_id,
        group,
    };
    let view = {
        let engine = Arc::clone(&engine);
        tauri::async_runtime::spawn_blocking(move || engine.open_view(&dataset_id, &spec, &key))
            .await
            .map_err(|e| AppError::Internal(format!("view task failed: {e}")))??
    };
    if view.materializing {
        let id = view.dataset.id.clone();
        tauri::async_runtime::spawn_blocking(move || match engine.materialize_view(&id) {
            Ok(true) => {
                let ready = ViewReady {
                    dataset_id: id,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                };
                let _ = app.emit("view-ready", ready);
            }
            // Closed or replaced meanwhile.
            Ok(false) | Err(AppError::Cancelled) => {}
            Err(e) => tracing::warn!("could not write view {id}: {e}"),
        });
    }
    Ok(view)
}

/// The most frequent values of a column under the view's other filters.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn column_values(
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    spec: ViewSpec,
    column: String,
    search: Option<String>,
    limit: Option<usize>,
    request_id: Option<String>,
    group: Option<String>,
) -> Result<ValueList> {
    let engine = Arc::clone(&engine);
    let key = RequestKey {
        id: request_id,
        group,
    };
    tauri::async_runtime::spawn_blocking(move || {
        engine.column_values(
            &dataset_id,
            &spec,
            &column,
            search.as_deref(),
            limit.unwrap_or(200),
            &key,
        )
    })
    .await
    .map_err(|e| AppError::Internal(format!("values task failed: {e}")))?
}

/// Statistics, histogram and top values of one column over a view.
#[tauri::command]
pub async fn column_profile(
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    spec: ViewSpec,
    column: String,
    request_id: Option<String>,
    group: Option<String>,
) -> Result<ColumnProfile> {
    let engine = Arc::clone(&engine);
    let key = RequestKey {
        id: request_id,
        group,
    };
    tauri::async_runtime::spawn_blocking(move || {
        engine.column_profile(&dataset_id, &spec, &column, &key)
    })
    .await
    .map_err(|e| AppError::Internal(format!("profile task failed: {e}")))?
}

/// Small histograms for the grid headers (numbers, dates, booleans).
#[tauri::command]
pub async fn column_histograms(
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    spec: ViewSpec,
    columns: Vec<String>,
    request_id: Option<String>,
    group: Option<String>,
) -> Result<Vec<ColumnHistogram>> {
    let engine = Arc::clone(&engine);
    let key = RequestKey {
        id: request_id,
        group,
    };
    tauri::async_runtime::spawn_blocking(move || {
        engine.column_histograms(&dataset_id, &spec, &columns, &key)
    })
    .await
    .map_err(|e| AppError::Internal(format!("histogram task failed: {e}")))?
}

/// The view as SQL that runs on its own in DuckDB ("Copy as SQL"): over
/// `reader` (the file's reader call, from its info), with the shown columns
/// under their display names (`labels`) and every value inlined.
#[tauri::command]
pub fn view_sql(
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    spec: ViewSpec,
    reader: String,
    labels: HashMap<String, String>,
) -> Result<String> {
    engine.view_sql(&dataset_id, &spec, &reader, &labels)
}
