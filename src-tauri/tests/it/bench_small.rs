//! Small benchmark suite on the 100 MB fixtures (`pnpm fixtures small`), used
//! by the CI regression guard (`scripts/bench.mjs`). Ignored by default:
//!   BENCH_OUT=bench.json cargo test -p dataliq --test it bench_small -- --ignored --nocapture
//!
//! Each flow runs a few times and keeps the fastest run, which is the most
//! stable number on a shared CI runner. `BENCH_RUNS=n` changes the number of
//! runs; `BENCH_VERBOSE=1` prints every run.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use dataliq_lib::cache::{Cache, CacheConfig};
use dataliq_lib::engine::{Engine, EngineConfig, RequestKey};
use dataliq_lib::export::convert::ConvertRequest;
use dataliq_lib::export::{ExportRequest, Exports};
use dataliq_lib::import::{self, ImportTarget, Imports};
use dataliq_lib::recipe::RecipeStep;
use dataliq_lib::settings::Settings;
use dataliq_lib::sources::{OpenOptions, Source};
use dataliq_lib::view::ViewSpec;

const RUNS: usize = 5;

fn generated(name: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/generated")
        .join(name);
    assert!(p.is_file(), "{name} missing: run `pnpm fixtures small`");
    p
}

fn engine(tmp: &std::path::Path) -> Engine {
    let mut cfg = EngineConfig::from_settings(&Settings::default());
    cfg.temp_dir = tmp.join("spill");
    Engine::open_in_memory(&cfg).unwrap()
}

fn cache(dir: PathBuf) -> Cache {
    Cache::new(CacheConfig {
        dir,
        max_bytes: 100 << 30,
        enabled: true,
    })
    .unwrap()
}

/// Fastest of `RUNS` runs; `f` returns the time of the measured part.
fn best(mut f: impl FnMut() -> Duration) -> Duration {
    let runs: usize = std::env::var("BENCH_RUNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(RUNS);
    let all: Vec<Duration> = (0..runs).map(|_| f()).collect();
    if std::env::var_os("BENCH_VERBOSE").is_some() {
        eprintln!("runs: {all:?}");
    }
    all.into_iter().min().unwrap()
}

/// Inspect + 1,000-row preview, as the UI does on open.
fn first_rows(name: &str) -> Duration {
    let path = generated(name);
    best(|| {
        let tmp = tempfile::tempdir().unwrap();
        let engine = engine(tmp.path());
        // A first open: nothing remembered from the previous run.
        dataliq_lib::sources::forget_inspections();
        let t = Instant::now();
        let source = Source::new(&path, OpenOptions::default())
            .unwrap()
            .resolve_dialect(&engine)
            .unwrap();
        source.inspect(&engine).unwrap();
        source
            .preview_ipc(&engine, 1000, &RequestKey::default())
            .unwrap();
        t.elapsed()
    })
}

/// Full import into an empty cache.
fn import_time(name: &str) -> Duration {
    let path = generated(name);
    best(|| {
        let tmp = tempfile::tempdir().unwrap();
        let engine = engine(tmp.path());
        let cache = cache(tmp.path().join("cache"));
        let target = ImportTarget {
            cache: &cache,
            temp_dir: tmp.path().join("tmp"),
        };
        dataliq_lib::sources::forget_inspections();
        let source = Source::new(&path, OpenOptions::default())
            .unwrap()
            .resolve_dialect(&engine)
            .unwrap();
        let t = Instant::now();
        import::import(&engine, &Imports::default(), &target, &source, "j", &|_| {}).unwrap();
        t.elapsed()
    })
}

/// Reopen of a cached import in a fresh session.
fn reopen_cached(name: &str) -> Duration {
    let path = generated(name);
    let tmp = tempfile::tempdir().unwrap();
    let cache = cache(tmp.path().join("cache"));
    let target = ImportTarget {
        cache: &cache,
        temp_dir: tmp.path().join("tmp"),
    };
    let run = || {
        let engine = engine(tmp.path());
        let source = Source::new(&path, OpenOptions::default())
            .unwrap()
            .resolve_dialect(&engine)
            .unwrap();
        let t = Instant::now();
        let out =
            import::import(&engine, &Imports::default(), &target, &source, "j", &|_| {}).unwrap();
        (t.elapsed(), out.from_cache)
    };
    assert!(!run().1, "first run imports");
    best(|| {
        let (d, from_cache) = run();
        assert!(from_cache);
        d
    })
}

/// Average random 500-row page of a Parquet file queried in place.
fn parquet_page(name: &str) -> Duration {
    let path = generated(name);
    let tmp = tempfile::tempdir().unwrap();
    let engine = engine(tmp.path());
    let source = Source::new(&path, OpenOptions::default()).unwrap();
    let ds = import::open_in_place(&engine, &source).unwrap();
    best(|| {
        let n = 20u64;
        let t = Instant::now();
        for i in 0..n {
            let row = (i * 99_991) % (ds.row_count - 500);
            engine
                .fetch_rows(&ds.id, row, 500, &RequestKey::default())
                .unwrap();
        }
        t.elapsed() / n as u32
    })
}

/// A file imported once into a fresh cache: its engine, dataset id and the
/// temp folder holding both.
fn imported(name: &str) -> (Engine, String, tempfile::TempDir) {
    let path = generated(name);
    let tmp = tempfile::tempdir().unwrap();
    let engine = engine(tmp.path());
    let cache = cache(tmp.path().join("cache"));
    let target = ImportTarget {
        cache: &cache,
        temp_dir: tmp.path().join("tmp"),
    };
    let source = Source::new(&path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(&engine)
        .unwrap();
    let out = import::import(&engine, &Imports::default(), &target, &source, "j", &|_| {}).unwrap();
    (engine, out.dataset.id, tmp)
}

/// Group by two columns with five measures, and a pivot, as the
/// Group by / pivot tool writes them, over a Parquet file in place.
fn pivot(name: &str) -> Duration {
    let path = generated(name);
    let tmp = tempfile::tempdir().unwrap();
    let engine = engine(tmp.path());
    let src = format!("read_parquet('{}')", path.display());
    let group = format!(
        "SELECT country, returned, count(*) AS n, sum(quantity * unit_price) AS total, \
         avg(unit_price) AS price, median(unit_price) AS median, \
         quantile_cont(unit_price, 0.95) AS p95 \
         FROM {src} GROUP BY country, returned ORDER BY country, returned"
    );
    let pivot = format!(
        "SELECT * FROM (PIVOT (SELECT *, year(order_date) AS yr FROM {src}) \
         ON returned USING sum(quantity) GROUP BY country, yr) ORDER BY ALL"
    );
    best(|| {
        let t = Instant::now();
        for sql in [&group, &pivot] {
            engine
                .query(sql, &[], 10_000, &RequestKey::default())
                .unwrap();
        }
        t.elapsed()
    })
}

/// A Parquet export split into files of 100,000 rows.
fn split_export(name: &str) -> Duration {
    let path = generated(name);
    let tmp = tempfile::tempdir().unwrap();
    let engine = engine(tmp.path());
    let source = Source::new(&path, OpenOptions::default()).unwrap();
    let ds = import::open_in_place(&engine, &source).unwrap();
    let mut n = 0;
    best(|| {
        n += 1;
        let req: ExportRequest = serde_json::from_value(serde_json::json!({
            "datasetId": ds.id,
            "spec": {},
            "path": tmp.path().join(format!("split-{n}")),
            "format": "parquet",
            "options": { "rowsPerFile": 100_000 },
        }))
        .unwrap();
        let t = Instant::now();
        let out =
            dataliq_lib::export::export(&engine, &Exports::default(), &req, "e", &|_| {}).unwrap();
        assert!(out.files >= 10);
        t.elapsed()
    })
}

/// Batch convert of a CSV file to Parquet.
fn convert(name: &str) -> Duration {
    let path = generated(name);
    let tmp = tempfile::tempdir().unwrap();
    let engine = engine(tmp.path());
    best(|| {
        dataliq_lib::sources::forget_inspections();
        let req: ConvertRequest = serde_json::from_value(serde_json::json!({
            "files": [path],
            "format": "parquet",
            "outDir": tmp.path(),
            "overwrite": true,
        }))
        .unwrap();
        let t = Instant::now();
        dataliq_lib::export::convert::convert(&engine, &Exports::default(), &req, "c", &|_| {})
            .unwrap();
        t.elapsed()
    })
}

/// The JSON structure graph of a whole file, with keys counted inside arrays.
fn json_structure(name: &str) -> Duration {
    let (engine, id, _tmp) = imported(name);
    best(|| {
        let t = Instant::now();
        let shape = engine
            .json_shape(&id, &ViewSpec::default(), true, &RequestKey::default())
            .unwrap();
        assert!(shape.rows > 0);
        t.elapsed()
    })
}

/// One row per item of an array column (a cleaning step).
fn unnest(name: &str, column: &str) -> Duration {
    let (engine, id, _tmp) = imported(name);
    let steps: Vec<RecipeStep> =
        serde_json::from_value(serde_json::json!([{ "op": "unnest", "column": column }])).unwrap();
    best(|| {
        let t = Instant::now();
        let out = engine
            .apply_recipe(&id, &steps, &RequestKey::default())
            .unwrap();
        assert!(out.dataset.row_count > 0);
        t.elapsed()
    })
}

#[test]
#[ignore = "needs `pnpm fixtures small`"]
fn bench_small() {
    let mut results: BTreeMap<&str, Duration> = BTreeMap::new();
    results.insert("first_rows_100mb_csv", first_rows("sales_100mb.csv"));
    results.insert("first_rows_100mb_csv_gz", first_rows("sales_100mb.csv.gz"));
    results.insert(
        "first_rows_100mb_ndjson_gz",
        first_rows("logs_100mb.ndjson.gz"),
    );
    results.insert("first_rows_100k_xlsx", first_rows("sales_100k.xlsx"));
    results.insert("import_100mb_csv", import_time("sales_100mb.csv"));
    results.insert("import_100mb_csv_gz", import_time("sales_100mb.csv.gz"));
    results.insert(
        "import_100mb_ndjson_gz",
        import_time("logs_100mb.ndjson.gz"),
    );
    results.insert("import_100k_xlsx", import_time("sales_100k.xlsx"));
    results.insert("reopen_cached_100mb_csv", reopen_cached("sales_100mb.csv"));
    results.insert("page_1m_parquet", parquet_page("sales_1m.parquet"));
    results.insert("pivot_1m_parquet", pivot("sales_1m.parquet"));
    results.insert("split_export_1m_parquet", split_export("sales_1m.parquet"));
    results.insert("convert_100mb_csv_to_parquet", convert("sales_100mb.csv"));
    results.insert(
        "json_structure_100mb_ndjson_gz",
        json_structure("logs_100mb.ndjson.gz"),
    );
    results.insert(
        "unnest_100mb_ndjson_gz",
        unnest("logs_100mb.ndjson.gz", "tags"),
    );

    let ms: BTreeMap<&str, f64> = results
        .iter()
        .map(|(k, d)| (*k, (d.as_secs_f64() * 1e5).round() / 100.0))
        .collect();
    for (k, v) in &ms {
        println!("{k}: {v} ms");
    }
    if let Ok(out) = std::env::var("BENCH_OUT") {
        std::fs::write(&out, serde_json::to_string_pretty(&ms).unwrap()).unwrap();
        println!("wrote {out}");
    }
}
