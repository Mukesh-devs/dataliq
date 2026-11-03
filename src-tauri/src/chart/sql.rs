//! SQL for charts over a view's `SELECT` (filters and search applied, no
//! sort). Column names reach SQL only through `quote_ident`, after being
//! checked against the dataset's schema; the view's values stay parameters.

use super::{
    Agg, ChartKind, ChartSpec, DEFAULT_BOXES, DEFAULT_CATEGORIES, DEFAULT_SLICES, MAX_CATEGORIES,
    MAX_POINTS, Measure, XKind,
};
use crate::engine::sql::quote_ident;
use crate::error::{AppError, Result};
use crate::sources::ColumnMeta;
use crate::view::ProfileKind;

/// One series of a grouped chart: a measure over the rows `filter` keeps
/// (all when none), e.g. one value of a "split by" column.
#[derive(Debug, Clone, PartialEq)]
pub struct SeriesAgg {
    pub measure: Measure,
    pub filter: Option<String>,
}

/// A grouped chart's query: `x`, one column per measure, then the number of
/// groups before the limit.
#[derive(Debug, Clone, PartialEq)]
pub struct GroupedSql {
    pub select: String,
    pub x_kind: XKind,
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScatterSql {
    /// Points with both values.
    pub count: String,
    /// `x`, `y` as DOUBLE (dates as ms), sampled to the limit.
    pub select: String,
    pub x_kind: XKind,
}

fn column<'a>(schema: &'a [ColumnMeta], name: &str) -> Result<&'a ColumnMeta> {
    schema
        .iter()
        .find(|c| c.name == name)
        .ok_or_else(|| AppError::Query(format!("There is no column named \"{name}\".")))
}

/// `col` as a TIMESTAMP (time-zone types are taken as their UTC instant).
fn as_timestamp(col: &str, meta: &ColumnMeta) -> String {
    if meta.r#type.to_ascii_uppercase().contains("TIME ZONE") {
        // Without the ICU extension, the UTC wall time of the instant.
        format!("make_timestamp(epoch_us({col}))")
    } else {
        format!("CAST({col} AS TIMESTAMP)")
    }
}

/// `col` on a number axis: the number, or ms since 1970 for dates.
fn axis_value(col: &str, meta: &ColumnMeta) -> Option<(String, XKind)> {
    match ProfileKind::of(&meta.r#type) {
        ProfileKind::Number => Some((format!("CAST({col} AS DOUBLE)"), XKind::Number)),
        ProfileKind::Temporal => Some((
            format!("CAST(epoch_ms({}) AS DOUBLE)", as_timestamp(col, meta)),
            XKind::Time,
        )),
        _ => None,
    }
}

/// A measure as a DOUBLE aggregate, over the rows `filter` keeps.
pub(crate) fn aggregate(
    m: &Measure,
    schema: &[ColumnMeta],
    filter: Option<&str>,
) -> Result<String> {
    let only = filter.map_or_else(String::new, |f| format!(" FILTER (WHERE {f})"));
    if m.agg == Agg::Count {
        return Ok(format!("CAST(count(*){only} AS DOUBLE)"));
    }
    let name = m
        .column
        .as_deref()
        .ok_or_else(|| AppError::Query("Choose a column to aggregate.".into()))?;
    let meta = column(schema, name)?;
    let col = quote_ident(name);
    if m.agg == Agg::CountDistinct {
        return Ok(format!("CAST(count(DISTINCT {col}){only} AS DOUBLE)"));
    }
    if ProfileKind::of(&meta.r#type) != ProfileKind::Number {
        return Err(AppError::Query(format!(
            "\"{name}\" is {}; sum, average, min and max need a number column.",
            meta.r#type
        )));
    }
    let f = match m.agg {
        Agg::Sum => "sum",
        Agg::Avg => "avg",
        Agg::Min => "min",
        Agg::Max => "max",
        Agg::Count | Agg::CountDistinct => unreachable!(),
    };
    Ok(format!("CAST({f}({col}){only} AS DOUBLE)"))
}

/// Bar, horizontal bar and line: rows grouped by `x` (dates by `bucket`).
/// Categories keep the largest groups by the first measure; numbers and
/// dates are in x order (up to [`MAX_POINTS`]).
pub fn grouped_sql(
    chart: &ChartSpec,
    series: &[SeriesAgg],
    view: &str,
    schema: &[ColumnMeta],
) -> Result<GroupedSql> {
    let meta = column(schema, &chart.x)?;
    let col = quote_ident(&chart.x);
    let kind = ProfileKind::of(&meta.r#type);
    let pie = chart.kind == ChartKind::Pie;
    let (x, x_kind) = match (kind, chart.bucket) {
        // A pie's slices are labels: dates by their bucket as text.
        (ProfileKind::Temporal, Some(b)) if pie => (
            format!(
                "CAST(CAST(date_trunc('{}', {}) AS DATE) AS VARCHAR)",
                b.unit(),
                as_timestamp(&col, meta)
            ),
            XKind::Category,
        ),
        _ if pie => (format!("CAST({col} AS VARCHAR)"), XKind::Category),
        (ProfileKind::Temporal, Some(b)) => (
            format!(
                "CAST(epoch_ms(date_trunc('{}', {})) AS DOUBLE)",
                b.unit(),
                as_timestamp(&col, meta)
            ),
            XKind::Time,
        ),
        _ => match axis_value(&col, meta) {
            // A line follows its x values; bars of numbers are categories.
            Some(v) if chart.kind == ChartKind::Line || kind == ProfileKind::Temporal => v,
            _ => (format!("CAST({col} AS VARCHAR)"), XKind::Category),
        },
    };
    let aggs = series
        .iter()
        .enumerate()
        .map(|(i, s)| {
            Ok(format!(
                "{} AS m{i}",
                aggregate(&s.measure, schema, s.filter.as_deref())?
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    // Split series: categories by their total over every series.
    let size = if series.iter().any(|s| s.filter.is_some()) {
        let parts: Vec<String> = (0..series.len())
            .map(|i| format!("coalesce(m{i}, 0)"))
            .collect();
        format!("({})", parts.join(" + "))
    } else {
        "m0".to_string()
    };
    let (order, limit) = if x_kind == XKind::Category {
        // Numbers as bars read best in their order, text (and slices) by size.
        let order = if kind == ProfileKind::Number && !pie {
            "CAST(x AS DOUBLE) ASC NULLS LAST".to_string()
        } else {
            format!("{size} DESC NULLS LAST, x ASC NULLS LAST")
        };
        let default = if pie {
            DEFAULT_SLICES
        } else {
            DEFAULT_CATEGORIES
        };
        (
            order,
            chart.limit.unwrap_or(default).clamp(1, MAX_CATEGORIES),
        )
    } else {
        ("x ASC NULLS LAST".to_string(), MAX_POINTS)
    };
    Ok(GroupedSql {
        select: format!(
            "SELECT *, count(*) OVER ()::BIGINT AS groups FROM (\
             SELECT {x} AS x, {} FROM ({view}) GROUP BY 1\
             ) ORDER BY {order} LIMIT {limit}",
            aggs.join(", ")
        ),
        x_kind,
        limit,
    })
}

/// Box plot: per group of `x` (the largest groups), the minimum, quartiles,
/// median and maximum of the number column `y`, and how many values.
pub fn box_sql(chart: &ChartSpec, view: &str, schema: &[ColumnMeta]) -> Result<GroupedSql> {
    let y = chart
        .y
        .as_deref()
        .ok_or_else(|| AppError::Query("Choose the number column to show the spread of.".into()))?;
    let meta = column(schema, y)?;
    if ProfileKind::of(&meta.r#type) != ProfileKind::Number {
        return Err(AppError::Query(format!(
            "A box plot shows the spread of numbers; \"{y}\" is {}.",
            meta.r#type
        )));
    }
    column(schema, &chart.x)?;
    let (x, yc) = (quote_ident(&chart.x), quote_ident(y));
    let v = format!("CAST({yc} AS DOUBLE)");
    let limit = chart
        .limit
        .unwrap_or(DEFAULT_BOXES)
        .clamp(1, MAX_CATEGORIES);
    Ok(GroupedSql {
        select: format!(
            "SELECT *, count(*) OVER ()::BIGINT AS groups FROM (\
             SELECT CAST({x} AS VARCHAR) AS x, min({v}) AS m0, quantile_cont({v}, 0.25) AS m1, \
             median({v}) AS m2, quantile_cont({v}, 0.75) AS m3, max({v}) AS m4, \
             CAST(count({v}) AS DOUBLE) AS m5 FROM ({view}) WHERE {yc} IS NOT NULL GROUP BY 1\
             ) ORDER BY m5 DESC, x ASC NULLS LAST LIMIT {limit}"
        ),
        x_kind: XKind::Category,
        limit,
    })
}

/// Scatter: `n` points with both values, a repeatable random sample when
/// there are more.
pub fn scatter_sql(
    x: &str,
    y: &str,
    n: u32,
    view: &str,
    schema: &[ColumnMeta],
) -> Result<ScatterSql> {
    let axis = |name: &str| -> Result<(String, XKind)> {
        let meta = column(schema, name)?;
        axis_value(&quote_ident(name), meta).ok_or_else(|| {
            AppError::Query(format!(
                "A scatter plot needs number or date columns; \"{name}\" is {}.",
                meta.r#type
            ))
        })
    };
    let (xv, x_kind) = axis(x)?;
    let (yv, _) = axis(y)?;
    let points = format!(
        "SELECT {xv} AS x, {yv} AS y FROM ({view}) WHERE {} IS NOT NULL AND {} IS NOT NULL",
        quote_ident(x),
        quote_ident(y)
    );
    Ok(ScatterSql {
        count: format!("SELECT count(*)::BIGINT FROM ({points})"),
        select: format!(
            "SELECT x, y FROM ({points}) USING SAMPLE reservoir({n} ROWS) REPEATABLE (7)"
        ),
        x_kind,
    })
}

/// The chart as one readable query over `view` (the view's own standalone
/// SQL, every value inlined), for "Copy chart SQL": it runs as-is in plain
/// DuckDB and gives the chart's numbers. Dates stay dates; histograms give
/// each bar's range and rows (bars without rows are left out).
pub fn readable_sql(chart: &ChartSpec, view: &str, schema: &[ColumnMeta]) -> Result<String> {
    let meta = column(schema, &chart.x)?;
    let col = quote_ident(&chart.x);
    let kind = ProfileKind::of(&meta.r#type);
    match chart.kind {
        ChartKind::Histogram => {
            let x = match kind {
                ProfileKind::Number => format!("CAST({col} AS DOUBLE)"),
                ProfileKind::Temporal => format!("epoch({})", as_timestamp(&col, meta)),
                _ => {
                    return Err(AppError::Query(format!(
                        "A histogram needs a number or date column; \"{}\" is {}.",
                        chart.x, meta.r#type
                    )));
                }
            };
            let bins = chart
                .bins
                .unwrap_or(super::DEFAULT_BINS)
                .clamp(1, super::MAX_BINS);
            let integer = kind == ProfileKind::Number && ProfileKind::is_integer(&meta.r#type);
            // Small integer ranges get one bar per value, as in the app.
            let one_per_value = format!("{integer} AND hi - lo < {bins}");
            let edge = |e: &str| {
                if kind == ProfileKind::Temporal {
                    format!("make_timestamp(CAST(({e}) * 1000000 AS BIGINT))")
                } else {
                    e.to_string()
                }
            };
            Ok(format!(
                "WITH v AS (SELECT {x} AS x FROM ({view}) WHERE {col} IS NOT NULL),\n\
                 r AS (SELECT min(x) AS lo, max(x) AS hi FROM v),\n\
                 w AS (SELECT lo, hi,\n\
                   CASE WHEN {one_per_value} THEN hi - lo + 1 WHEN hi > lo THEN {bins} ELSE 1 END AS n,\n\
                   CASE WHEN {one_per_value} THEN 1 WHEN hi > lo THEN (hi - lo) / {bins} ELSE 0 END AS width\n\
                 FROM r)\n\
                 SELECT {start} AS bin_start, {end} AS bin_end, count(*) AS \"rows\"\n\
                 FROM (SELECT CASE WHEN width = 0 THEN 0\n\
                   ELSE least(greatest(CAST(floor((x - lo) / width) AS BIGINT), 0), n - 1) END AS b,\n\
                   lo, hi, n, width FROM v, w)\n\
                 GROUP BY b, lo, hi, n, width\n\
                 ORDER BY b;",
                start = edge("lo + b * width"),
                end = edge(
                    "CASE WHEN b = n - 1 AND width <> 1 THEN hi ELSE lo + (b + 1) * width END"
                ),
            ))
        }
        ChartKind::Scatter => {
            let y = chart
                .y
                .as_deref()
                .ok_or_else(|| AppError::Query("Choose a column for the y axis.".into()))?;
            column(schema, y)?;
            let n = chart
                .sample
                .unwrap_or(super::DEFAULT_SAMPLE)
                .clamp(1, super::MAX_SAMPLE);
            let yc = quote_ident(y);
            Ok(format!(
                "SELECT * FROM (\n  SELECT {col}, {yc} FROM ({view})\n  WHERE {col} IS NOT NULL AND {yc} IS NOT NULL\n) USING SAMPLE reservoir({n} ROWS) REPEATABLE (7);"
            ))
        }
        ChartKind::Box => {
            let y = chart
                .y
                .as_deref()
                .ok_or_else(|| AppError::Query("Choose a number column.".into()))?;
            box_sql(chart, view, schema)?;
            let yc = quote_ident(y);
            let limit = chart
                .limit
                .unwrap_or(DEFAULT_BOXES)
                .clamp(1, MAX_CATEGORIES);
            Ok(format!(
                "SELECT {col}, min({yc}) AS \"min\", quantile_cont({yc}, 0.25) AS q1, median({yc}) AS median,\n\
                 quantile_cont({yc}, 0.75) AS q3, max({yc}) AS \"max\", count({yc}) AS \"values\"\n\
                 FROM ({view})\nWHERE {yc} IS NOT NULL\nGROUP BY 1\nORDER BY \"values\" DESC, 1 ASC NULLS LAST\nLIMIT {limit};"
            ))
        }
        ChartKind::Bar | ChartKind::HorizontalBar | ChartKind::Line | ChartKind::Pie => {
            let x = match (kind, chart.bucket) {
                (ProfileKind::Temporal, Some(b)) => {
                    format!("date_trunc('{}', {})", b.unit(), as_timestamp(&col, meta))
                }
                _ => col.clone(),
            };
            let measures = if chart.measures.is_empty() {
                vec![Measure {
                    agg: Agg::Count,
                    column: None,
                }]
            } else {
                chart.measures.clone()
            };
            let mut cols = vec![format!("{x} AS {col}")];
            for m in &measures {
                // The same checks and maths as the chart, in the column's own type.
                aggregate(m, schema, None)?;
                let expr = match (m.agg, m.column.as_deref().map(quote_ident)) {
                    (Agg::Count, _) => "count(*)".to_string(),
                    (Agg::CountDistinct, Some(c)) => format!("count(DISTINCT {c})"),
                    (Agg::Sum, Some(c)) => format!("sum({c})"),
                    (Agg::Avg, Some(c)) => format!("avg({c})"),
                    (Agg::Min, Some(c)) => format!("min({c})"),
                    (Agg::Max, Some(c)) => format!("max({c})"),
                    (_, None) => unreachable!("checked by aggregate()"),
                };
                cols.push(format!(
                    "{expr} AS {}",
                    quote_ident(&super::measure_name(m))
                ));
            }
            let pie = chart.kind == ChartKind::Pie;
            let category = pie
                || (!(chart.kind == ChartKind::Line && axis_value(&col, meta).is_some())
                    && kind != ProfileKind::Temporal);
            let categories = chart
                .limit
                .unwrap_or(if pie {
                    DEFAULT_SLICES
                } else {
                    DEFAULT_CATEGORIES
                })
                .clamp(1, MAX_CATEGORIES);
            // Split by a column: one row per group and value (the first measure).
            if let Some(split) = chart.split_by.as_deref().filter(|_| !pie) {
                column(schema, split)?;
                let measure = cols.get(1).cloned().unwrap_or_default();
                return Ok(format!(
                    "SELECT {}, {} AS {}, {measure}\nFROM ({view})\nGROUP BY 1, 2\nORDER BY 1 ASC NULLS LAST, 3 DESC NULLS LAST;",
                    cols[0],
                    quote_ident(split),
                    quote_ident(split),
                ));
            }
            let (order, limit) = if !category {
                ("1 ASC NULLS LAST".to_string(), MAX_POINTS)
            } else if kind == ProfileKind::Number && !pie {
                ("1 ASC NULLS LAST".to_string(), categories)
            } else {
                (
                    "2 DESC NULLS LAST, 1 ASC NULLS LAST".to_string(),
                    categories,
                )
            };
            let measures = if pie {
                &cols[..2.min(cols.len())]
            } else {
                &cols[..]
            };
            Ok(format!(
                "SELECT {}\nFROM ({view})\nGROUP BY 1\nORDER BY {order}\nLIMIT {limit};",
                measures.join(", ")
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::Bucket;

    fn schema() -> Vec<ColumnMeta> {
        [
            ("city", "VARCHAR"),
            ("amount", "DOUBLE"),
            ("quantity", "INTEGER"),
            ("joined", "DATE"),
            ("seen", "TIMESTAMP WITH TIME ZONE"),
            ("active", "BOOLEAN"),
        ]
        .iter()
        .map(|(n, t)| ColumnMeta {
            name: n.to_string(),
            r#type: t.to_string(),
        })
        .collect()
    }

    const VIEW: &str = "SELECT * FROM t WHERE \"amount\" > ?";

    fn chart(kind: ChartKind, x: &str) -> ChartSpec {
        ChartSpec {
            kind,
            x: x.into(),
            bucket: None,
            measures: vec![],
            y: None,
            split_by: None,
            bins: None,
            limit: None,
            sample: None,
        }
    }

    fn m(agg: Agg, column: Option<&str>) -> Measure {
        Measure {
            agg,
            column: column.map(String::from),
        }
    }

    /// Measures as unfiltered series, as `grouped_sql` takes them.
    fn all(measures: &[Measure]) -> Vec<SeriesAgg> {
        measures
            .iter()
            .map(|m| SeriesAgg {
                measure: m.clone(),
                filter: None,
            })
            .collect()
    }

    fn render(q: &GroupedSql) -> String {
        format!("{:?} limit {}\n{}", q.x_kind, q.limit, q.select)
    }

    #[test]
    fn bar_of_categories_keeps_the_largest() {
        let q = grouped_sql(
            &chart(ChartKind::Bar, "city"),
            &all(&[m(Agg::Count, None), m(Agg::Sum, Some("amount"))]),
            VIEW,
            &schema(),
        )
        .unwrap();
        insta::assert_snapshot!(render(&q));
    }

    #[test]
    fn bars_of_numbers_are_categories_in_order() {
        let q = grouped_sql(
            &chart(ChartKind::HorizontalBar, "quantity"),
            &all(&[m(Agg::Avg, Some("amount"))]),
            VIEW,
            &schema(),
        )
        .unwrap();
        insta::assert_snapshot!(render(&q));
    }

    #[test]
    fn line_by_month_and_by_timestamp_with_time_zone() {
        let mut c = chart(ChartKind::Line, "joined");
        c.bucket = Some(Bucket::Month);
        let month = grouped_sql(&c, &all(&[m(Agg::Max, Some("amount"))]), VIEW, &schema()).unwrap();
        c.x = "seen".into();
        c.bucket = Some(Bucket::Week);
        let week = grouped_sql(
            &c,
            &all(&[m(Agg::CountDistinct, Some("city"))]),
            VIEW,
            &schema(),
        )
        .unwrap();
        insta::assert_snapshot!(format!("{}\n\n{}", render(&month), render(&week)));
    }

    #[test]
    fn scatter_samples_points_with_both_values() {
        let q = scatter_sql("amount", "joined", 5000, VIEW, &schema()).unwrap();
        insta::assert_snapshot!(format!("{:?}\n{}\n{}", q.x_kind, q.count, q.select));
    }

    #[test]
    fn readable_sql_for_copying() {
        let mut bar = chart(ChartKind::Bar, "city");
        bar.measures = vec![m(Agg::Count, None), m(Agg::Avg, Some("amount"))];
        let mut line = chart(ChartKind::Line, "joined");
        line.bucket = Some(Bucket::Month);
        let mut hist = chart(ChartKind::Histogram, "quantity");
        hist.bins = Some(10);
        let mut scatter = chart(ChartKind::Scatter, "amount");
        scatter.y = Some("quantity".into());
        scatter.sample = Some(100);
        let view = "SELECT * FROM read_csv('/data/a.csv') WHERE \"amount\" > 5";
        let all = [bar, line, hist, scatter]
            .iter()
            .map(|c| readable_sql(c, view, &schema()).unwrap())
            .collect::<Vec<_>>()
            .join("\n\n");
        insta::assert_snapshot!(all);
    }

    #[test]
    fn bad_columns_are_errors_in_words() {
        let e = grouped_sql(
            &chart(ChartKind::Bar, "city"),
            &all(&[m(Agg::Sum, Some("city"))]),
            VIEW,
            &schema(),
        )
        .unwrap_err();
        assert!(e.to_string().contains("need a number column"), "{e}");
        let e =
            grouped_sql(&chart(ChartKind::Bar, "nope"), &all(&[]), VIEW, &schema()).unwrap_err();
        assert!(e.to_string().contains("no column named \"nope\""), "{e}");
        let e = scatter_sql("city", "amount", 10, VIEW, &schema()).unwrap_err();
        assert!(e.to_string().contains("number or date"), "{e}");
        // Names are quoted, never spliced.
        let mut s = schema();
        s.push(ColumnMeta {
            name: "a\"b".into(),
            r#type: "VARCHAR".into(),
        });
        let q = grouped_sql(
            &chart(ChartKind::Bar, "a\"b"),
            &all(&[m(Agg::Count, None)]),
            VIEW,
            &s,
        )
        .unwrap();
        assert!(
            q.select.contains("CAST(\"a\"\"b\" AS VARCHAR)"),
            "{}",
            q.select
        );
    }
}
