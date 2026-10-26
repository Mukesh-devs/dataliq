//! Grid paging over datasets: rowid-range pages are correct and fast at any
//! position, including the last partial page.

use std::io::Cursor;
use std::time::{Duration, Instant};

use arrow::array::AsArray;
use arrow::datatypes::Int64Type;
use arrow::ipc::reader::StreamReader;
use bigview_lib::engine::{Dataset, Engine, EngineConfig, RequestKey};

fn engine_with_table(rows: u64) -> (Engine, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let engine = Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 4 << 30,
        temp_dir: tmp.path().into(),
        threads: None,
    })
    .unwrap();
    engine
        .execute_batch(&format!(
            "CREATE TABLE \"big table\" AS SELECT range AS id, 'name ' || range AS name, \
             range * 0.5 AS amount FROM range({rows})"
        ))
        .unwrap();
    engine.datasets.insert(Dataset {
        id: "ds".into(),
        relation: "\"big table\"".into(),
        row_count: rows,
    });
    (engine, tmp)
}

fn ids(bytes: &[u8]) -> Vec<i64> {
    StreamReader::try_new(Cursor::new(bytes), None)
        .unwrap()
        .flat_map(|b| {
            let b = b.unwrap();
            b.column(0).as_primitive::<Int64Type>().values().to_vec()
        })
        .collect()
}

fn check_pages(engine: &Engine, rows: u64, budget: Duration) {
    let key = RequestKey::default();
    let page = 500;
    for start in [0, rows / 3, rows / 2, rows - 2 * page, rows - page] {
        let t = Instant::now();
        let bytes = engine.fetch_rows("ds", start, page, &key).unwrap();
        let elapsed = t.elapsed();
        let got = ids(&bytes);
        let expected: Vec<i64> = (start as i64..(start + page) as i64).collect();
        assert_eq!(got, expected, "page at {start}");
        assert!(elapsed < budget, "page at {start} took {elapsed:?}");
    }
}

#[test]
fn pages_are_exact_everywhere() {
    let rows = 2_000_000;
    let (engine, _t) = engine_with_table(rows);
    check_pages(&engine, rows, Duration::from_millis(500));
}

#[test]
fn last_partial_page_and_out_of_range() {
    let (engine, _t) = engine_with_table(1234);
    let key = RequestKey::default();
    assert_eq!(
        ids(&engine.fetch_rows("ds", 1000, 500, &key).unwrap()).len(),
        234
    );
    assert!(ids(&engine.fetch_rows("ds", 5000, 500, &key).unwrap()).is_empty());
    // Requests are capped so one call can't pull a whole table.
    assert_eq!(
        ids(&engine.fetch_rows("ds", 0, 1_000_000, &key).unwrap()).len(),
        1234
    );
}

#[test]
fn unknown_dataset_is_a_plain_error() {
    let (engine, _t) = engine_with_table(10);
    let err = engine
        .fetch_rows("nope", 0, 10, &RequestKey::default())
        .err()
        .unwrap();
    assert!(err.to_string().contains("no longer open"), "{err}");
}

/// 50M rows: every page well under the 100 ms "no blank page" budget.
#[test]
#[ignore = "builds a 50M-row table (~15 s)"]
fn pages_50m_rows_fast() {
    let rows = 50_000_000;
    let (engine, _t) = engine_with_table(rows);
    check_pages(&engine, rows, Duration::from_millis(100));
    let key = RequestKey::default();
    let t = Instant::now();
    let n = 200;
    for i in 0..n {
        let start = (i * 249_997) % (rows - 500);
        engine.fetch_rows("ds", start, 500, &key).unwrap();
    }
    println!(
        "50M rows: {:.2} ms per random 500-row page",
        t.elapsed().as_secs_f64() * 1000.0 / n as f64
    );
}
