//! Background import of a file into a cached DuckDB database, with progress,
//! cancellation and an integrity check for gzip input.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

use crate::cache::{self, Cache, CacheMeta, SourceStamp};
use crate::engine::raw::{Progress, RawConnection};
use crate::engine::sql::quote_ident;
use crate::engine::{Dataset, DatasetSource, Engine};
use crate::error::{AppError, Result};
use crate::sources::{Compression, Source, excel, friendly_error, integrity};

/// Progress report sent to the UI while an import runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub job_id: String,
    /// 0–100 when DuckDB can estimate it (bytes read for CSV, incl. .gz).
    pub percent: Option<f64>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub dataset: Dataset,
    /// True when an existing cache entry was reused (no import ran).
    pub from_cache: bool,
    pub elapsed_ms: u64,
}

struct Job {
    conn: Arc<RawConnection>,
    cancelled: Arc<AtomicBool>,
}

/// Running imports, for cancellation.
#[derive(Default)]
pub struct Imports {
    jobs: Mutex<HashMap<String, Job>>,
}

impl Imports {
    pub fn cancel(&self, job_id: &str) -> bool {
        match self.jobs.lock().get(job_id) {
            Some(job) => {
                job.cancelled.store(true, Ordering::SeqCst);
                job.conn.interrupt();
                true
            }
            None => false,
        }
    }
}

/// Where the import writes: the persistent cache, or a temp file when
/// caching is disabled.
pub struct ImportTarget<'a> {
    pub cache: &'a Cache,
    /// Used instead of the cache dir when caching is off.
    pub temp_dir: PathBuf,
}

fn alias(key: &str) -> String {
    quote_ident(&format!("ds_{key}"))
}

fn sql_string(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Attaches a finished database read-only and registers it as a dataset.
fn attach(engine: &Engine, key: &str, db: &std::path::Path, row_count: u64) -> Result<Dataset> {
    let alias = alias(key);
    engine.execute_batch(&format!(
        "ATTACH IF NOT EXISTS {} AS {alias} (READ_ONLY)",
        sql_string(&db.to_string_lossy())
    ))?;
    let dataset = Dataset {
        id: key.to_string(),
        source: DatasetSource::Table(format!("{alias}.main.data")),
        row_count,
        cached: true,
    };
    engine.datasets.insert(dataset.clone());
    Ok(dataset)
}

/// Closes a dataset: removes it from the registry and detaches its database.
pub fn close_dataset(engine: &Engine, id: &str) -> Result<()> {
    // Stop a view that is still being written in the background.
    engine.cancel(&crate::view::materialize_request_id(id));
    if let Some(ds) = engine.datasets.remove(id) {
        match ds.source {
            DatasetSource::Table(_) => {
                engine.execute_batch(&format!("DETACH DATABASE IF EXISTS {}", alias(id)))?;
            }
            DatasetSource::Materialized { table } => {
                engine.execute_batch(&format!("DROP TABLE IF EXISTS {table}"))?;
            }
            DatasetSource::Sorting { head, tail, .. } => {
                engine.execute_batch(&format!("DROP TABLE IF EXISTS {head}"))?;
                if let Some(tail) = tail {
                    engine.execute_batch(&format!("DROP TABLE IF EXISTS {tail}"))?;
                }
            }
            DatasetSource::Query { .. } | DatasetSource::Parquet { .. } => {}
        }
    }
    Ok(())
}

/// Margin kept free on the cache disk.
const DISK_MARGIN: u64 = 1 << 30;

/// Conservative on-disk size of the imported database. DuckDB's columnar
/// compression typically stores CSV in ~20% of its text size (measured: 5 GB
/// CSV -> 0.96 GB; 100 MB .csv.gz -> 40 MB), so these leave room to spare.
fn estimate_db_bytes(source: &Source, file_size: u64) -> u64 {
    match source.detected.compression {
        Compression::Gzip | Compression::Zstd => file_size.saturating_mul(3) / 2,
        Compression::None => file_size / 2,
    }
}

/// Imports `source` (or reuses the cache) and returns a pageable dataset.
/// Blocking; run on a worker thread. `on_progress` is called ~4×/second.
pub fn import(
    engine: &Engine,
    imports: &Imports,
    target: &ImportTarget<'_>,
    source: &Source,
    job_id: &str,
    on_progress: &(dyn Fn(ImportProgress) + Sync),
) -> Result<ImportOutcome> {
    let started = Instant::now();
    let stamp = SourceStamp::of(&source.path)?;
    let key = cache::cache_key(&stamp, &source.options);
    let cache = target.cache;
    let caching = cache.config.enabled;

    // Already open in this session.
    if let Ok(ds) = engine.datasets.get(&key) {
        return Ok(ImportOutcome {
            dataset: ds,
            from_cache: true,
            elapsed_ms: 0,
        });
    }
    // Reopen an unchanged file: attach the cached database.
    if caching {
        if let Some(meta) = cache.lookup(&key) {
            let ds = attach(engine, &key, &cache.db_path(&key), meta.row_count)?;
            cache.touch(&key);
            return Ok(ImportOutcome {
                dataset: ds,
                from_cache: true,
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
        }
    }

    let dir = if caching {
        cache.config.dir.clone()
    } else {
        target.temp_dir.clone()
    };
    std::fs::create_dir_all(&dir)?;
    let needed = estimate_db_bytes(source, stamp.size);
    if let Some(free) = cache::available_space(&dir) {
        if free < needed.saturating_add(DISK_MARGIN) {
            return Err(AppError::LowDisk {
                needed,
                available: free,
            });
        }
    }

    let partial = dir.join(format!("{key}.duckdb.partial"));
    let final_path = dir.join(format!("{key}.duckdb"));
    let discard = || {
        let _ = std::fs::remove_file(&partial);
        let _ = std::fs::remove_file(partial.with_extension("partial.wal"));
    };
    discard();
    let staging = quote_ident(&format!("import_{key}"));
    engine.execute_batch(&format!(
        "ATTACH {} AS {staging}",
        sql_string(&partial.to_string_lossy())
    ))?;

    let conn = Arc::new(engine.raw_connection()?);
    let cancelled = Arc::new(AtomicBool::new(false));
    imports.jobs.lock().insert(
        job_id.to_string(),
        Job {
            conn: Arc::clone(&conn),
            cancelled: Arc::clone(&cancelled),
        },
    );
    let corrupt = AtomicBool::new(false);
    let done = AtomicBool::new(false);

    let is_excel = source.is_excel();
    let report = |percent: Option<f64>| {
        on_progress(ImportProgress {
            job_id: job_id.to_string(),
            percent,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    };
    let result: Result<u64> = std::thread::scope(|scope| {
        // Progress reporter for DuckDB readers (Excel reports per batch of rows).
        // Parked rather than sleeping, so it exits as soon as the import ends.
        let reporter = scope.spawn(|| {
            if is_excel {
                return;
            }
            loop {
                std::thread::park_timeout(Duration::from_millis(250));
                if done.load(Ordering::SeqCst) {
                    break;
                }
                let Progress { percent, .. } = conn.progress();
                report(percent);
            }
        });
        // Gzip integrity check, on another core, alongside DuckDB.
        let checker = (source.detected.compression == Compression::Gzip).then(|| {
            scope.spawn(|| match integrity::verify_gzip(&source.path, &done) {
                Ok(_) => {}
                Err(_) => {
                    corrupt.store(true, Ordering::SeqCst);
                    conn.interrupt();
                }
            })
        });

        let run = || -> Result<u64> {
            if is_excel {
                let sheet = source.load_excel(None)?;
                let conn = engine.connection()?;
                let staging_name = format!("import_{key}");
                return excel::write_table(
                    &conn,
                    Some(&staging_name),
                    "data",
                    &sheet,
                    &cancelled,
                    &|p| report(Some(p)),
                );
            }
            conn.execute("SET enable_progress_bar = true", &[])?;
            conn.execute("SET enable_progress_bar_print = false", &[])?;
            let (reader, params) = source.reader()?;
            // An interrupt only stops a running statement, so a cancel that
            // arrived before this point must be checked by hand.
            if cancelled.load(Ordering::SeqCst) {
                return Err(AppError::Cancelled);
            }
            conn.execute(
                &format!("CREATE TABLE {staging}.main.data AS SELECT * FROM {reader}"),
                &params,
            )
            .map_err(|e| match e {
                AppError::Query(m) => friendly_error(&m),
                other => other,
            })?;
            // The table must be complete: wait for the integrity check.
            if let Some(c) = checker {
                let _ = c.join();
            }
            if corrupt.load(Ordering::SeqCst) {
                return Err(AppError::Query(
                    "This compressed file looks damaged or incomplete, so it can't be fully read."
                        .into(),
                ));
            }
            let conn = engine.connection()?;
            let rows: i64 = conn.query_row(
                &format!("SELECT count(*) FROM {staging}.main.data"),
                [],
                |r| r.get(0),
            )?;
            Ok(rows as u64)
        };
        let r = run();
        done.store(true, Ordering::SeqCst);
        reporter.thread().unpark();
        r
    });
    imports.jobs.lock().remove(job_id);
    let _ = engine.execute_batch(&format!("DETACH DATABASE IF EXISTS {staging}"));

    // A cancel that raced with the end of the import still wins: the user
    // asked for it, and nothing has been committed to the cache yet.
    let result = match result {
        Ok(_) if cancelled.load(Ordering::SeqCst) => Err(AppError::Cancelled),
        other => other,
    };
    let rows = match result {
        Ok(rows) => rows,
        Err(e) => {
            discard();
            if corrupt.load(Ordering::SeqCst) {
                return Err(AppError::Query(
                    "This compressed file looks damaged or incomplete, so it can't be fully read."
                        .into(),
                ));
            }
            if cancelled.load(Ordering::SeqCst) {
                return Err(AppError::Cancelled);
            }
            return Err(e);
        }
    };

    if caching {
        let meta = CacheMeta {
            key: key.clone(),
            source: stamp,
            row_count: rows,
            created_ms: cache::now_ms(),
            last_used_ms: cache::now_ms(),
        };
        cache.commit(&meta)?;
    } else {
        std::fs::rename(&partial, &final_path)?;
    }
    let ds = attach(engine, &key, &final_path, rows)?;
    if caching {
        cache.cleanup(&engine.datasets.ids());
    }
    Ok(ImportOutcome {
        dataset: ds,
        from_cache: false,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Reads the file directly, without importing (e.g. when disk space is low).
pub fn open_direct(engine: &Engine, source: &Source) -> Result<Dataset> {
    let stamp = SourceStamp::of(&source.path)?;
    let key = format!("direct-{}", cache::cache_key(&stamp, &source.options));
    let (sql, params) = source.reader()?;
    let conn = engine.connection()?;
    let rows: i64 = conn
        .query_row(
            &format!("SELECT count(*) FROM {sql}"),
            duckdb::params_from_iter(params.iter()),
            |r| r.get(0),
        )
        .map_err(|e| friendly_error(&e.to_string()))?;
    let ds = Dataset {
        id: key,
        source: DatasetSource::Query { sql, params },
        row_count: rows as u64,
        cached: false,
    };
    engine.datasets.insert(ds.clone());
    Ok(ds)
}

/// Opens a Parquet file as a dataset without importing. The row count comes
/// from the file metadata, so this is instant even for 50M rows.
pub fn open_in_place(engine: &Engine, source: &Source) -> Result<Dataset> {
    let stamp = SourceStamp::of(&source.path)?;
    let key = format!("pq-{}", cache::cache_key(&stamp, &source.options));
    if let Ok(ds) = engine.datasets.get(&key) {
        return Ok(ds);
    }
    let path = source.path.to_string_lossy().into_owned();
    let conn = engine.connection()?;
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM read_parquet(?)", [&path], |r| {
            r.get(0)
        })
        .map_err(|e| friendly_error(&e.to_string()))?;
    // `file_row_number` paging needs the name to be free.
    let clash: i64 = conn
        .query_row(
            "SELECT count(*) FROM (DESCRIBE SELECT * FROM read_parquet(?)) \
             WHERE column_name = 'file_row_number'",
            [&path],
            |r| r.get(0),
        )
        .map_err(|e| friendly_error(&e.to_string()))?;
    let dataset_source = if clash == 0 {
        DatasetSource::Parquet { path }
    } else {
        let (sql, params) = source.reader()?;
        DatasetSource::Query { sql, params }
    };
    let ds = Dataset {
        id: key,
        source: dataset_source,
        row_count: rows as u64,
        cached: false,
    };
    engine.datasets.insert(ds.clone());
    Ok(ds)
}
