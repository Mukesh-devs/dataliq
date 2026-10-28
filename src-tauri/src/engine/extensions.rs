//! DuckDB extensions that aren't built in (httpfs for URLs, sqlite for
//! SQLite files), installed and loaded only when a file needs them.
//!
//! The engine turns off DuckDB's autoloading and autoinstalling, so the app
//! makes no network requests on its own; the first file that needs an
//! extension downloads it (once, into the app's cache folder).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;

use super::Engine;
use crate::engine::Param;
use crate::engine::sql::literal;
use crate::error::{AppError, Result};

/// One install at a time in this process: two engines installing the same
/// extension at once both download it, and on Windows the second can't
/// replace the file the first has loaded. After the first, INSTALL finds it
/// there and does nothing.
static INSTALLING: Mutex<()> = Mutex::new(());

/// Where extensions go, and which are loaded.
#[derive(Default)]
pub struct ExtensionState {
    dir: Mutex<Option<PathBuf>>,
    loaded: Mutex<HashSet<String>>,
}

impl Engine {
    /// Where extensions are installed (the app's cache folder). Unset,
    /// DuckDB's default (`~/.duckdb/extensions`).
    pub fn set_extension_dir(&self, dir: &Path) {
        *self.extensions.dir.lock() = Some(dir.to_path_buf());
    }

    /// Installs (the first time) and loads `name`. `needed_for` says what
    /// asked for it, for the error ("Opening URLs"). Returns whether it was
    /// loaded just now.
    pub fn load_extension(&self, name: &str, needed_for: &str) -> Result<bool> {
        let mut loaded = self.extensions.loaded.lock();
        if loaded.contains(name) {
            return Ok(false);
        }
        let mut setup = String::new();
        if let Some(dir) = self.extensions.dir.lock().as_ref() {
            std::fs::create_dir_all(dir)?;
            setup.push_str(&format!(
                "SET extension_directory = {};\n",
                literal(&Param::Text(dir.to_string_lossy().into_owned()))
            ));
        }
        setup.push_str(&format!("INSTALL {name}; LOAD {name};"));
        let _installing = INSTALLING.lock();
        self.execute_batch(&setup).map_err(|e| {
            AppError::Query(format!(
                "{needed_for} needs DuckDB's {name} extension, which couldn't be installed. \
                 Connect to the internet once to download it ({}).",
                e.to_string().lines().next().unwrap_or_default()
            ))
        })?;
        loaded.insert(name.to_string());
        Ok(true)
    }

    pub fn extension_loaded(&self, name: &str) -> bool {
        self.extensions.loaded.lock().contains(name)
    }
}
