//! App updates (D51): checked against a signed manifest on GitHub Releases
//! by Tauri's updater plugin, which verifies each download against the
//! public key built into the app. Builds made without the key (local and CI
//! builds) have no updater; they say so instead of failing.

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{AppError, Result};

pub struct UpdateState {
    /// The build has an update key and manifest URL (the release workflow
    /// adds them), so the updater plugin is registered.
    pub configured: bool,
    /// The update found by the last check, until it's installed.
    pub pending: Mutex<Option<Update>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub configured: bool,
    pub current_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// The manifest's `pub_date` (RFC 3339), if any.
    pub date: Option<String>,
    /// Release notes from the manifest.
    pub notes: Option<String>,
}

/// Download progress, sent as `update-progress` while installing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

const NOT_CONFIGURED: &str = "This build of BigView can't update itself (it was built without an update key). \
     Download new versions from the releases page.";

fn failed(what: &str, e: tauri_plugin_updater::Error) -> AppError {
    tracing::warn!("couldn't {what}: {e}");
    AppError::Query(format!("Couldn't {what}: {e}"))
}

#[tauri::command]
pub fn update_status(app: AppHandle, state: State<'_, UpdateState>) -> UpdateStatus {
    UpdateStatus {
        configured: state.configured,
        current_version: app.package_info().version.to_string(),
    }
}

/// Asks the manifest for a newer version. `None`: this is the latest.
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<Option<UpdateInfo>> {
    if !state.configured {
        return Err(AppError::Query(NOT_CONFIGURED.into()));
    }
    let updater = app.updater().map_err(|e| failed("check for updates", e))?;
    let update = updater
        .check()
        .await
        .map_err(|e| failed("check for updates", e))?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        date: u
            .raw_json
            .get("pub_date")
            .and_then(|d| d.as_str())
            .map(str::to_string),
        notes: u.body.clone(),
    });
    *state.pending.lock() = update;
    Ok(info)
}

/// Downloads the update found by the last check, verifies its signature,
/// installs it and restarts the app (on Windows the installer closes it).
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<()> {
    let update = state
        .pending
        .lock()
        .take()
        .ok_or_else(|| AppError::Query("Check for updates first.".into()))?;
    let mut downloaded = 0u64;
    let progress = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.emit("update-progress", UpdateProgress { downloaded, total });
            },
            || tracing::info!("update downloaded"),
        )
        .await
        .map_err(|e| failed("install the update", e))?;
    tracing::info!(version = %update.version, "update installed, restarting");
    app.restart()
}
