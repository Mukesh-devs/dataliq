//! Charts over a view: the rows are aggregated (or sampled) in DuckDB and
//! only the small result goes to the UI, so a chart of 50M rows costs one
//! scan. Charts use the view's filters and search (not its sort or shown
//! columns), so they always match the rows the user sees.

mod sql;

use serde::{Deserialize, Serialize};

use arrow::array::{Array, AsArray};
use arrow::datatypes::{Float64Type, Int64Type};

use crate::engine::{Engine, RequestKey};
use crate::error::{AppError, Result};
use crate::view::{Bin, ProfileKind, ViewSpec};

pub use sql::{SeriesAgg, box_sql, grouped_sql, readable_sql, scatter_sql};

/// Categories shown by default (the largest by the first measure).
pub const DEFAULT_CATEGORIES: u32 = 50;
/// Most categories a bar chart shows.
pub const MAX_CATEGORIES: u32 = 500;
/// Most points of a line (numbers or dates on the x axis).
pub const MAX_POINTS: u32 = 10_000;
/// Points a scatter plot samples by default, and at most.
pub const DEFAULT_SAMPLE: u32 = 5_000;
pub const MAX_SAMPLE: u32 = 50_000;
/// Slices of a pie by default (the rest are "Other").
pub const DEFAULT_SLICES: u32 = 10;
/// Groups of a box plot by default.
pub const DEFAULT_BOXES: u32 = 20;
/// Series a "split by" column gives at most (the rest are "Other").
pub const MAX_SPLITS: usize = 7;
/// Histogram bars by default, and at most.
pub const DEFAULT_BINS: u32 = 30;
pub const MAX_BINS: u32 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChartKind {
    Bar,
    HorizontalBar,
    Line,
    Histogram,
    Scatter,
    /// One measure by category, as slices (the rest as "Other").
    Pie,
    /// The spread of `y` (min, quartiles, median, max) per group of `x`.
    Box,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Agg {
    /// Rows (the column, if given, is ignored).
    Count,
    Sum,
    Avg,
    Min,
    Max,
    CountDistinct,
}

/// Date and timestamp buckets on the x axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Bucket {
    Day,
    Week,
    Month,
    Year,
}

impl Bucket {
    fn unit(self) -> &'static str {
        match self {
            Bucket::Day => "day",
            Bucket::Week => "week",
            Bucket::Month => "month",
            Bucket::Year => "year",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measure {
    pub agg: Agg,
    #[serde(default)]
    pub column: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartSpec {
    pub kind: ChartKind,
    /// Grouped by (bar, line), binned (histogram) or the x axis (scatter).
    pub x: String,
    /// Dates and timestamps grouped by day, week, month or year.
    #[serde(default)]
    pub bucket: Option<Bucket>,
    /// Bar and line: one series per measure (default: count of rows).
    #[serde(default)]
    pub measures: Vec<Measure>,
    /// Scatter: the y axis; box plot: the number column.
    #[serde(default)]
    pub y: Option<String>,
    /// Bar and line: one series per value of this column (the first
    /// measure), the largest [`MAX_SPLITS`] and "Other".
    #[serde(default)]
    pub split_by: Option<String>,
    /// Histogram bars.
    #[serde(default)]
    pub bins: Option<u32>,
    /// Bar: the largest categories kept.
    #[serde(default)]
    pub limit: Option<u32>,
    /// Scatter: points sampled.
    #[serde(default)]
    pub sample: Option<u32>,
}

/// How the x values are to be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum XKind {
    /// Text labels (NULL is `null`).
    Category,
    Number,
    /// Milliseconds since 1970 (UTC).
    Time,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub name: String,
    pub values: Vec<Option<f64>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartData {
    pub kind: ChartKind,
    pub x_kind: XKind,
    /// Bar and line: the groups; scatter: the points' x.
    pub x: Vec<serde_json::Value>,
    /// Bar and line: one per measure; scatter: the points' y.
    pub series: Vec<Series>,
    /// Histogram bars (edges in the column's units; dates in ms).
    pub bins: Vec<Bin>,
    /// Groups (bar, line) or points with both values (scatter) in the view.
    pub total: u64,
    /// Fewer shown than `total`: the largest categories, the first points,
    /// or a random sample.
    pub truncated: bool,
    /// Pie of a count or sum: what the slices not shown add up to.
    pub other: Option<f64>,
    pub elapsed_ms: u64,
}

/// What one measure is called in the legend.
pub fn measure_name(m: &Measure) -> String {
    let col = m.column.as_deref().unwrap_or("");
    match m.agg {
        Agg::Count => "Count".into(),
        Agg::Sum => format!("Sum of {col}"),
        Agg::Avg => format!("Average {col}"),
        Agg::Min => format!("Min {col}"),
        Agg::Max => format!("Max {col}"),
        Agg::CountDistinct => format!("Distinct {col}"),
    }
}

fn values_f64(a: &dyn Array) -> Vec<Option<f64>> {
    let a = a.as_primitive::<Float64Type>();
    (0..a.len())
        .map(|i| (!a.is_null(i)).then(|| a.value(i)))
        .collect()
}

/// The legend name of a split value (NULL as "(empty)").
fn split_name(v: Option<&str>) -> String {
    v.map_or_else(|| "(empty)".to_string(), str::to_string)
}

impl Engine {
    /// The series of a grouped chart and their names: one per measure, or
    /// with `split_by` one per value of that column (the first measure) and
    /// "Other"; a pie takes the first measure, a box plot its five numbers.
    fn chart_series(
        &self,
        chart: &ChartSpec,
        built: &crate::view::BuiltView,
        schema: &[crate::sources::ColumnMeta],
        key: &RequestKey,
    ) -> Result<(Vec<SeriesAgg>, Vec<String>)> {
        let mut measures = if chart.measures.is_empty() {
            vec![Measure {
                agg: Agg::Count,
                column: None,
            }]
        } else {
            chart.measures.clone()
        };
        if chart.kind == ChartKind::Box {
            let y = chart.y.as_deref().unwrap_or_default();
            let names = ["Min", "Q1", "Median", "Q3", "Max", "Values"]
                .iter()
                .map(|n| {
                    format!(
                        "{n}{}",
                        if *n == "Values" {
                            String::new()
                        } else {
                            format!(" {y}")
                        }
                    )
                })
                .collect();
            return Ok((Vec::new(), names));
        }
        let split = chart.split_by.as_deref().filter(|_| {
            matches!(
                chart.kind,
                ChartKind::Bar | ChartKind::HorizontalBar | ChartKind::Line
            )
        });
        if chart.kind == ChartKind::Pie || split.is_some() {
            measures.truncate(1);
        }
        let Some(split) = split else {
            let names = measures.iter().map(measure_name).collect();
            let series = measures
                .into_iter()
                .map(|measure| SeriesAgg {
                    measure,
                    filter: None,
                })
                .collect();
            return Ok((series, names));
        };
        if split == chart.x {
            return Err(AppError::Query(
                "Split by a different column than the one on the axis.".into(),
            ));
        }
        let meta = schema
            .iter()
            .find(|c| c.name == split)
            .ok_or_else(|| AppError::Query(format!("There is no column named \"{split}\".")))?;
        let col = crate::engine::sql::quote_ident(&meta.name);
        let text = format!("CAST({col} AS VARCHAR)");
        // The most common values, one more to tell whether there are others.
        let r = self.query(
            &format!(
                "SELECT {text} AS v, count(*)::BIGINT AS n FROM ({}) GROUP BY 1 \
                 ORDER BY n DESC, v ASC NULLS LAST LIMIT {}",
                built.select,
                MAX_SPLITS + 1
            ),
            &built.params,
            MAX_SPLITS + 1,
            key,
        )?;
        let mut values: Vec<Option<String>> = Vec::new();
        for b in &r.batches {
            let v = b.column(0).as_string::<i32>();
            for i in 0..b.num_rows() {
                values.push((!v.is_null(i)).then(|| v.value(i).to_string()));
            }
        }
        let more = values.len() > MAX_SPLITS;
        values.truncate(MAX_SPLITS);
        let measure = measures.remove(0);
        let filter_of = |v: &Option<String>| match v {
            // Never NULL, so "Other" (NOT any of them) keeps rows with NULL.
            Some(v) => format!(
                "coalesce({text} = {}, false)",
                crate::engine::sql::literal(&crate::engine::Param::Text(v.clone()))
            ),
            None => format!("{col} IS NULL"),
        };
        let mut series: Vec<SeriesAgg> = values
            .iter()
            .map(|v| SeriesAgg {
                measure: measure.clone(),
                filter: Some(filter_of(v)),
            })
            .collect();
        let mut names: Vec<String> = values.iter().map(|v| split_name(v.as_deref())).collect();
        if more {
            let shown: Vec<String> = values
                .iter()
                .map(|v| format!("({})", filter_of(v)))
                .collect();
            series.push(SeriesAgg {
                measure,
                filter: Some(format!("NOT ({})", shown.join(" OR "))),
            });
            names.push("Other".into());
        }
        Ok((series, names))
    }

    /// "Copy chart SQL": the chart as one query over `reader` (the file's
    /// reader call, as for "Copy view as SQL") with the view's filters and
    /// search inlined; it runs as-is in plain DuckDB.
    pub fn chart_sql(
        &self,
        id: &str,
        view: &ViewSpec,
        chart: &ChartSpec,
        reader: &str,
    ) -> Result<String> {
        let schema = self.dataset_columns(id)?;
        let unsorted = ViewSpec {
            sort: Vec::new(),
            columns: None,
            ..view.clone()
        };
        let rows = crate::view::standalone_sql(
            &unsorted,
            reader,
            &schema,
            &std::collections::HashMap::new(),
            chrono::Local::now().date_naive(),
        )?;
        readable_sql(chart, rows.trim_end_matches(';'), &schema)
    }

    /// The chart `chart` of the view `view` on dataset `id`.
    pub fn chart_data(
        &self,
        id: &str,
        view: &ViewSpec,
        chart: &ChartSpec,
        key: &RequestKey,
    ) -> Result<ChartData> {
        let started = std::time::Instant::now();
        let (built, meta) = self.profile_view(id, view, &chart.x)?;
        let schema = self.dataset_columns(id)?;
        let mut data = match chart.kind {
            ChartKind::Histogram => {
                let kind = ProfileKind::of(&meta.r#type);
                let col = crate::engine::sql::quote_ident(&chart.x);
                let x = crate::view::numeric_expr(&col, kind, &meta.r#type).ok_or_else(|| {
                    AppError::Query(format!(
                        "A histogram needs a number or date column; \"{}\" is {}.",
                        chart.x, meta.r#type
                    ))
                })?;
                let r = self.query(
                    &format!(
                        "SELECT min({x}), max({x}), count({x})::BIGINT FROM ({})",
                        built.select
                    ),
                    &built.params,
                    1,
                    key,
                )?;
                let b = r
                    .batches
                    .first()
                    .ok_or_else(|| AppError::Internal("histogram range returned no rows".into()))?;
                let lo = b.column(0).as_primitive::<Float64Type>();
                let hi = b.column(1).as_primitive::<Float64Type>();
                let n = b.column(2).as_primitive::<Int64Type>().value(0) as u64;
                let bins = if lo.is_null(0) || hi.is_null(0) {
                    Vec::new()
                } else {
                    let integer =
                        kind == ProfileKind::Number && ProfileKind::is_integer(&meta.r#type);
                    let count = chart.bins.unwrap_or(DEFAULT_BINS).clamp(1, MAX_BINS) as usize;
                    let mut bins = self.histogram(
                        &built,
                        &x,
                        (lo.value(0), hi.value(0)),
                        integer,
                        count,
                        key,
                    )?;
                    if kind == ProfileKind::Temporal {
                        // Seconds to milliseconds, like the other charts' times.
                        for b in &mut bins {
                            b.lo *= 1000.0;
                            b.hi *= 1000.0;
                        }
                    }
                    bins
                };
                ChartData {
                    kind: chart.kind,
                    x_kind: if kind == ProfileKind::Temporal {
                        XKind::Time
                    } else {
                        XKind::Number
                    },
                    x: Vec::new(),
                    series: Vec::new(),
                    bins,
                    total: n,
                    truncated: false,
                    other: None,
                    elapsed_ms: 0,
                }
            }
            ChartKind::Scatter => {
                let y = chart
                    .y
                    .as_deref()
                    .ok_or_else(|| AppError::Query("Choose a column for the y axis.".into()))?;
                let n = chart.sample.unwrap_or(DEFAULT_SAMPLE).clamp(1, MAX_SAMPLE);
                let q = scatter_sql(&chart.x, y, n, &built.select, &schema)?;
                let total = {
                    let r = self.query(&q.count, &built.params, 1, key)?;
                    let b = r.batches.first().ok_or_else(|| {
                        AppError::Internal("scatter count returned no rows".into())
                    })?;
                    b.column(0).as_primitive::<Int64Type>().value(0) as u64
                };
                let r = self.query(&q.select, &built.params, n as usize, key)?;
                let mut x = Vec::new();
                let mut ys = Vec::new();
                for b in &r.batches {
                    x.extend(
                        values_f64(b.column(0).as_ref())
                            .into_iter()
                            .map(|v| v.map_or(serde_json::Value::Null, |v| serde_json::json!(v))),
                    );
                    ys.extend(values_f64(b.column(1).as_ref()));
                }
                ChartData {
                    kind: chart.kind,
                    x_kind: q.x_kind,
                    x,
                    series: vec![Series {
                        name: y.to_string(),
                        values: ys,
                    }],
                    bins: Vec::new(),
                    total,
                    truncated: total > n as u64,
                    other: None,
                    elapsed_ms: 0,
                }
            }
            ChartKind::Bar
            | ChartKind::HorizontalBar
            | ChartKind::Line
            | ChartKind::Pie
            | ChartKind::Box => {
                let (series, names) = self.chart_series(chart, &built, &schema, key)?;
                let q = if chart.kind == ChartKind::Box {
                    box_sql(chart, &built.select, &schema)?
                } else {
                    grouped_sql(chart, &series, &built.select, &schema)?
                };
                let r = self.query(&q.select, &built.params, q.limit as usize, key)?;
                let mut x = Vec::new();
                let mut series: Vec<Series> = names
                    .into_iter()
                    .map(|name| Series {
                        name,
                        values: Vec::new(),
                    })
                    .collect();
                let mut total = 0;
                for b in &r.batches {
                    let xs = b.column(0);
                    for i in 0..b.num_rows() {
                        x.push(if xs.is_null(i) {
                            serde_json::Value::Null
                        } else if q.x_kind == XKind::Category {
                            serde_json::json!(xs.as_string::<i32>().value(i))
                        } else {
                            serde_json::json!(xs.as_primitive::<Float64Type>().value(i))
                        });
                    }
                    for (m, s) in series.iter_mut().enumerate() {
                        s.values.extend(values_f64(b.column(1 + m).as_ref()));
                    }
                    let groups = b.column(1 + series.len()).as_primitive::<Int64Type>();
                    if b.num_rows() > 0 {
                        total = groups.value(0) as u64;
                    }
                }
                let truncated = total > x.len() as u64;
                // A pie of a count or sum shows what the hidden slices add up to.
                let other = match (chart.kind, chart.measures.first().map(|m| m.agg)) {
                    (ChartKind::Pie, None | Some(Agg::Count | Agg::Sum)) if truncated => {
                        let m = chart.measures.first().cloned().unwrap_or(Measure {
                            agg: Agg::Count,
                            column: None,
                        });
                        let all = sql::aggregate(&m, &schema, None)?;
                        let r = self.query(
                            &format!("SELECT {all} FROM ({})", built.select),
                            &built.params,
                            1,
                            key,
                        )?;
                        let whole = r
                            .batches
                            .first()
                            .and_then(|b| values_f64(b.column(0).as_ref()).first().copied())
                            .flatten();
                        let shown: f64 = series
                            .first()
                            .map(|s| s.values.iter().flatten().sum())
                            .unwrap_or(0.0);
                        whole.map(|w| w - shown).filter(|o| *o > 0.0)
                    }
                    _ => None,
                };
                ChartData {
                    kind: chart.kind,
                    x_kind: q.x_kind,
                    truncated,
                    x,
                    series,
                    bins: Vec::new(),
                    total,
                    other,
                    elapsed_ms: 0,
                }
            }
        };
        data.elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(data)
    }
}
