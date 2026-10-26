//! Small benchmark suite on the 100 MB fixtures (`pnpm fixtures small`), used
//! by the CI regression guard (`scripts/bench.mjs`). Ignored by default:
//!   BENCH_OUT=bench.json cargo test -p bigview --test it bench_small -- --ignored --nocapture
//!
//! Each flow runs a few times and keeps the fastest run, which is the most
//! stable number on a shared CI runner.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use bigview_lib::cache::{Cache, CacheConfig};
use bigview_lib::engine::{Engine, EngineConfig, RequestKey};
use bigview_lib::import::{self, ImportTarget, Imports};
use bigview_lib::settings::Settings;
use bigview_lib::sources::{OpenOptions, Source};

const RUNS: usize = 3;

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
    (0..RUNS).map(|_| f()).min().unwrap()
}

/// Inspect + 1,000-row preview, as the UI does on open.
fn first_rows(name: &str) -> Duration {
    let path = generated(name);
    best(|| {
        let tmp = tempfile::tempdir().unwrap();
        let engine = engine(tmp.path());
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
