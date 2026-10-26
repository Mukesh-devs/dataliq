//! Full-import timings on generated large files. Ignored by default:
//!   cargo test -p bigview --test perf_import -- --ignored --nocapture --test-threads=1

use std::path::PathBuf;
use std::time::Instant;

use bigview_lib::cache::{Cache, CacheConfig};
use bigview_lib::engine::{Engine, EngineConfig};
use bigview_lib::import::{self, ImportTarget, Imports};
use bigview_lib::settings::Settings;
use bigview_lib::sources::{OpenOptions, Source};

fn generated(name: &str) -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/generated")
        .join(name);
    p.is_file().then_some(p)
}

fn manifest_rows(name: &str) -> Option<u64> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/manifest.json");
    let m: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
    m[name]["rows"].as_u64()
}

/// Peak resident memory of this process (Linux), in MiB.
fn peak_rss_mib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024)
}

fn measure(name: &str) {
    let Some(path) = generated(name) else {
        eprintln!("{name}: not generated, skipping (run `pnpm fixtures {name}`)");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let mut cfg = EngineConfig::from_settings(&Settings::default());
    cfg.temp_dir = tmp.path().join("spill");
    let limit_mib = cfg.memory_limit_bytes >> 20;
    let engine = Engine::open_in_memory(&cfg).unwrap();
    let cache = Cache::new(CacheConfig {
        dir: tmp.path().join("cache"),
        max_bytes: 100 << 30,
        enabled: true,
    })
    .unwrap();
    let target = ImportTarget {
        cache: &cache,
        temp_dir: tmp.path().join("tmp"),
    };
    let source = Source::new(&path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(&engine)
        .unwrap();
    let max_pct = parking_lot::Mutex::new(0.0f64);
    let t = Instant::now();
    let out = import::import(
        &engine,
        &Imports::default(),
        &target,
        &source,
        "job",
        &|p| {
            if let Some(v) = p.percent {
                let mut m = max_pct.lock();
                *m = m.max(v);
            }
        },
    )
    .unwrap();
    let secs = t.elapsed().as_secs_f64();
    let size = std::fs::metadata(&path).unwrap().len();
    let db = cache.info().used_bytes;
    println!(
        "{name}: {} rows imported in {secs:.1} s ({:.0} MB/s of file), cache db {:.2} GB, \
         max progress seen {:.0}%, peak RSS {:?} MiB (DuckDB limit {limit_mib} MiB)",
        out.dataset.row_count,
        size as f64 / secs / 1e6,
        db as f64 / (1u64 << 30) as f64,
        *max_pct.lock(),
        peak_rss_mib(),
    );
    if let Some(expected) = manifest_rows(name) {
        assert_eq!(
            out.dataset.row_count, expected,
            "{name}: row count differs from manifest"
        );
    }
    // Reopen from the cache in a new session.
    drop(engine);
    let engine = Engine::open_in_memory(&cfg).unwrap();
    let t = Instant::now();
    let again = import::import(
        &engine,
        &Imports::default(),
        &target,
        &source,
        "job2",
        &|_| {},
    )
    .unwrap();
    assert!(again.from_cache);
    println!(
        "{name}: reopen from cache in {:.3} s",
        t.elapsed().as_secs_f64()
    );
}

#[test]
#[ignore = "needs generated fixtures"]
fn import_100mb_csv() {
    measure("sales_100mb.csv");
}

#[test]
#[ignore = "needs generated fixtures"]
fn import_100mb_csv_gz() {
    measure("sales_100mb.csv.gz");
}

#[test]
#[ignore = "needs generated fixtures"]
fn import_5gb_csv() {
    measure("sales_5gb.csv");
}

#[test]
#[ignore = "needs generated fixtures"]
fn import_5gb_csv_gz() {
    measure("sales_5gb.csv.gz");
}
