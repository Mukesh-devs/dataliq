use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::commands::view::ViewReady;
use crate::engine::{Engine, RequestKey};
use crate::error::{AppError, Result};
use crate::recipe::{RecipeFile, RecipeOutcome, RecipeStep};

/// Applies the cleaning `steps` to dataset `dataset_id`: a new dataset of
/// the cleaned rows, read through its query at first and written to a
/// session table in the background (announced with `view-ready`). A newer
/// request in the same `group` (one per tab) cancels this one.
#[tauri::command]
pub async fn apply_recipe(
    app: AppHandle,
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    steps: Vec<RecipeStep>,
    request_id: Option<String>,
    group: Option<String>,
) -> Result<RecipeOutcome> {
    let started = std::time::Instant::now();
    let engine = Arc::clone(&engine);
    let key = RequestKey {
        id: request_id,
        group,
    };
    let outcome = {
        let engine = Arc::clone(&engine);
        tauri::async_runtime::spawn_blocking(move || engine.apply_recipe(&dataset_id, &steps, &key))
            .await
            .map_err(|e| AppError::Internal(format!("recipe task failed: {e}")))??
    };
    let id = outcome.dataset.id.clone();
    tauri::async_runtime::spawn_blocking(move || match engine.materialize_view(&id) {
        Ok(true) => {
            let ready = ViewReady {
                dataset_id: id,
                elapsed_ms: started.elapsed().as_millis() as u64,
            };
            let _ = app.emit("view-ready", ready);
            if let Err(e) = engine.release_memory() {
                tracing::warn!("could not release memory after a recipe: {e}");
            }
        }
        // Closed or replaced meanwhile.
        Ok(false) | Err(AppError::Cancelled) => {}
        Err(e) => tracing::warn!("could not write recipe {id}: {e}"),
    });
    Ok(outcome)
}

/// The recipe as one standalone DuckDB script over `reader` (the file's
/// reader call), each step under its label (one per step, optional).
#[tauri::command]
pub fn recipe_script(
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    steps: Vec<RecipeStep>,
    reader: String,
    labels: Option<Vec<String>>,
) -> Result<String> {
    engine.recipe_script(&dataset_id, &steps, &reader, &labels.unwrap_or_default())
}

/// Saves a recipe as JSON at `path` (chosen in the save dialog).
#[tauri::command]
pub fn save_recipe(path: PathBuf, recipe: RecipeFile) -> Result<()> {
    crate::recipe::save_recipe(&path, &recipe)
}

/// Reads a recipe saved with `save_recipe`.
#[tauri::command]
pub fn load_recipe(path: PathBuf) -> Result<RecipeFile> {
    crate::recipe::load_recipe(&path)
}

/// Saves a recipe's SQL script at `path` (a `.sql` file).
#[tauri::command]
pub fn save_recipe_script(path: PathBuf, script: String) -> Result<()> {
    crate::recipe::save_script(&path, &script)
}
