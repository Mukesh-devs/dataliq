//! Datasets: tables the grid can page through by row number.

use std::collections::HashMap;

use parking_lot::RwLock;
use serde::Serialize;

use super::{Engine, Param, RequestKey};
use crate::error::{AppError, Result};

/// How a dataset's rows are read.
#[derive(Debug, Clone, PartialEq)]
pub enum DatasetSource {
    /// A quoted table name whose `rowid`s are contiguous from 0 (created with
    /// CREATE TABLE AS and never deleted from). Paged by rowid range.
    Table(String),
    /// A table expression read directly from the file (no import). Paged with
    /// LIMIT/OFFSET, so deep pages are slower; used when disk space is low.
    Query { sql: String, params: Vec<Param> },
    /// A Parquet file queried in place, paged with its `file_row_number`
    /// (DuckDB skips row groups, so any page costs about the same).
    Parquet { path: String },
    /// A view written to a session-only table (quoted, qualified name), in
    /// view order with contiguous rowids. Paged like `Table`; dropped when
    /// the dataset is closed.
    Materialized { table: String },
    /// A sorted view whose full sort is still being written (see
    /// `Engine::materialize_view`). Its first rows (`head`) and, once
    /// written, last rows (`tail`, stored in reverse) are small tables.
    /// Over a table, the rows' order by row id (`ordered`, from `order`) is
    /// written next, and pages in between read through it; otherwise they
    /// wait for the full table.
    Sorting {
        head: String,
        head_rows: u64,
        tail: Option<String>,
        tail_rows: u64,
        /// The view's sorted query, its exact reverse, and their parameters.
        select: String,
        reversed: String,
        params: Vec<Param>,
        order: Option<crate::view::RowOrder>,
        ordered: Option<String>,
    },
}

/// Data the grid can page through.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dataset {
    pub id: String,
    #[serde(skip)]
    pub source: DatasetSource,
    pub row_count: u64,
    /// Imported into the cache (false = read straight from the file).
    pub cached: bool,
}

#[derive(Default)]
pub struct Datasets {
    map: RwLock<HashMap<String, Dataset>>,
}

impl Datasets {
    pub fn insert(&self, dataset: Dataset) {
        self.map.write().insert(dataset.id.clone(), dataset);
    }

    pub fn get(&self, id: &str) -> Result<Dataset> {
        self.map
            .read()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::Query(format!("This data is no longer open ({id}).")))
    }

    pub fn remove(&self, id: &str) -> Option<Dataset> {
        self.map.write().remove(id)
    }

    /// Swaps how an open dataset's rows are read (same rows, same order).
    /// Returns false if the dataset was closed meanwhile.
    pub fn replace_source(&self, id: &str, source: DatasetSource) -> bool {
        match self.map.write().get_mut(id) {
            Some(ds) => {
                ds.source = source;
                true
            }
            None => false,
        }
    }

    /// Edits an open dataset's source in place. Returns false if the
    /// dataset was closed meanwhile.
    pub fn update_source(&self, id: &str, edit: impl FnOnce(&mut DatasetSource)) -> bool {
        match self.map.write().get_mut(id) {
            Some(ds) => {
                edit(&mut ds.source);
                true
            }
            None => false,
        }
    }

    pub fn ids(&self) -> Vec<String> {
        self.map.read().keys().cloned().collect()
    }
}

/// Largest page the grid may request at once.
pub const MAX_PAGE_ROWS: u64 = 10_000;

/// Rows of a sorted view written before the full sort (its first rows, and
/// its last rows in reverse), so the top and bottom show in about a second.
pub const MAX_HEAD: u64 = 10_000;

impl Engine {
    /// The dataset once rows `[start, start + count)` can be read: for a view
    /// still being sorted, waits (polling) until they are in its head, its
    /// tail, or the full table. Fails if the dataset is closed meanwhile.
    fn wait_for_rows(&self, id: &str, start: u64, count: u64) -> Result<Dataset> {
        loop {
            let ds = self.datasets.get(id)?;
            let end = start.saturating_add(count).min(ds.row_count);
            let ready = match &ds.source {
                DatasetSource::Sorting {
                    head_rows,
                    tail,
                    tail_rows,
                    ordered,
                    ..
                } => {
                    end <= *head_rows
                        || (tail.is_some() && start >= ds.row_count.saturating_sub(*tail_rows))
                        || ordered.is_some()
                }
                _ => true,
            };
            if ready {
                return Ok(ds);
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// Rows `[start, start + count)` of a dataset as Arrow IPC bytes. Pages by
    /// rowid range, which DuckDB answers in milliseconds anywhere in the table
    /// (no OFFSET scans).
    pub fn fetch_rows(
        &self,
        id: &str,
        start: u64,
        count: u64,
        key: &RequestKey,
    ) -> Result<Vec<u8>> {
        match self.fetch_rows_once(id, start, count, key) {
            // A sorted view can switch to its full table (dropping the small
            // ones) between choosing a table and reading it: read again.
            Err(AppError::Query(_))
                if matches!(
                    self.datasets.get(id).map(|d| d.source),
                    Ok(DatasetSource::Materialized { .. })
                ) =>
            {
                self.fetch_rows_once(id, start, count, key)
            }
            other => other,
        }
    }

    fn fetch_rows_once(
        &self,
        id: &str,
        start: u64,
        count: u64,
        key: &RequestKey,
    ) -> Result<Vec<u8>> {
        let count = count.min(MAX_PAGE_ROWS);
        let ds = self.wait_for_rows(id, start, count)?;
        let end = start.saturating_add(count).min(ds.row_count);
        match &ds.source {
            DatasetSource::Sorting {
                head, head_rows, ..
            } if end <= *head_rows => {
                let sql =
                    format!("SELECT * FROM {head} WHERE rowid >= ? AND rowid < ? ORDER BY rowid");
                let params = [Param::Int(start as i64), Param::Int(end as i64)];
                self.query_ipc(&sql, &params, count as usize, key)
            }
            DatasetSource::Sorting {
                tail: Some(tail),
                tail_rows,
                ..
            } if start >= ds.row_count.saturating_sub(*tail_rows) => {
                // The tail holds the last rows in reverse: row `i` of the view
                // is tail row `row_count - 1 - i`.
                let sql = format!(
                    "SELECT * FROM {tail} WHERE rowid > ? AND rowid <= ? ORDER BY rowid DESC"
                );
                let params = [
                    Param::Int(ds.row_count as i64 - 1 - end as i64),
                    Param::Int(ds.row_count as i64 - 1 - start as i64),
                ];
                self.query_ipc(&sql, &params, count as usize, key)
            }
            DatasetSource::Sorting {
                order: Some(order),
                ordered: Some(ordered),
                ..
            } => {
                let sql = order.page.replace(crate::view::ORDER_TABLE, ordered);
                let params = [Param::Int(start as i64), Param::Int(end as i64)];
                self.query_ipc(&sql, &params, count as usize, key)
            }
            DatasetSource::Sorting { .. } => unreachable!("wait_for_rows only returns ready rows"),
            DatasetSource::Table(relation) | DatasetSource::Materialized { table: relation } => {
                let sql = format!(
                    "SELECT * FROM {relation} WHERE rowid >= ? AND rowid < ? ORDER BY rowid"
                );
                let params = [Param::Int(start as i64), Param::Int(end as i64)];
                self.query_ipc(&sql, &params, count as usize, key)
            }
            DatasetSource::Parquet { path } => {
                let sql = "SELECT * EXCLUDE (file_row_number) \
                           FROM read_parquet(?, file_row_number = true) \
                           WHERE file_row_number >= ? AND file_row_number < ? \
                           ORDER BY file_row_number";
                let params = [
                    Param::Text(path.clone()),
                    Param::Int(start as i64),
                    Param::Int(end as i64),
                ];
                self.query_ipc(sql, &params, count as usize, key)
            }
            DatasetSource::Query { sql, params } => {
                let sql = format!("SELECT * FROM {sql} LIMIT ? OFFSET ?");
                let mut params = params.clone();
                params.push(Param::Int(end.saturating_sub(start) as i64));
                params.push(Param::Int(start as i64));
                self.query_ipc(&sql, &params, count as usize, key)
            }
        }
    }
}
