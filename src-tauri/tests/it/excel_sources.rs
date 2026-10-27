//! Excel (.xlsx and .xls): sheets, header rows, types, dates, cached formula
//! values, empty rows, preview and import.

use std::io::Cursor;
use std::path::PathBuf;

use arrow::array::{Array, AsArray};
use arrow::ipc::reader::StreamReader;
use arrow::record_batch::RecordBatch;
use bigview_lib::cache::{Cache, CacheConfig};
use bigview_lib::engine::{Engine, EngineConfig, RequestKey};
use bigview_lib::error::AppError;
use bigview_lib::import::{self, ImportTarget, Imports};
use bigview_lib::sources::{ExcelOptions, FileFormat, OpenOptions, Source, SourceInfo};

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

fn open(
    engine: &Engine,
    rel: &str,
    excel: ExcelOptions,
) -> Result<(SourceInfo, RecordBatch), AppError> {
    let source = Source::new(
        &fixture(rel),
        OpenOptions {
            excel,
            ..OpenOptions::default()
        },
    )?;
    let info = source.inspect(engine)?;
    let batch = decode(source.preview_ipc(engine, 1000, &RequestKey::default())?);
    Ok((info, batch))
}

fn cols(info: &SourceInfo) -> Vec<(String, String)> {
    info.columns
        .iter()
        .map(|c| (c.name.clone(), c.r#type.clone()))
        .collect()
}

fn text(batch: &RecordBatch, col: usize, row: usize) -> Option<String> {
    let c = batch.column(col);
    if c.is_null(row) {
        return None;
    }
    let c = arrow::compute::cast(c, &arrow::datatypes::DataType::Utf8).unwrap();
    Some(c.as_string::<i32>().value(row).to_string())
}

fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}

#[test]
fn xlsx_first_sheet_with_types_dates_and_formulas() {
    let (engine, _t) = engine();
    let (info, batch) = open(&engine, "excel/multi_sheet.xlsx", ExcelOptions::default()).unwrap();
    assert_eq!(info.format, FileFormat::Xlsx);
    let excel = info.excel.clone().unwrap();
    assert_eq!(excel.sheets, ["Orders", "Notes"]);
    assert_eq!(excel.sheet, "Orders");
    assert_eq!(excel.header_row, 1);
    assert_eq!(
        cols(&info),
        pairs(&[
            ("id", "BIGINT"),
            ("customer", "VARCHAR"),
            ("date", "DATE"),
            ("qty", "BIGINT"),
            ("price", "DOUBLE"),
            ("total", "DOUBLE"),
        ])
    );
    // Row 5 of the sheet is empty and skipped; "Dave" has blanks (NULL).
    assert_eq!(batch.num_rows(), 4);
    assert_eq!(text(&batch, 1, 3).as_deref(), Some("Dave"));
    assert_eq!(text(&batch, 2, 1).as_deref(), Some("2024-02-29"));
    assert_eq!(text(&batch, 2, 3), None);
    // Formula cells use their cached results.
    assert_eq!(text(&batch, 5, 0).as_deref(), Some("19.0"));
    assert_eq!(text(&batch, 5, 2).as_deref(), Some("6.25"));
}

#[test]
fn title_rows_are_skipped_and_header_row_can_be_chosen() {
    let (engine, _t) = engine();
    let notes = ExcelOptions {
        sheet: Some("Notes".into()),
        header_row: None,
    };
    let (info, batch) = open(&engine, "excel/multi_sheet.xlsx", notes).unwrap();
    assert_eq!(
        info.excel.as_ref().unwrap().header_row,
        3,
        "title above the table is skipped"
    );
    assert_eq!(
        cols(&info),
        pairs(&[("key", "VARCHAR"), ("value", "BOOLEAN")])
    );
    assert_eq!(batch.num_rows(), 1);

    let no_header = ExcelOptions {
        sheet: Some("Notes".into()),
        header_row: Some(0),
    };
    let (info, batch) = open(&engine, "excel/multi_sheet.xlsx", no_header).unwrap();
    assert_eq!(
        cols(&info),
        pairs(&[("column1", "VARCHAR"), ("column2", "VARCHAR")])
    );
    assert_eq!(batch.num_rows(), 3);
    assert_eq!(
        text(&batch, 0, 0).as_deref(),
        Some("Title row, not a header")
    );
}

#[test]
fn legacy_xls() {
    let (engine, _t) = engine();
    let (info, batch) = open(&engine, "excel/legacy.xls", ExcelOptions::default()).unwrap();
    assert_eq!(info.format, FileFormat::Xls);
    assert_eq!(info.excel.as_ref().unwrap().sheets, ["Inventory", "Empty"]);
    assert_eq!(
        cols(&info),
        pairs(&[
            ("sku", "BIGINT"),
            ("item", "VARCHAR"),
            ("stock", "BIGINT"),
            ("price", "DOUBLE"),
            ("received", "DATE"),
            ("active", "BOOLEAN"),
        ])
    );
    assert_eq!(batch.num_rows(), 3);
    assert_eq!(text(&batch, 1, 1).as_deref(), Some("Gädget"));
    assert_eq!(text(&batch, 4, 2).as_deref(), Some("2024-02-29"));
}

#[test]
fn missing_sheet_and_empty_sheet() {
    let (engine, _t) = engine();
    let err = open(
        &engine,
        "excel/legacy.xls",
        ExcelOptions {
            sheet: Some("Nope".into()),
            header_row: None,
        },
    )
    .err()
    .unwrap();
    assert_eq!(err.to_string(), "There is no sheet named \"Nope\".");
    let (info, batch) = open(
        &engine,
        "excel/legacy.xls",
        ExcelOptions {
            sheet: Some("Empty".into()),
            header_row: None,
        },
    )
    .unwrap();
    assert!(info.columns.is_empty());
    assert_eq!(batch.num_rows(), 0);
}

#[test]
fn excel_imports_into_the_cache() {
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
    let source = Source::new(&fixture("excel/multi_sheet.xlsx"), OpenOptions::default()).unwrap();
    let progress = parking_lot::Mutex::new(Vec::new());
    let out = import::import(&engine, &Imports::default(), &target, &source, "x", &|p| {
        progress.lock().push(p.percent)
    })
    .unwrap();
    assert_eq!(out.dataset.row_count, 4);
    assert!(!progress.lock().is_empty(), "Excel imports report progress");
    let page = decode(
        engine
            .fetch_rows(&out.dataset.id, 0, 10, &RequestKey::default())
            .unwrap(),
    );
    assert_eq!(page.num_rows(), 4);
    assert_eq!(text(&page, 1, 0).as_deref(), Some("Alice"));
    // Another sheet is a different cache entry.
    let notes = OpenOptions {
        excel: ExcelOptions {
            sheet: Some("Notes".into()),
            header_row: None,
        },
        ..OpenOptions::default()
    };
    let source = Source::new(&fixture("excel/multi_sheet.xlsx"), notes).unwrap();
    let out2 =
        import::import(&engine, &Imports::default(), &target, &source, "y", &|_| {}).unwrap();
    assert_ne!(out.dataset.id, out2.dataset.id);
    assert_eq!(out2.dataset.row_count, 1);
}

/// The reader SQL ("Copy as SQL") gives the same table in DuckDB's `excel`
/// extension. Ignored by default: it downloads the extension.
/// `cargo test -p bigview --test it excel_reader_sql -- --ignored`
#[test]
#[ignore = "downloads DuckDB's excel extension"]
fn excel_reader_sql_reads_the_same_table_in_duckdb() {
    let (engine, _t) = engine();
    let conn = duckdb::Connection::open_in_memory().unwrap();
    conn.execute_batch("INSTALL excel; LOAD excel;").unwrap();
    for sheet in [None, Some("Notes")] {
        let opts = ExcelOptions {
            sheet: sheet.map(String::from),
            header_row: None,
        };
        let (info, batch) = open(&engine, "excel/multi_sheet.xlsx", opts).unwrap();
        let sql = format!("SELECT * FROM {}", info.reader_sql);
        let mut stmt = conn.prepare(&sql).unwrap();
        let arrow: Vec<RecordBatch> = stmt.query_arrow([]).unwrap().collect();
        let theirs = arrow::compute::concat_batches(&arrow[0].schema(), &arrow).unwrap();
        let names: Vec<String> = theirs
            .schema()
            .fields()
            .iter()
            .map(|f| f.name().clone())
            .collect();
        assert_eq!(
            names,
            info.columns
                .iter()
                .map(|c| c.name.clone())
                .collect::<Vec<_>>(),
            "{sql}"
        );
        assert_eq!(theirs.num_rows(), batch.num_rows(), "{sql}");
        for c in 0..batch.num_columns() {
            for r in 0..batch.num_rows() {
                assert_eq!(
                    text(&theirs, c, r),
                    text(&batch, c, r),
                    "column {c} row {r}: {sql}"
                );
            }
        }
    }
}
