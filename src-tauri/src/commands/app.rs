use std::path::PathBuf;
use std::sync::Once;
use std::time::Instant;

use parking_lot::Mutex;
use tauri::State;

use crate::error::{AppError, Result};

/// Files passed on the command line at startup, until the UI takes them.
pub struct StartupFiles {
    pub files: Mutex<Vec<PathBuf>>,
    /// When the process started, to log how long the UI took to load.
    pub started: Instant,
    pub ready: Once,
}

/// Returns (once) the files the app was started with. The UI calls this as
/// soon as it has mounted, so the first call is logged as "frontend ready".
#[tauri::command]
pub fn take_startup_files(startup: State<'_, StartupFiles>) -> Vec<PathBuf> {
    startup.ready.call_once(|| {
        tracing::info!(
            elapsed_ms = startup.started.elapsed().as_millis() as u64,
            "frontend ready"
        );
    });
    std::mem::take(&mut *startup.files.lock())
}

/// Replaces the macOS menu bar with the frontend's menus (see `menu`).
/// Elsewhere the menus are drawn in the window; nothing to do.
#[tauri::command]
pub fn set_native_menu(app: tauri::AppHandle, menus: Vec<crate::menu::NativeMenu>) -> Result<()> {
    if cfg!(target_os = "macos") {
        let menu = crate::menu::build(&app, &menus)
            .map_err(|e| AppError::Internal(format!("menu: {e}")))?;
        app.set_menu(menu)
            .map_err(|e| AppError::Internal(format!("menu: {e}")))?;
    }
    Ok(())
}
