//! BigView desktop app: Tauri entry point and module tree.

pub mod cache;
pub mod chart;
pub mod cli;
pub mod commands;
pub mod compare;
pub mod engine;
pub mod error;
pub mod export;
pub mod import;
pub mod quality;
pub mod recipe;
pub mod remote;
pub mod settings;
pub mod sources;
pub mod sql;
pub mod view;

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
            engine::remove_stale_scratch(&cfg.temp_dir);
            let engine = Engine::open_in_memory(&cfg)?;
            // httpfs, when a URL is first opened, goes next to the cache.
            engine.set_extension_dir(&paths.app_cache_dir()?.join("duckdb-extensions"));
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
            app.manage(Arc::new(sql::library::SqlLibrary::new(
                paths.app_data_dir()?,
            )));
            app.manage(Arc::new(export::Exports::default()));
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
            commands::app::take_startup_files,
            commands::view::open_view,
            commands::view::column_values,
            commands::view::column_profile,
            commands::view::column_histograms,
            commands::view::view_sql,
            commands::sql::register_table,
            commands::sql::unregister_table,
            commands::sql::sql_result,
            commands::sql::sql_history,
            commands::sql::add_sql_history,
            commands::sql::clear_sql_history,
            commands::sql::saved_queries,
            commands::sql::save_query,
            commands::sql::delete_saved_query,
            commands::export::export_view,
            commands::export::cancel_export,
            commands::chart::chart_data,
            commands::chart::chart_sql,
            commands::chart::save_chart_image,
            commands::recipe::apply_recipe,
            commands::recipe::recipe_script,
            commands::recipe::save_recipe,
            commands::recipe::load_recipe,
            commands::recipe::save_recipe_script,
            commands::compare::compare_files,
            commands::compare::compare_sql,
            commands::quality::data_quality,
            commands::remote::get_s3_settings,
            commands::remote::save_s3_settings,
            commands::remote::clear_s3_settings
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
