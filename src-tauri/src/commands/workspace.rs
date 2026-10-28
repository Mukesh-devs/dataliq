//! Saving and opening workspaces (`.bigview` files).

use std::path::PathBuf;

use crate::error::Result;
use crate::workspace::{self, WorkspaceFile};

/// Saves the workspace at `path` (chosen in the save dialog).
#[tauri::command]
pub fn save_workspace(path: PathBuf, workspace: WorkspaceFile) -> Result<()> {
    workspace::save(&path, &workspace)
}

/// Reads a workspace; files that moved with it are found again.
#[tauri::command]
pub fn load_workspace(path: PathBuf) -> Result<WorkspaceFile> {
    workspace::load(&path)
}
