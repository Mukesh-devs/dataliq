//! Converting a folder of files to another format and back.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use dataliq_lib::engine::{Engine, EngineConfig};
use dataliq_lib::export::convert::{self, ConvertRequest};
use dataliq_lib::export::{ExportFormat, Exports};

fn fixture(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures")
        .join(rel)
}

fn engine(dir: &Path) -> Engine {
    Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: dir.join("spill"),
        threads: Some(2),
    })
    .unwrap()
}

fn count(engine: &Engine, from: &str) -> i64 {
    engine
        .connection()
        .unwrap()
        .query_row(&format!("SELECT count(*) FROM {from}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn a_folder_of_csv_gz_and_ndjson_to_parquet_and_back() {
    let tmp = tempfile::tempdir().unwrap();
    let input = tmp.path().join("in");
    std::fs::create_dir(&input).unwrap();
    for f in [
        "csv/people.csv",
        "csv/semicolon.csv",
        "csv/comma.csv.gz",
        "json/records.ndjson",
    ] {
        let src = fixture(f);
        std::fs::copy(&src, input.join(src.file_name().unwrap())).unwrap();
    }
    std::fs::write(input.join(".hidden.csv"), "a\n1\n").unwrap();
    std::fs::write(input.join("notes.md"), "# not data").unwrap();
    let engine = engine(tmp.path());

    let files = convert::list_data_files(&input).unwrap();
    let names: Vec<String> = files
        .iter()
        .map(|f| f.path.file_name().unwrap().to_string_lossy().to_string())
        .collect();
    assert_eq!(
        names,
        [
            "comma.csv.gz",
            "people.csv",
            "records.ndjson",
            "semicolon.csv"
        ]
    );

    let out = tmp.path().join("out");
    std::fs::create_dir(&out).unwrap();
    let progress = Mutex::new(Vec::new());
    let request = ConvertRequest {
        files: files.iter().map(|f| f.path.clone()).collect(),
        format: ExportFormat::Parquet,
        out_dir: out.clone(),
        overwrite: false,
    };
    let exports = Exports::default();
    let done = convert::convert(&engine, &exports, &request, "job", &|p| {
        progress.lock().unwrap().push(p.percent)
    })
    .unwrap();
    assert!(
        done.files.iter().all(|f| f.error.is_none()),
        "{:?}",
        done.files
    );
    let percents = progress.into_inner().unwrap();
    assert_eq!(percents.last(), Some(&100.0));
    assert!(
        percents.windows(2).all(|w| w[0] <= w[1] + 1e-9),
        "{percents:?}"
    );
    // Same rows in each new file, the semicolon one read with its delimiter.
    for (f, c) in files.iter().zip(&done.files) {
        let new = c.output.as_ref().unwrap();
        assert_eq!(
            new.file_name().unwrap().to_string_lossy(),
            convert::output_name(&f.path, ExportFormat::Parquet)
        );
        let rows = count(&engine, &format!("read_parquet('{}')", new.display()));
        assert_eq!(rows as u64, c.rows);
        assert!(c.rows > 0 && c.output_bytes > 0);
    }
    let semicolon = out.join("semicolon.parquet");
    let columns: i64 = engine
        .connection()
        .unwrap()
        .query_row(
            &format!(
                "SELECT count(*) FROM (DESCRIBE SELECT * FROM read_parquet('{}'))",
                semicolon.display()
            ),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(columns > 1, "the semicolon file kept its columns");

    // Again: the outputs exist and are skipped, unless replacing them.
    let again = convert::convert(&engine, &exports, &request, "job", &|_| {}).unwrap();
    assert!(again.files.iter().all(|f| {
        f.output.is_none()
            && f.error
                .as_deref()
                .is_some_and(|e| e.contains("already exists"))
    }));
    let replace = ConvertRequest {
        overwrite: true,
        ..request.clone()
    };
    let replaced = convert::convert(&engine, &exports, &replace, "job", &|_| {}).unwrap();
    assert!(replaced.files.iter().all(|f| f.output.is_some()));

    // Back to CSV.gz from the Parquet files; a broken file fails alone.
    std::fs::write(out.join("broken.parquet"), b"PAR1 not really").unwrap();
    let back = tmp.path().join("back");
    std::fs::create_dir(&back).unwrap();
    let parquet = convert::list_data_files(&out).unwrap();
    assert_eq!(parquet.len(), 5);
    let request = ConvertRequest {
        files: parquet.iter().map(|f| f.path.clone()).collect(),
        format: ExportFormat::CsvGz,
        out_dir: back.clone(),
        overwrite: false,
    };
    let done = convert::convert(&engine, &exports, &request, "job", &|_| {}).unwrap();
    let failed: Vec<&str> = done
        .files
        .iter()
        .filter(|f| f.error.is_some())
        .map(|f| f.source.file_name().unwrap().to_str().unwrap())
        .collect();
    assert_eq!(failed, ["broken.parquet"]);
    assert!(!back.join("broken.csv.gz.partial").exists());
    assert_eq!(
        count(
            &engine,
            &format!("read_csv('{}')", back.join("people.csv.gz").display())
        ),
        1000
    );
    // Excel is not a target here.
    let xlsx = ConvertRequest {
        format: ExportFormat::Xlsx,
        ..request
    };
    assert!(convert::convert(&engine, &exports, &xlsx, "job", &|_| {}).is_err());
}
