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

    pub fn ids(&self) -> Vec<String> {
        self.map.read().keys().cloned().collect()
    }
}

/// Largest page the grid may request at once.
pub const MAX_PAGE_ROWS: u64 = 10_000;

impl Engine {
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
        let ds = self.datasets.get(id)?;
        let count = count.min(MAX_PAGE_ROWS);
        let end = start.saturating_add(count).min(ds.row_count);
        match &ds.source {
            DatasetSource::Table(relation) => {
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
