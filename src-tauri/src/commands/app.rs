use std::path::PathBuf;
use std::sync::Once;
use std::time::Instant;

use parking_lot::Mutex;
use tauri::State;

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
