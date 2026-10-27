use std::sync::Arc;

use tauri::State;

use crate::chart::{ChartData, ChartSpec};
use crate::engine::{Engine, RequestKey};
use crate::error::{AppError, Result};
use crate::view::ViewSpec;

/// A chart of the view `spec` on dataset `dataset_id`. A newer request in
/// the same `group` (one per tab) cancels this one.
#[tauri::command]
pub async fn chart_data(
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    spec: ViewSpec,
    chart: ChartSpec,
    request_id: Option<String>,
    group: Option<String>,
) -> Result<ChartData> {
    let engine = Arc::clone(&engine);
    tauri::async_runtime::spawn_blocking(move || {
        let key = RequestKey {
            id: request_id,
            group,
        };
        engine.chart_data(&dataset_id, &spec, &chart, &key)
    })
    .await
    .map_err(|e| AppError::Internal(format!("task failed: {e}")))?
}
