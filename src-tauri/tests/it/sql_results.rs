//! SQL results as pageable datasets, over every kind of file, joins included.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use arrow::array::{Array, AsArray};
use arrow::datatypes::{Float64Type, Int64Type};
use arrow::ipc::reader::StreamReader;
use dataliq_lib::cache::{Cache, CacheConfig};
use dataliq_lib::engine::{Dataset, Engine, RequestKey};
use dataliq_lib::error::AppError;
use dataliq_lib::import::{self, ImportTarget, Imports};
use dataliq_lib::sources::{OpenOptions, Source};

use crate::filters::fx;

fn fixture(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures")
        .join(rel)
}

/// Imports a file into a cache in `dir`, as the app does.
fn import_file(engine: &Engine, dir: &Path, path: &Path) -> Dataset {
    let cache = Cache::new(CacheConfig {
        dir: dir.join("cache"),
        max_bytes: 1 << 30,
        enabled: true,
    })
    .unwrap();
    let target = ImportTarget {
        cache: &cache,
        temp_dir: dir.join("tmp"),
    };
    let source = Source::new(path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(engine)
        .unwrap();
    import::import(engine, &Imports::default(), &target, &source, "j", &|_| {})
        .unwrap()
        .dataset
}

fn key() -> RequestKey {
    RequestKey {
        id: None,
        group: Some("sql".into()),
    }
}

/// Every row of a dataset, page by page, as batches.
fn rows(engine: &Engine, ds: &Dataset) -> Vec<arrow::record_batch::RecordBatch> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < ds.row_count {
        let bytes = engine
            .fetch_rows(&ds.id, start, 500, &RequestKey::default())
            .unwrap();
        out.extend(
            StreamReader::try_new(Cursor::new(bytes), None)
                .unwrap()
                .map(|b| b.unwrap()),
        );
        start += 500;
    }
    out
}

fn single_i64(engine: &Engine, sql: &str) -> i64 {
    let ds = engine.sql_result(sql, &key()).unwrap();
    assert_eq!(ds.row_count, 1, "{sql}");
    rows(engine, &ds)[0]
        .column(0)
        .as_primitive::<Int64Type>()
        .value(0)
}

#[test]
fn sql_over_csv_excel_json_and_parquet_with_a_join() {
    let fx = fx();
    let tmp = tempfile::tempdir().unwrap();
    fx.engine.register_table(&fx.dataset.id, "people").unwrap();
    let orders = import_file(&fx.engine, tmp.path(), &fixture("excel/multi_sheet.xlsx"));
    fx.engine.register_table(&orders.id, "orders").unwrap();
    let accounts = import_file(&fx.engine, tmp.path(), &fixture("json/array.json"));
    fx.engine.register_table(&accounts.id, "accounts").unwrap();
    // A Parquet file with a bonus for the first 100 people.
    let pq = tmp.path().join("bonus.parquet");
    fx.engine
        .execute_batch(&format!(
            "COPY (SELECT range + 1 AS id, (range + 1) * 10 AS bonus FROM range(100)) TO '{}' (FORMAT parquet)",
            pq.to_string_lossy().replace('\'', "''")
        ))
        .unwrap();
    let bonus =
        import::open_in_place(&fx.engine, &Source::new(&pq, Default::default()).unwrap()).unwrap();
    fx.engine.register_table(&bonus.id, "bonus").unwrap();

    assert_eq!(single_i64(&fx.engine, "SELECT count(*) FROM people"), 1000);
    // Excel: qty 2 + 1 + 5 (Dave has none).
    assert_eq!(
        single_i64(&fx.engine, "SELECT sum(qty)::BIGINT FROM orders"),
        8
    );
    // JSON.
    let ds = fx
        .engine
        .sql_result("SELECT name FROM accounts WHERE active ORDER BY id", &key())
        .unwrap();
    let names: Vec<String> = rows(&fx.engine, &ds)
        .iter()
        .flat_map(|b| {
            let a = b.column(0).as_string::<i32>();
            (0..a.len())
                .map(|i| a.value(i).to_string())
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(names, ["Alice", "Carol"]);
    // CSV joined with Parquet.
    assert_eq!(
        single_i64(
            &fx.engine,
            "SELECT count(*) FROM people p JOIN bonus b USING (id)"
        ),
        100
    );
    let expected: f64 = fx
        .people
        .iter()
        .filter(|p| p.id <= 100)
        .filter_map(|p| p.amount)
        .sum();
    let ds = fx
        .engine
        .sql_result(
            "SELECT sum(p.amount) FROM people p JOIN bonus b ON p.id = b.id",
            &key(),
        )
        .unwrap();
    let got = rows(&fx.engine, &ds)[0]
        .column(0)
        .as_primitive::<Float64Type>()
        .value(0);
    assert!((got - expected).abs() < 1e-6, "{got} vs {expected}");
}

#[test]
fn results_page_in_the_query_order_and_close_cleanly() {
    let fx = fx();
    fx.engine.register_table(&fx.dataset.id, "people").unwrap();
    let ds = fx
        .engine
        .sql_result(
            "SELECT id, amount FROM people ORDER BY amount DESC NULLS LAST, id -- biggest first",
            &key(),
        )
        .unwrap();
    assert_eq!(ds.row_count, 1000);
    let ids: Vec<i64> = rows(&fx.engine, &ds)
        .iter()
        .flat_map(|b| {
            let a = b.column(0).as_primitive::<Int64Type>();
            (0..a.len()).map(|i| a.value(i)).collect::<Vec<_>>()
        })
        .collect();
    let mut expected: Vec<_> = fx.people.iter().collect();
    expected.sort_by(|a, b| match (a.amount, b.amount) {
        (Some(x), Some(y)) => y.partial_cmp(&x).unwrap().then(a.id.cmp(&b.id)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.id.cmp(&b.id),
    });
    assert_eq!(ids, expected.iter().map(|p| p.id).collect::<Vec<_>>());
    // Closing drops the stored rows.
    import::close_dataset(&fx.engine, &ds.id).unwrap();
    assert!(fx.engine.datasets.get(&ds.id).is_err());
}

#[test]
fn results_see_session_temp_tables_and_report_errors_in_the_users_lines() {
    let fx = fx();
    fx.engine
        .query_session(
            "CREATE TEMP TABLE picks AS SELECT 3 AS n UNION ALL SELECT 4",
            &[],
            10,
            &key(),
        )
        .unwrap();
    assert_eq!(
        single_i64(&fx.engine, "SELECT sum(n)::BIGINT FROM picks"),
        7
    );
    match fx.engine.sql_result("SELECT 1,\n  nope FROM picks", &key()) {
        Err(AppError::Query(m)) => {
            assert!(m.contains("LINE 2:   nope FROM picks"), "{m}");
            // The caret is still under "nope".
            let caret = m.lines().last().unwrap();
            assert_eq!(caret.find('^'), Some("LINE 2:   ".len()), "{m}");
        }
        other => panic!("expected a query error, got {other:?}"),
    }
}
