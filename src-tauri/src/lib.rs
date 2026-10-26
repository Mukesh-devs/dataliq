//! BigView desktop app: Tauri entry point and module tree.

pub mod commands;
pub mod engine;
pub mod error;
pub mod settings;
pub mod sources;

mod logging;

use std::sync::Arc;

use tauri::Manager;

use crate::engine::{Engine, EngineConfig};
use crate::settings::{SETTINGS_FILE, Settings};

/// Builds and runs the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = app.path();
            let log_guard = logging::init(&paths.app_log_dir()?);
            app.manage(log_guard);

            let settings_path = paths.app_config_dir()?.join(SETTINGS_FILE);
            let settings = Settings::load_or_default(&settings_path);
            if !settings_path.exists() {
                // Write defaults so users can find and edit the file.
                if let Err(e) = settings.save(&settings_path) {
                    tracing::warn!("could not write default settings: {e}");
                }
            }
            let cfg = EngineConfig::from_settings(&settings);
            tracing::info!(
                memory_limit_mib = cfg.memory_limit_bytes / (1024 * 1024),
                temp_dir = %cfg.temp_dir.display(),
                "starting DuckDB"
            );
            let engine = Engine::open_in_memory(&cfg)?;
            app.manage(Arc::new(engine));
            app.manage(settings);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::query::run_query,
            commands::query::cancel_query,
            commands::query::fetch_rows,
            commands::files::open_file,
            commands::files::preview_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running BigView");
}
