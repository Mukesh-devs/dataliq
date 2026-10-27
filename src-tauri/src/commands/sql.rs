use std::sync::Arc;

use tauri::State;

use crate::engine::Engine;
use crate::error::Result;

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
