//! Statistics of the grid's selection (count, sum, average, min, max, …),
//! like a spreadsheet's status bar. One aggregate query over the view: only
//! a single row of numbers leaves DuckDB, however many rows are selected.

use std::fmt::Write as _;

use serde::Serialize;

use super::profile::{f64_at, i64_at, text_at};
use super::{EXACT_DISTINCT_ROWS, ProfileKind, Relation, ViewSpec, build};
use crate::engine::sql::quote_ident;
use crate::engine::{Engine, RequestKey};
use crate::error::{AppError, Result};

/// Most row ranges one request may carry (a selection of many separate rows).
pub const MAX_SELECTION_RANGES: usize = 10_000;

/// Statistics of one selected column.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionColumnStats {
    pub column: String,
    pub kind: ProfileKind,
    /// Cells that are not NULL (empty text included).
    pub values: u64,
    /// Text cells holding "" (counted in `values`).
    pub empty: u64,
    /// Numbers only.
    pub sum: Option<f64>,
    pub avg: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    /// Smallest and largest value as text: dates, timestamps and text.
    pub min_text: Option<String>,
    pub max_text: Option<String>,
    /// Distinct values (NULL not counted), when asked for.
    pub distinct: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionStats {
    /// Selected rows (of the view).
    pub rows: u64,
    pub columns: Vec<SelectionColumnStats>,
    /// `distinct` is an estimate (views over [`EXACT_DISTINCT_ROWS`] rows).
    pub distinct_approx: bool,
    pub elapsed_ms: u64,
}

/// How to count distinct values, if at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Distinct {
    No,
    Exact,
    /// HyperLogLog estimate, for big views.
    Approx,
}

/// Aggregates computed for one column, in result order ([`PER_COLUMN`]).
fn column_aggregates(col: &str, kind: ProfileKind, distinct: Distinct) -> String {
    let mut out = format!("count({col})::BIGINT");
    if kind == ProfileKind::Text {
        let _ = write!(out, ", count_if({col} = '')::BIGINT");
    } else {
        out.push_str(", 0::BIGINT");
    }
    if kind == ProfileKind::Number {
        let x = format!("CAST({col} AS DOUBLE)");
        let _ = write!(out, ", sum({x}), avg({x}), min({x}), max({x})");
    } else {
        out.push_str(", NULL::DOUBLE, NULL::DOUBLE, NULL::DOUBLE, NULL::DOUBLE");
    }
    if matches!(kind, ProfileKind::Temporal | ProfileKind::Text) {
        let _ = write!(
            out,
            ", CAST(min({col}) AS VARCHAR), CAST(max({col}) AS VARCHAR)"
        );
    } else {
        out.push_str(", NULL::VARCHAR, NULL::VARCHAR");
    }
    match distinct {
        Distinct::No => out.push_str(", NULL::BIGINT"),
        Distinct::Exact => {
            let _ = write!(out, ", count(DISTINCT {col})::BIGINT");
        }
        Distinct::Approx => {
            let _ = write!(out, ", CAST(approx_count_distinct({col}) AS BIGINT)");
        }
    }
    out
}

/// Expressions per column in [`column_aggregates`].
const PER_COLUMN: usize = 9;

impl Engine {
    /// Statistics of `columns` over the rows of the view `spec` of dataset
    /// `id`: all rows, or only the view positions in `rows` (`[start, end)`
    /// ranges, 0-based, in the view's order). Distinct values are counted
    /// only when `distinct` is set (it is the slow one).
    pub fn selection_stats(
        &self,
        id: &str,
        spec: &ViewSpec,
        columns: &[String],
        rows: Option<&[[u64; 2]]>,
        distinct: bool,
        key: &RequestKey,
    ) -> Result<SelectionStats> {
        let started = std::time::Instant::now();
        if columns.is_empty() {
            return Err(AppError::Query("Select some columns first.".into()));
        }
        let rows = rows.filter(|r| !r.is_empty());
        if rows.is_some_and(|r| r.len() > MAX_SELECTION_RANGES) {
            return Err(AppError::Query(
                "The selection has too many separate parts to add up.".into(),
            ));
        }
        let base = self.datasets.get(id)?;
        let schema = self.dataset_columns(id)?;
        let mut metas = Vec::with_capacity(columns.len());
        for name in columns {
            let meta = schema
                .iter()
                .find(|c| &c.name == name)
                .ok_or_else(|| AppError::Query(format!("There is no column named \"{name}\".")))?;
            metas.push(meta);
        }
        // Positions follow the view's sort; without them the order (and the
        // sort, which is the slow part) doesn't matter.
        let view_spec = ViewSpec {
            sort: if rows.is_some() {
                spec.sort.clone()
            } else {
                Vec::new()
            },
            columns: None,
            ..spec.clone()
        };
        let view = build(&view_spec, &Relation::of(&base.source), &schema)?;
        let distinct_approx = distinct && base.row_count > EXACT_DISTINCT_ROWS;
        let how = match (distinct, distinct_approx) {
            (false, _) => Distinct::No,
            (true, false) => Distinct::Exact,
            (true, true) => Distinct::Approx,
        };

        let mut select = String::from("count(*)::BIGINT");
        for meta in &metas {
            let kind = ProfileKind::of(&meta.r#type);
            select.push_str(", ");
            select.push_str(&column_aggregates(&quote_ident(&meta.name), kind, how));
        }
        let from = match rows {
            None => format!("({})", view.select),
            Some(ranges) => {
                let pos = quote_ident("__dataliq_pos");
                let keep = ranges
                    .iter()
                    .map(|[a, b]| format!("({pos} >= {a} AND {pos} < {b})"))
                    .collect::<Vec<_>>()
                    .join(" OR ");
                format!(
                    "(SELECT * FROM (SELECT *, row_number() OVER () - 1 AS {pos} FROM ({})) WHERE {keep})",
                    view.select
                )
            }
        };
        let sql = format!("SELECT {select} FROM {from}");
        let out = self.query(&sql, &view.params, 1, key)?;
        let b = out
            .batches
            .first()
            .ok_or_else(|| AppError::Internal("selection stats returned no rows".into()))?;
        let stats = metas
            .iter()
            .enumerate()
            .map(|(i, meta)| {
                let at = 1 + i * PER_COLUMN;
                SelectionColumnStats {
                    column: meta.name.clone(),
                    kind: ProfileKind::of(&meta.r#type),
                    values: i64_at(b, at).unwrap_or(0) as u64,
                    empty: i64_at(b, at + 1).unwrap_or(0) as u64,
                    sum: f64_at(b, at + 2),
                    avg: f64_at(b, at + 3),
                    min: f64_at(b, at + 4),
                    max: f64_at(b, at + 5),
                    min_text: text_at(b, at + 6),
                    max_text: text_at(b, at + 7),
                    distinct: i64_at(b, at + 8).map(|d| d as u64),
                }
            })
            .collect();
        Ok(SelectionStats {
            rows: i64_at(b, 0).unwrap_or(0) as u64,
            columns: stats,
            distinct_approx,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregates_fit_the_column_kind() {
        let n = column_aggregates("\"a\"", ProfileKind::Number, Distinct::No);
        assert!(n.contains("sum(CAST(\"a\" AS DOUBLE))"));
        assert!(n.contains("NULL::VARCHAR, NULL::VARCHAR, NULL::BIGINT"));
        let t = column_aggregates("\"t\"", ProfileKind::Text, Distinct::Approx);
        assert!(t.contains("count_if(\"t\" = '')"));
        assert!(t.contains("CAST(min(\"t\") AS VARCHAR)"));
        assert!(t.ends_with("CAST(approx_count_distinct(\"t\") AS BIGINT)"));
        let d = column_aggregates("\"d\"", ProfileKind::Temporal, Distinct::Exact);
        assert!(d.ends_with("count(DISTINCT \"d\")::BIGINT"));
    }
}
