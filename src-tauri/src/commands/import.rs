use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::cache::{Cache, CacheInfo};
use crate::engine::{Dataset, Engine};
use crate::error::{AppError, Result};
use crate::import::{self, ImportOutcome, ImportTarget, Imports};
use crate::settings::Settings;
use crate::sources::{OpenOptions, Source};

/// Shared state for imports.
pub struct ImportState {
    pub cache: Cache,
    pub imports: Imports,
    /// Where imports go when caching is disabled.
    pub temp_dir: PathBuf,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("task failed: {e}")))?
}

/// Imports a file into the cache (or reuses it) and returns a pageable
/// dataset. Emits `import-progress` events tagged with `job_id`.
#[tauri::command]
pub async fn import_file(
    app: AppHandle,
    engine: State<'_, Arc<Engine>>,
    state: State<'_, Arc<ImportState>>,
    path: PathBuf,
    options: Option<OpenOptions>,
    job_id: String,
) -> Result<ImportOutcome> {
    let engine = Arc::clone(&engine);
    let state = Arc::clone(&state);
    blocking(move || {
        let source = Source::new(&path, options.unwrap_or_default())?.resolve_dialect(&engine)?;
        let target = ImportTarget {
            cache: &state.cache,
            temp_dir: state.temp_dir.clone(),
        };
        let emit = |p| {
            let _ = app.emit("import-progress", p);
        };
        let out = import::import(&engine, &state.imports, &target, &source, &job_id, &emit);
        // An import leaves DuckDB holding the file's pages; give them back
        // (the grid reads them again from the cache file as needed).
        if let Err(e) = engine.release_memory() {
            tracing::warn!("could not release memory after import: {e}");
        }
        out
    })
    .await
}

#[tauri::command]
pub fn cancel_import(state: State<'_, Arc<ImportState>>, job_id: String) -> bool {
    state.imports.cancel(&job_id)
}

/// Reads the file directly without importing (slower paging; no disk needed).
#[tauri::command]
pub async fn open_direct(
    engine: State<'_, Arc<Engine>>,
    path: PathBuf,
    options: Option<OpenOptions>,
) -> Result<Dataset> {
    let engine = Arc::clone(&engine);
    blocking(move || {
        let source = Source::new(&path, options.unwrap_or_default())?.resolve_dialect(&engine)?;
        import::open_direct(&engine, &source)
    })
    .await
}

#[tauri::command]
pub async fn close_dataset(engine: State<'_, Arc<Engine>>, dataset_id: String) -> Result<()> {
    let engine = Arc::clone(&engine);
    blocking(move || import::close_dataset(&engine, &dataset_id)).await
}

#[tauri::command]
pub fn cache_info(state: State<'_, Arc<ImportState>>) -> CacheInfo {
    state.cache.info()
}

/// Deletes every cache entry that is not open right now.
#[tauri::command]
pub fn clear_cache(
    engine: State<'_, Arc<Engine>>,
    state: State<'_, Arc<ImportState>>,
) -> CacheInfo {
    state.cache.clear(&engine.datasets.ids());
    state.cache.info()
}

#[tauri::command]
pub fn get_settings(settings: State<'_, Settings>) -> Settings {
    settings.inner().clone()
}
