//! Workspaces: the open tabs (each file with its import settings, view,
//! column layout, recipe and chart), the SQL panel and the side panels,
//! saved as a `.bigview` JSON file and opened again later.
//!
//! The backend owns the file and its paths; what each tab keeps is the
//! frontend's (passed through unread), so new tab settings need no change
//! here. Each file is saved with its absolute path and, when it is inside
//! the workspace's folder, its path from there: a folder of data and its
//! workspace can be moved or shared together.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

const FORMAT: &str = "bigview-workspace";
const VERSION: u32 = 1;
pub const EXTENSION: &str = "bigview";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub version: u32,
    pub tabs: Vec<WorkspaceTab>,
    /// The tab shown, by position.
    #[serde(default)]
    pub active: Option<usize>,
    /// SQL panel: text, open, height.
    #[serde(default)]
    pub sql: Option<serde_json::Value>,
    /// Side panels shown.
    #[serde(default)]
    pub panels: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTab {
    /// Absolute path or URL. When loading, where the file was found.
    pub path: String,
    /// From the workspace's folder (`/` between folders), when inside it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative: Option<String>,
    /// Everything else the frontend keeps for the tab.
    #[serde(flatten)]
    pub state: serde_json::Map<String, serde_json::Value>,
}

fn has_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION))
}

fn folder_of(path: &Path) -> PathBuf {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    path.parent().map(Path::to_path_buf).unwrap_or_default()
}

/// Saves `workspace` at `path` (a `.bigview` file), adding each file's path
/// from the workspace's folder.
pub fn save(path: &Path, workspace: &WorkspaceFile) -> Result<()> {
    if !has_extension(path) {
        return Err(AppError::Query(format!(
            "Workspaces are saved as .{EXTENSION} files."
        )));
    }
    // The folder the workspace will be in (it may not exist as a file yet).
    let dir = path
        .parent()
        .map(|p| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()))
        .unwrap_or_default();
    let mut file = WorkspaceFile {
        format: FORMAT.into(),
        version: VERSION,
        ..workspace.clone()
    };
    for tab in &mut file.tabs {
        let p = Path::new(&tab.path);
        tab.relative = if crate::remote::is_url(p) {
            None
        } else {
            let abs = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
            abs.strip_prefix(&dir)
                .ok()
                .filter(|r| !r.as_os_str().is_empty())
                .map(|r| r.to_string_lossy().replace('\\', "/"))
        };
    }
    let mut json = serde_json::to_vec_pretty(&file)
        .map_err(|e| AppError::Internal(format!("could not write the workspace: {e}")))?;
    json.push(b'\n');
    let mut partial = path.to_path_buf().into_os_string();
    partial.push(".partial");
    std::fs::write(&partial, &json)?;
    std::fs::rename(&partial, path)?;
    Ok(())
}

/// Reads a workspace saved by [`save`]. A file no longer at its absolute
/// path but next to the workspace as it was (the folder moved) is found
/// there; one found nowhere keeps its path, so its tab says it's missing.
pub fn load(path: &Path) -> Result<WorkspaceFile> {
    let text = std::fs::read_to_string(path)?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AppError::Query(format!("This file is not valid JSON: {e}")))?;
    if value.get("format").and_then(|f| f.as_str()) != Some(FORMAT) {
        return Err(AppError::Query(
            "This file is not a BigView workspace.".into(),
        ));
    }
    let version = value.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
    if version == 0 || version > u64::from(VERSION) {
        return Err(AppError::Query(format!(
            "This workspace was saved by a newer BigView (version {version}); update BigView to open it."
        )));
    }
    let mut file: WorkspaceFile = serde_json::from_value(value)
        .map_err(|e| AppError::Query(format!("This workspace is damaged: {e}")))?;
    let dir = folder_of(path);
    for tab in &mut file.tabs {
        let p = Path::new(&tab.path);
        if crate::remote::is_url(p) || p.exists() || crate::sources::multi::is_pattern(p) {
            continue;
        }
        if let Some(rel) = &tab.relative {
            let moved = dir.join(rel);
            if moved.exists() {
                tab.path = moved.to_string_lossy().into_owned();
            }
        }
    }
    if file.active.is_some_and(|a| a >= file.tabs.len()) {
        file.active = None;
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tab(path: &Path, view: serde_json::Value) -> WorkspaceTab {
        let mut state = serde_json::Map::new();
        state.insert("view".into(), view);
        WorkspaceTab {
            path: path.to_string_lossy().into_owned(),
            relative: None,
            state,
        }
    }

    #[test]
    fn round_trips_and_follows_a_moved_folder() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir_all(project.join("data")).unwrap();
        let inside = project.join("data/sales.csv");
        std::fs::write(&inside, "a\n1\n").unwrap();
        let outside = root.path().join("other.csv");
        std::fs::write(&outside, "a\n2\n").unwrap();
        let ws = WorkspaceFile {
            format: String::new(),
            version: 0,
            tabs: vec![
                tab(&inside, json!({"search": "x"})),
                tab(&outside, json!(null)),
                tab(Path::new("https://example.com/a.csv"), json!(null)),
            ],
            active: Some(1),
            sql: Some(json!({"text": "SELECT 1", "open": true})),
            panels: None,
        };
        let file = project.join("work.bigview");
        save(&file, &ws).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"format\": \"bigview-workspace\""), "{text}");
        assert!(text.contains("\"relative\": \"data/sales.csv\""), "{text}");

        let back = load(&file).unwrap();
        assert_eq!(back.tabs.len(), 3);
        assert_eq!(back.tabs[0].state["view"], json!({"search": "x"}));
        assert_eq!(back.tabs[1].relative, None);
        assert_eq!(back.tabs[2].path, "https://example.com/a.csv");
        assert_eq!(back.active, Some(1));
        assert_eq!(back.sql, ws.sql);

        // The project folder moves: its file is found where it went; the
        // file outside it (now gone) keeps its old path.
        let moved = root.path().join("moved");
        std::fs::rename(&project, &moved).unwrap();
        std::fs::remove_file(&outside).unwrap();
        let back = load(&moved.join("work.bigview")).unwrap();
        let found = PathBuf::from(&back.tabs[0].path);
        assert_eq!(
            std::fs::canonicalize(found).unwrap(),
            std::fs::canonicalize(moved.join("data/sales.csv")).unwrap()
        );
        assert_eq!(back.tabs[1].path, outside.to_string_lossy());
    }

    #[test]
    fn other_files_are_said_in_words() {
        let dir = tempfile::tempdir().unwrap();
        let ws = WorkspaceFile {
            format: String::new(),
            version: 0,
            tabs: vec![],
            active: None,
            sql: None,
            panels: None,
        };
        let err = save(&dir.path().join("w.json"), &ws)
            .unwrap_err()
            .to_string();
        assert!(err.contains(".bigview files"), "{err}");
        let p = dir.path().join("x.bigview");
        std::fs::write(&p, "{\"format\": \"bigview-recipe\", \"version\": 1}").unwrap();
        assert!(
            load(&p)
                .unwrap_err()
                .to_string()
                .contains("not a BigView workspace")
        );
        std::fs::write(
            &p,
            "{\"format\": \"bigview-workspace\", \"version\": 9, \"tabs\": []}",
        )
        .unwrap();
        assert!(load(&p).unwrap_err().to_string().contains("newer BigView"));
        std::fs::write(&p, "nope").unwrap();
        assert!(load(&p).unwrap_err().to_string().contains("not valid JSON"));
        std::fs::write(
            &p,
            "{\"format\": \"bigview-workspace\", \"version\": 1, \"tabs\": [], \"active\": 4}",
        )
        .unwrap();
        assert_eq!(load(&p).unwrap().active, None);
    }
}
