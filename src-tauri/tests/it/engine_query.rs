//! Integration tests for the DuckDB engine: types and values of a known query,
//! Arrow IPC encoding, parameters, row limits, settings and cancellation.

use std::io::Cursor;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use arrow::array::{
    Array, AsArray, BooleanArray, Date32Array, Float64Array, Int64Array, ListArray, StringArray,
    TimestampMicrosecondArray,
};
use arrow::datatypes::{DataType, TimeUnit};
use arrow::ipc::reader::StreamReader;
use arrow::record_batch::RecordBatch;
use bigview_lib::engine::{Engine, EngineConfig, Param, RequestKey};
use bigview_lib::error::AppError;

const KNOWN_QUERY: &str = "SELECT * FROM (VALUES
    (1::BIGINT, 'alpha', 1.5::DOUBLE, true, DATE '2024-01-31', TIMESTAMP '2024-01-31 12:34:56.789', [1, 2]),
    (2, 'béta', -2.25, false, DATE '1999-12-31', TIMESTAMP '1999-12-31 23:59:59', []),
    (3, NULL, NULL, NULL, NULL, NULL, NULL)
  ) t(id, name, amount, flag, day, ts, tags) ORDER BY id";

fn engine() -> (Engine, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let engine = Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: tmp.path().join("spill"),
        threads: Some(2),
    })
    .unwrap();
    (engine, tmp)
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/ipc/known_query.arrows")
}

fn decode(bytes: &[u8]) -> Vec<RecordBatch> {
    StreamReader::try_new(Cursor::new(bytes), None)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn single_batch(batches: &[RecordBatch]) -> RecordBatch {
    arrow::compute::concat_batches(&batches[0].schema(), batches).unwrap()
}

#[test]
fn known_query_has_expected_types_and_values() {
    let (engine, _tmp) = engine();
    let result = engine
        .query(KNOWN_QUERY, &[], 100, &RequestKey::default())
        .unwrap();
    assert_eq!(result.rows, 3);
    assert!(!result.truncated);

    let types: Vec<DataType> = result
        .schema
        .fields()
        .iter()
        .map(|f| f.data_type().clone())
        .collect();
    assert_eq!(types[0], DataType::Int64);
    assert_eq!(types[1], DataType::Utf8);
    assert_eq!(types[2], DataType::Float64);
    assert_eq!(types[3], DataType::Boolean);
    assert_eq!(types[4], DataType::Date32);
    assert_eq!(types[5], DataType::Timestamp(TimeUnit::Microsecond, None));
    assert!(matches!(types[6], DataType::List(_)));

    let b = single_batch(&result.batches);
    let ids = b.column(0).as_any().downcast_ref::<Int64Array>().unwrap();
    assert_eq!(ids.values().as_ref(), &[1, 2, 3]);
    let names = b.column(1).as_any().downcast_ref::<StringArray>().unwrap();
    assert_eq!(names.value(1), "béta");
    assert!(names.is_null(2));
    let amounts = b.column(2).as_any().downcast_ref::<Float64Array>().unwrap();
    assert_eq!(amounts.value(1), -2.25);
    let flags = b.column(3).as_any().downcast_ref::<BooleanArray>().unwrap();
    assert!(flags.value(0) && !flags.value(1) && flags.is_null(2));
    let days = b.column(4).as_any().downcast_ref::<Date32Array>().unwrap();
    assert_eq!(days.value(0), 19753); // 2024-01-31 = days since 1970-01-01
    let ts = b
        .column(5)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();
    assert_eq!(ts.value(0), 1_706_704_496_789_000);
    let tags = b.column(6).as_any().downcast_ref::<ListArray>().unwrap();
    assert_eq!(
        tags.value(0)
            .as_primitive::<arrow::datatypes::Int32Type>()
            .values()
            .as_ref(),
        &[1, 2]
    );
    assert_eq!(tags.value(1).len(), 0);
    assert!(tags.is_null(2));
}

#[test]
fn ipc_bytes_round_trip_and_match_committed_fixture() {
    let (engine, _tmp) = engine();
    let bytes = engine
        .query_ipc(KNOWN_QUERY, &[], 100, &RequestKey::default())
        .unwrap();
    let fresh = single_batch(&decode(&bytes));
    assert_eq!(fresh.num_rows(), 3);

    // The committed fixture is also decoded by the frontend tests
    // (src/lib/arrow.test.ts). Regenerate with UPDATE_FIXTURES=1.
    let path = fixture_path();
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        std::fs::write(&path, &bytes).unwrap();
    }
    let committed = single_batch(&decode(&std::fs::read(&path).unwrap()));
    assert_eq!(
        committed, fresh,
        "fixture is stale: rerun with UPDATE_FIXTURES=1"
    );
}

#[test]
fn empty_result_still_has_schema() {
    let (engine, _tmp) = engine();
    let bytes = engine
        .query_ipc(
            "SELECT 1 AS a, 'x' AS b WHERE false",
            &[],
            100,
            &RequestKey::default(),
        )
        .unwrap();
    let reader = StreamReader::try_new(Cursor::new(&bytes), None).unwrap();
    let schema = reader.schema();
    assert_eq!(schema.field(0).name(), "a");
    assert_eq!(reader.map(|b| b.unwrap().num_rows()).sum::<usize>(), 0);
}

#[test]
fn binds_parameters() {
    let (engine, _tmp) = engine();
    let params = [
        Param::Int(41),
        Param::Text("it's; DROP TABLE x".into()),
        Param::Null,
    ];
    let r = engine
        .query(
            "SELECT ?::BIGINT + 1 AS n, ? AS s, ? IS NULL AS z",
            &params,
            10,
            &RequestKey::default(),
        )
        .unwrap();
    let b = single_batch(&r.batches);
    assert_eq!(
        b.column(0)
            .as_primitive::<arrow::datatypes::Int64Type>()
            .value(0),
        42
    );
    assert_eq!(
        b.column(1).as_string::<i32>().value(0),
        "it's; DROP TABLE x"
    );
    assert!(b.column(2).as_boolean().value(0));
}

#[test]
fn max_rows_truncates() {
    let (engine, _tmp) = engine();
    let r = engine
        .query(
            "SELECT * FROM range(10000)",
            &[],
            2500,
            &RequestKey::default(),
        )
        .unwrap();
    assert_eq!(r.rows, 2500);
    assert!(r.truncated);
    assert_eq!(r.batches.iter().map(|b| b.num_rows()).sum::<usize>(), 2500);
}

#[test]
fn applies_memory_limit_and_temp_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let spill = tmp.path().join("spill dir ü");
    let engine = Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 512 * 1024 * 1024,
        temp_dir: spill.clone(),
        threads: Some(1),
    })
    .unwrap();
    let r = engine
        .query(
            "SELECT current_setting('memory_limit') AS m, current_setting('temp_directory') AS t, \
             current_setting('threads')::INT AS th",
            &[],
            1,
            &RequestKey::default(),
        )
        .unwrap();
    let b = single_batch(&r.batches);
    let mem = b.column(0).as_string::<i32>().value(0).to_string();
    assert!(
        mem.contains("512") || mem.contains("536"),
        "memory_limit = {mem}"
    );
    assert_eq!(
        b.column(1).as_string::<i32>().value(0),
        spill.to_string_lossy()
    );
    assert_eq!(
        b.column(2)
            .as_primitive::<arrow::datatypes::Int32Type>()
            .value(0),
        1
    );
    assert!(spill.is_dir());
}

#[test]
fn json_and_parquet_work_offline() {
    let (engine, tmp) = engine();
    let json = tmp.path().join("a.json");
    std::fs::write(&json, r#"[{"x": 1}, {"x": 2}]"#).unwrap();
    let parquet = tmp.path().join("a.parquet");
    engine
        .execute_batch(&format!(
            "COPY (SELECT 7 AS y) TO '{}' (FORMAT parquet)",
            parquet.display()
        ))
        .unwrap();
    let r = engine
        .query(
            "SELECT (SELECT sum(x) FROM read_json(?)) AS j, (SELECT y FROM read_parquet(?)) AS p",
            &[
                Param::Text(json.to_string_lossy().into()),
                Param::Text(parquet.to_string_lossy().into()),
            ],
            1,
            &RequestKey::default(),
        )
        .unwrap();
    let b = single_batch(&r.batches);
    assert_eq!(b.num_rows(), 1);
}

#[test]
fn query_errors_are_plain_messages() {
    let (engine, _tmp) = engine();
    let err = engine
        .query("SELECT nope FROM range(1)", &[], 1, &RequestKey::default())
        .err()
        .unwrap();
    assert!(
        matches!(err, AppError::Query(ref m) if m.contains("nope")),
        "{err:?}"
    );
}

const SLOW_QUERY: &str =
    "SELECT sum(hash(a.range + b.range)) FROM range(100000) a, range(100000) b";

#[test]
fn cancel_by_request_id() {
    let (engine, _tmp) = engine();
    let engine = Arc::new(engine);
    let e = Arc::clone(&engine);
    let handle = std::thread::spawn(move || {
        let key = RequestKey {
            id: Some("r1".into()),
            group: None,
        };
        e.query(SLOW_QUERY, &[], 1, &key)
    });
    // Wait until the request is registered, then cancel it.
    let mut cancelled = false;
    for _ in 0..200 {
        std::thread::sleep(Duration::from_millis(10));
        if engine.cancel("r1") {
            cancelled = true;
            break;
        }
    }
    assert!(cancelled, "request never started");
    let result = handle.join().unwrap();
    assert!(
        matches!(result, Err(AppError::Cancelled)),
        "{:?}",
        result.err()
    );
    assert!(
        !engine.cancel("r1"),
        "finished request must be unregistered"
    );
}

#[test]
fn newer_request_in_group_cancels_older() {
    let (engine, _tmp) = engine();
    let engine = Arc::new(engine);
    let e = Arc::clone(&engine);
    let old = std::thread::spawn(move || {
        let key = RequestKey {
            id: Some("old".into()),
            group: Some("view-1".into()),
        };
        e.query(SLOW_QUERY, &[], 1, &key)
    });
    // Make sure the old request is running before the new one starts.
    for _ in 0..200 {
        if engine.is_running("old") {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(engine.is_running("old"), "old request never started");
    let key = RequestKey {
        id: Some("new".into()),
        group: Some("view-1".into()),
    };
    let new = engine.query("SELECT 1", &[], 1, &key).unwrap();
    assert_eq!(new.rows, 1);
    let old = old.join().unwrap();
    assert!(matches!(old, Err(AppError::Cancelled)), "{:?}", old.err());
}
