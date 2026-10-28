//! Column profiles on people.csv, checked against statistics computed here
//! from the parsed file (independently of DuckDB).

use std::collections::{HashMap, HashSet};

use bigview_lib::engine::{Param, RequestKey};
use bigview_lib::view::{BINS, Filter, FilterOp, ProfileKind, TOP_VALUES, ViewSpec};

use crate::filters::{Person, fx};

fn profile(
    fx: &crate::filters::Fx,
    spec: &ViewSpec,
    column: &str,
) -> bigview_lib::view::ColumnProfile {
    fx.engine
        .column_profile(&fx.dataset.id, spec, column, &RequestKey::default())
        .unwrap()
}

/// Histogram counts with the same edges as the app: BINS equal bars from
/// min to max, the maximum in the last bar.
fn bins(values: &[f64]) -> Vec<u64> {
    let lo = values.iter().cloned().fold(f64::INFINITY, f64::min);
    let hi = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let w = (hi - lo) / BINS as f64;
    let mut out = vec![0u64; BINS];
    for v in values {
        let b = (((v - lo) / w).floor() as i64).clamp(0, BINS as i64 - 1);
        out[b as usize] += 1;
    }
    out
}

fn top<T: Clone + Eq + std::hash::Hash + Ord>(
    values: impl Iterator<Item = Option<T>>,
) -> Vec<(Option<T>, u64)> {
    let mut counts: HashMap<Option<T>, u64> = HashMap::new();
    for v in values {
        *counts.entry(v).or_default() += 1;
    }
    let mut v: Vec<_> = counts.into_iter().collect();
    // Most frequent first, then by value with NULL first (like the app).
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v
}

#[test]
fn number_column_profile() {
    let fx = fx();
    let p = profile(&fx, &ViewSpec::default(), "amount");
    let vals: Vec<f64> = fx.people.iter().filter_map(|p| p.amount).collect();
    assert_eq!(p.kind, ProfileKind::Number);
    assert_eq!(p.rows, 1000);
    assert_eq!(p.nulls, 1000 - vals.len() as u64);
    let n = vals.len() as f64;
    let mean = vals.iter().sum::<f64>() / n;
    let sd = (vals.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1.0)).sqrt();
    assert!(
        (p.mean.unwrap() - mean).abs() < 1e-9,
        "{:?} vs {mean}",
        p.mean
    );
    assert!((p.stddev.unwrap() - sd).abs() < 1e-9);
    let min = vals.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    assert_eq!(p.min.as_deref().unwrap().parse::<f64>().unwrap(), min);
    assert_eq!(p.max.as_deref().unwrap().parse::<f64>().unwrap(), max);
    let distinct: HashSet<u64> = vals.iter().map(|v| v.to_bits()).collect();
    assert_eq!(p.distinct, Some(distinct.len() as u64));
    assert!(!p.distinct_approx);
    let h = p.histogram.unwrap();
    assert_eq!(h.len(), BINS);
    assert_eq!(h.first().unwrap().lo, min);
    assert_eq!(h.last().unwrap().hi, max);
    assert_eq!(h.iter().map(|b| b.count).collect::<Vec<_>>(), bins(&vals));
}

#[test]
fn integer_text_date_and_boolean_profiles() {
    let fx = fx();
    // id: 1..=1000, all distinct.
    let p = profile(&fx, &ViewSpec::default(), "id");
    assert_eq!(
        (p.min.as_deref(), p.max.as_deref()),
        (Some("1"), Some("1000"))
    );
    assert_eq!(p.distinct, Some(1000));
    assert_eq!(p.mean, Some(500.5));
    let ids: Vec<f64> = (1..=1000).map(f64::from).collect();
    assert_eq!(
        p.histogram
            .unwrap()
            .iter()
            .map(|b| b.count)
            .collect::<Vec<_>>(),
        bins(&ids)
    );
    assert!(p.top_truncated);

    // name: text, NULLs and "" both present; byte-wise min / max.
    let p = profile(&fx, &ViewSpec::default(), "name");
    assert_eq!(p.kind, ProfileKind::Text);
    let names: Vec<&str> = fx.people.iter().filter_map(|p| p.name.as_deref()).collect();
    assert_eq!(p.nulls, 1000 - names.len() as u64);
    assert_eq!(p.min.as_deref(), names.iter().min().copied());
    assert_eq!(p.max.as_deref(), names.iter().max().copied());
    assert_eq!(
        p.distinct,
        Some(names.iter().collect::<HashSet<_>>().len() as u64)
    );
    assert_eq!((p.mean, p.histogram.as_ref()), (None, None));

    // joined: dates, histogram over seconds since 1970.
    let p = profile(&fx, &ViewSpec::default(), "joined");
    assert_eq!(p.kind, ProfileKind::Temporal);
    let dates: Vec<&str> = fx
        .people
        .iter()
        .filter_map(|p| p.joined.as_deref())
        .collect();
    assert_eq!(p.min.as_deref(), dates.iter().min().copied());
    assert_eq!(p.max.as_deref(), dates.iter().max().copied());
    let secs: Vec<f64> = dates
        .iter()
        .map(|d| {
            let d = chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").unwrap();
            d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp() as f64
        })
        .collect();
    assert_eq!(
        p.histogram
            .unwrap()
            .iter()
            .map(|b| b.count)
            .collect::<Vec<_>>(),
        bins(&secs)
    );

    // active: booleans, top values are true / false / null.
    let p = profile(&fx, &ViewSpec::default(), "active");
    assert_eq!(p.kind, ProfileKind::Boolean);
    let want = top(fx.people.iter().map(|p| p.active.map(|b| b.to_string())));
    let got: Vec<_> = p.top.iter().map(|v| (v.value.clone(), v.count)).collect();
    assert_eq!(got, want);
    assert!(!p.top_truncated);
}

#[test]
fn top_values_and_filters() {
    let fx = fx();
    let p = profile(&fx, &ViewSpec::default(), "city");
    let want = top(fx.people.iter().map(|p| p.city.clone()));
    let got: Vec<_> = p.top.iter().map(|v| (v.value.clone(), v.count)).collect();
    assert_eq!(got, want[..want.len().min(TOP_VALUES)]);

    // Under a filter (including one on the profiled column itself).
    let spec = ViewSpec {
        filters: vec![
            Filter {
                column: "active".into(),
                op: FilterOp::Equals {
                    value: Param::Bool(true),
                },
                not: false,
            },
            Filter {
                column: "amount".into(),
                op: FilterOp::Gt {
                    value: Param::Int(100),
                },
                not: false,
            },
        ],
        sort: vec![bigview_lib::view::SortKey {
            column: "amount".into(),
            descending: true,
        }],
        ..ViewSpec::default()
    };
    let keep = |p: &&Person| p.active == Some(true) && p.amount.is_some_and(|a| a > 100.0);
    let p = profile(&fx, &spec, "amount");
    let vals: Vec<f64> = fx
        .people
        .iter()
        .filter(keep)
        .filter_map(|p| p.amount)
        .collect();
    assert_eq!(p.rows, vals.len() as u64);
    assert_eq!(p.nulls, 0);
    assert!(p.min.unwrap().parse::<f64>().unwrap() > 100.0);
    assert_eq!(
        p.histogram
            .unwrap()
            .iter()
            .map(|b| b.count)
            .collect::<Vec<_>>(),
        bins(&vals)
    );
    // An empty view: no histogram bars, no values.
    let none = ViewSpec {
        filters: vec![Filter {
            column: "amount".into(),
            op: FilterOp::Gt {
                value: Param::Int(1_000_000),
            },
            not: false,
        }],
        ..ViewSpec::default()
    };
    let p = profile(&fx, &none, "amount");
    assert_eq!((p.rows, p.nulls, p.distinct), (0, 0, Some(0)));
    assert_eq!(p.histogram, Some(vec![]));
    assert!(p.top.is_empty());
}

#[test]
fn header_histograms() {
    let fx = fx();
    let cols: Vec<String> = ["id", "name", "amount", "joined", "active"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let h = fx
        .engine
        .column_histograms(
            &fx.dataset.id,
            &ViewSpec::default(),
            &cols,
            &RequestKey::default(),
        )
        .unwrap();
    // Text columns have no header histogram.
    let names: Vec<&str> = h.iter().map(|c| c.column.as_str()).collect();
    assert_eq!(names, ["id", "amount", "joined", "active"]);
    let amount = h.iter().find(|c| c.column == "amount").unwrap();
    let vals: Vec<f64> = fx.people.iter().filter_map(|p| p.amount).collect();
    assert_eq!(
        amount.bins.iter().map(|b| b.count).collect::<Vec<_>>(),
        bins(&vals)
    );
    let active = h.iter().find(|c| c.column == "active").unwrap();
    let t = fx.people.iter().filter(|p| p.active == Some(true)).count() as u64;
    let f = fx.people.iter().filter(|p| p.active == Some(false)).count() as u64;
    assert_eq!(
        active.bins.iter().map(|b| b.count).collect::<Vec<_>>(),
        [t, f, 1000 - t - f]
    );
}

#[test]
fn header_histograms_edge_cases() {
    let fx = fx();
    let run = |spec: &ViewSpec, cols: &[&str]| {
        let cols: Vec<String> = cols.iter().map(|s| s.to_string()).collect();
        fx.engine
            .column_histograms(&fx.dataset.id, spec, &cols, &RequestKey::default())
    };
    assert!(run(&ViewSpec::default(), &[]).unwrap().is_empty());
    assert!(run(&ViewSpec::default(), &["name"]).unwrap().is_empty());
    assert!(run(&ViewSpec::default(), &["id", "nope"]).is_err());
    // No rows in the view: number columns get no bars, booleans all zeros.
    let none = ViewSpec {
        filters: vec![Filter {
            column: "id".into(),
            op: FilterOp::Lt {
                value: Param::Int(-1),
            },
            not: false,
        }],
        ..ViewSpec::default()
    };
    let h = run(&none, &["amount", "active"]).unwrap();
    assert!(h[0].bins.is_empty());
    assert_eq!(
        h[1].bins.iter().map(|b| b.count).collect::<Vec<_>>(),
        [0, 0, 0]
    );
}

#[test]
fn small_integer_ranges_get_one_bar_per_value() {
    let fx = fx();
    fx.engine
        .execute_batch(
            "CREATE TABLE stars AS SELECT (range % 5 + 1)::TINYINT AS stars, NULL::INTEGER AS empty \
             FROM range(103)",
        )
        .unwrap();
    fx.engine.datasets.insert(bigview_lib::engine::Dataset {
        id: "stars".into(),
        source: bigview_lib::engine::DatasetSource::Table("stars".into()),
        row_count: 103,
        cached: true,
    });
    let p = fx
        .engine
        .column_profile(
            "stars",
            &ViewSpec::default(),
            "stars",
            &RequestKey::default(),
        )
        .unwrap();
    let h = p.histogram.unwrap();
    let edges: Vec<(f64, f64, u64)> = h.iter().map(|b| (b.lo, b.hi, b.count)).collect();
    assert_eq!(
        edges,
        [
            (1.0, 2.0, 21),
            (2.0, 3.0, 21),
            (3.0, 4.0, 21),
            (4.0, 5.0, 20),
            (5.0, 6.0, 20)
        ]
    );
    // A column of only NULLs.
    let p = fx
        .engine
        .column_profile(
            "stars",
            &ViewSpec::default(),
            "empty",
            &RequestKey::default(),
        )
        .unwrap();
    assert_eq!(
        (p.nulls, p.distinct, p.min, p.mean),
        (103, Some(0), None, None)
    );
    assert_eq!(p.histogram, Some(vec![]));
    assert_eq!(p.top.len(), 1);
}

#[test]
fn near_unique_columns_still_list_every_common_value() {
    // 1.5M rows: 1.2M unique values (over APPROX_TOP_DISTINCT, so the
    // values come from the estimate), one sentinel in 10% of the rows, NULL
    // in another 10%, and one value in 1%.
    let fx = fx();
    let conn = fx.engine.connection().unwrap();
    conn.execute_batch(
        "CREATE TABLE ids AS SELECT CASE WHEN range % 10 = 0 THEN -1 \
           WHEN range % 10 = 1 THEN NULL WHEN range % 100 = 2 THEN -2 ELSE range END AS id \
         FROM range(1500000)",
    )
    .unwrap();
    fx.engine.datasets.insert(bigview_lib::engine::Dataset {
        id: "ids".into(),
        source: bigview_lib::engine::DatasetSource::Table("ids".into()),
        row_count: 1_500_000,
        cached: true,
    });
    let p = fx
        .engine
        .column_profile("ids", &ViewSpec::default(), "id", &RequestKey::default())
        .unwrap();
    assert!(p.distinct.unwrap() > bigview_lib::view::APPROX_TOP_DISTINCT);
    assert!(p.top_approx);
    assert!(p.top_truncated);
    let top: Vec<(Option<&str>, u64)> = p
        .top
        .iter()
        .map(|t| (t.value.as_deref(), t.count))
        .collect();
    assert_eq!(top.len(), TOP_VALUES);
    // The common values, with exact counts and NULL first among equals.
    assert_eq!(
        top[..3],
        [(None, 150_000), (Some("-1"), 150_000), (Some("-2"), 15_000)]
    );
    // Then values seen once.
    assert!(top[3..].iter().all(|(v, n)| v.is_some() && *n == 1));

    // A filter applies to both scans of the estimate (NULLs are filtered out).
    let spec = ViewSpec {
        filters: vec![Filter {
            column: "id".into(),
            op: FilterOp::Lt {
                value: Param::Int(1_400_000),
            },
            not: false,
        }],
        ..ViewSpec::default()
    };
    let p = fx
        .engine
        .column_profile("ids", &spec, "id", &RequestKey::default())
        .unwrap();
    assert!(p.top_approx);
    assert_eq!(p.nulls, 0);
    let top: Vec<(Option<&str>, u64)> = p
        .top
        .iter()
        .map(|t| (t.value.as_deref(), t.count))
        .collect();
    assert_eq!(top[..2], [(Some("-1"), 150_000), (Some("-2"), 15_000)]);
    assert!(top[2..].iter().all(|(v, n)| v.is_some() && *n == 1));
}
