//! Minimal safe wrappers over DuckDB's C API for what the `duckdb` crate does
//! not expose: owning the database handle, and running a long statement on a
//! raw connection whose progress another thread can read
//! (`duckdb_query_progress`). Used for background imports.

use std::ffi::{CStr, CString, c_char};
use std::ptr;

use duckdb::ffi;

use super::Param;
use crate::error::{AppError, Result};

fn cstring(s: &str) -> Result<CString> {
    CString::new(s).map_err(|_| AppError::Query("Text contains a NUL byte.".into()))
}

/// Reads and (optionally) frees a C error string.
unsafe fn take_error(err: *const c_char, free: bool) -> String {
    if err.is_null() {
        return "unknown DuckDB error".into();
    }
    let msg = unsafe { CStr::from_ptr(err) }
        .to_string_lossy()
        .into_owned();
    if free {
        unsafe { ffi::duckdb_free(err as *mut _) };
    }
    msg
}

/// An open DuckDB database. Closed on drop, so it must outlive every
/// connection made from it (the `Engine` guarantees this).
pub struct RawDb(ffi::duckdb_database);

// DuckDB database handles are thread-safe.
unsafe impl Send for RawDb {}
unsafe impl Sync for RawDb {}

impl RawDb {
    /// Opens an in-memory database with the given settings.
    pub fn open_in_memory(settings: &[(&str, String)]) -> Result<RawDb> {
        unsafe {
            let mut config: ffi::duckdb_config = ptr::null_mut();
            if ffi::duckdb_create_config(&mut config) != ffi::duckdb_state_DuckDBSuccess {
                return Err(AppError::Internal("could not create DuckDB config".into()));
            }
            for (name, value) in settings {
                let (n, v) = (cstring(name)?, cstring(value)?);
                if ffi::duckdb_set_config(config, n.as_ptr(), v.as_ptr())
                    != ffi::duckdb_state_DuckDBSuccess
                {
                    ffi::duckdb_destroy_config(&mut config);
                    return Err(AppError::Settings(format!(
                        "invalid DuckDB setting {name} = {value}"
                    )));
                }
            }
            let mut db: ffi::duckdb_database = ptr::null_mut();
            let mut err: *mut c_char = ptr::null_mut();
            // A null path opens an in-memory database.
            let rc = ffi::duckdb_open_ext(ptr::null(), &mut db, config, &mut err);
            ffi::duckdb_destroy_config(&mut config);
            if rc != ffi::duckdb_state_DuckDBSuccess {
                return Err(AppError::Internal(take_error(err, true)));
            }
            Ok(RawDb(db))
        }
    }

    pub fn handle(&self) -> ffi::duckdb_database {
        self.0
    }
}

impl Drop for RawDb {
    fn drop(&mut self) {
        unsafe { ffi::duckdb_close(&mut self.0) };
    }
}

/// Snapshot of a running statement's progress.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Progress {
    /// 0–100, or `None` while DuckDB cannot estimate it yet.
    pub percent: Option<f64>,
    pub rows_processed: u64,
    pub total_rows: u64,
}

/// A raw connection for one long-running statement. `execute` must be called
/// from one thread at a time; `progress` and `interrupt` may be called from
/// any thread while it runs.
pub struct RawConnection {
    con: ffi::duckdb_connection,
}

// `duckdb_query_progress` reads atomics and `duckdb_interrupt` is designed to
// be called from other threads; `execute` is only used by one thread.
unsafe impl Send for RawConnection {}
unsafe impl Sync for RawConnection {}

impl RawConnection {
    pub fn connect(db: &RawDb) -> Result<RawConnection> {
        let mut con: ffi::duckdb_connection = ptr::null_mut();
        let rc = unsafe { ffi::duckdb_connect(db.handle(), &mut con) };
        if rc != ffi::duckdb_state_DuckDBSuccess {
            return Err(AppError::Internal("could not connect to DuckDB".into()));
        }
        Ok(RawConnection { con })
    }

    /// Prepares, binds and runs one statement, discarding its result.
    pub fn execute(&self, sql: &str, params: &[Param]) -> Result<()> {
        let sql = cstring(sql)?;
        unsafe {
            let mut stmt: ffi::duckdb_prepared_statement = ptr::null_mut();
            if ffi::duckdb_prepare(self.con, sql.as_ptr(), &mut stmt)
                != ffi::duckdb_state_DuckDBSuccess
            {
                let msg = take_error(ffi::duckdb_prepare_error(stmt), false);
                ffi::duckdb_destroy_prepare(&mut stmt);
                return Err(error_from(msg));
            }
            // Keep CStrings alive until execution.
            let mut texts = Vec::new();
            for (i, p) in params.iter().enumerate() {
                let idx = (i + 1) as ffi::idx_t;
                let rc = match p {
                    Param::Null => ffi::duckdb_bind_null(stmt, idx),
                    Param::Bool(b) => ffi::duckdb_bind_boolean(stmt, idx, *b),
                    Param::Int(v) => ffi::duckdb_bind_int64(stmt, idx, *v),
                    Param::Float(v) => ffi::duckdb_bind_double(stmt, idx, *v),
                    Param::Text(s) => {
                        let c = cstring(s)?;
                        let rc = ffi::duckdb_bind_varchar(stmt, idx, c.as_ptr());
                        texts.push(c);
                        rc
                    }
                };
                if rc != ffi::duckdb_state_DuckDBSuccess {
                    ffi::duckdb_destroy_prepare(&mut stmt);
                    return Err(AppError::Internal(format!(
                        "could not bind parameter {idx}"
                    )));
                }
            }
            let mut result: ffi::duckdb_result = std::mem::zeroed();
            let rc = ffi::duckdb_execute_prepared(stmt, &mut result);
            let outcome = if rc == ffi::duckdb_state_DuckDBSuccess {
                Ok(())
            } else {
                Err(error_from(take_error(
                    ffi::duckdb_result_error(&mut result),
                    false,
                )))
            };
            ffi::duckdb_destroy_result(&mut result);
            ffi::duckdb_destroy_prepare(&mut stmt);
            drop(texts);
            outcome
        }
    }

    pub fn progress(&self) -> Progress {
        let p = unsafe { ffi::duckdb_query_progress(self.con) };
        Progress {
            percent: (p.percentage >= 0.0).then_some(p.percentage),
            rows_processed: p.rows_processed,
            total_rows: p.total_rows_to_process,
        }
    }

    pub fn interrupt(&self) {
        unsafe { ffi::duckdb_interrupt(self.con) };
    }
}

impl Drop for RawConnection {
    fn drop(&mut self) {
        unsafe { ffi::duckdb_disconnect(&mut self.con) };
    }
}

fn error_from(msg: String) -> AppError {
    if msg.contains("Interrupted") {
        AppError::Cancelled
    } else {
        AppError::Query(msg)
    }
}
