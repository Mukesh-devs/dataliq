//! DuckDB session: one in-memory database per app, a connection per query,
//! memory limit + spill directory from settings, and cancellable requests.

mod cancel;
pub mod datasets;
mod ipc;
mod param;
pub mod raw;
pub mod sql;

use std::path::PathBuf;

use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;
use duckdb::Connection;
use parking_lot::Mutex;

pub use cancel::RequestRegistry;
pub use datasets::{Dataset, DatasetSource, Datasets};
pub use ipc::batches_to_ipc;
pub use param::Param;

use crate::error::{AppError, Result};
use crate::settings::Settings;

/// Engine configuration derived from [`Settings`].
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub memory_limit_bytes: u64,
    pub temp_dir: PathBuf,
    pub threads: Option<u32>,
}

impl EngineConfig {
    pub fn from_settings(s: &Settings) -> Self {
        EngineConfig {
            memory_limit_bytes: s.memory_limit_bytes(),
            temp_dir: s.effective_temp_dir(),
            threads: s.threads,
        }
    }
}

/// Identifies a request so it can be cancelled. Starting a request in a
/// `group` (e.g. one grid view) cancels any older request in the same group.
#[derive(Debug, Clone, Default)]
pub struct RequestKey {
    pub id: Option<String>,
    pub group: Option<String>,
}

/// Rows of a query result as Arrow data.
pub struct QueryBatches {
    pub schema: SchemaRef,
    pub batches: Vec<RecordBatch>,
    /// Number of rows returned (after `max_rows`).
    pub rows: usize,
    /// True when the result had more than `max_rows` rows.
    pub truncated: bool,
}

pub struct Engine {
    /// Root connection. Only used to create per-query connections, which
    /// share the same database; DuckDB connections are not `Sync`.
    root: Mutex<Connection>,
    requests: RequestRegistry,
    /// Tables the grid can page through.
    pub datasets: Datasets,
    /// The database handle; declared last so it is closed after `root`.
    raw: raw::RawDb,
}

impl Engine {
    /// Opens an in-memory DuckDB database with the given limits.
    pub fn open_in_memory(cfg: &EngineConfig) -> Result<Engine> {
        std::fs::create_dir_all(&cfg.temp_dir)?;
        let mib = (cfg.memory_limit_bytes / (1024 * 1024)).max(1);
        let mut settings = vec![
            ("max_memory", format!("{mib}MiB")),
            (
                "temp_directory",
                cfg.temp_dir.to_string_lossy().into_owned(),
            ),
            // Fully offline: json/parquet are compiled in; never download extensions.
            ("autoload_known_extensions", "false".to_string()),
            ("autoinstall_known_extensions", "false".to_string()),
        ];
        if let Some(t) = cfg.threads {
            settings.push(("threads", t.max(1).to_string()));
        }
        let raw = raw::RawDb::open_in_memory(&settings)?;
        // SAFETY: `raw` outlives every connection: it is dropped last (field
        // order) and connections are only used while the Engine is alive.
        let conn = unsafe { Connection::open_from_raw(raw.handle())? };
        Ok(Engine {
            root: Mutex::new(conn),
            requests: RequestRegistry::default(),
            datasets: Datasets::default(),
            raw,
        })
    }

    /// A raw connection for a long statement whose progress can be polled.
    pub fn raw_connection(&self) -> Result<raw::RawConnection> {
        raw::RawConnection::connect(&self.raw)
    }

    /// A new connection to the shared database, for one query on one thread.
    pub fn connection(&self) -> Result<Connection> {
        Ok(self.root.lock().try_clone()?)
    }

    /// Runs `sql` with bound `params` and returns up to `max_rows` rows.
    /// Blocking: call from `spawn_blocking`.
    pub fn query(
        &self,
        sql: &str,
        params: &[Param],
        max_rows: usize,
        key: &RequestKey,
    ) -> Result<QueryBatches> {
        let conn = self.connection()?;
        let guard = self.requests.register(key, conn.interrupt_handle());
        if guard.is_cancelled() {
            return Err(AppError::Cancelled);
        }
        let mut stmt = conn.prepare(sql)?;
        let arrow = stmt.query_arrow(duckdb::params_from_iter(params.iter()))?;
        let schema = arrow.get_schema();
        let mut batches = Vec::new();
        let mut rows = 0usize;
        let mut truncated = false;
        for batch in arrow {
            if rows + batch.num_rows() > max_rows {
                let take = max_rows - rows;
                if take > 0 {
                    batches.push(batch.slice(0, take));
                }
                rows = max_rows;
                truncated = true;
                break;
            }
            rows += batch.num_rows();
            batches.push(batch);
        }
        if guard.is_cancelled() {
            return Err(AppError::Cancelled);
        }
        Ok(QueryBatches {
            schema,
            batches,
            rows,
            truncated,
        })
    }

    /// Like [`Engine::query`] but encodes the result as Arrow IPC stream bytes.
    pub fn query_ipc(
        &self,
        sql: &str,
        params: &[Param],
        max_rows: usize,
        key: &RequestKey,
    ) -> Result<Vec<u8>> {
        let result = self.query(sql, params, max_rows, key)?;
        batches_to_ipc(&result.schema, &result.batches)
    }

    /// Runs statements that return no rows (DDL, SET, …).
    pub fn execute_batch(&self, sql: &str) -> Result<()> {
        Ok(self.connection()?.execute_batch(sql)?)
    }

    /// Whether a request with this id is currently running.
    pub fn is_running(&self, request_id: &str) -> bool {
        self.requests.is_running(request_id)
    }

    /// Cancels a running request. Returns false if it was not running.
    pub fn cancel(&self, request_id: &str) -> bool {
        self.requests.cancel(request_id)
    }
}
