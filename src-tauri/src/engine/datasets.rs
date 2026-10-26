//! Datasets: tables the grid can page through by row number.

use std::collections::HashMap;

use parking_lot::RwLock;
use serde::Serialize;

use super::{Engine, Param, RequestKey};
use crate::error::{AppError, Result};

/// A pageable table. `relation` is a quoted table name whose `rowid`s are
/// contiguous from 0 (tables created with CREATE TABLE AS, never deleted from).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dataset {
    pub id: String,
    #[serde(skip)]
    pub relation: String,
    pub row_count: u64,
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
        let sql = format!(
            "SELECT * FROM {} WHERE rowid >= ? AND rowid < ? ORDER BY rowid",
            ds.relation
        );
        let params = [Param::Int(start as i64), Param::Int(end as i64)];
        self.query_ipc(&sql, &params, count as usize, key)
    }
}
