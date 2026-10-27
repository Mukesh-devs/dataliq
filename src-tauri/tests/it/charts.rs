//! Charts over people.csv, imported as the app does: every number is
//! checked against values computed here from the parsed CSV, and charts
//! follow the view's filters.

use std::collections::BTreeMap;

use bigview_lib::chart::{Agg, Bucket, ChartData, ChartKind, ChartSpec, Measure, XKind};
use bigview_lib::engine::{Param, RequestKey};
use bigview_lib::view::{Filter, FilterOp, ViewSpec};

use crate::filters::{Fx, Person, fx};

fn spec(kind: ChartKind, x: &str) -> ChartSpec {
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

fn measure(agg: Agg, column: Option<&str>) -> Measure {
    Measure {
        agg,
        column: column.map(String::from),
    }
}

fn chart(fx: &Fx, view: &ViewSpec, c: &ChartSpec) -> ChartData {
    fx.engine
        .chart_data(&fx.dataset.id, view, c, &RequestKey::default())
        .unwrap()
}

fn active_only() -> ViewSpec {
    ViewSpec {
        filters: vec![Filter {
            column: "active".into(),
            op: FilterOp::Equals {
                value: Param::Bool(true),
            },
            not: false,
        }],
        ..Default::default()
    }
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-6 * a.abs().max(b.abs()).max(1.0)
}

/// Groups of `people` by city: (count, sum of amount, amounts seen).
fn by_city(people: &[&Person]) -> BTreeMap<Option<String>, (u64, f64, u64)> {
    let mut g: BTreeMap<Option<String>, (u64, f64, u64)> = BTreeMap::new();
    for p in people {
        let e = g.entry(p.city.clone()).or_default();
        e.0 += 1;
        if let Some(a) = p.amount {
            e.1 += a;
            e.2 += 1;
        }
    }
    g
}

fn label(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(String::from)
}

#[test]
fn bars_count_and_sum_by_category_largest_first() {
    let fx = fx();
    let mut c = spec(ChartKind::Bar, "city");
    c.measures = vec![
        measure(Agg::Count, None),
        measure(Agg::Sum, Some("amount")),
        measure(Agg::Avg, Some("amount")),
    ];
    let data = chart(&fx, &ViewSpec::default(), &c);
    let all: Vec<&Person> = fx.people.iter().collect();
    let want = by_city(&all);
    assert_eq!(data.x_kind, XKind::Category);
    assert_eq!(data.total, want.len() as u64);
    assert!(!data.truncated);
    assert_eq!(
        data.series
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["Count", "Sum of amount", "Average amount"]
    );
    // Largest count first; ties by name, NULL last.
    let mut order: Vec<_> = want.iter().collect();
    order.sort_by(|a, b| {
        b.1.0
            .cmp(&a.1.0)
            .then(a.0.is_none().cmp(&b.0.is_none()))
            .then(a.0.cmp(b.0))
    });
    let got: Vec<Option<String>> = data.x.iter().map(label).collect();
    assert_eq!(
        got,
        order.iter().map(|(k, _)| (*k).clone()).collect::<Vec<_>>()
    );
    for (i, (_, (n, sum, with_amount))) in order.iter().enumerate() {
        assert_eq!(data.series[0].values[i], Some(*n as f64));
        assert!(close(data.series[1].values[i].unwrap(), *sum), "{i}");
        let avg = data.series[2].values[i].unwrap();
        assert!(close(avg, sum / *with_amount as f64), "{i}");
    }
}

#[test]
fn charts_follow_the_views_filters_and_keep_the_largest_categories() {
    let fx = fx();
    let mut c = spec(ChartKind::HorizontalBar, "city");
    c.limit = Some(3);
    let data = chart(&fx, &active_only(), &c);
    let active: Vec<&Person> = fx
        .people
        .iter()
        .filter(|p| p.active == Some(true))
        .collect();
    let want = by_city(&active);
    let mut counts: Vec<u64> = want.values().map(|v| v.0).collect();
    counts.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(data.total, want.len() as u64);
    assert!(data.truncated);
    assert_eq!(data.x.len(), 3);
    assert_eq!(
        data.series[0].values,
        counts[..3]
            .iter()
            .map(|&n| Some(n as f64))
            .collect::<Vec<_>>()
    );
    for (x, v) in data.x.iter().zip(&data.series[0].values) {
        assert_eq!(want[&label(x)].0 as f64, v.unwrap());
    }
}

#[test]
fn line_by_month_in_date_order() {
    let fx = fx();
    let mut c = spec(ChartKind::Line, "joined");
    c.bucket = Some(Bucket::Month);
    c.measures = vec![measure(Agg::Max, Some("amount"))];
    let data = chart(&fx, &ViewSpec::default(), &c);
    let mut want: BTreeMap<Option<String>, Option<f64>> = BTreeMap::new();
    for p in &fx.people {
        let month = p.joined.as_ref().map(|d| format!("{}-01", &d[..7]));
        let e = want.entry(month).or_default();
        if let Some(a) = p.amount {
            *e = Some(e.map_or(a, |m: f64| m.max(a)));
        }
    }
    // NULL dates last; the rest by date.
    let mut keys: Vec<_> = want.keys().cloned().collect();
    keys.sort_by(|a, b| a.is_none().cmp(&b.is_none()).then(a.cmp(b)));
    assert_eq!(data.x_kind, XKind::Time);
    assert_eq!(data.x.len(), keys.len());
    for (i, k) in keys.iter().enumerate() {
        let ms = k.as_ref().map(|d| {
            chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d")
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis() as f64
        });
        assert_eq!(data.x[i].as_f64(), ms, "{k:?}");
        assert_eq!(data.series[0].values[i], want[k], "{k:?}");
    }
}

#[test]
fn histogram_counts_every_value_once() {
    let fx = fx();
    let mut c = spec(ChartKind::Histogram, "amount");
    c.bins = Some(10);
    let view = active_only();
    let data = chart(&fx, &view, &c);
    let amounts: Vec<f64> = fx
        .people
        .iter()
        .filter(|p| p.active == Some(true))
        .filter_map(|p| p.amount)
        .collect();
    let (lo, hi) = amounts
        .iter()
        .fold((f64::MAX, f64::MIN), |(l, h), &a| (l.min(a), h.max(a)));
    assert_eq!(data.bins.len(), 10);
    assert_eq!(data.total, amounts.len() as u64);
    assert_eq!(
        data.bins.iter().map(|b| b.count).sum::<u64>(),
        amounts.len() as u64
    );
    assert!(close(data.bins[0].lo, lo) && close(data.bins[9].hi, hi));
    for b in &data.bins {
        let last = close(b.hi, hi);
        let n = amounts
            .iter()
            .filter(|&&a| a >= b.lo && (a < b.hi || (last && a <= b.hi)))
            .count() as u64;
        // Floating-point edges may move a value on a boundary by one bar.
        assert!(n.abs_diff(b.count) <= 1, "{b:?}: {n}");
    }
    // Dates are binned in milliseconds.
    let dates = chart(
        &fx,
        &ViewSpec::default(),
        &spec(ChartKind::Histogram, "joined"),
    );
    assert_eq!(dates.x_kind, XKind::Time);
    assert!(dates.bins[0].lo > 1.6e12, "{:?}", dates.bins[0]);
    // Text can't be binned.
    let err = fx
        .engine
        .chart_data(
            &fx.dataset.id,
            &view,
            &spec(ChartKind::Histogram, "city"),
            &RequestKey::default(),
        )
        .unwrap_err();
    assert!(err.to_string().contains("number or date"), "{err}");
}

#[test]
fn scatter_samples_repeatably_from_the_view() {
    let fx = fx();
    let mut c = spec(ChartKind::Scatter, "amount");
    c.y = Some("id".into());
    c.sample = Some(100);
    let data = chart(&fx, &ViewSpec::default(), &c);
    let both: Vec<&Person> = fx.people.iter().filter(|p| p.amount.is_some()).collect();
    assert_eq!(data.total, both.len() as u64);
    assert!(data.truncated);
    assert_eq!(data.x.len(), 100);
    assert_eq!(data.series[0].values.len(), 100);
    // Every point is a real row.
    for (x, y) in data.x.iter().zip(&data.series[0].values) {
        let id = y.unwrap() as i64;
        let p = fx.people.iter().find(|p| p.id == id).unwrap();
        assert!(close(p.amount.unwrap(), x.as_f64().unwrap()));
    }
    // The same sample each time.
    let again = chart(&fx, &ViewSpec::default(), &c);
    assert_eq!(again.x, data.x);
    // All points when there are fewer than the sample.
    c.sample = Some(5000);
    let all = chart(&fx, &active_only(), &c);
    assert!(!all.truncated);
    assert_eq!(all.x.len() as u64, all.total);
}
