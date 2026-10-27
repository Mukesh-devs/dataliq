use std::sync::Arc;

use tauri::State;

use crate::engine::{Engine, RequestKey};
use crate::error::{AppError, Result};
use crate::view::{OpenedView, ValueList, ViewSpec};

/// Opens a filtered/sorted view of a dataset as a new pageable dataset.
/// A newer request in the same `group` (one per tab) cancels an older one.
#[tauri::command]
pub async fn open_view(
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    spec: ViewSpec,
    request_id: Option<String>,
    group: Option<String>,
) -> Result<OpenedView> {
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
        // Deep pages of a filtered view get fast once it is written out.
        let id = view.dataset.id.clone();
        tauri::async_runtime::spawn_blocking(move || match engine.materialize_view(&id) {
            Ok(_) | Err(AppError::Cancelled) => {}
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
