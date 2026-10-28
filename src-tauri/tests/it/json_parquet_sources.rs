//! JSON, NDJSON (plus .gz) and Parquet fixtures open correctly; JSON imports
//! like CSV, Parquet is queried in place.

use std::io::Cursor;
use std::path::PathBuf;

use arrow::array::{Array, AsArray};
use arrow::datatypes::DataType;
use arrow::ipc::reader::StreamReader;
use arrow::record_batch::RecordBatch;
use dataliq_lib::cache::{Cache, CacheConfig};
use dataliq_lib::engine::{Engine, EngineConfig, RequestKey};
use dataliq_lib::import::{self, ImportTarget, Imports};
use dataliq_lib::sources::{Compression, FileFormat, OpenOptions, Source, SourceInfo};

fn fixture(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures")
        .join(rel)
}

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

fn decode(bytes: Vec<u8>) -> RecordBatch {
    let reader = StreamReader::try_new(Cursor::new(bytes), None).unwrap();
    let schema = reader.schema();
    let batches: Vec<RecordBatch> = reader.map(|b| b.unwrap()).collect();
    arrow::compute::concat_batches(&schema, &batches).unwrap()
}

fn open(engine: &Engine, rel: &str) -> (Source, SourceInfo, RecordBatch) {
    let source = Source::new(&fixture(rel), OpenOptions::default())
        .unwrap()
        .resolve_dialect(engine)
        .unwrap();
    let info = source
        .inspect(engine)
        .unwrap_or_else(|e| panic!("{rel}: {e}"));
    let batch = decode(
        source
            .preview_ipc(engine, 1000, &RequestKey::default())
            .unwrap(),
    );
    (source, info, batch)
}

fn names(info: &SourceInfo) -> Vec<&str> {
    info.columns.iter().map(|c| c.name.as_str()).collect()
}

#[test]
fn json_array_and_ndjson() {
    let (engine, _t) = engine();
    let (_, info, batch) = open(&engine, "json/array.json");
    assert_eq!(info.format, FileFormat::Json);
    assert!(info.sniffed.is_none());
    assert_eq!(names(&info), ["id", "name", "amount", "active"]);
    assert_eq!(batch.num_rows(), 3);
    assert!(batch.column(2).is_null(1), "JSON null stays NULL");
    let (_, info, batch) = open(&engine, "json/records.ndjson");
    assert_eq!(info.format, FileFormat::Ndjson);
    assert_eq!(names(&info), ["id", "name", "amount"]);
    assert_eq!(batch.num_rows(), 3);
}

#[test]
fn nested_json_keeps_structure() {
    let (engine, _t) = engine();
    let (_, info, batch) = open(&engine, "json/nested.json");
    assert_eq!(names(&info), ["id", "user", "tags", "scores"]);
    assert!(
        info.columns[1].r#type.starts_with("STRUCT"),
        "{}",
        info.columns[1].r#type
    );
    assert!(matches!(batch.column(1).data_type(), DataType::Struct(_)));
    assert!(matches!(batch.column(2).data_type(), DataType::List(_)));
    assert!(batch.column(1).is_null(2), "null object");
    let tags = batch.column(2).as_list::<i32>();
    assert_eq!(tags.value(0).len(), 2);
    assert_eq!(tags.value(1).len(), 0, "empty array is not NULL");
}

#[test]
fn gzip_json_matches_plain() {
    let (engine, _t) = engine();
    for rel in ["json/array.json", "json/records.ndjson"] {
        let (_, plain_info, plain) = open(&engine, rel);
        let (_, gz_info, gz) = open(&engine, &format!("{rel}.gz"));
        assert_eq!(gz_info.compression, Compression::Gzip);
        assert_eq!(names(&plain_info), names(&gz_info));
        assert_eq!(plain, gz, "{rel}");
    }
}

#[test]
fn json_imports_like_csv() {
    let (engine, tmp) = engine();
    let cache = Cache::new(CacheConfig {
        dir: tmp.path().join("cache"),
        max_bytes: 1 << 30,
        enabled: true,
    })
    .unwrap();
    let target = ImportTarget {
        cache: &cache,
        temp_dir: tmp.path().join("t"),
    };
    let source = Source::new(&fixture("json/nested.json"), OpenOptions::default()).unwrap();
    let out = import::import(&engine, &Imports::default(), &target, &source, "j", &|_| {}).unwrap();
    assert_eq!(out.dataset.row_count, 3);
    let page = decode(
        engine
            .fetch_rows(&out.dataset.id, 0, 10, &RequestKey::default())
            .unwrap(),
    );
    assert!(
        matches!(page.column(1).data_type(), DataType::Struct(_)),
        "nested types survive import"
    );
}

#[test]
fn parquet_with_many_types() {
    let (engine, _t) = engine();
    let (source, info, batch) = open(&engine, "parquet/types.parquet");
    assert_eq!(info.format, FileFormat::Parquet);
    assert!(source.is_queried_in_place());
    assert_eq!(info.columns.len(), 18);
    assert_eq!(batch.num_rows(), 3);
    let types: Vec<&str> = info.columns.iter().map(|c| c.r#type.as_str()).collect();
    for t in [
        "BOOLEAN",
        "TINYINT",
        "BIGINT",
        "DOUBLE",
        "DECIMAL(10,2)",
        "VARCHAR",
        "DATE",
        "BLOB",
        "UUID",
    ] {
        assert!(types.contains(&t), "missing {t} in {types:?}");
    }
    assert_eq!(batch.column(9).as_string::<i32>().value(2), "ünïcødé ✓");
}

#[test]
fn parquet_is_paged_in_place_with_instant_row_count() {
    let (engine, _t) = engine();
    let source = Source::new(&fixture("parquet/types.parquet"), OpenOptions::default()).unwrap();
    let ds = import::open_in_place(&engine, &source).unwrap();
    assert_eq!(ds.row_count, 3);
    assert!(!ds.cached);
    let page = decode(
        engine
            .fetch_rows(&ds.id, 1, 2, &RequestKey::default())
            .unwrap(),
    );
    assert_eq!(page.num_rows(), 2);
    assert_eq!(
        page.column(0)
            .as_primitive::<arrow::datatypes::Int32Type>()
            .values()
            .as_ref(),
        &[2, 3]
    );
}
