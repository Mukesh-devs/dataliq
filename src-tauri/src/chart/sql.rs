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
