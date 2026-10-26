//! App settings, stored as a readable JSON file in the OS config directory.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

pub const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// DuckDB memory limit in MiB. `None` = 50% of physical RAM.
    pub memory_limit_mb: Option<u64>,
    /// Directory where DuckDB spills large sorts/joins. `None` = OS temp dir.
    pub temp_dir: Option<PathBuf>,
    /// DuckDB worker threads. `None` = all cores.
    pub threads: Option<u32>,
}

#[allow(clippy::derivable_impls)] // explicit so defaults are documented in one place
impl Default for Settings {
    fn default() -> Self {
        Settings {
            memory_limit_mb: None,
            temp_dir: None,
            threads: None,
        }
    }
}

impl Settings {
    /// Loads settings from `path`. A missing file yields the defaults.
    pub fn load(path: &Path) -> Result<Settings> {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| AppError::Settings(format!("{e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(e.into()),
        }
    }

    /// Like [`Settings::load`], but falls back to defaults (with a warning) on a
    /// broken file so a typo never prevents the app from starting.
    pub fn load_or_default(path: &Path) -> Settings {
        Settings::load(path).unwrap_or_else(|e| {
            tracing::warn!("ignoring settings at {}: {e}", path.display());
            Settings::default()
        })
    }

    /// Writes settings as pretty JSON, creating the parent directory.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| AppError::Internal(format!("serialize settings: {e}")))?;
        std::fs::write(path, text + "\n")?;
        Ok(())
    }

    /// Effective DuckDB memory limit in bytes.
    pub fn memory_limit_bytes(&self) -> u64 {
        match self.memory_limit_mb {
            Some(mb) => mb.max(256) * 1024 * 1024,
            None => default_memory_limit_bytes(),
        }
    }

    /// Effective spill directory.
    pub fn effective_temp_dir(&self) -> PathBuf {
        self.temp_dir
            .clone()
            .unwrap_or_else(|| std::env::temp_dir().join("bigview-spill"))
    }
}

/// 50% of physical RAM (at least 1 GiB).
fn default_memory_limit_bytes() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    (sys.total_memory() / 2).max(1024 * 1024 * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings::load(&dir.path().join(SETTINGS_FILE)).unwrap();
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn round_trips_and_uses_camel_case() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(SETTINGS_FILE);
        let s = Settings {
            memory_limit_mb: Some(2048),
            temp_dir: Some(dir.path().join("spill")),
            threads: Some(2),
        };
        s.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"memoryLimitMb\": 2048"), "{text}");
        assert_eq!(Settings::load(&path).unwrap(), s);
    }

    #[test]
    fn partial_file_fills_in_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTINGS_FILE);
        std::fs::write(&path, r#"{ "threads": 4 }"#).unwrap();
        let s = Settings::load(&path).unwrap();
        assert_eq!(s.threads, Some(4));
        assert_eq!(s.memory_limit_mb, None);
    }

    #[test]
    fn broken_file_is_an_error_but_load_or_default_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTINGS_FILE);
        std::fs::write(&path, "{ not json").unwrap();
        assert!(matches!(Settings::load(&path), Err(AppError::Settings(_))));
        assert_eq!(Settings::load_or_default(&path), Settings::default());
    }

    #[test]
    fn memory_limit_defaults_to_half_of_ram() {
        let s = Settings::default();
        assert!(s.memory_limit_bytes() >= 1024 * 1024 * 1024);
        let s = Settings {
            memory_limit_mb: Some(512),
            ..Settings::default()
        };
        assert_eq!(s.memory_limit_bytes(), 512 * 1024 * 1024);
    }
}
