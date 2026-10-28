//! Data quality warnings for a dataset: columns with many empty cells,
//! text with stray spaces, numbers stored as text with some values that
//! aren't numbers, dates in more than one format, numeric outliers, and
//! exact duplicate rows. Each warning carries the filters that show the
//! rows it is about, and a cleaning step that fixes it where there is one.
//!
//! The counts use the same tests as the filters (the view's regex, empty
//! and range filters), so "Show rows" always shows exactly that many rows.

use arrow::array::{Array, AsArray};
use arrow::datatypes::{Float64Type, Int64Type};
use serde::Serialize;

use crate::engine::sql::{inline_params, quote_ident};
use crate::engine::{Engine, Param, RequestKey};
use crate::error::{AppError, Result};
use crate::recipe::{NewType, Step};
use crate::sources::ColumnMeta;
use crate::view::{Filter, FilterOp, Relation};

/// A column is "mostly empty" from this share of empty cells.
pub const EMPTY_SHARE: f64 = 0.2;
/// Text is "numbers with exceptions" when at least this share are numbers.
pub const NUMBER_SHARE: f64 = 0.5;
/// Outliers lie further than this many interquartile ranges from the middle half.
pub const OUTLIER_IQR: f64 = 3.0;

/// A number as text (what change type to number reads), spaces allowed around it.
pub const NUMBER_RE: &str = r"^\s*[-+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][-+]?[0-9]+)?\s*$";
/// A space at the start or end: what `trim` (the Trim step) removes.
pub const SPACES_RE: &str = "^ | $";

/// Date formats told apart in text columns: name, example, pattern.
pub const DATE_FORMATS: [(&str, &str, &str); 4] = [
    (
        "year-month-day",
        "2024-01-31",
        r"^\s*[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}\s*$",
    ),
    (
        "day/month/year",
        "31/01/2024",
        r"^\s*[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}\s*$",
    ),
    (
        "day.month.year",
        "31.01.2024",
        r"^\s*[0-9]{1,2}[.][0-9]{1,2}[.][0-9]{4}\s*$",
    ),
    (
        "day-month-year",
        "31-01-2024",
        r"^\s*[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}\s*$",
    ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WarningKind {
    Empty,
    Spaces,
    MixedTypes,
    DateFormats,
    Outliers,
    Duplicates,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub kind: WarningKind,
    /// The column it is about (none for duplicate rows).
    pub column: Option<String>,
    /// Rows it is about.
    pub rows: u64,
    /// One sentence, e.g. "3 values have spaces at the start or end".
    pub message: String,
    /// Shows the rows it is about (all must match). Empty for duplicates.
    pub filters: Vec<Filter>,
    /// A cleaning step that fixes it.
    pub fix: Option<Step>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityReport {
    pub rows: u64,
    pub warnings: Vec<Warning>,
    pub elapsed_ms: u64,
}

#[derive(Clone, Copy, PartialEq)]
enum Family {
    Text,
    Number,
    Other,
}

fn family(t: &str) -> Family {
    let t = t.to_ascii_uppercase();
    if t == "VARCHAR" || t.starts_with("VARCHAR(") {
        Family::Text
    } else if [
        "TINYINT",
        "SMALLINT",
        "INTEGER",
        "BIGINT",
        "HUGEINT",
        "UTINYINT",
        "USMALLINT",
        "UINTEGER",
        "UBIGINT",
        "FLOAT",
        "DOUBLE",
    ]
    .contains(&t.as_str())
        || t.starts_with("DECIMAL")
    {
        Family::Number
    } else {
        Family::Other
    }
}

fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn plural(n: u64, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

fn percent(part: u64, whole: u64) -> String {
    let p = if whole == 0 {
        0.0
    } else {
        part as f64 * 100.0 / whole as f64
    };
    if p > 0.0 && p < 1.0 {
        "<1%".into()
    } else {
        format!("{p:.0}%")
    }
}

fn filter(column: &str, op: FilterOp, not: bool) -> Filter {
    Filter {
        column: column.to_string(),
        op,
        not,
    }
}

/// Rows of the sample that sets outlier bounds and picks the text columns
/// worth testing for numbers and dates.
pub const SAMPLE_ROWS: u64 = 100_000;
/// In the sample, the share of numbers (or dates) that makes a text column
/// worth counting in full: below the warnings' own threshold, so a sample
/// never hides a warning the full count would give.
const SAMPLE_GATE: f64 = 0.4;

/// One aggregate query: its select list, and how to read each result.
struct Scan {
    select: Vec<String>,
}

impl Scan {
    fn new() -> Scan {
        Scan { select: Vec::new() }
    }

    /// Adds a BIGINT count of the rows matching `cond`; returns its index.
    fn count(&mut self, cond: &str) -> usize {
        self.select
            .push(format!("CAST(count(*) FILTER ({cond}) AS BIGINT)"));
        self.select.len() - 1
    }

    /// Adds a DOUBLE expression; returns its index.
    fn float(&mut self, expr: String) -> usize {
        self.select.push(format!("CAST({expr} AS DOUBLE)"));
        self.select.len() - 1
    }

    fn run(
        &self,
        engine: &Engine,
        from: &str,
        key: &RequestKey,
    ) -> Result<Option<arrow::record_batch::RecordBatch>> {
        if self.select.is_empty() {
            return Ok(None);
        }
        let out = engine.query(
            &format!("SELECT {} FROM {from}", self.select.join(", ")),
            &[],
            1,
            key,
        )?;
        Ok(out.batches.into_iter().next())
    }
}

fn int_at(batch: &arrow::record_batch::RecordBatch, i: usize) -> u64 {
    let a = batch.column(i).as_primitive::<Int64Type>();
    if a.is_null(0) { 0 } else { a.value(0) as u64 }
}

fn float_at(batch: &arrow::record_batch::RecordBatch, i: usize) -> Option<f64> {
    let a = batch.column(i).as_primitive::<Float64Type>();
    (!a.is_null(0)).then(|| a.value(0))
}

impl Engine {
    /// The quality warnings of dataset `id`.
    ///
    /// A repeatable sample of [`SAMPLE_ROWS`] rows gives the number columns'
    /// quartiles (for the outlier bounds) and tells which text columns hold
    /// mostly numbers or dates; then one scan of all rows counts empty
    /// cells, stray spaces and (for those columns) numbers and date
    /// formats, one counts the values outside the bounds, and one the
    /// duplicate rows. Every count is over all rows.
    pub fn quality(&self, id: &str, key: &RequestKey) -> Result<QualityReport> {
        let started = std::time::Instant::now();
        let ds = self.datasets.get(id)?;
        let rel = Relation::of(&ds.source);
        let table = inline_params(&rel.sql, &rel.params);
        let columns = self.dataset_columns(id)?;
        let regex = |q: &str, re: &str| format!("regexp_matches({q}, {})", lit(re));

        // The sample: quartiles, and which text columns to test in full.
        let mut sample = Scan::new();
        let mut quartile_at = vec![None; columns.len()];
        let mut shape_at = vec![None; columns.len()];
        for (i, c) in columns.iter().enumerate() {
            let q = quote_ident(&c.name);
            match family(&c.r#type) {
                Family::Number => {
                    let lo = sample.float(format!("quantile_cont({q}, 0.25)"));
                    sample.float(format!("quantile_cont({q}, 0.75)"));
                    quartile_at[i] = Some(lo);
                }
                Family::Text => {
                    let non_empty = sample.count(&format!("{q} IS NOT NULL AND {q} <> ''"));
                    sample.count(&regex(&q, NUMBER_RE));
                    for (_, _, re) in DATE_FORMATS {
                        sample.count(&regex(&q, re));
                    }
                    shape_at[i] = Some(non_empty);
                }
                Family::Other => {}
            }
        }
        let sampled = sample.run(
            self,
            &format!(
                "(SELECT * FROM {table} USING SAMPLE reservoir({SAMPLE_ROWS} ROWS) REPEATABLE (7))"
            ),
            key,
        )?;

        // The full scan.
        let mut full = Scan::new();
        let rows_at = full.count("TRUE");
        let mut at: Vec<[Option<usize>; 4 + DATE_FORMATS.len()]> =
            vec![[None; 4 + DATE_FORMATS.len()]; columns.len()];
        let mut measures: Vec<Measures> = columns.iter().map(|_| Measures::default()).collect();
        for (i, c) in columns.iter().enumerate() {
            let q = quote_ident(&c.name);
            let text = family(&c.r#type) == Family::Text;
            at[i][0] = Some(full.count(&if text {
                format!("{q} IS NULL OR {q} = ''")
            } else {
                format!("{q} IS NULL")
            }));
            if let (Some(b), Some(lo)) = (&sampled, quartile_at[i]) {
                measures[i].quartiles = float_at(b, lo).zip(float_at(b, lo + 1));
            }
            if !text {
                continue;
            }
            at[i][1] = Some(full.count(&format!("{q} <> trim({q})")));
            at[i][2] = Some(full.count(&format!("{q} IS NOT NULL AND {q} <> ''")));
            let (Some(b), Some(s)) = (&sampled, shape_at[i]) else {
                continue;
            };
            let non_empty = int_at(b, s).max(1) as f64;
            if int_at(b, s + 1) as f64 / non_empty >= SAMPLE_GATE {
                at[i][3] = Some(full.count(&regex(&q, NUMBER_RE)));
            }
            let dated: u64 = (0..DATE_FORMATS.len()).map(|f| int_at(b, s + 2 + f)).sum();
            if dated as f64 / non_empty >= SAMPLE_GATE {
                for (f, (_, _, re)) in DATE_FORMATS.iter().enumerate() {
                    at[i][4 + f] = Some(full.count(&regex(&q, re)));
                }
            }
        }
        let counted = full
            .run(self, &table, key)?
            .ok_or_else(|| AppError::Internal("no quality counts".into()))?;
        let rows = int_at(&counted, rows_at);
        let get = |i: Option<usize>| i.map_or(0, |i| int_at(&counted, i));
        for (m, a) in measures.iter_mut().zip(&at) {
            m.empty = get(a[0]);
            m.spaces = get(a[1]);
            m.non_empty = get(a[2]);
            m.numbers = get(a[3]);
            for f in 0..DATE_FORMATS.len() {
                m.dates[f] = get(a[4 + f]);
            }
        }

        let mut warnings = Vec::new();
        for (c, m) in columns.iter().zip(&measures) {
            column_warnings(c, m, rows, &mut warnings);
        }

        // Outliers: values outside each number column's bounds.
        let bounds: Vec<(&ColumnMeta, f64, f64)> = columns
            .iter()
            .zip(&measures)
            .filter_map(|(c, m)| {
                let (q1, q3) = m.quartiles?;
                let iqr = q3 - q1;
                (iqr > 0.0).then_some((
                    c,
                    round(q1 - OUTLIER_IQR * iqr),
                    round(q3 + OUTLIER_IQR * iqr),
                ))
            })
            .collect();
        let mut outside = Scan::new();
        for (c, lo, hi) in &bounds {
            let q = quote_ident(&c.name);
            outside.count(&format!("{q} < {lo} OR {q} > {hi}"));
        }
        if let Some(b) = outside.run(self, &table, key)? {
            for (i, (c, lo, hi)) in bounds.iter().enumerate() {
                let n = int_at(&b, i);
                if n == 0 {
                    continue;
                }
                let (lo, hi) = (*lo, *hi);
                warnings.push(Warning {
                    kind: WarningKind::Outliers,
                    column: Some(c.name.clone()),
                    rows: n,
                    message: format!(
                        "{} far outside the usual range (below {lo} or above {hi})",
                        plural(n, "value")
                    ),
                    filters: vec![
                        filter(&c.name, FilterOp::NotNull, false),
                        filter(
                            &c.name,
                            FilterOp::Range {
                                min: Some(Param::Float(lo)),
                                max: Some(Param::Float(hi)),
                            },
                            true,
                        ),
                    ],
                    fix: None,
                });
            }
        }

        // Exact duplicate rows (all columns equal), by a hash of each row.
        if !columns.is_empty() {
            let all = columns
                .iter()
                .map(|c| quote_ident(&c.name))
                .collect::<Vec<_>>()
                .join(", ");
            let distinct = self.count(
                &format!("SELECT CAST(count(DISTINCT hash({all})) AS BIGINT) FROM {table}"),
                &[],
                key,
            )?;
            let extra = rows.saturating_sub(distinct);
            if extra > 0 {
                warnings.push(Warning {
                    kind: WarningKind::Duplicates,
                    column: None,
                    rows: extra,
                    message: format!(
                        "{} are exact copies of an earlier row",
                        plural(extra, "row")
                    ),
                    filters: Vec::new(),
                    fix: Some(Step::RemoveDuplicates { columns: None }),
                });
            }
        }

        Ok(QualityReport {
            rows,
            warnings,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }
}

/// Rounded for showing and filtering: 4 significant decimals at most.
fn round(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

/// What the scan measured about one column.
#[derive(Default)]
struct Measures {
    empty: u64,
    spaces: u64,
    non_empty: u64,
    numbers: u64,
    dates: [u64; DATE_FORMATS.len()],
    quartiles: Option<(f64, f64)>,
}

fn column_warnings(c: &ColumnMeta, m: &Measures, rows: u64, out: &mut Vec<Warning>) {
    let name = &c.name;
    let empty = m.empty;
    if rows > 0 && empty > 0 && empty as f64 / rows as f64 >= EMPTY_SHARE {
        out.push(Warning {
            kind: WarningKind::Empty,
            column: Some(name.clone()),
            rows: empty,
            message: format!(
                "{} of {} rows are empty ({})",
                empty,
                rows,
                percent(empty, rows)
            ),
            filters: vec![filter(name, FilterOp::Empty, false)],
            fix: None,
        });
    }
    if family(&c.r#type) != Family::Text {
        return;
    }
    let (spaces, non_empty, numbers, dates) = (m.spaces, m.non_empty, m.numbers, m.dates);
    if spaces > 0 {
        out.push(Warning {
            kind: WarningKind::Spaces,
            column: Some(name.clone()),
            rows: spaces,
            message: format!(
                "{} {} spaces at the start or end",
                plural(spaces, "value"),
                if spaces == 1 { "has" } else { "have" }
            ),
            filters: vec![filter(
                name,
                FilterOp::Regex {
                    pattern: SPACES_RE.into(),
                },
                false,
            )],
            fix: Some(Step::Trim {
                column: name.clone(),
            }),
        });
    }
    let dated: u64 = dates.iter().sum();
    if non_empty > 0 && numbers < non_empty && numbers as f64 / non_empty as f64 >= NUMBER_SHARE {
        let others = non_empty - numbers;
        out.push(Warning {
            kind: WarningKind::MixedTypes,
            column: Some(name.clone()),
            rows: others,
            message: format!(
                "Mostly numbers, but {} {} not ({} of {} values)",
                plural(others, "value"),
                if others == 1 { "is" } else { "are" },
                percent(others, non_empty),
                non_empty
            ),
            filters: vec![
                filter(name, FilterOp::Empty, true),
                filter(
                    name,
                    FilterOp::Regex {
                        pattern: NUMBER_RE.into(),
                    },
                    true,
                ),
            ],
            fix: Some(Step::ChangeType {
                column: name.clone(),
                to: NewType::Number,
                format: None,
            }),
        });
    }
    let used: Vec<usize> = (0..dates.len()).filter(|&f| dates[f] > 0).collect();
    if used.len() > 1 && dated as f64 / non_empty.max(1) as f64 >= NUMBER_SHARE {
        // The rows not in the most common format.
        let main = *used.iter().max_by_key(|&&f| dates[f]).unwrap();
        let rest: Vec<usize> = used.iter().copied().filter(|&f| f != main).collect();
        let n: u64 = rest.iter().map(|&f| dates[f]).sum();
        let parts = used
            .iter()
            .map(|&f| format!("{} like {}", dates[f], DATE_FORMATS[f].1))
            .collect::<Vec<_>>()
            .join(", ");
        let pattern = rest
            .iter()
            .map(|&f| format!("({})", DATE_FORMATS[f].2))
            .collect::<Vec<_>>()
            .join("|");
        out.push(Warning {
            kind: WarningKind::DateFormats,
            column: Some(name.clone()),
            rows: n,
            message: format!("Dates in {} formats: {parts}", used.len()),
            filters: vec![filter(name, FilterOp::Regex { pattern }, false)],
            fix: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_of_duckdb_types() {
        assert!(family("VARCHAR") == Family::Text);
        assert!(family("DECIMAL(18,3)") == Family::Number);
        assert!(family("BIGINT") == Family::Number);
        assert!(family("DATE") == Family::Other);
        assert!(family("BOOLEAN") == Family::Other);
    }

    #[test]
    fn shares_read_well() {
        assert_eq!(percent(1, 1000), "<1%");
        assert_eq!(percent(18, 22), "82%");
        assert_eq!(percent(0, 0), "0%");
        assert_eq!(round(2.000_04), 2.0);
    }
}
