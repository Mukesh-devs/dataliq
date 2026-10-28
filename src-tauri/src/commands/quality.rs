use std::sync::Arc;

use tauri::State;

use crate::engine::{Engine, RequestKey};
use crate::error::{AppError, Result};
use crate::quality::QualityReport;

/// The data quality warnings of dataset `dataset_id`. A newer request in
/// the same `group` (one per tab) cancels this one.
#[tauri::command]
pub async fn data_quality(
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    request_id: Option<String>,
    group: Option<String>,
) -> Result<QualityReport> {
    let engine = Arc::clone(&engine);
    tauri::async_runtime::spawn_blocking(move || {
        let key = RequestKey {
            id: request_id,
            group,
        };
        engine.quality(&dataset_id, &key)
    })
    .await
    .map_err(|e| AppError::Internal(format!("quality task failed: {e}")))?
}
