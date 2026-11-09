//! Selection statistics (status bar count / sum / avg / min / max) on
//! people.csv, checked against values computed here from the parsed file.

use dataliq_lib::engine::RequestKey;
use dataliq_lib::view::{Filter, FilterOp, ProfileKind, SelectionStats, SortKey, ViewSpec};

use crate::filters::{Person, fx};

fn stats(
    fx: &crate::filters::Fx,
    spec: &ViewSpec,
    columns: &[&str],
    rows: Option<&[[u64; 2]]>,
    distinct: bool,
) -> SelectionStats {
    let columns: Vec<String> = columns.iter().map(|c| c.to_string()).collect();
    fx.engine
        .selection_stats(
            &fx.dataset.id,
            spec,
            &columns,
            rows,
            distinct,
            &RequestKey::default(),
        )
        .unwrap()
}

fn close(a: Option<f64>, b: f64) {
    let a = a.expect("a value");
    assert!((a - b).abs() < 1e-6 * b.abs().max(1.0), "{a} vs {b}");
}

#[test]
fn whole_columns() {
    let fx = fx();
    let s = stats(
        &fx,
        &ViewSpec::default(),
        &["amount", "name", "joined", "active"],
        None,
        true,
    );
    assert_eq!(s.rows, fx.people.len() as u64);
    assert!(!s.distinct_approx);

    let amounts: Vec<f64> = fx.people.iter().filter_map(|p| p.amount).collect();
    let a = &s.columns[0];
    assert_eq!(a.kind, ProfileKind::Number);
    assert_eq!(a.values, amounts.len() as u64);
    assert_eq!(a.empty, 0);
    close(a.sum, amounts.iter().sum());
    close(a.avg, amounts.iter().sum::<f64>() / amounts.len() as f64);
    close(a.min, amounts.iter().cloned().fold(f64::INFINITY, f64::min));
    close(
        a.max,
        amounts.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
    );
    assert_eq!(a.min_text, None);

    let n = &s.columns[1];
    assert_eq!(n.kind, ProfileKind::Text);
    assert_eq!(
        n.values,
        fx.people.iter().filter(|p| p.name.is_some()).count() as u64
    );
    assert_eq!(
        n.empty,
        fx.people
            .iter()
            .filter(|p| p.name.as_deref() == Some(""))
            .count() as u64
    );
    assert_eq!(n.sum, None);
    let mut names: Vec<&str> = fx.people.iter().filter_map(|p| p.name.as_deref()).collect();
    names.sort();
    assert_eq!(n.min_text.as_deref(), names.first().copied());
    assert_eq!(n.max_text.as_deref(), names.last().copied());
    names.dedup();
    assert_eq!(n.distinct, Some(names.len() as u64));

    let j = &s.columns[2];
    assert_eq!(j.kind, ProfileKind::Temporal);
    let mut dates: Vec<&str> = fx
        .people
        .iter()
        .filter_map(|p| p.joined.as_deref())
        .collect();
    dates.sort();
    assert_eq!(j.min_text.as_deref(), dates.first().copied());
    assert_eq!(j.max_text.as_deref(), dates.last().copied());

    let b = &s.columns[3];
    assert_eq!(b.kind, ProfileKind::Boolean);
    assert_eq!(
        b.values,
        fx.people.iter().filter(|p| p.active.is_some()).count() as u64
    );
    assert_eq!((b.min_text.as_ref(), b.sum), (None, None));
    assert_eq!(b.distinct, Some(2));
}

#[test]
fn distinct_only_when_asked() {
    let fx = fx();
    let s = stats(&fx, &ViewSpec::default(), &["city"], None, false);
    assert_eq!(s.columns[0].distinct, None);
}

#[test]
fn row_ranges_follow_the_view_sort_and_filters() {
    let fx = fx();
    let spec = ViewSpec {
        filters: vec![Filter {
            column: "amount".into(),
            path: None,
            op: FilterOp::NotNull,
            not: false,
        }],
        sort: vec![SortKey {
            column: "amount".into(),
            descending: true,
        }],
        ..ViewSpec::default()
    };
    // The 3 largest amounts and the 2 at positions 10 and 11.
    let mut sorted: Vec<&Person> = fx.people.iter().filter(|p| p.amount.is_some()).collect();
    sorted.sort_by(|a, b| b.amount.partial_cmp(&a.amount).unwrap());
    let picked: Vec<f64> = [0, 1, 2, 10, 11]
        .iter()
        .map(|&i| sorted[i].amount.unwrap())
        .collect();
    let s = stats(&fx, &spec, &["amount"], Some(&[[0, 3], [10, 12]]), false);
    assert_eq!(s.rows, 5);
    let a = &s.columns[0];
    assert_eq!(a.values, 5);
    close(a.sum, picked.iter().sum());
    close(a.max, picked[0]);
    close(a.min, picked[4]);
}

#[test]
fn unknown_columns_and_empty_selections_are_errors() {
    let fx = fx();
    let key = RequestKey::default();
    let spec = ViewSpec::default();
    assert!(
        fx.engine
            .selection_stats(&fx.dataset.id, &spec, &["nope".into()], None, false, &key)
            .is_err()
    );
    assert!(
        fx.engine
            .selection_stats(&fx.dataset.id, &spec, &[], None, false, &key)
            .is_err()
    );
}
