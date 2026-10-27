//! SQL for charts over a view's `SELECT` (filters and search applied, no
//! sort). Column names reach SQL only through `quote_ident`, after being
//! checked against the dataset's schema; the view's values stay parameters.

use super::{
    Agg, ChartKind, ChartSpec, DEFAULT_CATEGORIES, MAX_CATEGORIES, MAX_POINTS, Measure, XKind,
};
use crate::engine::sql::quote_ident;
use crate::error::{AppError, Result};
use crate::sources::ColumnMeta;
use crate::view::ProfileKind;

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

fn aggregate(m: &Measure, schema: &[ColumnMeta]) -> Result<String> {
    if m.agg == Agg::Count {
        return Ok("CAST(count(*) AS DOUBLE)".into());
    }
    let name = m
        .column
        .as_deref()
        .ok_or_else(|| AppError::Query("Choose a column to aggregate.".into()))?;
    let meta = column(schema, name)?;
    let col = quote_ident(name);
    if m.agg == Agg::CountDistinct {
        return Ok(format!("CAST(count(DISTINCT {col}) AS DOUBLE)"));
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
    Ok(format!("CAST({f}({col}) AS DOUBLE)"))
}

/// Bar, horizontal bar and line: rows grouped by `x` (dates by `bucket`).
/// Categories keep the largest groups by the first measure; numbers and
/// dates are in x order (up to [`MAX_POINTS`]).
pub fn grouped_sql(
    chart: &ChartSpec,
    measures: &[Measure],
    view: &str,
    schema: &[ColumnMeta],
) -> Result<GroupedSql> {
    let meta = column(schema, &chart.x)?;
    let col = quote_ident(&chart.x);
    let kind = ProfileKind::of(&meta.r#type);
    let (x, x_kind) = match (kind, chart.bucket) {
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
    let aggs = measures
        .iter()
        .enumerate()
        .map(|(i, m)| Ok(format!("{} AS m{i}", aggregate(m, schema)?)))
        .collect::<Result<Vec<_>>>()?;
    let (order, limit) = if x_kind == XKind::Category {
        // Numbers as bars read best in their order, text by size.
        let order = if kind == ProfileKind::Number {
            "CAST(x AS DOUBLE) ASC NULLS LAST".to_string()
        } else {
            "m0 DESC NULLS LAST, x ASC NULLS LAST".to_string()
        };
        (
            order,
            chart
                .limit
                .unwrap_or(DEFAULT_CATEGORIES)
                .clamp(1, MAX_CATEGORIES),
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
        ChartKind::Bar | ChartKind::HorizontalBar | ChartKind::Line => {
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
                aggregate(m, schema)?;
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
            let category = !(chart.kind == ChartKind::Line && axis_value(&col, meta).is_some())
                && kind != ProfileKind::Temporal;
            let (order, limit) = if !category {
                ("1 ASC NULLS LAST".to_string(), MAX_POINTS)
            } else if kind == ProfileKind::Number {
                (
                    "1 ASC NULLS LAST".to_string(),
                    chart
                        .limit
                        .unwrap_or(DEFAULT_CATEGORIES)
                        .clamp(1, MAX_CATEGORIES),
                )
            } else {
                (
                    "2 DESC NULLS LAST, 1 ASC NULLS LAST".to_string(),
                    chart
                        .limit
                        .unwrap_or(DEFAULT_CATEGORIES)
                        .clamp(1, MAX_CATEGORIES),
                )
            };
            Ok(format!(
                "SELECT {}\nFROM ({view})\nGROUP BY 1\nORDER BY {order}\nLIMIT {limit};",
                cols.join(", ")
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

    fn render(q: &GroupedSql) -> String {
        format!("{:?} limit {}\n{}", q.x_kind, q.limit, q.select)
    }

    #[test]
    fn bar_of_categories_keeps_the_largest() {
        let q = grouped_sql(
            &chart(ChartKind::Bar, "city"),
            &[m(Agg::Count, None), m(Agg::Sum, Some("amount"))],
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
            &[m(Agg::Avg, Some("amount"))],
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
        let month = grouped_sql(&c, &[m(Agg::Max, Some("amount"))], VIEW, &schema()).unwrap();
        c.x = "seen".into();
        c.bucket = Some(Bucket::Week);
        let week =
            grouped_sql(&c, &[m(Agg::CountDistinct, Some("city"))], VIEW, &schema()).unwrap();
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
            &[m(Agg::Sum, Some("city"))],
            VIEW,
            &schema(),
        )
        .unwrap_err();
        assert!(e.to_string().contains("need a number column"), "{e}");
        let e = grouped_sql(&chart(ChartKind::Bar, "nope"), &[], VIEW, &schema()).unwrap_err();
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
            &[m(Agg::Count, None)],
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
