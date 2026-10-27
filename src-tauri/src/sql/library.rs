//! The SQL panel's query history and saved queries, kept as JSON files in
//! the app data directory.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

pub const HISTORY_FILE: &str = "sql-history.json";
pub const SAVED_FILE: &str = "sql-saved.json";
/// Oldest history entries beyond this many are dropped.
pub const MAX_HISTORY: usize = 500;

/// One run of the SQL panel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub sql: String,
    /// Milliseconds since 1970.
    pub ran_at: u64,
    pub elapsed_ms: u64,
    /// Rows of the result, when it had some.
    #[serde(default)]
    pub rows: Option<u64>,
    /// The error, when it failed.
    #[serde(default)]
    pub error: Option<String>,
}

/// What the frontend sends for a run; the time is added here.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewHistoryEntry {
    pub sql: String,
    pub elapsed_ms: u64,
    #[serde(default)]
    pub rows: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub name: String,
    pub sql: String,
    /// Milliseconds since 1970.
    pub saved_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

pub struct SqlLibrary {
    dir: PathBuf,
    /// One change at a time (read, change, write).
    lock: Mutex<()>,
}

impl SqlLibrary {
    pub fn new(dir: impl Into<PathBuf>) -> SqlLibrary {
        SqlLibrary {
            dir: dir.into(),
            lock: Mutex::new(()),
        }
    }

    fn path(&self, file: &str) -> PathBuf {
        self.dir.join(file)
    }

    /// A file's items; none when it is missing. A broken file is moved
    /// aside (`.broken`) so the next write can't destroy what's in it.
    fn read<T: DeserializeOwned>(&self, file: &str) -> Vec<T> {
        let path = self.path(file);
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };
        match serde_json::from_str(&text) {
            Ok(items) => items,
            Err(e) => {
                tracing::warn!(
                    "{} is not valid ({e}); keeping it as .broken",
                    path.display()
                );
                let _ = std::fs::rename(&path, path.with_extension("json.broken"));
                Vec::new()
            }
        }
    }

    /// Writes the whole file at once (a temporary file, then a rename), so a
    /// crash never leaves half a file.
    fn write<T: Serialize>(&self, file: &str, items: &[T]) -> Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let path = self.path(file);
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(items)
            .map_err(|e| AppError::Internal(format!("serialize {file}: {e}")))?;
        std::fs::write(&tmp, text + "\n")?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Newest first; with `search`, only runs whose SQL contains it (any case).
    pub fn history(&self, search: Option<&str>, limit: usize) -> Vec<HistoryEntry> {
        let _g = self.lock.lock();
        let needle = search
            .map(str::to_lowercase)
            .filter(|s| !s.trim().is_empty());
        self.read::<HistoryEntry>(HISTORY_FILE)
            .into_iter()
            .filter(|e| {
                needle
                    .as_ref()
                    .is_none_or(|n| e.sql.to_lowercase().contains(n))
            })
            .take(limit)
            .collect()
    }

    /// Records a run. Running the same SQL again moves it to the top instead
    /// of adding a copy.
    pub fn add_history(&self, entry: NewHistoryEntry) -> Result<HistoryEntry> {
        let sql = entry.sql.trim().to_string();
        if sql.is_empty() {
            return Err(AppError::Query("There is no SQL to remember.".into()));
        }
        let _g = self.lock.lock();
        let mut items = self.read::<HistoryEntry>(HISTORY_FILE);
        items.retain(|e| e.sql != sql);
        let added = HistoryEntry {
            sql,
            ran_at: now_ms(),
            elapsed_ms: entry.elapsed_ms,
            rows: entry.rows,
            error: entry.error,
        };
        items.insert(0, added.clone());
        items.truncate(MAX_HISTORY);
        self.write(HISTORY_FILE, &items)?;
        Ok(added)
    }

    pub fn clear_history(&self) -> Result<()> {
        let _g = self.lock.lock();
        self.write::<HistoryEntry>(HISTORY_FILE, &[])
    }

    /// Saved queries, by name (any case).
    pub fn saved(&self) -> Vec<SavedQuery> {
        let _g = self.lock.lock();
        let mut items = self.read::<SavedQuery>(SAVED_FILE);
        items.sort_by_key(|q| q.name.to_lowercase());
        items
    }

    /// Saves `sql` as `name`, replacing a query of that name (any case).
    pub fn save_query(&self, name: &str, sql: &str) -> Result<SavedQuery> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Query("Give the query a name.".into()));
        }
        if sql.trim().is_empty() {
            return Err(AppError::Query("There is no SQL to save.".into()));
        }
        let _g = self.lock.lock();
        let mut items = self.read::<SavedQuery>(SAVED_FILE);
        let lower = name.to_lowercase();
        items.retain(|q| q.name.to_lowercase() != lower);
        let saved = SavedQuery {
            name: name.to_string(),
            sql: sql.trim().to_string(),
            saved_at: now_ms(),
        };
        items.push(saved.clone());
        self.write(SAVED_FILE, &items)?;
        Ok(saved)
    }

    /// Deletes a saved query; false if there was none of that name.
    pub fn delete_saved(&self, name: &str) -> Result<bool> {
        let _g = self.lock.lock();
        let mut items = self.read::<SavedQuery>(SAVED_FILE);
        let before = items.len();
        items.retain(|q| q.name != name);
        if items.len() == before {
            return Ok(false);
        }
        self.write(SAVED_FILE, &items)?;
        Ok(true)
    }

    /// Where the files are (for messages and tests).
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(sql: &str) -> NewHistoryEntry {
        NewHistoryEntry {
            sql: sql.into(),
            elapsed_ms: 5,
            rows: Some(1),
            error: None,
        }
    }

    #[test]
    fn history_is_newest_first_without_copies_and_searchable() {
        let dir = tempfile::tempdir().unwrap();
        let lib = SqlLibrary::new(dir.path().join("data"));
        assert!(lib.history(None, 10).is_empty());
        lib.add_history(run("SELECT 1")).unwrap();
        lib.add_history(run("SELECT * FROM people")).unwrap();
        lib.add_history(run("  SELECT 1 \n")).unwrap();
        let sqls: Vec<_> = lib.history(None, 10).into_iter().map(|e| e.sql).collect();
        assert_eq!(sqls, ["SELECT 1", "SELECT * FROM people"]);
        assert_eq!(lib.history(Some("PEOPLE"), 10).len(), 1);
        assert_eq!(lib.history(Some("  "), 10).len(), 2);
        assert_eq!(lib.history(None, 1).len(), 1);
        // Kept across restarts (a new library over the same files).
        let again = SqlLibrary::new(dir.path().join("data"));
        assert_eq!(again.history(None, 10).len(), 2);
        again.clear_history().unwrap();
        assert!(lib.history(None, 10).is_empty());
        assert!(lib.add_history(run("  ")).is_err());
    }

    #[test]
    fn history_keeps_the_newest_entries() {
        let dir = tempfile::tempdir().unwrap();
        let lib = SqlLibrary::new(dir.path());
        for i in 0..MAX_HISTORY + 5 {
            lib.add_history(run(&format!("SELECT {i}"))).unwrap();
        }
        let all = lib.history(None, usize::MAX);
        assert_eq!(all.len(), MAX_HISTORY);
        assert_eq!(all[0].sql, format!("SELECT {}", MAX_HISTORY + 4));
    }

    #[test]
    fn saved_queries_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let lib = SqlLibrary::new(dir.path());
        lib.save_query("top cities", "SELECT city FROM people")
            .unwrap();
        lib.save_query("Busy days", "SELECT 2").unwrap();
        // Same name in another case replaces it.
        lib.save_query("Top Cities", "SELECT city, count(*) FROM people GROUP BY 1")
            .unwrap();
        let saved = lib.saved();
        assert_eq!(
            saved.iter().map(|q| q.name.as_str()).collect::<Vec<_>>(),
            ["Busy days", "Top Cities"]
        );
        assert!(saved[1].sql.contains("count(*)"));
        assert!(lib.save_query(" ", "SELECT 1").is_err());
        assert!(lib.save_query("empty", "  ").is_err());
        assert!(lib.delete_saved("Busy days").unwrap());
        assert!(!lib.delete_saved("Busy days").unwrap());
        assert_eq!(lib.saved().len(), 1);
    }

    #[test]
    fn a_broken_file_is_kept_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SAVED_FILE), "{ not json").unwrap();
        let lib = SqlLibrary::new(dir.path());
        assert!(lib.saved().is_empty());
        assert!(dir.path().join("sql-saved.json.broken").exists());
        lib.save_query("a", "SELECT 1").unwrap();
        assert_eq!(lib.saved().len(), 1);
    }
}
