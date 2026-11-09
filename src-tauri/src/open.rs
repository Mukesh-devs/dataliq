//! Opening a file, as the app's commands do it: its info and first rows
//! (side by side), then the full import.
//!
//! A file imported before opens from the cache without being read: its
//! cache entry holds what opening it showed, and the check that it is the
//! same file (its size and time of last change) is one `stat`. A digest of
//! its first and last bytes is then compared in the background, for edits
//! that kept both.

use std::path::Path;
use std::sync::Arc;

use crate::cache::{self, Cache};
use crate::commands::files::PREVIEW_ROWS;
use crate::engine::{DatasetSource, Engine, RequestKey};
use crate::error::Result;
use crate::import::{self, ImportOutcome, ImportProgress, ImportTarget, Imports};
use crate::sources::{OpenOptions, Source, SourceInfo};

/// A file found in the cache, attached and ready to page.
pub struct Reopened {
    pub info: SourceInfo,
    key: String,
    /// The digest the entry was imported with (none for folders).
    fingerprint: Option<String>,
}

impl Reopened {
    /// Compares the file's first and last bytes with the cache entry's; on
    /// a difference the entry is dropped (the next open imports again) and
    /// `on_changed` runs. Meant for a background thread.
    pub fn verify(&self, cache: &Cache, on_changed: impl FnOnce()) {
        let Some(expected) = &self.fingerprint else {
            return;
        };
        if cache::fingerprint(&self.info.path).as_ref() != Some(expected) {
            tracing::info!(
                "{} changed on disk since it was imported",
                self.info.path.display()
            );
            cache.forget(&self.key);
            on_changed();
        }
    }
}

/// The cache entry for this file version and these options, attached: no
/// sniffing, no reading the file. None when there is none (or it predates
/// cached file info), the file is read in place, or caching is off.
pub fn reopen(
    engine: &Engine,
    cache: &Cache,
    path: &Path,
    options: &OpenOptions,
) -> Result<Option<Reopened>> {
    if !cache.enabled() || crate::remote::is_url(path) {
        return Ok(None);
    }
    let source = Source::new(path, options.clone())?;
    if source.is_queried_in_place() {
        return Ok(None);
    }
    let open_key = cache::cache_key(&source.stamp()?, options);
    let Some(meta) = cache.lookup_open(&open_key) else {
        return Ok(None);
    };
    let Some(mut info) = meta
        .info
        .clone()
        .and_then(|v| serde_json::from_value::<SourceInfo>(v).ok())
    else {
        return Ok(None);
    };
    let dataset = match engine.datasets.get(&meta.key) {
        Ok(ds) => ds,
        // A damaged entry is deleted: the file opens and imports as new.
        Err(_) => match import::attach_cached(engine, cache, &meta.key, meta.row_count) {
            Some(ds) => ds,
            None => return Ok(None),
        },
    };
    cache.touch(&meta.key);
    info.path = path.to_path_buf();
    info.dataset = Some(dataset);
    Ok(Some(Reopened {
        info,
        key: meta.key,
        fingerprint: meta.fingerprint,
    }))
}

/// Detects the format, sniffs CSV settings and lists the columns; from the
/// cache (with the data ready) when the file was imported before.
pub fn info(
    engine: &Engine,
    cache: &Cache,
    path: &Path,
    options: OpenOptions,
) -> Result<SourceInfo> {
    info_then(engine, cache, path, options, |_| {})
}

/// [`info`], handing a reopen from the cache to `background` (to verify it
/// off the caller's thread).
pub fn info_then(
    engine: &Engine,
    cache: &Cache,
    path: &Path,
    options: OpenOptions,
    background: impl FnOnce(Arc<Reopened>),
) -> Result<SourceInfo> {
    if let Some(r) = reopen(engine, cache, path, &options)? {
        let r = Arc::new(r);
        let info = r.info.clone();
        background(r);
        return Ok(info);
    }
    let source = Source::new(path, options)?.resolve_dialect(engine)?;
    let mut info = source.inspect(engine)?;
    if source.is_queried_in_place() {
        info.dataset = Some(import::open_in_place(engine, &source)?);
    }
    Ok(info)
}

/// The first rows as Arrow IPC bytes: from the cache entry when there is
/// one, else read straight from the file.
pub fn preview(
    engine: &Engine,
    cache: &Cache,
    path: &Path,
    options: OpenOptions,
    key: &RequestKey,
) -> Result<Vec<u8>> {
    if let Some(r) = reopen(engine, cache, path, &options)?
        && let Some(DatasetSource::Table(table)) = r.info.dataset.as_ref().map(|d| &d.source)
    {
        return engine.query_ipc(
            &format!("SELECT * FROM {table} LIMIT {PREVIEW_ROWS}"),
            &[],
            PREVIEW_ROWS,
            key,
        );
    }
    Source::new(path, options)?
        .resolve_dialect(engine)?
        .preview_ipc(engine, PREVIEW_ROWS, key)
}

/// Imports the file (or reuses the cache) and returns a pageable dataset.
pub fn import(
    engine: &Engine,
    imports: &Imports,
    target: &ImportTarget<'_>,
    path: &Path,
    options: OpenOptions,
    job_id: &str,
    on_progress: &(dyn Fn(ImportProgress) + Sync),
) -> Result<ImportOutcome> {
    let source = Source::new(path, options.clone())?.resolve_dialect(engine)?;
    let out = import::import(engine, imports, target, &source, job_id, on_progress)?;
    if out.dataset.cached && target.cache.enabled() && !source.is_remote() {
        // The CSV delimiter may have been worked out: a reopen with the
        // options as asked finds this entry without sniffing.
        let open_key = cache::cache_key(&source.stamp()?, &options);
        target.cache.link(&open_key, &out.dataset.id);
    }
    Ok(out)
}
