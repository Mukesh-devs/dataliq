//! DuckDB session: one in-memory database per app, a connection per query,
//! memory limit + spill directory from settings, and cancellable requests.

mod cancel;
pub mod datasets;
mod extensions;
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

/// File name prefix of scratch databases (`views-<pid>-<n>.duckdb`).
pub const SCRATCH_PREFIX: &str = "views-";

fn next_scratch() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

/// Deletes scratch databases left in `dir` by an earlier session that did
/// not exit cleanly. Call once at app start (the app is single-instance).
pub fn remove_stale_scratch(dir: &std::path::Path) {
    let own = format!("{SCRATCH_PREFIX}{}-", std::process::id());
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(SCRATCH_PREFIX) && !name.starts_with(&own) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

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
    /// Session-only on-disk database for materialized views, attached on
    /// first use and deleted when the engine is dropped.
    scratch: Mutex<Option<PathBuf>>,
    temp_dir: PathBuf,
    requests: RequestRegistry,
    /// Tables the grid can page through.
    pub datasets: Datasets,
    /// Held (shared) by every running query and import; `release_memory`
    /// only runs when it can take it exclusively, i.e. when nothing runs.
    busy: parking_lot::RwLock<()>,
    /// The SQL panel's own connection, so temp tables and `SET` last from
    /// one statement to the next. Created on first use.
    session: Mutex<Option<Connection>>,
    /// httpfs, loaded only when a URL is opened.
    pub(crate) extensions: extensions::ExtensionState,
    /// Database files attached this session (SQLite, DuckDB).
    pub(crate) attached: crate::sources::database::Attached,
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
            // Offline by default: json/parquet are compiled in, and the others
            // are installed only when a file needs them (see `extensions`).
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
            scratch: Mutex::new(None),
            session: Mutex::new(None),
            busy: parking_lot::RwLock::new(()),
            temp_dir: cfg.temp_dir.clone(),
            requests: RequestRegistry::default(),
            datasets: Datasets::default(),
            extensions: extensions::ExtensionState::default(),
            attached: Default::default(),
            raw,
        })
    }

    /// Schema for session-only tables (materialized views), attached on first
    /// use: `dl_scratch.main`. On disk, so big views are compressed and
    /// don't count against the memory limit.
    pub fn scratch_schema(&self) -> Result<&'static str> {
        let mut scratch = self.scratch.lock();
        if scratch.is_none() {
            let path = self.temp_dir.join(format!(
                "{SCRATCH_PREFIX}{}-{}.duckdb",
                std::process::id(),
                next_scratch()
            ));
            let _ = std::fs::remove_file(&path);
            self.execute_batch(&format!(
                "ATTACH '{}' AS dl_scratch",
                path.to_string_lossy().replace('\'', "''")
            ))?;
            *scratch = Some(path);
        }
        Ok("dl_scratch.main")
    }

    /// Runs a statement that returns no rows (e.g. `CREATE TABLE … AS`),
    /// cancellable through `key` like a query.
    pub fn execute_keyed(&self, sql: &str, params: &[Param], key: &RequestKey) -> Result<usize> {
        self.execute_on(&self.connection()?, sql, params, key)
    }

    /// Like [`Engine::execute_keyed`], on a given connection (e.g. the session).
    pub fn execute_on(
        &self,
        conn: &Connection,
        sql: &str,
        params: &[Param],
        key: &RequestKey,
    ) -> Result<usize> {
        let _busy = self.busy();
        let guard = self.requests.register(key, conn.interrupt_handle());
        // An interrupt only stops a running statement: check before and after.
        if guard.is_cancelled() {
            return Err(AppError::Cancelled);
        }
        let result = conn.execute(sql, duckdb::params_from_iter(params.iter()));
        if guard.is_cancelled() {
            return Err(AppError::Cancelled);
        }
        Ok(result?)
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
        self.query_with(&conn, sql, params, max_rows, key)
    }

    /// Like [`Engine::query`], on the SQL panel's session connection.
    /// Statements run one at a time; a newer one in the same group cancels
    /// the running one first.
    pub fn query_session(
        &self,
        sql: &str,
        params: &[Param],
        max_rows: usize,
        key: &RequestKey,
    ) -> Result<QueryBatches> {
        self.with_session(key, |conn| {
            self.query_with(conn, sql, params, max_rows, key)
        })
    }

    /// Runs `f` on the SQL panel's session connection, one at a time. An
    /// older statement of `key`'s group is interrupted first so the session
    /// frees up, unless a newer one already replaced this request.
    pub fn with_session<T>(
        &self,
        key: &RequestKey,
        f: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        if self.requests.claim(key) {
            return Err(AppError::Cancelled);
        }
        let mut session = self.session.lock();
        if session.is_none() {
            *session = Some(self.connection()?);
        }
        f(session.as_ref().expect("session connection just created"))
    }

    fn query_with(
        &self,
        conn: &Connection,
        sql: &str,
        params: &[Param],
        max_rows: usize,
        key: &RequestKey,
    ) -> Result<QueryBatches> {
        let _busy = self.busy();
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

    /// Like [`Engine::query_session`] but encodes the result as Arrow IPC.
    pub fn query_ipc_session(
        &self,
        sql: &str,
        max_rows: usize,
        key: &RequestKey,
    ) -> Result<Vec<u8>> {
        let result = self.query_session(sql, &[], max_rows, key)?;
        batches_to_ipc(&result.schema, &result.batches)
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

    /// Runs a query on a caller-owned connection (e.g. one holding temp
    /// tables) and encodes the result as Arrow IPC.
    pub fn query_ipc_on(conn: &Connection, sql: &str, max_rows: usize) -> Result<Vec<u8>> {
        let mut stmt = conn.prepare(sql)?;
        let arrow = stmt.query_arrow([])?;
        let schema = arrow.get_schema();
        let mut batches = Vec::new();
        let mut rows = 0;
        for batch in arrow {
            if rows >= max_rows {
                break;
            }
            let take = batch.num_rows().min(max_rows - rows);
            rows += take;
            batches.push(batch.slice(0, take));
        }
        batches_to_ipc(&schema, &batches)
    }

    /// Gives DuckDB's cached data pages back (they are read again from the
    /// cache files when needed) by lowering the memory limit for a moment.
    /// Does nothing while a query or import runs, so none runs short of memory.
    pub fn release_memory(&self) -> Result<bool> {
        let Some(_idle) = self.busy.try_write() else {
            return Ok(false);
        };
        let conn = self.connection()?;
        let limit: String =
            conn.query_row("SELECT current_setting('memory_limit')", [], |r| r.get(0))?;
        conn.execute_batch("SET memory_limit = '64MB'")?;
        // Always restore, even if eviction complained.
        conn.execute_batch(&format!("SET memory_limit = '{}'", limit.replace('\'', "")))?;
        Ok(true)
    }

    /// New memory and thread limits from Settings, for every connection.
    pub fn set_limits(&self, memory_limit_bytes: u64, threads: Option<u32>) -> Result<()> {
        let mib = (memory_limit_bytes / (1024 * 1024)).max(1);
        let threads = threads
            .map(|t| t.max(1) as usize)
            .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()));
        self.execute_batch(&format!(
            "SET memory_limit = '{mib}MiB'; SET threads = {threads};"
        ))
    }

    /// Marks work in progress for [`Engine::release_memory`] until dropped.
    /// Nesting is fine: the exclusive side is only ever tried, never waited for.
    pub fn busy(&self) -> parking_lot::RwLockReadGuard<'_, ()> {
        self.busy.read()
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

impl Drop for Engine {
    fn drop(&mut self) {
        if let Some(path) = self.scratch.lock().take() {
            let _ = self
                .root
                .lock()
                .execute_batch("DETACH DATABASE IF EXISTS dl_scratch");
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(path.with_extension("duckdb.wal"));
        }
    }
}
