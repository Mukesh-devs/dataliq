use std::sync::Arc;

use tauri::State;

use crate::connect::{self, ConnectRequest, Connected, Connections, LiveTable, SavedConnection};
use crate::engine::Engine;
use crate::error::{AppError, Result};

/// Saved database connections (without passwords) and whether each is attached.
#[tauri::command]
pub fn list_connections(saved: State<'_, Arc<Connections>>) -> Vec<SavedConnection> {
    saved.list()
}

/// Attaches a MySQL or PostgreSQL database read-only and lists its tables.
#[tauri::command]
pub async fn connect_database(
    engine: State<'_, Arc<Engine>>,
    saved: State<'_, Arc<Connections>>,
    request: ConnectRequest,
) -> Result<Connected> {
    let (engine, saved) = (Arc::clone(&engine), Arc::clone(&saved));
    tauri::async_runtime::spawn_blocking(move || connect::connect(&engine, &saved, &request))
        .await
        .map_err(|e| AppError::Internal(format!("connect task failed: {e}")))?
}

/// The tables of an attached database, again (they may have changed).
#[tauri::command]
pub async fn live_tables(engine: State<'_, Arc<Engine>>, name: String) -> Result<Vec<LiveTable>> {
    let engine = Arc::clone(&engine);
    tauri::async_runtime::spawn_blocking(move || engine.live_tables(&name))
        .await
        .map_err(|e| AppError::Internal(format!("tables task failed: {e}")))?
}

#[tauri::command]
pub fn disconnect_database(
    engine: State<'_, Arc<Engine>>,
    saved: State<'_, Arc<Connections>>,
    name: String,
) -> Result<()> {
    connect::disconnect(&engine, &saved, &name)
}

/// Forgets a saved connection and its password in the keychain.
#[tauri::command]
pub fn forget_connection(saved: State<'_, Arc<Connections>>, name: String) -> Result<()> {
    saved.forget(&name)
}
