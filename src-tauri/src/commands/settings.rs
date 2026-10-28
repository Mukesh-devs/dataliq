//! The Settings screen: app settings (memory, threads, cache) read, saved to
//! the settings file and applied at once where they can be; a new cache or
//! temporary folder applies when the app restarts.

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use super::import::ImportState;
use crate::engine::Engine;
use crate::error::Result;
use crate::settings::{self, Settings};

/// The settings in use, where they are saved, and what the app started with
/// (folders only change on a restart).
pub struct SettingsState {
    pub path: PathBuf,
    pub current: RwLock<Settings>,
    pub started: Settings,
}

/// Defaults and limits the Settings screen shows next to the values.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInfo {
    pub total_memory_mb: u64,
    pub default_memory_limit_mb: u64,
    pub cores: u32,
    pub default_cache_dir: PathBuf,
    pub default_temp_dir: PathBuf,
    pub settings_file: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSettings {
    pub settings: Settings,
    /// A folder changed: it applies when DataLiq restarts.
    pub restart_needed: bool,
}

#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Settings {
    state.current.read().clone()
}

#[tauri::command]
pub fn settings_info(app: AppHandle, state: State<'_, SettingsState>) -> Result<SettingsInfo> {
    Ok(SettingsInfo {
        total_memory_mb: settings::total_memory_bytes() / (1024 * 1024),
        default_memory_limit_mb: settings::default_memory_limit_bytes() / (1024 * 1024),
        cores: std::thread::available_parallelism().map_or(1, |n| n.get() as u32),
        default_cache_dir: app
            .path()
            .app_cache_dir()
            .map_err(|e| crate::error::AppError::Internal(e.to_string()))?
            .join("datasets"),
        default_temp_dir: Settings::default().effective_temp_dir(),
        settings_file: state.path.clone(),
    })
}

/// Saves the settings and applies them: memory and threads at once, the
/// cache's size and on/off at once (a smaller size at the next cleanup).
#[tauri::command]
pub fn save_settings(
    engine: State<'_, Arc<Engine>>,
    imports: State<'_, Arc<ImportState>>,
    state: State<'_, SettingsState>,
    settings: Settings,
) -> Result<SavedSettings> {
    settings.validate()?;
    settings.save(&state.path)?;
    engine.set_limits(settings.memory_limit_bytes(), settings.threads)?;
    imports.cache.set_limits(
        settings.cache_enabled,
        settings.cache_max_gb.saturating_mul(1 << 30),
    );
    imports.cache.cleanup(&engine.datasets.ids());
    let restart_needed = settings.cache_dir != state.started.cache_dir
        || settings.temp_dir != state.started.temp_dir;
    *state.current.write() = settings.clone();
    Ok(SavedSettings {
        settings,
        restart_needed,
    })
}
