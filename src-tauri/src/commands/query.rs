use std::sync::Arc;

use serde::Deserialize;
use tauri::State;
use tauri::ipc::Response;

use crate::engine::{Engine, Param, RequestKey};
use crate::error::{AppError, Result};

/// Hard cap on rows returned by one `run_query` call. The grid pages data, so
/// a single response never needs more than this.
pub const MAX_ROWS_CAP: usize = 100_000;

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct QueryOptions {
    pub params: Vec<Param>,
    pub max_rows: Option<usize>,
    pub request_id: Option<String>,
    pub group: Option<String>,
    /// Run on the SQL panel's session connection (temp tables and `SET`
    /// carry over between statements). No parameters.
    pub session: bool,
}

/// Runs SQL and returns the result as raw Arrow IPC stream bytes.
#[tauri::command]
pub async fn run_query(
    engine: State<'_, Arc<Engine>>,
    sql: String,
    options: Option<QueryOptions>,
) -> Result<Response> {
    let engine = Arc::clone(&engine);
    let opts = options.unwrap_or_default();
    let max_rows = opts.max_rows.unwrap_or(10_000).min(MAX_ROWS_CAP);
    let key = RequestKey {
        id: opts.request_id,
        group: opts.group,
    };
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        if opts.session {
            engine.query_ipc_session(&sql, max_rows, &key)
        } else {
            engine.query_ipc(&sql, &opts.params, max_rows, &key)
        }
    })
    .await
    .map_err(|e| AppError::Internal(format!("query task failed: {e}")))??;
    Ok(Response::new(bytes))
}

/// Rows `[start, start + count)` of an open dataset as Arrow IPC bytes.
#[tauri::command]
pub async fn fetch_rows(
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    start: u64,
    count: u64,
    request_id: Option<String>,
) -> Result<Response> {
    let engine = Arc::clone(&engine);
    let key = RequestKey {
        id: request_id,
        group: None,
    };
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        engine.fetch_rows(&dataset_id, start, count, &key)
    })
    .await
    .map_err(|e| AppError::Internal(format!("query task failed: {e}")))??;
    Ok(Response::new(bytes))
}

/// Cancels a running request by id. Returns whether it was running.
#[tauri::command]
pub fn cancel_query(engine: State<'_, Arc<Engine>>, request_id: String) -> bool {
    engine.cancel(&request_id)
}
