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

pub use sql::{grouped_sql, readable_sql, scatter_sql};

/// Categories shown by default (the largest by the first measure).
pub const DEFAULT_CATEGORIES: u32 = 50;
/// Most categories a bar chart shows.
pub const MAX_CATEGORIES: u32 = 500;
/// Most points of a line (numbers or dates on the x axis).
pub const MAX_POINTS: u32 = 10_000;
/// Points a scatter plot samples by default, and at most.
pub const DEFAULT_SAMPLE: u32 = 5_000;
pub const MAX_SAMPLE: u32 = 50_000;
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
    /// Scatter: the y axis.
    #[serde(default)]
    pub y: Option<String>,
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

impl Engine {
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
                    elapsed_ms: 0,
                }
            }
            ChartKind::Bar | ChartKind::HorizontalBar | ChartKind::Line => {
                let measures = if chart.measures.is_empty() {
                    vec![Measure {
                        agg: Agg::Count,
                        column: None,
                    }]
                } else {
                    chart.measures.clone()
                };
                let q = grouped_sql(chart, &measures, &built.select, &schema)?;
                let r = self.query(&q.select, &built.params, q.limit as usize, key)?;
                let mut x = Vec::new();
                let mut series: Vec<Series> = measures
                    .iter()
                    .map(|m| Series {
                        name: measure_name(m),
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
                    let groups = b.column(1 + measures.len()).as_primitive::<Int64Type>();
                    if b.num_rows() > 0 {
                        total = groups.value(0) as u64;
                    }
                }
                ChartData {
                    kind: chart.kind,
                    x_kind: q.x_kind,
                    truncated: total > x.len() as u64,
                    x,
                    series,
                    bins: Vec::new(),
                    total,
                    elapsed_ms: 0,
                }
            }
        };
        data.elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(data)
    }
}
