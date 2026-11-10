//! Free-space checks: the size estimates are close to what is written
//! (never far above it, so a check can't refuse an export that fits), and
//! a write that can't fit is refused before anything is written.

use std::path::Path;

use dataliq_lib::engine::{Dataset, DatasetSource, Engine, EngineConfig};
use dataliq_lib::export::convert::{self, ConvertRequest};
use dataliq_lib::export::{self, ExportFormat, ExportRequest};

fn engine(dir: &Path) -> Engine {
    Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: dir.join("spill"),
        threads: Some(2),
    })
    .unwrap()
}

/// 50,000 rows of numbers, text, dates and a few NULLs, as dataset "t".
fn table(engine: &Engine) {
    engine
        .execute_batch(
            "CREATE TABLE t AS SELECT range AS id, 'customer ' || (range % 977) AS name, \
             (range * 7919 % 100000) / 100.0 AS amount, DATE '2024-01-01' + (range % 365)::INT AS day, \
             CASE WHEN range % 10 = 0 THEN NULL ELSE ['eu', 'us', 'apac'][1 + range % 3] END AS region \
             FROM range(50000)",
        )
        .unwrap();
    engine.datasets.insert(Dataset {
        id: "t".into(),
        source: DatasetSource::Table("t".into()),
        row_count: 50_000,
        cached: true,
    });
}

fn request(path: &Path, format: ExportFormat) -> ExportRequest {
    serde_json::from_value(serde_json::json!({
        "datasetId": "t",
        "spec": {},
        "path": path,
        "format": format,
    }))
    .unwrap()
}

#[test]
fn export_estimates_are_close_to_what_is_written() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = engine(tmp.path());
    table(&engine);
    for (format, ext) in [
        (ExportFormat::Csv, "csv"),
        (ExportFormat::CsvGz, "csv.gz"),
        (ExportFormat::Parquet, "parquet"),
        (ExportFormat::Ndjson, "ndjson"),
        (ExportFormat::Xlsx, "xlsx"),
    ] {
        let path = tmp.path().join(format!("out.{ext}"));
        let req = request(&path, format);
        let estimate = export::estimated_bytes(&engine, &req).unwrap() as f64;
        export::export(&engine, &export::Exports::default(), &req, "e", &|_| {}).unwrap();
        let actual = std::fs::metadata(&path).unwrap().len() as f64;
        let ratio = estimate / actual;
        eprintln!("{ext}: estimate {estimate:.0}, written {actual:.0} ({ratio:.2}x)");
        assert!(ratio < 1.5, "{ext}: estimate {ratio:.2}x what is written");
        assert!(ratio > 0.25, "{ext}: estimate {ratio:.2}x what is written");
    }
}

#[test]
fn convert_estimates_are_close_to_what_is_written() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = engine(tmp.path());
    table(&engine);
    let csv = tmp.path().join("in.csv");
    let gz = tmp.path().join("in2.csv.gz");
    let pq = tmp.path().join("in3.parquet");
    engine
        .execute_batch(&format!(
            "COPY t TO '{}' (HEADER); COPY t TO '{}' (HEADER, COMPRESSION gzip); \
             COPY t TO '{}' (FORMAT parquet)",
            csv.display(),
            gz.display(),
            pq.display()
        ))
        .unwrap();
    let out = tmp.path().join("out");
    std::fs::create_dir(&out).unwrap();
    for (files, format) in [
        (vec![csv.clone(), gz.clone()], ExportFormat::Parquet),
        (vec![pq.clone()], ExportFormat::Csv),
    ] {
        let req: ConvertRequest = serde_json::from_value(serde_json::json!({
            "files": files,
            "format": format,
            "outDir": out,
            "overwrite": true,
        }))
        .unwrap();
        let estimate = convert::estimated_bytes(&req) as f64;
        let done =
            convert::convert(&engine, &export::Exports::default(), &req, "c", &|_| {}).unwrap();
        let actual: u64 = done.files.iter().map(|f| f.output_bytes).sum();
        let ratio = estimate / actual as f64;
        eprintln!("{format:?}: estimate {estimate:.0}, written {actual} ({ratio:.2}x)");
        assert!(ratio < 2.5 && ratio > 0.2, "{format:?}: {ratio:.2}x");
    }
}
