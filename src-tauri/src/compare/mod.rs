//! Comparing two datasets (two files, or two versions of one) by key
//! columns: which rows were added, removed or changed, and which cells.
//!
//! One full outer join on the keys. A key that appears more than once on a
//! side is matched by its order of appearance (the first `id = 7` on the
//! left with the first on the right, the second with the second, …) and
//! counted, so duplicate keys never multiply rows. Columns of different
//! types are compared as text.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::engine::sql::{inline_params, literal, quote_ident};
use crate::engine::{Dataset, DatasetSource, Engine, Param, RequestKey};
use crate::error::{AppError, Result};
use crate::sources::ColumnMeta;
use crate::view::Relation;

static NEXT_DIFF: AtomicU64 = AtomicU64::new(1);

/// Name of the column saying what happened to a row.
pub const STATUS: &str = "status";
/// Name of the column listing a changed row's changed columns.
pub const CHANGED: &str = "changed";
/// Suffix of the column holding a changed column's old value.
pub const BEFORE: &str = " (before)";

const POS: &str = "__bigview_pos";
const DUP: &str = "__bigview_dup";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareSpec {
    /// Columns identifying a row on both sides.
    pub keys: Vec<String>,
}

/// A column the two sides both have, with different types.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Retyped {
    pub name: String,
    pub left: String,
    pub right: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnChanges {
    pub name: String,
    pub rows: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    /// The rows that differ: status, keys, then each compared column (its
    /// new value) followed by its old value when it changed somewhere.
    pub dataset: Dataset,
    pub columns: Vec<ColumnMeta>,
    pub left_rows: u64,
    pub right_rows: u64,
    pub added: u64,
    pub removed: u64,
    pub changed: u64,
    pub same: u64,
    /// Rows whose key appears more than once on that side.
    pub duplicate_left: u64,
    pub duplicate_right: u64,
    /// Compared columns (both sides, not keys).
    pub compared: Vec<String>,
    pub only_left: Vec<String>,
    pub only_right: Vec<String>,
    pub retyped: Vec<Retyped>,
    /// Changed rows per compared column (columns with changes only).
    pub changes: Vec<ColumnChanges>,
    pub elapsed_ms: u64,
}

/// The parts of a comparison's SQL, over two table expressions.
struct Plan {
    keys: Vec<String>,
    compared: Vec<String>,
    /// Compared columns whose types differ (compared as text).
    as_text: HashSet<String>,
    /// No key repeats on either side: rows join on the keys alone, without
    /// numbering each key's occurrences (a sort of each side).
    unique: bool,
}

impl Plan {
    fn new(keys: &[String], left: &[ColumnMeta], right: &[ColumnMeta]) -> Result<Plan> {
        if keys.is_empty() {
            return Err(AppError::Query(
                "Pick at least one key column to match rows by.".into(),
            ));
        }
        let find = |cols: &[ColumnMeta], name: &str| cols.iter().find(|c| c.name == name).cloned();
        for k in keys {
            if find(left, k).is_none() || find(right, k).is_none() {
                return Err(AppError::Query(format!(
                    "Both files need the key column \"{k}\"."
                )));
            }
        }
        let mut compared = Vec::new();
        let mut as_text = HashSet::new();
        for l in left {
            if keys.contains(&l.name) {
                continue;
            }
            if let Some(r) = find(right, &l.name) {
                if r.r#type != l.r#type {
                    as_text.insert(l.name.clone());
                }
                compared.push(l.name.clone());
            }
        }
        Ok(Plan {
            keys: keys.to_vec(),
            compared,
            as_text,
            unique: false,
        })
    }

    /// `l."c" IS DISTINCT FROM r."c"` (as text when the types differ).
    fn differs(&self, c: &str) -> String {
        let q = quote_ident(c);
        if self.as_text.contains(c) {
            format!("CAST(l.{q} AS VARCHAR) IS DISTINCT FROM CAST(r.{q} AS VARCHAR)")
        } else {
            format!("l.{q} IS DISTINCT FROM r.{q}")
        }
    }

    fn key_list(&self) -> String {
        self.keys
            .iter()
            .map(|k| quote_ident(k))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// `WITH l AS (…), r AS (…)`: each side with its file order and the
    /// occurrence of its key.
    fn sides(&self, left: &Side, right: &Side) -> String {
        let keys = self.key_list();
        let side = |s: &Side| {
            if self.unique {
                format!("SELECT *, {} AS {POS} FROM {}", s.order, s.sql)
            } else {
                format!(
                    "SELECT *, row_number() OVER (PARTITION BY {keys} ORDER BY {POS}) AS {DUP} \
                     FROM (SELECT *, {} AS {POS} FROM {})",
                    s.order, s.sql
                )
            }
        };
        format!("WITH l AS ({}),\nr AS ({})", side(left), side(right))
    }

    /// The join of both sides on their keys and key occurrence.
    fn join(&self) -> String {
        let on = self
            .keys
            .iter()
            .map(|k| {
                let q = quote_ident(k);
                format!("l.{q} IS NOT DISTINCT FROM r.{q}")
            })
            .chain((!self.unique).then(|| format!("l.{DUP} = r.{DUP}")))
            .collect::<Vec<_>>()
            .join(" AND ");
        format!("FROM l FULL OUTER JOIN r ON {on}")
    }

    /// Both sides have the row.
    fn both() -> String {
        format!("l.{POS} IS NOT NULL AND r.{POS} IS NOT NULL")
    }

    /// Some compared column differs.
    fn any(&self) -> String {
        if self.compared.is_empty() {
            return "FALSE".into();
        }
        let parts = self
            .compared
            .iter()
            .map(|c| self.differs(c))
            .collect::<Vec<_>>();
        format!("({})", parts.join(" OR "))
    }

    /// One row: added, removed, changed and same rows, then the changed
    /// rows of each compared column.
    fn counts(&self, left: &Side, right: &Side) -> String {
        let both = Self::both();
        let any = self.any();
        let mut cols = vec![
            format!("count(*) FILTER (l.{POS} IS NULL)"),
            format!("count(*) FILTER (r.{POS} IS NULL)"),
            format!("count(*) FILTER ({both} AND {any})"),
            format!("count(*) FILTER ({both} AND NOT {any})"),
        ];
        for c in &self.compared {
            cols.push(format!("count(*) FILTER ({both} AND {})", self.differs(c)));
        }
        let cols = cols
            .into_iter()
            .map(|c| format!("CAST({c} AS BIGINT)"))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "{}\nSELECT {cols}\n{}",
            self.sides(left, right),
            self.join()
        )
    }

    /// The differing rows, in the left file's order, then the added rows in
    /// the right file's. `changed_cols`: columns that change somewhere get
    /// a `(before)` column after them.
    fn rows(&self, left: &Side, right: &Side, changed_cols: &[String]) -> String {
        let both = Self::both();
        let mut select = vec![format!(
            "CASE WHEN l.{POS} IS NULL THEN 'added' WHEN r.{POS} IS NULL THEN 'removed' \
             ELSE 'changed' END AS {}",
            quote_ident(STATUS)
        )];
        for k in &self.keys {
            let q = quote_ident(k);
            select.push(format!("coalesce(l.{q}, r.{q}) AS {q}"));
        }
        let names = self
            .compared
            .iter()
            .filter(|c| changed_cols.contains(c))
            .map(|c| {
                format!(
                    "CASE WHEN {both} AND {} THEN {} END",
                    self.differs(c),
                    literal(&Param::Text(c.clone()))
                )
            })
            .collect::<Vec<_>>();
        select.push(if names.is_empty() {
            format!("CAST(NULL AS VARCHAR) AS {}", quote_ident(CHANGED))
        } else {
            format!(
                "nullif(concat_ws(', ', {}), '') AS {}",
                names.join(", "),
                quote_ident(CHANGED)
            )
        });
        for c in &self.compared {
            let q = quote_ident(c);
            let text = self.as_text.contains(c);
            let val = |side: &str| {
                if text {
                    format!("CAST({side}.{q} AS VARCHAR)")
                } else {
                    format!("{side}.{q}")
                }
            };
            // The new value; a removed row's old one.
            select.push(format!(
                "CASE WHEN r.{POS} IS NULL THEN {} ELSE {} END AS {q}",
                val("l"),
                val("r")
            ));
            if changed_cols.contains(c) {
                select.push(format!(
                    "CASE WHEN {both} AND {} THEN {} END AS {}",
                    self.differs(c),
                    val("l"),
                    quote_ident(&format!("{c}{BEFORE}"))
                ));
            }
        }
        format!(
            "{}\nSELECT {}\n{}\nWHERE l.{POS} IS NULL OR r.{POS} IS NULL OR {}\n\
             ORDER BY l.{POS} NULLS LAST, r.{POS}",
            self.sides(left, right),
            select.join(",\n  "),
            self.join(),
            self.any(),
        )
    }
}

/// One side of a comparison: a table expression and its file order.
pub(crate) struct Side {
    pub sql: String,
    pub order: String,
}

impl Side {
    fn of(ds: &Dataset) -> Side {
        let rel = Relation::of(&ds.source);
        Side {
            sql: inline_params(&rel.sql, &rel.params),
            order: rel
                .row_order
                .unwrap_or_else(|| "row_number() OVER ()".into()),
        }
    }

    /// `reader` (a file's reader call) in the file's order.
    fn reader(reader: &str) -> Side {
        Side {
            sql: reader.to_string(),
            order: "row_number() OVER ()".into(),
        }
    }
}

impl Engine {
    /// Rows of `side` beyond the first with each key (0: every key is unique).
    fn repeated_keys(&self, side: &Side, keys: &str, key: &RequestKey) -> Result<u64> {
        self.count(
            &format!(
                "SELECT CAST(count(*) - count(DISTINCT hash({keys})) AS BIGINT) FROM {}",
                side.sql
            ),
            &[],
            key,
        )
    }

    /// The plan for `left` against `right`, knowing whether keys repeat;
    /// also each side's rows whose key repeats.
    fn plan(
        &self,
        spec: &CompareSpec,
        (lcols, rcols): (&[ColumnMeta], &[ColumnMeta]),
        (ls, rs): (&Side, &Side),
        key: &RequestKey,
    ) -> Result<(Plan, u64, u64)> {
        let mut plan = Plan::new(&spec.keys, lcols, rcols)?;
        let keys = plan.key_list();
        let mut dups = [0, 0];
        for (i, side) in [ls, rs].into_iter().enumerate() {
            if self.repeated_keys(side, &keys, key)? > 0 {
                dups[i] = self.duplicate_rows(side, &keys, key)?;
            }
        }
        plan.unique = dups == [0, 0];
        Ok((plan, dups[0], dups[1]))
    }

    /// Rows whose key appears more than once in `side`.
    fn duplicate_rows(&self, side: &Side, keys: &str, key: &RequestKey) -> Result<u64> {
        self.count(
            &format!(
                "SELECT count(*)::BIGINT FROM (SELECT count(*) OVER (PARTITION BY {keys}) AS n \
                 FROM {}) WHERE n > 1",
                side.sql
            ),
            &[],
            key,
        )
    }

    /// Compares dataset `left` (the old version) with `right` (the new) by
    /// `spec.keys`: the differing rows as a new dataset, and the counts.
    pub fn compare(
        &self,
        left: &str,
        right: &str,
        spec: &CompareSpec,
        key: &RequestKey,
    ) -> Result<Comparison> {
        let started = std::time::Instant::now();
        let (lds, rds) = (self.datasets.get(left)?, self.datasets.get(right)?);
        let (lcols, rcols) = (self.dataset_columns(left)?, self.dataset_columns(right)?);
        let (ls, rs) = (Side::of(&lds), Side::of(&rds));
        let (plan, duplicate_left, duplicate_right) =
            self.plan(spec, (&lcols, &rcols), (&ls, &rs), key)?;

        let counts = self.query(&plan.counts(&ls, &rs), &[], 1, key)?;
        let batch = counts
            .batches
            .first()
            .ok_or_else(|| AppError::Internal("no counts".into()))?;
        let at = |i: usize| -> u64 {
            use arrow::array::AsArray;
            batch
                .column(i)
                .as_primitive::<arrow::datatypes::Int64Type>()
                .value(0) as u64
        };
        let changes: Vec<ColumnChanges> = plan
            .compared
            .iter()
            .enumerate()
            .map(|(i, c)| ColumnChanges {
                name: c.clone(),
                rows: at(4 + i),
            })
            .filter(|c| c.rows > 0)
            .collect();
        let changed_cols: Vec<String> = changes.iter().map(|c| c.name.clone()).collect();
        let sql = format!("({})", plan.rows(&ls, &rs, &changed_cols));
        let columns = self.describe(&format!("SELECT * FROM {sql}"))?;
        let (added, removed, changed, same) = (at(0), at(1), at(2), at(3));
        let dataset = Dataset {
            id: format!("diff-{}", NEXT_DIFF.fetch_add(1, Ordering::Relaxed)),
            source: DatasetSource::Query {
                sql,
                params: Vec::new(),
            },
            row_count: added + removed + changed,
            cached: lds.cached && rds.cached,
        };
        self.datasets.insert(dataset.clone());
        let names = |cols: &[ColumnMeta], other: &[ColumnMeta]| {
            cols.iter()
                .filter(|c| !other.iter().any(|o| o.name == c.name))
                .map(|c| c.name.clone())
                .collect::<Vec<_>>()
        };
        let retyped = plan
            .compared
            .iter()
            .filter(|c| plan.as_text.contains(*c))
            .map(|c| Retyped {
                name: c.clone(),
                left: lcols.iter().find(|x| &x.name == c).unwrap().r#type.clone(),
                right: rcols.iter().find(|x| &x.name == c).unwrap().r#type.clone(),
            })
            .collect();
        Ok(Comparison {
            dataset,
            columns,
            left_rows: lds.row_count,
            right_rows: rds.row_count,
            added,
            removed,
            changed,
            same,
            duplicate_left,
            duplicate_right,
            compared: plan.compared.clone(),
            only_left: names(&lcols, &rcols),
            only_right: names(&rcols, &lcols),
            retyped,
            changes,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// The comparison's differing rows as one standalone query over the two
    /// files' readers (runs as-is in plain DuckDB).
    pub fn compare_sql(
        &self,
        left: &str,
        right: &str,
        spec: &CompareSpec,
        left_reader: &str,
        right_reader: &str,
    ) -> Result<String> {
        let (lcols, rcols) = (self.dataset_columns(left)?, self.dataset_columns(right)?);
        let (ls, rs) = (
            Side::of(&self.datasets.get(left)?),
            Side::of(&self.datasets.get(right)?),
        );
        let (plan, _, _) = self.plan(spec, (&lcols, &rcols), (&ls, &rs), &RequestKey::default())?;
        let counts = self.query(&plan.counts(&ls, &rs), &[], 1, &RequestKey::default())?;
        let batch = counts
            .batches
            .first()
            .ok_or_else(|| AppError::Internal("no counts".into()))?;
        let changed_cols: Vec<String> = plan
            .compared
            .iter()
            .enumerate()
            .filter(|(i, _)| {
                use arrow::array::AsArray;
                batch
                    .column(4 + i)
                    .as_primitive::<arrow::datatypes::Int64Type>()
                    .value(0)
                    > 0
            })
            .map(|(_, c)| c.clone())
            .collect();
        Ok(format!(
            "{};",
            plan.rows(
                &Side::reader(left_reader),
                &Side::reader(right_reader),
                &changed_cols
            )
        ))
    }
}
