//! Opening views as pageable datasets, and value lists for filters.

use std::sync::atomic::{AtomicU64, Ordering};

use arrow::array::{Array, AsArray};
use arrow::datatypes::Int64Type;
use serde::Serialize;

use super::{BuiltView, Filter, FilterOp, Relation, ViewSpec, build};
use crate::engine::datasets::MAX_HEAD;
use crate::engine::sql::quote_ident;
use crate::engine::{Dataset, DatasetSource, Engine, Param, RequestKey};
use crate::error::{AppError, Result};
use crate::sources::ColumnMeta;

/// Most values a value list returns.
pub const MAX_VALUES: usize = 1000;

static NEXT_VIEW: AtomicU64 = AtomicU64::new(1);

/// Request id of a view's background materialization, for cancelling it.
pub fn materialize_request_id(view_id: &str) -> String {
    format!("materialize:{view_id}")
}

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
    /// The view still reads through its query; it is being written to a
    /// table in the background (see [`Engine::materialize_view`]).
    pub materializing: bool,
}

impl Engine {
    /// The view of `spec` on dataset `id` as standalone SQL over `reader`
    /// (see [`super::standalone_sql`]), with "today" as the local date.
    pub fn view_sql(
        &self,
        id: &str,
        spec: &ViewSpec,
        reader: &str,
        labels: &std::collections::HashMap<String, String>,
    ) -> Result<String> {
        let schema = self.dataset_columns(id)?;
        super::standalone_sql(
            spec,
            reader,
            &schema,
            labels,
            chrono::Local::now().date_naive(),
        )
    }

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

    pub(crate) fn count(&self, sql: &str, params: &[Param], key: &RequestKey) -> Result<u64> {
        let out = self.query(sql, params, 1, key)?;
        let batch = out
            .batches
            .first()
            .ok_or_else(|| AppError::Internal("count returned no rows".into()))?;
        let col = batch.column(0).as_primitive::<Int64Type>();
        Ok(col.value(0) as u64)
    }

    /// Writes `view` to a new session table and returns its qualified name.
    fn write_view(&self, view_id: &str, view: &BuiltView, key: &RequestKey) -> Result<String> {
        let table = format!(
            "{}.{}",
            self.scratch_schema()?,
            quote_ident(&format!("v_{view_id}"))
        );
        let sql = format!("CREATE TABLE {table} AS {}", view.select);
        if let Err(e) = self.execute_keyed(&sql, &view.params, key) {
            let _ = self.execute_batch(&format!("DROP TABLE IF EXISTS {table}"));
            return Err(e);
        }
        Ok(table)
    }

    /// Opens `spec` over dataset `id` as a new dataset the grid can page
    /// through. Close it with `close_dataset` when it is replaced.
    ///
    /// Sorted views are written to a table right away (the sort reads every
    /// row anyway), so every page is a fast rowid range. Unsorted views are
    /// only counted, which is quick, and read through their query until
    /// [`Engine::materialize_view`] has written them out.
    pub fn open_view(&self, id: &str, spec: &ViewSpec, key: &RequestKey) -> Result<OpenedView> {
        let started = std::time::Instant::now();
        let base = self.datasets.get(id)?;
        let schema = self.dataset_columns(id)?;
        let view = build(spec, &Relation::of(&base.source), &schema)?;
        let view_id = format!("view-{}", NEXT_VIEW.fetch_add(1, Ordering::Relaxed));
        let (source, rows, materializing) = if spec.sort.is_empty() {
            let rows = self.count(&view.count, &view.params, key)?;
            let source = DatasetSource::Query {
                sql: format!("({})", view.select),
                params: view.params,
            };
            (source, rows, true)
        } else {
            // A full sort of millions of rows takes a while; its first rows
            // only need one scan (top-N). Write those now, the rest later.
            let rows = self.count(&view.count, &view.params, key)?;
            let head = BuiltView {
                select: format!("{} LIMIT {MAX_HEAD}", view.select),
                ..view.clone()
            };
            let table = self.write_view(&format!("{view_id}_head"), &head, key)?;
            if rows <= MAX_HEAD {
                (DatasetSource::Materialized { table }, rows, false)
            } else {
                let source = DatasetSource::Sorting {
                    head: table,
                    head_rows: MAX_HEAD,
                    tail: None,
                    tail_rows: 0,
                    select: view.select,
                    reversed: view.reversed.unwrap_or_default(),
                    params: view.params,
                };
                (source, rows, true)
            }
        };
        let dataset = Dataset {
            id: view_id,
            source,
            row_count: rows,
            cached: base.cached,
        };
        self.datasets.insert(dataset.clone());
        Ok(OpenedView {
            dataset,
            total_rows: base.row_count,
            elapsed_ms: started.elapsed().as_millis() as u64,
            materializing,
        })
    }

    /// Finishes a view opened by [`Engine::open_view`] in the background:
    /// an unsorted view is written to a table so deep pages are as fast as
    /// the first; a sorted one first gets its last rows (so jumping to the
    /// end is quick), then its full sort. The dataset then switches to the
    /// table: same rows, same order, so the grid doesn't notice. Returns
    /// false if there was nothing to do or the view was closed meanwhile;
    /// `close_dataset` cancels a running materialization.
    pub fn materialize_view(&self, view_id: &str) -> Result<bool> {
        let key = RequestKey {
            id: Some(materialize_request_id(view_id)),
            group: None,
        };
        let ds = self.datasets.get(view_id)?;
        let (select, params, partial) = match ds.source {
            DatasetSource::Query { sql, params } => (format!("SELECT * FROM {sql}"), params, None),
            DatasetSource::Sorting {
                head,
                select,
                reversed,
                params,
                ..
            } => {
                let tail_view = BuiltView {
                    select: format!("{reversed} LIMIT {MAX_HEAD}"),
                    count: String::new(),
                    reversed: None,
                    params: params.clone(),
                };
                let tail = self.write_view(&format!("{view_id}_tail"), &tail_view, &key)?;
                let switched = self.datasets.update_source(view_id, |source| {
                    if let DatasetSource::Sorting {
                        tail: t, tail_rows, ..
                    } = source
                    {
                        *t = Some(tail.clone());
                        *tail_rows = MAX_HEAD;
                    }
                });
                if !switched {
                    self.execute_batch(&format!("DROP TABLE IF EXISTS {tail}"))?;
                    return Ok(false);
                }
                (select, params, Some((head, tail)))
            }
            _ => return Ok(false),
        };
        let view = BuiltView {
            select,
            count: String::new(),
            reversed: None,
            params,
        };
        let table = self.write_view(view_id, &view, &key)?;
        let switched = self.datasets.replace_source(
            view_id,
            DatasetSource::Materialized {
                table: table.clone(),
            },
        );
        if !switched {
            self.execute_batch(&format!("DROP TABLE IF EXISTS {table}"))?;
        }
        if let Some((head, tail)) = partial {
            // Pages still reading the small tables hold their own snapshot.
            self.execute_batch(&format!(
                "DROP TABLE IF EXISTS {head}; DROP TABLE IF EXISTS {tail}"
            ))?;
        }
        Ok(switched)
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
