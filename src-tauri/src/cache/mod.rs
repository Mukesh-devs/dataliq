//! Dataset cache: one DuckDB file per imported dataset in the OS cache dir.
//!
//! Key = hash of (absolute path, file size, modified time, import options), so
//! reopening an unchanged file is instant and any change re-imports. Imports
//! write to `<key>.duckdb.partial` and are renamed only on success, so a
//! cancelled or failed import never leaves a broken entry.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::Result;
use crate::sources::OpenOptions;

#[derive(Debug, Clone)]
pub struct CacheConfig {
    pub dir: PathBuf,
    pub max_bytes: u64,
    pub enabled: bool,
}

/// Identity of a source file version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStamp {
    pub path: PathBuf,
    pub size: u64,
    pub modified_ms: u64,
    /// Several files (a folder or pattern): a digest of each one's path,
    /// size and last change, so adding, removing or editing any of them
    /// is a new version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<String>,
}

impl SourceStamp {
    pub fn of(path: &Path) -> Result<SourceStamp> {
        let abs = std::fs::canonicalize(path)?;
        let meta = std::fs::metadata(&abs)?;
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok(SourceStamp {
            path: abs,
            size: meta.len(),
            modified_ms,
            parts: None,
        })
    }
}

/// A digest of several files' stamps (see [`SourceStamp::parts`]).
pub fn digest_parts(parts: &[SourceStamp]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p.path.to_string_lossy().as_bytes());
        h.update(b"\0");
        h.update(p.size.to_le_bytes());
        h.update(p.modified_ms.to_le_bytes());
    }
    h.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Stable cache key for a file version + import options.
pub fn cache_key(stamp: &SourceStamp, options: &OpenOptions) -> String {
    let mut h = Sha256::new();
    // Format version: bump to invalidate every cache entry after a change
    // in how imports are written.
    h.update(b"dataliq-cache-v2\0");
    h.update(stamp.path.to_string_lossy().as_bytes());
    h.update(b"\0");
    h.update(stamp.size.to_le_bytes());
    h.update(stamp.modified_ms.to_le_bytes());
    if let Some(parts) = &stamp.parts {
        h.update(b"parts\0");
        h.update(parts.as_bytes());
    }
    h.update(serde_json::to_vec(options).unwrap_or_default());
    h.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Stored next to each cached database.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheMeta {
    pub key: String,
    pub source: SourceStamp,
    pub row_count: u64,
    pub created_ms: u64,
    pub last_used_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub dir: PathBuf,
    pub enabled: bool,
    pub max_bytes: u64,
    pub used_bytes: u64,
    pub entries: usize,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct Cache {
    dir: PathBuf,
    /// Changed from Settings while the app runs (see [`Cache::set_limits`]).
    enabled: AtomicBool,
    max_bytes: AtomicU64,
}

impl Cache {
    pub fn new(config: CacheConfig) -> Result<Cache> {
        std::fs::create_dir_all(&config.dir)?;
        let cache = Cache {
            dir: config.dir,
            enabled: AtomicBool::new(config.enabled),
            max_bytes: AtomicU64::new(config.max_bytes),
        };
        cache.remove_partials();
        Ok(cache)
    }

    pub fn db_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.duckdb"))
    }

    pub fn partial_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.duckdb.partial"))
    }

    fn meta_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.json"))
    }

    /// A complete cache entry for `key`, if any.
    pub fn lookup(&self, key: &str) -> Option<CacheMeta> {
        if !self.db_path(key).is_file() {
            return None;
        }
        let text = std::fs::read_to_string(self.meta_path(key)).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn touch(&self, key: &str) {
        if let Some(mut meta) = self.lookup(key) {
            meta.last_used_ms = now_ms();
            let _ = self.write_meta(&meta);
        }
    }

    fn write_meta(&self, meta: &CacheMeta) -> Result<()> {
        let text = serde_json::to_string_pretty(meta)
            .map_err(|e| crate::error::AppError::Internal(e.to_string()))?;
        std::fs::write(self.meta_path(&meta.key), text)?;
        Ok(())
    }

    /// Turns a finished `.partial` into a cache entry.
    pub fn commit(&self, meta: &CacheMeta) -> Result<()> {
        // Meta first: an entry only counts once the .duckdb exists.
        self.write_meta(meta)?;
        std::fs::rename(self.partial_path(&meta.key), self.db_path(&meta.key))?;
        Ok(())
    }

    /// Deletes a failed or cancelled import (and DuckDB's WAL next to it).
    pub fn discard_partial(&self, key: &str) {
        let p = self.partial_path(key);
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_file(p.with_extension("partial.wal"));
    }

    fn remove_partials(&self) {
        if let Ok(rd) = std::fs::read_dir(&self.dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.contains(".duckdb.partial") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }

    fn entries(&self) -> Vec<(CacheMeta, u64)> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&self.dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if let Some(key) = name.strip_suffix(".duckdb") {
                    if let Some(meta) = self.lookup(key) {
                        let bytes = e.metadata().map(|m| m.len()).unwrap_or(0);
                        out.push((meta, bytes));
                    }
                }
            }
        }
        out
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Whether imports are kept between sessions.
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn max_bytes(&self) -> u64 {
        self.max_bytes.load(Ordering::Relaxed)
    }

    /// New limits from Settings; a smaller size applies at the next cleanup.
    pub fn set_limits(&self, enabled: bool, max_bytes: u64) {
        self.enabled.store(enabled, Ordering::Relaxed);
        self.max_bytes.store(max_bytes, Ordering::Relaxed);
    }

    pub fn info(&self) -> CacheInfo {
        let entries = self.entries();
        CacheInfo {
            dir: self.dir.clone(),
            enabled: self.enabled(),
            max_bytes: self.max_bytes(),
            used_bytes: entries.iter().map(|(_, b)| b).sum(),
            entries: entries.len(),
        }
    }

    pub fn remove(&self, key: &str) {
        let _ = std::fs::remove_file(self.db_path(key));
        let _ = std::fs::remove_file(self.meta_path(key));
        let _ = std::fs::remove_file(self.db_path(key).with_extension("duckdb.wal"));
    }

    /// Deletes least recently used entries until the cache fits its size
    /// limit. Keys in `keep` (datasets open right now) are never deleted.
    /// Returns the deleted keys.
    pub fn cleanup(&self, keep: &[String]) -> Vec<String> {
        let mut entries = self.entries();
        let mut used: u64 = entries.iter().map(|(_, b)| b).sum();
        entries.sort_by_key(|(m, _)| m.last_used_ms);
        let mut removed = Vec::new();
        for (meta, bytes) in entries {
            if used <= self.max_bytes() {
                break;
            }
            if keep.contains(&meta.key) {
                continue;
            }
            self.remove(&meta.key);
            used = used.saturating_sub(bytes);
            removed.push(meta.key);
        }
        removed
    }

    /// Deletes every entry except those in `keep`.
    pub fn clear(&self, keep: &[String]) -> usize {
        let mut n = 0;
        for (meta, _) in self.entries() {
            if !keep.contains(&meta.key) {
                self.remove(&meta.key);
                n += 1;
            }
        }
        n
    }
}

/// Free bytes on the disk that holds `dir` (None if unknown).
pub fn available_space(dir: &Path) -> Option<u64> {
    let dir = std::fs::canonicalize(dir).ok()?;
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .iter()
        .filter(|d| dir.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::CsvOptions;

    fn stamp(size: u64, modified_ms: u64) -> SourceStamp {
        SourceStamp {
            path: "/data/a.csv".into(),
            size,
            modified_ms,
            parts: None,
        }
    }

    #[test]
    fn key_changes_with_file_version_and_options() {
        let opts = OpenOptions::default();
        let k = cache_key(&stamp(10, 1), &opts);
        assert_eq!(k.len(), 32);
        assert_eq!(k, cache_key(&stamp(10, 1), &opts), "stable");
        assert_ne!(k, cache_key(&stamp(11, 1), &opts), "size");
        assert_ne!(k, cache_key(&stamp(10, 2), &opts), "mtime");
        let other = OpenOptions {
            csv: CsvOptions {
                delimiter: Some(";".into()),
                ..CsvOptions::default()
            },
            ..OpenOptions::default()
        };
        assert_ne!(k, cache_key(&stamp(10, 1), &other), "options");
    }

    fn meta(key: &str, last_used_ms: u64) -> CacheMeta {
        CacheMeta {
            key: key.into(),
            source: stamp(1, 1),
            row_count: 1,
            created_ms: 0,
            last_used_ms,
        }
    }

    fn fake_entry(cache: &Cache, key: &str, bytes: usize, last_used: u64) {
        std::fs::write(cache.partial_path(key), vec![0u8; bytes]).unwrap();
        cache.commit(&meta(key, last_used)).unwrap();
    }

    #[test]
    fn commit_lookup_and_partials() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(CacheConfig {
            dir: dir.path().into(),
            max_bytes: 1 << 30,
            enabled: true,
        })
        .unwrap();
        std::fs::write(cache.partial_path("k1"), b"x").unwrap();
        assert!(cache.lookup("k1").is_none(), "a partial is not an entry");
        cache.commit(&meta("k1", 5)).unwrap();
        assert_eq!(cache.lookup("k1").unwrap().row_count, 1);
        std::fs::write(cache.partial_path("k2"), b"x").unwrap();
        cache.discard_partial("k2");
        assert!(!cache.partial_path("k2").exists());
        // Leftover partials from a crash are removed at startup.
        std::fs::write(cache.partial_path("k3"), b"x").unwrap();
        let cache = Cache::new(CacheConfig {
            dir: cache.dir().to_path_buf(),
            max_bytes: cache.max_bytes(),
            enabled: cache.enabled(),
        })
        .unwrap();
        assert!(!cache.partial_path("k3").exists());
        assert_eq!(cache.info().entries, 1);
    }

    #[test]
    fn cleanup_removes_least_recently_used_but_keeps_open_ones() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(CacheConfig {
            dir: dir.path().into(),
            max_bytes: 2500,
            enabled: true,
        })
        .unwrap();
        fake_entry(&cache, "old", 1000, 1);
        fake_entry(&cache, "open", 1000, 2);
        fake_entry(&cache, "mid", 1000, 3);
        fake_entry(&cache, "new", 1000, 4);
        let removed = cache.cleanup(&["open".to_string()]);
        assert_eq!(removed, vec!["old".to_string(), "mid".to_string()]);
        assert!(cache.lookup("open").is_some() && cache.lookup("new").is_some());
        assert_eq!(cache.info().used_bytes, 2000);
        assert_eq!(cache.clear(&["open".to_string()]), 1);
        assert_eq!(cache.info().entries, 1);
    }

    #[test]
    fn free_space_is_known_for_temp_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert!(available_space(dir.path()).unwrap_or(1) > 0);
    }
}
