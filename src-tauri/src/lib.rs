//! BigView desktop app: Tauri entry point and module tree.

pub mod cache;
pub mod cli;
pub mod commands;
pub mod engine;
pub mod error;
pub mod import;
pub mod settings;
pub mod sources;

mod logging;
#[cfg(target_os = "macos")]
mod menu;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::engine::{Engine, EngineConfig};
use crate::settings::{SETTINGS_FILE, Settings};

/// Builds and runs the Tauri application.
pub fn run() {
    let started = std::time::Instant::now();
    let cwd = std::env::current_dir().unwrap_or_default();
    let startup = cli::files_from_args(&std::env::args().collect::<Vec<_>>(), &cwd);
    tauri::Builder::default()
        // Must be registered first: a second launch forwards its files here
        // and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = cli::files_from_args(&argv, std::path::Path::new(&cwd));
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::app::StartupFiles {
            files: parking_lot::Mutex::new(startup),
            started,
            ready: std::sync::Once::new(),
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            menu::install(app)?;
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

            let cache_dir = match &settings.cache_dir {
                Some(dir) => dir.clone(),
                None => paths.app_cache_dir()?.join("datasets"),
            };
            let cache = cache::Cache::new(cache::CacheConfig {
                dir: cache_dir,
                max_bytes: settings.cache_max_gb.saturating_mul(1 << 30),
                enabled: settings.cache_enabled,
            })?;
            // Uncached imports live only for this session.
            let temp_dir = std::env::temp_dir().join(format!("bigview-{}", std::process::id()));
            app.manage(Arc::new(commands::import::ImportState {
                cache,
                imports: import::Imports::default(),
                temp_dir,
            }));
            app.manage(settings);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::query::run_query,
            commands::query::cancel_query,
            commands::query::fetch_rows,
            commands::files::open_file,
            commands::files::preview_file,
            commands::import::import_file,
            commands::import::cancel_import,
            commands::import::open_direct,
            commands::import::close_dataset,
            commands::import::cache_info,
            commands::import::clear_cache,
            commands::import::get_settings,
            commands::app::take_startup_files
        ])
        .build(tauri::generate_context!())
        .expect("error while building BigView")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Uncached imports are session-only.
                if let Some(state) = app.try_state::<Arc<commands::import::ImportState>>() {
                    let _ = std::fs::remove_dir_all(&state.temp_dir);
                }
            }
        });
}
