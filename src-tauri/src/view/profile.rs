//! Column profiles over a view: summary statistics, a histogram and the
//! most common values, computed in DuckDB (only the small result leaves it).

use arrow::array::{Array, AsArray};
use arrow::datatypes::{Float64Type, Int64Type};
use serde::Serialize;

use super::{BuiltView, Relation, ValueCount, ViewSpec, build};
use crate::engine::sql::quote_ident;
use crate::engine::{Engine, Param, RequestKey};
use crate::error::{AppError, Result};
use crate::sources::ColumnMeta;

/// Bars in a histogram.
pub const BINS: usize = 20;
/// Most common values listed in a profile.
pub const TOP_VALUES: usize = 10;
/// Up to this many rows, distinct values are counted exactly; above, with
/// DuckDB's HyperLogLog estimate (much faster on tens of millions of rows).
pub const EXACT_DISTINCT_ROWS: u64 = 10_000_000;

/// What kind of statistics fit a column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileKind {
    Number,
    /// Dates and timestamps; histogram edges are seconds since 1970.
    Temporal,
    Text,
    Boolean,
    Other,
}

impl ProfileKind {
    pub fn of(duckdb_type: &str) -> ProfileKind {
        let t = duckdb_type.to_ascii_uppercase();
        let numeric = [
            "TINYINT",
            "SMALLINT",
            "INTEGER",
            "BIGINT",
            "HUGEINT",
            "UTINYINT",
            "USMALLINT",
            "UINTEGER",
            "UBIGINT",
            "UHUGEINT",
            "FLOAT",
            "DOUBLE",
        ];
        if numeric.contains(&t.as_str()) || t.starts_with("DECIMAL") {
            ProfileKind::Number
        } else if t == "DATE" || t.starts_with("TIMESTAMP") {
            ProfileKind::Temporal
        } else if t == "VARCHAR" {
            ProfileKind::Text
        } else if t == "BOOLEAN" {
            ProfileKind::Boolean
        } else {
            ProfileKind::Other
        }
    }

    fn is_integer(duckdb_type: &str) -> bool {
        let t = duckdb_type.to_ascii_uppercase();
        t.ends_with("INT") || t == "INTEGER" || t.ends_with("INTEGER")
    }
}

/// One bar: values in `[lo, hi)` (the last bar includes `hi`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bin {
    pub lo: f64,
    pub hi: f64,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnProfile {
    pub column: String,
    /// DuckDB type name.
    pub r#type: String,
    pub kind: ProfileKind,
    /// Rows in the view.
    pub rows: u64,
    pub nulls: u64,
    pub distinct: Option<u64>,
    /// `distinct` is an estimate (views over [`EXACT_DISTINCT_ROWS`] rows).
    pub distinct_approx: bool,
    /// Smallest and largest value, as text (none for nested types).
    pub min: Option<String>,
    pub max: Option<String>,
    /// Numbers only.
    pub mean: Option<f64>,
    pub stddev: Option<f64>,
    /// Numbers, dates and timestamps; empty when every value is NULL.
    pub histogram: Option<Vec<Bin>>,
    pub top: Vec<ValueCount>,
    /// More distinct values exist than `top` lists.
    pub top_truncated: bool,
    pub elapsed_ms: u64,
}

/// A column's histogram, for the small charts in the grid headers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnHistogram {
    pub column: String,
    pub kind: ProfileKind,
    pub bins: Vec<Bin>,
}

/// `col` as a DOUBLE for histograms: the number itself, or seconds since 1970.
fn numeric_expr(col: &str, kind: ProfileKind, duckdb_type: &str) -> Option<String> {
    match kind {
        ProfileKind::Number => Some(format!("CAST({col} AS DOUBLE)")),
        ProfileKind::Temporal if duckdb_type.to_ascii_uppercase().contains("TIME ZONE") => {
            Some(format!("epoch({col})"))
        }
        ProfileKind::Temporal => Some(format!("epoch(CAST({col} AS TIMESTAMP))")),
        _ => None,
    }
}

fn f64_at(batch: &arrow::record_batch::RecordBatch, col: usize) -> Option<f64> {
    let a = batch.column(col).as_primitive::<Float64Type>();
    (!a.is_null(0)).then(|| a.value(0))
}

fn i64_at(batch: &arrow::record_batch::RecordBatch, col: usize) -> Option<i64> {
    let a = batch.column(col).as_primitive::<Int64Type>();
    (!a.is_null(0)).then(|| a.value(0))
}

fn text_at(batch: &arrow::record_batch::RecordBatch, col: usize) -> Option<String> {
    let a = batch.column(col).as_string::<i32>();
    (!a.is_null(0)).then(|| a.value(0).to_string())
}

impl Engine {
    /// The view (filters and search of `spec`, no sort) over dataset `id`,
    /// and the column's metadata.
    fn profile_view(
        &self,
        id: &str,
        spec: &ViewSpec,
        column: &str,
    ) -> Result<(BuiltView, ColumnMeta)> {
        let base = self.datasets.get(id)?;
        let schema = self.dataset_columns(id)?;
        let meta = schema
            .iter()
            .find(|c| c.name == column)
            .cloned()
            .ok_or_else(|| AppError::Query(format!("There is no column named \"{column}\".")))?;
        let unsorted = ViewSpec {
            sort: Vec::new(),
            columns: None,
            ..spec.clone()
        };
        Ok((
            build(&unsorted, &Relation::of(&base.source), &schema)?,
            meta,
        ))
    }

    /// Histogram of `x` (a DOUBLE expression over the view) between `lo` and `hi`.
    fn histogram(
        &self,
        view: &BuiltView,
        x: &str,
        (lo, hi): (f64, f64),
        integer: bool,
        key: &RequestKey,
    ) -> Result<Vec<Bin>> {
        // Small integer ranges get one bar per value; otherwise BINS bars.
        let (n, width) = if integer && hi - lo < BINS as f64 {
            ((hi - lo) as usize + 1, 1.0)
        } else if hi > lo {
            (BINS, (hi - lo) / BINS as f64)
        } else {
            (1, 0.0)
        };
        let last = n as i64 - 1;
        let sql = format!(
            "SELECT b, count(*)::BIGINT FROM ( \
               SELECT CASE WHEN ? = 0 THEN 0 \
                 ELSE least(greatest(CAST(floor((x - ?) / ?) AS BIGINT), 0), {last}) END AS b \
               FROM (SELECT {x} AS x FROM ({select})) WHERE x IS NOT NULL \
             ) GROUP BY b ORDER BY b",
            select = view.select
        );
        // Our parameters come first in the SQL text, then the view's.
        let mut params = vec![Param::Float(width), Param::Float(lo), Param::Float(width)];
        params.extend(view.params.iter().cloned());
        let out = self.query(&sql, &params, n, key)?;
        let mut counts = vec![0u64; n];
        for batch in &out.batches {
            let b = batch.column(0).as_primitive::<Int64Type>();
            let c = batch.column(1).as_primitive::<Int64Type>();
            for i in 0..batch.num_rows() {
                if let Some(slot) = counts.get_mut(b.value(i) as usize) {
                    *slot = c.value(i) as u64;
                }
            }
        }
        Ok(counts
            .into_iter()
            .enumerate()
            .map(|(i, count)| Bin {
                lo: lo + i as f64 * width,
                // The last bar ends exactly at the maximum (no float drift),
                // except for one-bar-per-integer histograms.
                hi: if i == n - 1 && width != 1.0 {
                    hi
                } else {
                    lo + (i + 1) as f64 * width
                },
                count,
            })
            .collect())
    }

    /// Statistics of one column over the rows of `spec` (filters and search;
    /// sorting doesn't matter) on dataset `id`.
    pub fn column_profile(
        &self,
        id: &str,
        spec: &ViewSpec,
        column: &str,
        key: &RequestKey,
    ) -> Result<ColumnProfile> {
        let started = std::time::Instant::now();
        let (view, meta) = self.profile_view(id, spec, column)?;
        let kind = ProfileKind::of(&meta.r#type);
        let col = quote_ident(column);
        let rows = self.datasets.get(id)?.row_count;
        let distinct_approx = rows > EXACT_DISTINCT_ROWS;
        let distinct = if distinct_approx {
            format!("approx_count_distinct({col})")
        } else {
            format!("count(DISTINCT {col})")
        };
        let x = numeric_expr(&col, kind, &meta.r#type);
        let minmax = if kind == ProfileKind::Other {
            "NULL::VARCHAR, NULL::VARCHAR".to_string()
        } else {
            format!("CAST(min({col}) AS VARCHAR), CAST(max({col}) AS VARCHAR)")
        };
        let moments = if kind == ProfileKind::Number {
            format!("avg(CAST({col} AS DOUBLE)), stddev_samp(CAST({col} AS DOUBLE))")
        } else {
            "NULL::DOUBLE, NULL::DOUBLE".to_string()
        };
        let range = match &x {
            Some(x) => format!("min({x}), max({x})"),
            None => "NULL::DOUBLE, NULL::DOUBLE".to_string(),
        };
        let sql = format!(
            "SELECT count(*)::BIGINT, count({col})::BIGINT, {minmax}, {moments}, \
             CAST({distinct} AS BIGINT), {range} FROM ({})",
            view.select
        );
        let out = self.query(&sql, &view.params, 1, key)?;
        let b = out
            .batches
            .first()
            .ok_or_else(|| AppError::Internal("profile returned no rows".into()))?;
        let total = i64_at(b, 0).unwrap_or(0) as u64;
        let non_null = i64_at(b, 1).unwrap_or(0) as u64;
        let (lo, hi) = (f64_at(b, 7), f64_at(b, 8));

        let histogram = match (&x, lo, hi) {
            (Some(x), Some(lo), Some(hi)) => Some(self.histogram(
                &view,
                x,
                (lo, hi),
                kind == ProfileKind::Number && ProfileKind::is_integer(&meta.r#type),
                key,
            )?),
            (Some(_), _, _) => Some(Vec::new()),
            _ => None,
        };

        // Grouped by the typed value (much cheaper than by its text on
        // near-unique columns); only the few rows kept are cast to text.
        let top_sql = format!(
            "SELECT CAST(v AS VARCHAR), n FROM ( \
               SELECT {col} AS v, count(*)::BIGINT AS n FROM ({}) \
               GROUP BY 1 ORDER BY n DESC, v ASC NULLS FIRST LIMIT {} \
             ) ORDER BY n DESC, v ASC NULLS FIRST",
            view.select,
            TOP_VALUES + 1
        );
        let top_out = self.query(&top_sql, &view.params, TOP_VALUES + 1, key)?;
        let mut top = Vec::new();
        for batch in &top_out.batches {
            let v = batch.column(0).as_string::<i32>();
            let n = batch.column(1).as_primitive::<Int64Type>();
            for i in 0..batch.num_rows() {
                top.push(ValueCount {
                    value: (!v.is_null(i)).then(|| v.value(i).to_string()),
                    count: n.value(i) as u64,
                });
            }
        }
        let top_truncated = top.len() > TOP_VALUES;
        top.truncate(TOP_VALUES);

        Ok(ColumnProfile {
            column: column.to_string(),
            r#type: meta.r#type,
            kind,
            rows: total,
            nulls: total - non_null,
            distinct: i64_at(b, 6).map(|d| d as u64),
            distinct_approx,
            min: text_at(b, 2),
            max: text_at(b, 3),
            mean: f64_at(b, 4),
            stddev: f64_at(b, 5),
            histogram,
            top,
            top_truncated,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// Histograms for the grid headers: numbers, dates and timestamps get
    /// bars over their range; booleans get three bars, true / false / null
    /// in that order. Other columns are skipped.
    pub fn column_histograms(
        &self,
        id: &str,
        spec: &ViewSpec,
        columns: &[String],
        key: &RequestKey,
    ) -> Result<Vec<ColumnHistogram>> {
        let Some(first) = columns.first() else {
            return Ok(Vec::new());
        };
        let (view, _) = self.profile_view(id, spec, first)?;
        let schema = self.dataset_columns(id)?;
        // One scan for every column's range (or boolean counts), then one
        // histogram query per number or date column.
        struct Planned {
            column: String,
            kind: ProfileKind,
            x: Option<String>,
            integer: bool,
            at: usize,
        }
        let mut planned = Vec::new();
        let mut exprs = Vec::new();
        for column in columns {
            let meta = schema.iter().find(|c| &c.name == column).ok_or_else(|| {
                AppError::Query(format!("There is no column named \"{column}\"."))
            })?;
            let kind = ProfileKind::of(&meta.r#type);
            let col = quote_ident(column);
            let at = exprs.len();
            let x = if kind == ProfileKind::Boolean {
                exprs.push(format!("count(*) FILTER ({col})::DOUBLE"));
                exprs.push(format!("count(*) FILTER (NOT {col})::DOUBLE"));
                exprs.push(format!("count(*) FILTER ({col} IS NULL)::DOUBLE"));
                None
            } else if let Some(x) = numeric_expr(&col, kind, &meta.r#type) {
                exprs.push(format!("min({x})"));
                exprs.push(format!("max({x})"));
                Some(x)
            } else {
                continue;
            };
            planned.push(Planned {
                column: column.clone(),
                kind,
                x,
                integer: kind == ProfileKind::Number && ProfileKind::is_integer(&meta.r#type),
                at,
            });
        }
        if planned.is_empty() {
            return Ok(Vec::new());
        }
        let r = self.query(
            &format!("SELECT {} FROM ({})", exprs.join(", "), view.select),
            &view.params,
            1,
            key,
        )?;
        let b = r
            .batches
            .first()
            .ok_or_else(|| AppError::Internal("histogram ranges returned no rows".into()))?;
        let mut out = Vec::new();
        for p in planned {
            let bins = match &p.x {
                None => (0..3)
                    .map(|i| Bin {
                        lo: i as f64,
                        hi: i as f64 + 1.0,
                        count: f64_at(b, p.at + i).unwrap_or(0.0) as u64,
                    })
                    .collect(),
                Some(x) => match (f64_at(b, p.at), f64_at(b, p.at + 1)) {
                    (Some(lo), Some(hi)) => self.histogram(&view, x, (lo, hi), p.integer, key)?,
                    _ => Vec::new(),
                },
            };
            out.push(ColumnHistogram {
                column: p.column,
                kind: p.kind,
                bins,
            });
        }
        Ok(out)
    }
}
