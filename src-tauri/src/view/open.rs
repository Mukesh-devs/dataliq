//! Opening views as pageable datasets, and value lists for filters.

use std::sync::atomic::{AtomicU64, Ordering};

use arrow::array::{Array, AsArray};
use arrow::datatypes::Int64Type;
use serde::Serialize;

use super::{Filter, FilterOp, Relation, ViewSpec, build};
use crate::engine::{Dataset, DatasetSource, Engine, Param, RequestKey};
use crate::error::{AppError, Result};
use crate::sources::ColumnMeta;

/// Most values a value list returns.
pub const MAX_VALUES: usize = 1000;

static NEXT_VIEW: AtomicU64 = AtomicU64::new(1);

/// One entry of a column's value list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueCount {
    /// The value as text (`None` = NULL). Bound back as a parameter, DuckDB
    /// casts it to the column's type, so it round-trips for every
    /// non-nested type.
    pub value: Option<String>,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueList {
    pub values: Vec<ValueCount>,
    /// More distinct values exist than were returned.
    pub truncated: bool,
}

/// A view opened as a dataset.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedView {
    pub dataset: Dataset,
    /// Rows in the underlying dataset, for "N of M rows".
    pub total_rows: u64,
    pub elapsed_ms: u64,
}

impl Engine {
    /// Column names and DuckDB types of an open dataset.
    pub fn dataset_columns(&self, id: &str) -> Result<Vec<ColumnMeta>> {
        let ds = self.datasets.get(id)?;
        let rel = Relation::of(&ds.source);
        let conn = self.connection()?;
        let mut stmt = conn.prepare(&format!(
            "SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM {})",
            rel.sql
        ))?;
        let cols = stmt
            .query_map(duckdb::params_from_iter(rel.params.iter()), |r| {
                Ok(ColumnMeta {
                    name: r.get(0)?,
                    r#type: r.get(1)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(cols)
    }

    fn count(&self, sql: &str, params: &[Param], key: &RequestKey) -> Result<u64> {
        let out = self.query(sql, params, 1, key)?;
        let batch = out
            .batches
            .first()
            .ok_or_else(|| AppError::Internal("count returned no rows".into()))?;
        let col = batch.column(0).as_primitive::<Int64Type>();
        Ok(col.value(0) as u64)
    }

    /// Counts the rows of `spec` over dataset `id` and registers the view as
    /// a new dataset the grid can page through. Close it with
    /// `close_dataset` when it is replaced.
    pub fn open_view(&self, id: &str, spec: &ViewSpec, key: &RequestKey) -> Result<OpenedView> {
        let started = std::time::Instant::now();
        let base = self.datasets.get(id)?;
        let schema = self.dataset_columns(id)?;
        let view = build(spec, &Relation::of(&base.source), &schema)?;
        let rows = self.count(&view.count, &view.params, key)?;
        let dataset = Dataset {
            id: format!("view-{}", NEXT_VIEW.fetch_add(1, Ordering::Relaxed)),
            source: DatasetSource::Query {
                sql: format!("({})", view.select),
                params: view.params,
            },
            row_count: rows,
            cached: base.cached,
        };
        self.datasets.insert(dataset.clone());
        Ok(OpenedView {
            dataset,
            total_rows: base.row_count,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// The most frequent values of `column` among the rows matching the
    /// view's *other* filters (so a value list shows what it can still
    /// select), optionally narrowed to values containing `search`.
    pub fn column_values(
        &self,
        id: &str,
        spec: &ViewSpec,
        column: &str,
        search: Option<&str>,
        limit: usize,
        key: &RequestKey,
    ) -> Result<ValueList> {
        let base = self.datasets.get(id)?;
        let schema = self.dataset_columns(id)?;
        let mut filters: Vec<Filter> = spec
            .filters
            .iter()
            .filter(|f| f.column != column)
            .cloned()
            .collect();
        if let Some(s) = search.filter(|s| !s.is_empty()) {
            filters.push(Filter {
                column: column.to_string(),
                op: FilterOp::Contains {
                    value: s.to_string(),
                    case_sensitive: false,
                },
                not: false,
            });
        }
        let narrowed = ViewSpec {
            filters,
            search: spec.search.clone(),
            ..ViewSpec::default()
        };
        let view = build(&narrowed, &Relation::of(&base.source), &schema)?;
        let col = crate::engine::sql::quote_ident(column);
        let limit = limit.clamp(1, MAX_VALUES);
        let sql = format!(
            "SELECT CAST({col} AS VARCHAR) AS value, count(*) AS n FROM ({}) \
             GROUP BY 1 ORDER BY n DESC, value ASC NULLS FIRST LIMIT {}",
            view.select,
            limit + 1
        );
        let out = self.query(&sql, &view.params, limit + 1, key)?;
        let mut values = Vec::new();
        for batch in &out.batches {
            let text = batch.column(0).as_string::<i32>();
            let counts = batch.column(1).as_primitive::<Int64Type>();
            for i in 0..batch.num_rows() {
                values.push(ValueCount {
                    value: (!text.is_null(i)).then(|| text.value(i).to_string()),
                    count: counts.value(i) as u64,
                });
            }
        }
        let truncated = values.len() > limit;
        values.truncate(limit);
        Ok(ValueList { values, truncated })
    }
}
