//! v0.6 sources on generated large files: a folder of gzipped CSV files,
//! a 50M-row DuckDB file queried in place, a SQLite import and Parquet
//! over HTTP. Ignored by default (needs `pnpm fixtures`, a few minutes):
//!   cargo test -p dataliq --test it perf_sources -- --ignored --nocapture --test-threads=1

use std::path::{Path, PathBuf};
use std::time::Instant;

use dataliq_lib::cache::{Cache, CacheConfig};
use dataliq_lib::engine::{Engine, EngineConfig, RequestKey};
use dataliq_lib::import::{self, ImportTarget, Imports};
use dataliq_lib::settings::Settings;
use dataliq_lib::sources::{DatabaseOptions, OpenOptions, Source};
use dataliq_lib::view::{Filter, FilterOp, SortKey, ViewSpec};

fn generated(name: &str) -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/generated")
        .join(name);
    p.is_file().then_some(p)
}

fn extension_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/duckdb-extensions")
}

struct Fx {
    engine: Engine,
    cache: Cache,
    tmp: tempfile::TempDir,
}

fn fx() -> Fx {
    let tmp =
        tempfile::tempdir_in(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target")).unwrap();
    let mut cfg = EngineConfig::from_settings(&Settings::default());
    cfg.temp_dir = tmp.path().join("spill");
    let engine = Engine::open_in_memory(&cfg).unwrap();
    engine.set_extension_dir(&extension_dir());
    let cache = Cache::new(CacheConfig {
        dir: tmp.path().join("cache"),
        max_bytes: 100 << 30,
        enabled: true,
    })
    .unwrap();
    Fx { engine, cache, tmp }
}

impl Fx {
    fn open(&self, path: &Path, options: OpenOptions) -> Source {
        Source::new(path, options)
            .unwrap()
            .resolve_dialect(&self.engine)
            .unwrap()
    }

    fn import(&self, source: &Source) -> (u64, f64) {
        let target = ImportTarget {
            cache: &self.cache,
            temp_dir: self.tmp.path().join("tmp"),
        };
        let t = Instant::now();
        let out = import::import(
            &self.engine,
            &Imports::default(),
            &target,
            source,
            "job",
            &|_| {},
        )
        .unwrap();
        (out.dataset.row_count, t.elapsed().as_secs_f64())
    }
}

fn secs(t: Instant) -> f64 {
    t.elapsed().as_secs_f64()
}

/// Ten gzipped CSV files (hard links to one 100 MB file) as one table.
#[test]
#[ignore = "needs generated fixtures"]
fn perf_sources_folder_of_csv_gz() {
    let Some(file) = generated("sales_100mb.csv.gz") else {
        eprintln!("sales_100mb.csv.gz not generated, skipping");
        return;
    };
    let fx = fx();
    let dir = fx.tmp.path().join("logs");
    std::fs::create_dir_all(&dir).unwrap();
    for i in 1..=10 {
        std::fs::hard_link(&file, dir.join(format!("part-{i:02}.csv.gz"))).unwrap();
    }
    let key = RequestKey::default();
    let t = Instant::now();
    let source = fx.open(&dir, OpenOptions::default());
    let info = source.inspect(&fx.engine).unwrap();
    source.preview_ipc(&fx.engine, 1000, &key).unwrap();
    println!(
        "folder of 10 × 100 MB .csv.gz: opened, {} columns and first rows in {:.2} s",
        info.columns.len(),
        secs(t)
    );
    let (rows, s) = fx.import(&source);
    println!("folder of 10 × 100 MB .csv.gz: {rows} rows imported in {s:.1} s");

    let single = fx.open(&file, OpenOptions::default());
    let (rows, s) = fx.import(&single);
    println!("one 100 MB .csv.gz (for comparison): {rows} rows imported in {s:.1} s");
}

/// A DuckDB file of 50M rows: opened, paged and filtered in place.
#[test]
#[ignore = "needs generated fixtures; writes a 50M-row DuckDB file"]
fn perf_sources_duckdb_file_50m() {
    let Some(parquet) = generated("sales_50m.parquet") else {
        eprintln!("sales_50m.parquet not generated, skipping");
        return;
    };
    let fx = fx();
    let path = fx.tmp.path().join("sales.duckdb");
    let t = Instant::now();
    duckdb::Connection::open(&path)
        .unwrap()
        .execute_batch(&format!(
            "CREATE TABLE sales AS SELECT * FROM read_parquet('{}'); CHECKPOINT;",
            parquet.display()
        ))
        .unwrap();
    println!(
        "duckdb file: written in {:.1} s ({:.2} GB)",
        secs(t),
        std::fs::metadata(&path).unwrap().len() as f64 / 1e9
    );
    let key = RequestKey::default();
    let t = Instant::now();
    let source = fx.open(&path, OpenOptions::default());
    source.inspect(&fx.engine).unwrap();
    let ds = import::open_in_place(&fx.engine, &source).unwrap();
    fx.engine.fetch_rows(&ds.id, 0, 500, &key).unwrap();
    println!(
        "duckdb file 50M: attached, listed and first page in {:.2} s ({} rows)",
        secs(t),
        ds.row_count
    );
    for (label, start) in [("middle", ds.row_count / 2), ("last", ds.row_count - 500)] {
        let t = Instant::now();
        fx.engine.fetch_rows(&ds.id, start, 500, &key).unwrap();
        println!("duckdb file 50M: page at the {label} in {:.3} s", secs(t));
    }
    let filter = ViewSpec {
        filters: vec![Filter {
            column: "country".into(),
            op: FilterOp::Contains {
                value: "an".into(),
                case_sensitive: false,
            },
            not: false,
        }],
        ..ViewSpec::default()
    };
    let sorted = ViewSpec {
        sort: vec![SortKey {
            column: "unit_price".into(),
            descending: true,
        }],
        ..ViewSpec::default()
    };
    for (label, spec) in [
        ("filter country contains 'an'", filter),
        ("sort by unit_price desc", sorted),
    ] {
        let t = Instant::now();
        let v = fx.engine.open_view(&ds.id, &spec, &key).unwrap();
        fx.engine.fetch_rows(&v.dataset.id, 0, 500, &key).unwrap();
        println!(
            "duckdb file 50M: {label}: {} rows, first page in {:.2} s",
            v.dataset.row_count,
            secs(t)
        );
    }
}

/// A 1M-row SQLite file imported into the cache.
#[test]
#[ignore = "needs generated fixtures"]
fn perf_sources_sqlite_1m() {
    let Some(parquet) = generated("sales_1m.parquet") else {
        eprintln!("sales_1m.parquet not generated, skipping");
        return;
    };
    let fx = fx();
    let path = fx.tmp.path().join("sales.sqlite");
    // DECIMAL and TIMESTAMP aren't SQLite types: written as text.
    duckdb::Connection::open_in_memory()
        .unwrap()
        .execute_batch(&format!(
            "SET extension_directory = '{}'; INSTALL sqlite; LOAD sqlite;
             ATTACH '{}' AS s (TYPE sqlite);
             CREATE TABLE s.sales AS SELECT * FROM read_parquet('{}');",
            extension_dir().display(),
            path.display(),
            parquet.display()
        ))
        .unwrap();
    let t = Instant::now();
    let source = fx.open(
        &path,
        OpenOptions {
            database: DatabaseOptions {
                schema: None,
                table: Some("sales".into()),
            },
            ..OpenOptions::default()
        },
    );
    source.inspect(&fx.engine).unwrap();
    source
        .preview_ipc(&fx.engine, 1000, &RequestKey::default())
        .unwrap();
    println!(
        "sqlite 1M ({:.0} MB): attached, listed and first rows in {:.2} s",
        std::fs::metadata(&path).unwrap().len() as f64 / 1e6,
        secs(t)
    );
    let (rows, s) = fx.import(&source);
    println!("sqlite 1M: {rows} rows imported in {s:.1} s");
}

/// A 1M-row Parquet file read over HTTP from a local server.
#[test]
#[ignore = "needs generated fixtures"]
fn perf_sources_parquet_over_http() {
    let Some(parquet) = generated("sales_1m.parquet") else {
        eprintln!("sales_1m.parquet not generated, skipping");
        return;
    };
    let fx = fx();
    let www = fx.tmp.path().join("www");
    std::fs::create_dir_all(&www).unwrap();
    std::fs::hard_link(&parquet, www.join("sales.parquet")).unwrap();
    let server = crate::remote::serve(www);
    let url = PathBuf::from(format!("{}/sales.parquet", server.base));
    let key = RequestKey::default();
    let t = Instant::now();
    let source = fx.open(&url, OpenOptions::default());
    source.inspect(&fx.engine).unwrap();
    let ds = import::open_in_place(&fx.engine, &source).unwrap();
    fx.engine.fetch_rows(&ds.id, 0, 500, &key).unwrap();
    println!(
        "parquet over http 1M: httpfs loaded, first page in {:.2} s ({} requests)",
        secs(t),
        server.requests.lock().unwrap().len()
    );
    let before = server.requests.lock().unwrap().len();
    let t = Instant::now();
    fx.engine
        .fetch_rows(&ds.id, ds.row_count / 2, 500, &key)
        .unwrap();
    println!(
        "parquet over http 1M: page at the middle in {:.3} s ({} requests)",
        secs(t),
        server.requests.lock().unwrap().len() - before
    );
}

/// 200 small gzipped CSV files of one header (a month of hourly logs).
#[test]
#[ignore = "needs generated fixtures"]
fn perf_sources_folder_of_200_small_files() {
    let Some(parquet) = generated("sales_1m.parquet") else {
        eprintln!("sales_1m.parquet not generated, skipping");
        return;
    };
    let fx = fx();
    let dir = fx.tmp.path().join("hours");
    std::fs::create_dir_all(&dir).unwrap();
    let conn = duckdb::Connection::open_in_memory().unwrap();
    conn.execute_batch(&format!(
        "CREATE TABLE s AS SELECT * FROM read_parquet('{}')",
        parquet.display()
    ))
    .unwrap();
    for i in 0..200 {
        conn.execute_batch(&format!(
            "COPY (SELECT * FROM s WHERE order_id % 200 = {i}) TO '{}' (HEADER, COMPRESSION gzip)",
            dir.join(format!("hour-{i:03}.csv.gz")).display()
        ))
        .unwrap();
    }
    let key = RequestKey::default();
    for (label, every) in [("one header", false), ("every file sniffed", true)] {
        let t = Instant::now();
        let mut source = fx.open(&dir, OpenOptions::default());
        if every {
            source = source.sniffing_every_file();
        }
        source.inspect(&fx.engine).unwrap();
        source.preview_ipc(&fx.engine, 1000, &key).unwrap();
        println!(
            "folder of 200 small .csv.gz ({label}): opened and first rows in {:.2} s",
            secs(t)
        );
    }
    let (rows, s) = fx.import(&fx.open(&dir, OpenOptions::default()));
    println!("folder of 200 small .csv.gz: {rows} rows imported in {s:.1} s");
}
