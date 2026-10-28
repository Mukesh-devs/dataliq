//! Sorted views end to end on people.csv: the exact order (NULLs last, ties
//! in file order), stable paging over the whole view, filters + sort, and
//! materialized views for filter-only views.

use std::cmp::Ordering;
use std::io::Cursor;

use arrow::array::AsArray;
use arrow::datatypes::Int64Type;
use arrow::ipc::reader::StreamReader;
use bigview_lib::engine::{DatasetSource, Engine, Param, RequestKey};
use bigview_lib::import;
use bigview_lib::view::{Filter, FilterOp, SortKey, ViewSpec};

use crate::filters::{Person, fx};

fn key(column: &str, descending: bool) -> SortKey {
    SortKey {
        column: column.into(),
        descending,
    }
}

/// Every id of a dataset, page by page (500 rows), in order.
fn all_ids(engine: &Engine, id: &str, rows: u64) -> Vec<i64> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < rows {
        let bytes = engine
            .fetch_rows(id, start, 500, &RequestKey::default())
            .unwrap();
        for b in StreamReader::try_new(Cursor::new(bytes), None).unwrap() {
            let b = b.unwrap();
            let col = b.column(0).as_primitive::<Int64Type>();
            out.extend((0..col.len()).map(|i| col.value(i)));
        }
        start += 500;
    }
    out
}

/// NULLs last in both directions, like the view builder.
fn cmp_opt<T: PartialOrd>(a: &Option<T>, b: &Option<T>, desc: bool) -> Ordering {
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, _) => Ordering::Greater,
        (_, None) => Ordering::Less,
        (Some(x), Some(y)) => {
            let o = x.partial_cmp(y).unwrap();
            if desc { o.reverse() } else { o }
        }
    }
}

/// Expected ids for a sort, ties broken by file order (stable sort).
fn expected(
    people: &[Person],
    cmp: impl Fn(&Person, &Person) -> Ordering,
    keep: impl Fn(&Person) -> bool,
) -> Vec<i64> {
    let mut rows: Vec<&Person> = people.iter().filter(|p| keep(p)).collect();
    rows.sort_by(|a, b| cmp(a, b));
    rows.iter().map(|p| p.id).collect()
}

fn open(fx: &crate::filters::Fx, spec: &ViewSpec) -> bigview_lib::view::OpenedView {
    fx.engine
        .open_view(&fx.dataset.id, spec, &RequestKey::default())
        .unwrap()
}

#[test]
fn single_column_sorts_put_nulls_last_and_keep_file_order_for_ties() {
    let fx = fx();
    for desc in [false, true] {
        let v = open(
            &fx,
            &ViewSpec {
                sort: vec![key("amount", desc)],
                ..ViewSpec::default()
            },
        );
        assert!(!v.materializing, "sorted views are written right away");
        assert!(matches!(
            fx.engine.datasets.get(&v.dataset.id).unwrap().source,
            DatasetSource::Materialized { .. }
        ));
        assert_eq!(v.dataset.row_count, 1000);
        let want = expected(
            &fx.people,
            |a, b| cmp_opt(&a.amount, &b.amount, desc),
            |_| true,
        );
        assert_eq!(
            all_ids(&fx.engine, &v.dataset.id, 1000),
            want,
            "amount desc={desc}"
        );
    }
    // Text with many ties (cities): ties stay in file order.
    let v = open(
        &fx,
        &ViewSpec {
            sort: vec![key("city", true)],
            ..ViewSpec::default()
        },
    );
    let want = expected(&fx.people, |a, b| cmp_opt(&a.city, &b.city, true), |_| true);
    assert_eq!(all_ids(&fx.engine, &v.dataset.id, 1000), want);
}

#[test]
fn multi_column_sort_with_filters() {
    let fx = fx();
    let spec = ViewSpec {
        filters: vec![Filter {
            column: "active".into(),
            op: FilterOp::Equals {
                value: Param::Bool(true),
            },
            not: false,
        }],
        sort: vec![
            key("city", false),
            key("joined", true),
            key("amount", false),
        ],
        ..ViewSpec::default()
    };
    let v = open(&fx, &spec);
    let want = expected(
        &fx.people,
        |a, b| {
            cmp_opt(&a.city, &b.city, false)
                .then_with(|| cmp_opt(&a.joined, &b.joined, true))
                .then_with(|| cmp_opt(&a.amount, &b.amount, false))
        },
        |p| p.active == Some(true),
    );
    assert_eq!(v.dataset.row_count, want.len() as u64);
    // Paging the whole view twice gives the same rows (stable paging).
    let first = all_ids(&fx.engine, &v.dataset.id, v.dataset.row_count);
    assert_eq!(first, want);
    assert_eq!(
        all_ids(&fx.engine, &v.dataset.id, v.dataset.row_count),
        first
    );
}

#[test]
fn filter_only_views_are_materialized_without_changing_their_rows() {
    let fx = fx();
    let spec = ViewSpec {
        filters: vec![Filter {
            column: "amount".into(),
            op: FilterOp::Gt {
                value: Param::Int(500),
            },
            not: false,
        }],
        ..ViewSpec::default()
    };
    let v = open(&fx, &spec);
    assert!(v.materializing);
    let before = all_ids(&fx.engine, &v.dataset.id, v.dataset.row_count);
    assert!(fx.engine.materialize_view(&v.dataset.id).unwrap());
    assert!(matches!(
        fx.engine.datasets.get(&v.dataset.id).unwrap().source,
        DatasetSource::Materialized { .. }
    ));
    let after = all_ids(&fx.engine, &v.dataset.id, v.dataset.row_count);
    assert_eq!(after, before, "same rows, same (file) order");
    let want: Vec<i64> = fx
        .people
        .iter()
        .filter(|p| p.amount.is_some_and(|a| a > 500.0))
        .map(|p| p.id)
        .collect();
    assert_eq!(after, want);
    // A second call has nothing to do.
    assert!(!fx.engine.materialize_view(&v.dataset.id).unwrap());
}

fn scratch_tables(engine: &Engine) -> Vec<String> {
    let conn = engine.connection().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT table_name FROM duckdb_tables() WHERE database_name = 'bv_scratch' ORDER BY 1",
        )
        .unwrap();
    stmt.query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<Vec<String>, _>>()
        .unwrap()
}

#[test]
fn closing_a_view_drops_its_table() {
    let fx = fx();
    let a = open(
        &fx,
        &ViewSpec {
            sort: vec![key("name", false)],
            ..ViewSpec::default()
        },
    );
    let b = open(
        &fx,
        &ViewSpec {
            sort: vec![key("id", true)],
            ..ViewSpec::default()
        },
    );
    assert_eq!(scratch_tables(&fx.engine).len(), 2);
    import::close_dataset(&fx.engine, &a.dataset.id).unwrap();
    // Views that fit in their first rows are just that table.
    assert_eq!(
        scratch_tables(&fx.engine),
        [format!("v_{}_head", b.dataset.id)]
    );
    import::close_dataset(&fx.engine, &b.dataset.id).unwrap();
    assert!(scratch_tables(&fx.engine).is_empty());
    // Materializing a closed view is a plain error, and leaves nothing behind.
    assert!(fx.engine.materialize_view(&a.dataset.id).is_err());
    assert!(scratch_tables(&fx.engine).is_empty());
}

#[test]
fn a_newer_sort_cancels_an_older_one_in_the_same_group() {
    let fx = fx();
    // A table big enough that the older view takes a while: its filter
    // has to look at every one of the 10M rows (a sort alone only keeps
    // the top rows, which a fast machine finishes before the newer view
    // can cancel it).
    fx.engine
        .execute_batch(
            "CREATE TABLE big AS SELECT range AS id, hash(range) AS h, \
             CAST(range AS VARCHAR) AS t FROM range(10000000)",
        )
        .unwrap();
    fx.engine.datasets.insert(bigview_lib::engine::Dataset {
        id: "big".into(),
        source: DatasetSource::Table("big".into()),
        row_count: 10_000_000,
        cached: true,
    });
    let engine = std::sync::Arc::new(fx.engine);
    let slow = {
        let engine = std::sync::Arc::clone(&engine);
        std::thread::spawn(move || {
            let req = RequestKey {
                id: Some("old".into()),
                group: Some("view:tab-1".into()),
            };
            let spec = ViewSpec {
                filters: vec![Filter {
                    column: "t".into(),
                    op: FilterOp::Regex {
                        pattern: "7.*3.*1".into(),
                    },
                    not: false,
                }],
                sort: vec![key("h", true)],
                ..ViewSpec::default()
            };
            engine.open_view("big", &spec, &req)
        })
    };
    while !engine.is_running("old") {
        std::thread::yield_now();
    }
    let newer = RequestKey {
        id: Some("new".into()),
        group: Some("view:tab-1".into()),
    };
    let spec = ViewSpec {
        sort: vec![key("id", false)],
        ..ViewSpec::default()
    };
    let fast = engine.open_view(&fx.dataset.id, &spec, &newer).unwrap();
    let old = slow.join().unwrap();
    assert!(
        matches!(old, Err(bigview_lib::error::AppError::Cancelled)),
        "{:?}",
        old.map(|v| v.dataset)
    );
    // Only the newer view's table is left.
    assert_eq!(
        scratch_tables(&engine),
        [format!("v_{}_head", fast.dataset.id)]
    );
}

#[test]
fn sorting_a_parquet_file_queried_in_place() {
    let tmp = tempfile::tempdir().unwrap();
    let fx = fx();
    let path = tmp.path().join("people.parquet");
    fx.engine
        .execute_batch(&format!(
            "COPY (SELECT * FROM {}) TO '{}' (FORMAT parquet)",
            match fx.engine.datasets.get(&fx.dataset.id).unwrap().source {
                DatasetSource::Table(t) => t,
                _ => unreachable!(),
            },
            path.to_string_lossy().replace('\'', "''")
        ))
        .unwrap();
    let source = bigview_lib::sources::Source::new(&path, Default::default()).unwrap();
    let ds = import::open_in_place(&fx.engine, &source).unwrap();
    let v = fx
        .engine
        .open_view(
            &ds.id,
            &ViewSpec {
                sort: vec![key("amount", true), key("id", false)],
                ..ViewSpec::default()
            },
            &RequestKey::default(),
        )
        .unwrap();
    let want = expected(
        &fx.people,
        |a, b| cmp_opt(&a.amount, &b.amount, true).then(a.id.cmp(&b.id)),
        |_| true,
    );
    assert_eq!(all_ids(&fx.engine, &v.dataset.id, 1000), want);
}

/// More rows than fit in a sorted view's head: the first and last rows are
/// served before the full sort is written; middle pages wait for it.
#[test]
fn big_sorts_show_first_and_last_rows_before_the_full_sort() {
    use bigview_lib::engine::datasets::MAX_HEAD;
    let fx = fx();
    let n: u64 = 3 * MAX_HEAD;
    fx.engine
        .execute_batch(&format!(
            "CREATE TABLE mid AS SELECT range AS id, hash(range) % 1000 AS k FROM range({n})"
        ))
        .unwrap();
    fx.engine.datasets.insert(bigview_lib::engine::Dataset {
        id: "mid".into(),
        source: DatasetSource::Table("mid".into()),
        row_count: n,
        cached: true,
    });
    let spec = ViewSpec {
        sort: vec![key("k", true)],
        ..ViewSpec::default()
    };
    let v = fx
        .engine
        .open_view("mid", &spec, &RequestKey::default())
        .unwrap();
    assert!(v.materializing);
    assert_eq!(v.dataset.row_count, n);
    assert!(matches!(
        fx.engine.datasets.get(&v.dataset.id).unwrap().source,
        DatasetSource::Sorting { tail: None, .. }
    ));
    // Expected order: k descending, ties by id (file order).
    let conn = fx.engine.connection().unwrap();
    let want: Vec<i64> = conn
        .prepare("SELECT id FROM mid ORDER BY k DESC, id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let page = |start: u64| {
        let bytes = fx
            .engine
            .fetch_rows(&v.dataset.id, start, 500, &RequestKey::default())
            .unwrap();
        StreamReader::try_new(Cursor::new(bytes), None)
            .unwrap()
            .flat_map(|b| {
                b.unwrap()
                    .column(0)
                    .as_primitive::<Int64Type>()
                    .values()
                    .to_vec()
            })
            .collect::<Vec<i64>>()
    };
    // The first rows are ready right away.
    assert_eq!(page(0), want[..500]);
    assert_eq!(
        page(MAX_HEAD - 500),
        want[(MAX_HEAD - 500) as usize..MAX_HEAD as usize]
    );

    // A middle page waits for the full sort; finish it on another thread.
    let engine = std::sync::Arc::new(fx.engine);
    let id = v.dataset.id.clone();
    let writer = {
        let engine = std::sync::Arc::clone(&engine);
        let id = id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            engine.materialize_view(&id)
        })
    };
    let middle = engine
        .fetch_rows(&id, n / 2, 500, &RequestKey::default())
        .unwrap();
    assert!(writer.join().unwrap().unwrap());
    let got: Vec<i64> = StreamReader::try_new(Cursor::new(middle), None)
        .unwrap()
        .flat_map(|b| {
            b.unwrap()
                .column(0)
                .as_primitive::<Int64Type>()
                .values()
                .to_vec()
        })
        .collect();
    assert_eq!(got, want[(n / 2) as usize..(n / 2 + 500) as usize]);
    // Now a plain table; only it is left in the scratch database.
    assert!(matches!(
        engine.datasets.get(&id).unwrap().source,
        DatasetSource::Materialized { .. }
    ));
    assert_eq!(scratch_tables(&engine), [format!("v_{id}")]);
    let all = all_ids(&engine, &id, n);
    assert_eq!(all, want);
}

#[test]
fn the_tail_serves_the_last_rows_in_order() {
    use bigview_lib::engine::datasets::MAX_HEAD;
    let fx = fx();
    let n: u64 = 3 * MAX_HEAD + 123;
    fx.engine
        .execute_batch(&format!(
            "CREATE TABLE t3 AS SELECT range AS id, CASE WHEN range % 7 = 0 THEN NULL ELSE hash(range) % 50 END AS k FROM range({n})"
        ))
        .unwrap();
    fx.engine.datasets.insert(bigview_lib::engine::Dataset {
        id: "t3".into(),
        source: DatasetSource::Table("t3".into()),
        row_count: n,
        cached: true,
    });
    let spec = ViewSpec {
        sort: vec![key("k", false)],
        ..ViewSpec::default()
    };
    let v = fx
        .engine
        .open_view("t3", &spec, &RequestKey::default())
        .unwrap();
    let conn = fx.engine.connection().unwrap();
    let want: Vec<i64> = conn
        .prepare("SELECT id FROM t3 ORDER BY k ASC NULLS LAST, id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    // Write only the tail, by hand, as the background job's first stage does.
    let ds = fx.engine.datasets.get(&v.dataset.id).unwrap();
    let DatasetSource::Sorting {
        reversed, params, ..
    } = ds.source
    else {
        panic!("expected a partial sort");
    };
    fx.engine
        .execute_batch(&format!(
            "CREATE TABLE bv_scratch.main.manual_tail AS {reversed} LIMIT {MAX_HEAD}"
        ))
        .unwrap();
    assert!(params.is_empty());
    assert!(fx.engine.datasets.update_source(&v.dataset.id, |s| {
        if let DatasetSource::Sorting {
            tail, tail_rows, ..
        } = s
        {
            *tail = Some("bv_scratch.main.manual_tail".into());
            *tail_rows = MAX_HEAD;
        }
    }));
    // The last rows (NULL keys, in file order) come from the tail.
    let last = n - 300;
    let bytes = fx
        .engine
        .fetch_rows(&v.dataset.id, last, 500, &RequestKey::default())
        .unwrap();
    let got: Vec<i64> = StreamReader::try_new(Cursor::new(bytes), None)
        .unwrap()
        .flat_map(|b| {
            b.unwrap()
                .column(0)
                .as_primitive::<Int64Type>()
                .values()
                .to_vec()
        })
        .collect();
    assert_eq!(got, want[last as usize..]);
    let bytes = fx
        .engine
        .fetch_rows(&v.dataset.id, n - MAX_HEAD, 500, &RequestKey::default())
        .unwrap();
    let got: Vec<i64> = StreamReader::try_new(Cursor::new(bytes), None)
        .unwrap()
        .flat_map(|b| {
            b.unwrap()
                .column(0)
                .as_primitive::<Int64Type>()
                .values()
                .to_vec()
        })
        .collect();
    assert_eq!(
        got,
        want[(n - MAX_HEAD) as usize..(n - MAX_HEAD + 500) as usize]
    );
}
