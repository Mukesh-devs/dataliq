//! Every CSV/TSV fixture opens correctly through `sources::Source`:
//! detection, sniffing, column types, preview values and friendly errors.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use arrow::array::{Array, AsArray};
use arrow::ipc::reader::StreamReader;
use arrow::record_batch::RecordBatch;
use bigview_lib::engine::{Engine, EngineConfig, RequestKey};
use bigview_lib::error::AppError;
use bigview_lib::sources::{Compression, CsvOptions, FileFormat, OpenOptions, Source, SourceInfo};

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

fn open(
    engine: &Engine,
    path: &Path,
    csv: CsvOptions,
) -> Result<(SourceInfo, RecordBatch), AppError> {
    let source = Source::new(path, OpenOptions { csv })?.resolve_dialect(engine)?;
    let info = source.inspect(engine)?;
    let bytes = source.preview_ipc(engine, 1000, &RequestKey::default())?;
    let reader = StreamReader::try_new(Cursor::new(bytes), None).unwrap();
    let schema = reader.schema();
    let batches: Vec<RecordBatch> = reader.map(|b| b.unwrap()).collect();
    let batch = arrow::compute::concat_batches(&schema, &batches).unwrap();
    Ok((info, batch))
}

fn open_default(engine: &Engine, rel: &str) -> (SourceInfo, RecordBatch) {
    open(engine, &fixture(rel), CsvOptions::default()).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

fn names(info: &SourceInfo) -> Vec<&str> {
    info.columns.iter().map(|c| c.name.as_str()).collect()
}

fn types(info: &SourceInfo) -> Vec<&str> {
    info.columns.iter().map(|c| c.r#type.as_str()).collect()
}

fn text(batch: &RecordBatch, col: usize, row: usize) -> Option<String> {
    let c = batch.column(col);
    if c.is_null(row) {
        return None;
    }
    let c = arrow::compute::cast(c, &arrow::datatypes::DataType::Utf8).unwrap();
    Some(c.as_string::<i32>().value(row).to_string())
}

#[test]
fn comma_csv_with_types() {
    let (engine, _t) = engine();
    let (info, batch) = open_default(&engine, "csv/comma.csv");
    assert_eq!(info.format, FileFormat::Csv);
    assert_eq!(info.compression, Compression::None);
    assert_eq!(names(&info), ["id", "name", "amount", "joined"]);
    assert_eq!(types(&info), ["BIGINT", "VARCHAR", "DOUBLE", "DATE"]);
    let sniffed = info.sniffed.unwrap();
    assert_eq!(sniffed.delimiter, ",");
    assert!(sniffed.has_header);
    assert_eq!(batch.num_rows(), 3);
    assert_eq!(text(&batch, 1, 2).as_deref(), Some("Carol"));
    assert_eq!(text(&batch, 3, 2).as_deref(), Some("2024-02-29"));
    assert!(
        info.reader_sql.starts_with("read_csv('"),
        "{}",
        info.reader_sql
    );
}

#[test]
fn delimiters_are_detected() {
    let (engine, _t) = engine();
    for (rel, delim) in [
        ("csv/semicolon.csv", ";"),
        ("csv/tab.tsv", "\t"),
        ("csv/pipe.csv", "|"),
    ] {
        let (info, batch) = open_default(&engine, rel);
        assert_eq!(info.sniffed.as_ref().unwrap().delimiter, delim, "{rel}");
        assert_eq!(names(&info)[0], "id", "{rel}");
        assert_eq!(batch.num_rows(), 3, "{rel}");
    }
    let (_, batch) = open_default(&engine, "csv/semicolon.csv");
    assert_eq!(text(&batch, 3, 1).as_deref(), Some("München"));
}

#[test]
fn quoted_fields_with_commas_quotes_and_newlines() {
    let (engine, _t) = engine();
    let (_, batch) = open_default(&engine, "csv/quoted.csv");
    assert_eq!(batch.num_rows(), 3);
    assert_eq!(text(&batch, 1, 0).as_deref(), Some("Hello, world"));
    assert_eq!(text(&batch, 2, 0).as_deref(), Some("She said \"hi\""));
    assert_eq!(text(&batch, 1, 1).as_deref(), Some("line one\nline two"));
    assert_eq!(text(&batch, 2, 2).as_deref(), Some("trailing, comma,"));
}

#[test]
fn utf8_bom_is_stripped() {
    let (engine, _t) = engine();
    let (info, batch) = open_default(&engine, "csv/utf8_bom.csv");
    assert_eq!(names(&info), ["id", "name"]);
    assert_eq!(text(&batch, 1, 0).as_deref(), Some("Zoë"));
    assert_eq!(text(&batch, 1, 2).as_deref(), Some("日本"));
}

#[test]
fn latin1_needs_encoding_and_says_so() {
    let (engine, _t) = engine();
    let err = open(&engine, &fixture("csv/latin1.csv"), CsvOptions::default())
        .err()
        .unwrap();
    assert!(err.to_string().contains("Encoding"), "{err}");
    let csv = CsvOptions {
        encoding: Some("latin-1".into()),
        ..CsvOptions::default()
    };
    let (_, batch) = open(&engine, &fixture("csv/latin1.csv"), csv).unwrap();
    assert_eq!(text(&batch, 1, 0).as_deref(), Some("Zoë"));
    assert_eq!(text(&batch, 1, 1).as_deref(), Some("Müller"));
    assert_eq!(text(&batch, 1, 2).as_deref(), Some("Ångström"));
}

#[test]
fn empty_fields_are_null_and_null_text_is_text() {
    let (engine, _t) = engine();
    let (_, batch) = open_default(&engine, "csv/nulls.csv");
    assert_eq!(text(&batch, 1, 0), None, "empty field is NULL");
    assert_eq!(
        text(&batch, 1, 1).as_deref(),
        Some("NULL"),
        "literal NULL text is kept"
    );
    assert_eq!(text(&batch, 1, 2).as_deref(), Some("value"));
    assert_eq!(text(&batch, 2, 2), None);
}

#[test]
fn mixed_types_fall_back_to_text() {
    let (engine, _t) = engine();
    let (info, batch) = open_default(&engine, "csv/mixed_types.csv");
    assert_eq!(types(&info)[1], "VARCHAR");
    assert_eq!(text(&batch, 1, 2).as_deref(), Some("n/a"));
    assert_eq!(batch.num_rows(), 5);
}

#[test]
fn dates_iso_and_custom_formats() {
    let (engine, _t) = engine();
    let (info, _) = open_default(&engine, "csv/dates.csv");
    let t = types(&info);
    assert_eq!(t[1], "DATE", "iso");
    assert_eq!(t[4], "TIMESTAMP", "ts");
    // US dates need an explicit format.
    let csv = CsvOptions {
        date_format: Some("%m/%d/%Y".into()),
        ..CsvOptions::default()
    };
    let (info, batch) = open(&engine, &fixture("csv/dates.csv"), csv).unwrap();
    assert_eq!(types(&info)[2], "DATE", "us with date format");
    assert_eq!(text(&batch, 2, 0).as_deref(), Some("2024-01-31"));
}

#[test]
fn header_only_has_columns_and_no_rows() {
    let (engine, _t) = engine();
    let (info, batch) = open_default(&engine, "csv/header_only.csv");
    assert_eq!(names(&info), ["id", "name", "amount"]);
    assert_eq!(batch.num_rows(), 0);
}

#[test]
fn empty_file_gives_plain_error() {
    let (engine, _t) = engine();
    let err = open(&engine, &fixture("csv/empty.csv"), CsvOptions::default())
        .err()
        .unwrap();
    assert_eq!(err.to_string(), "This file is empty.");
}

#[test]
fn bad_rows_error_suggests_fix_and_ignore_works() {
    let (engine, _t) = engine();
    let err = open(&engine, &fixture("csv/bad_rows.csv"), CsvOptions::default())
        .err()
        .unwrap();
    let msg = err.to_string();
    assert!(
        msg.contains("has 4 columns, expected 3") && msg.contains("Ignore bad rows"),
        "{msg}"
    );
    let csv = CsvOptions {
        ignore_errors: true,
        ..CsvOptions::default()
    };
    let (info, batch) = open(&engine, &fixture("csv/bad_rows.csv"), csv).unwrap();
    assert_eq!(info.columns.len(), 3);
    assert_eq!(batch.num_rows(), 9, "the bad row is skipped");
}

#[test]
fn wide_file_has_500_columns() {
    let (engine, _t) = engine();
    let (info, batch) = open_default(&engine, "csv/wide_500.csv");
    assert_eq!(info.columns.len(), 500);
    assert_eq!(batch.num_columns(), 500);
    assert_eq!(batch.num_rows(), 20);
    assert_eq!(text(&batch, 499, 19).as_deref(), Some("10000"));
}

#[test]
fn gzip_twins_match_plain_files() {
    let (engine, _t) = engine();
    for rel in ["csv/comma.csv", "csv/tab.tsv", "csv/quoted.csv"] {
        let (pi, pb) = open_default(&engine, rel);
        let (gi, gb) = open_default(&engine, &format!("{rel}.gz"));
        assert_eq!(gi.compression, Compression::Gzip, "{rel}");
        assert_eq!(names(&pi), names(&gi), "{rel}");
        assert_eq!(pb, gb, "{rel}");
    }
}

#[test]
fn gzip_without_gz_extension_is_detected() {
    let (engine, tmp) = engine();
    let path = tmp.path().join("export.csv");
    std::fs::copy(fixture("csv/comma.csv.gz"), &path).unwrap();
    let (info, batch) = open(&engine, &path, CsvOptions::default()).unwrap();
    assert_eq!(info.compression, Compression::Gzip);
    assert_eq!(batch.num_rows(), 3);
}

#[test]
fn zstd_csv_is_supported() {
    let (engine, tmp) = engine();
    let path = tmp.path().join("data.csv.zst");
    engine
        .execute_batch(&format!(
            "COPY (SELECT range AS id, 'r' || range AS label FROM range(10)) TO '{}' (FORMAT csv, COMPRESSION zstd)",
            path.display()
        ))
        .unwrap();
    let (info, batch) = open(&engine, &path, CsvOptions::default()).unwrap();
    assert_eq!(info.compression, Compression::Zstd);
    assert_eq!(batch.num_rows(), 10);
}

/// DuckDB treats an early end of a gzip stream as the end of the data, so the
/// preview shows the readable rows. Truncation is detected by the integrity
/// check that runs with the full import (see docs/DECISIONS.md, D12).
#[test]
fn truncated_gzip_preview_shows_readable_rows() {
    let (engine, _t) = engine();
    let (info, batch) = open_default(&engine, "csv/corrupted.csv.gz");
    assert_eq!(names(&info), ["id", "name", "amount"]);
    assert!(batch.num_rows() > 0 && batch.num_rows() <= 1000);
}

#[test]
fn user_options_override_the_sniffer() {
    let (engine, _t) = engine();
    let csv = CsvOptions {
        header: Some(false),
        skip_rows: Some(1),
        ..CsvOptions::default()
    };
    let (info, batch) = open(&engine, &fixture("csv/comma.csv"), csv).unwrap();
    assert_eq!(names(&info)[0], "column0");
    assert_eq!(batch.num_rows(), 3);
    let csv = CsvOptions {
        delimiter: Some(";".into()),
        ..CsvOptions::default()
    };
    let (info, _) = open(&engine, &fixture("csv/comma.csv"), csv).unwrap();
    assert_eq!(info.columns.len(), 1, "forced delimiter is respected");
}

#[test]
fn paths_with_spaces_quotes_and_unicode() {
    let (engine, tmp) = engine();
    let dir = tmp.path().join("my data ü's");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("o'brien 日本.csv");
    std::fs::copy(fixture("csv/comma.csv"), &path).unwrap();
    let (_, batch) = open(&engine, &path, CsvOptions::default()).unwrap();
    assert_eq!(batch.num_rows(), 3);
}

#[test]
fn missing_file_is_a_plain_error() {
    let (engine, _t) = engine();
    let err = open(
        &engine,
        Path::new("/definitely/not/here.csv"),
        CsvOptions::default(),
    )
    .err()
    .unwrap();
    assert!(err.to_string().starts_with("File not found"), "{err}");
}
