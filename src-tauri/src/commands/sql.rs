use std::sync::Arc;

use tauri::State;

use crate::engine::{Dataset, Engine, RequestKey};
use crate::error::{AppError, Result};

/// Makes an open dataset queryable in the SQL panel as `name`.
#[tauri::command]
pub fn register_table(
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    name: String,
) -> Result<()> {
    engine.register_table(&dataset_id, &name)
}

/// Removes a table name from the SQL panel.
#[tauri::command]
pub fn unregister_table(engine: State<'_, Arc<Engine>>, name: String) -> Result<()> {
    engine.unregister_table(&name)
}

/// Runs a query in the SQL panel's session and returns its rows as a
/// pageable dataset (close it with `close_dataset`).
#[tauri::command]
pub async fn sql_result(
    engine: State<'_, Arc<Engine>>,
    sql: String,
    request_id: Option<String>,
) -> Result<Dataset> {
    let engine = Arc::clone(&engine);
    let key = RequestKey {
        id: request_id,
        group: Some("sql".into()),
    };
    tauri::async_runtime::spawn_blocking(move || engine.sql_result(&sql, &key))
        .await
        .map_err(|e| AppError::Internal(format!("SQL task failed: {e}")))?
}
