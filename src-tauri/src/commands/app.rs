use std::path::PathBuf;

use parking_lot::Mutex;
use tauri::State;

/// Files passed on the command line at startup, until the UI takes them.
#[derive(Default)]
pub struct StartupFiles(pub Mutex<Vec<PathBuf>>);

/// Returns (once) the files the app was started with.
#[tauri::command]
pub fn take_startup_files(files: State<'_, StartupFiles>) -> Vec<PathBuf> {
    std::mem::take(&mut *files.0.lock())
}
