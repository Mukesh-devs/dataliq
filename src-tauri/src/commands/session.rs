//! The session: autosave and restore, the crash log and diagnostics.

use std::sync::Arc;

use tauri::State;

use crate::commands::import::ImportState;
use crate::commands::settings::SettingsState;
use crate::engine::Engine;
use crate::error::Result;
use crate::session::{self, Session, SessionStart};
use crate::workspace::WorkspaceFile;

/// What the last session left: its tabs, and whether it crashed. Once.
#[tauri::command]
pub fn session_start(session: State<'_, Session>) -> SessionStart {
    session.take_start()
}

/// Saves the open tabs as the session (called a moment after each change).
#[tauri::command]
pub async fn session_save(session: State<'_, Session>, workspace: WorkspaceFile) -> Result<()> {
    session.save(&workspace)
}

#[tauri::command]
pub fn session_clear(session: State<'_, Session>) {
    session.clear();
}

/// An error the UI caught (window `error` / `unhandledrejection`), kept in
/// the local crash log.
#[tauri::command]
pub fn report_ui_error(
    session: State<'_, Session>,
    message: String,
    stack: Option<String>,
) -> Result<()> {
    let log = session.crash_log();
    session::ui_error(log.parent().unwrap_or(&log), &message, stack.as_deref())
}

/// Versions, system, settings, cache, the last crashes and the end of the
/// log, as text for the clipboard. Nothing is sent anywhere.
#[tauri::command]
pub async fn diagnostics(
    session: State<'_, Session>,
    engine: State<'_, Arc<Engine>>,
    settings: State<'_, SettingsState>,
    imports: State<'_, Arc<ImportState>>,
) -> Result<String> {
    let engine_version = engine
        .connection()
        .and_then(|c| {
            c.query_row("SELECT library_version FROM pragma_version()", [], |r| {
                r.get::<_, String>(0)
            })
            .map_err(Into::into)
        })
        .unwrap_or_else(|_| "unknown".into());
    let log = session.crash_log();
    let settings = settings.current.read().clone();
    Ok(session::diagnostics(&session::DiagnosticsInput {
        engine_version,
        settings: &settings,
        memory: engine.memory_usage().ok(),
        cache: imports.cache.info(),
        log_dir: log.parent().unwrap_or(&log),
    }))
}
