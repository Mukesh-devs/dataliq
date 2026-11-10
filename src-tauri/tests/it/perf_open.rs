//! What opening a file costs end to end, the way the app does it: file info
//! and the first rows side by side, then the full import; then the same file
//! reopened in a new session (from the cache). Ignored by default:
//!   cargo test -p dataliq --test it perf_open -- --ignored --nocapture --test-threads=1

use std::path::{Path, PathBuf};
use std::time::Instant;

use dataliq_lib::cache::{Cache, CacheConfig};
use dataliq_lib::engine::{Engine, EngineConfig, RequestKey};
use dataliq_lib::import::{ImportTarget, Imports};
use dataliq_lib::open;
use dataliq_lib::settings::Settings;
use dataliq_lib::sources::OpenOptions;

fn generated(name: &str) -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/generated")
        .join(name);
    p.is_file().then_some(p)
}

struct Timings {
    first_rows: f64,
    full_data: f64,
    from_cache: bool,
}

/// Info and preview in parallel (as the UI asks for them); the import starts
/// as soon as the info is back, unless it came with the data.
fn open_like_the_app(engine: &Engine, target: &ImportTarget<'_>, path: &Path) -> Timings {
    let t = Instant::now();
    let (first_rows, full_data, from_cache) = std::thread::scope(|s| {
        let info = s.spawn(|| {
            let info = open::info(engine, target.cache, path, OpenOptions::default()).unwrap();
            let from_cache = info.dataset.is_some();
            let info_at = t.elapsed().as_secs_f64();
            if !from_cache {
                let out = open::import(
                    engine,
                    &Imports::default(),
                    target,
                    path,
                    OpenOptions::default(),
                    "job",
                    &|_| {},
                )
                .unwrap();
                assert!(out.dataset.row_count > 0);
            }
            (info_at, t.elapsed().as_secs_f64(), from_cache)
        });
        let preview = s.spawn(|| {
            let bytes = open::preview(
                engine,
                target.cache,
                path,
                OpenOptions::default(),
                &RequestKey::default(),
            )
            .unwrap();
            assert!(!bytes.is_empty());
            t.elapsed().as_secs_f64()
        });
        let preview_at = preview.join().unwrap();
        let (info_at, done_at, from_cache) = info.join().unwrap();
        (info_at.max(preview_at), done_at, from_cache)
    });
    Timings {
        first_rows,
        full_data,
        from_cache,
    }
}

fn measure(name: &str) {
    let Some(path) = generated(name) else {
        eprintln!("{name}: not generated, skipping (run `pnpm fixtures {name}`)");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let mut cfg = EngineConfig::from_settings(&Settings::default());
    cfg.temp_dir = tmp.path().join("spill");
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
    let engine = Engine::open_in_memory(&cfg).unwrap();
    let cold = open_like_the_app(&engine, &target, &path);
    drop(engine);
    let engine = Engine::open_in_memory(&cfg).unwrap();
    let warm = open_like_the_app(&engine, &target, &path);
    println!(
        "{name}: first rows {:.2} s, full data {:.2} s; reopened: first rows {:.3} s, \
         full data {:.3} s (data with the info: {})",
        cold.first_rows, cold.full_data, warm.first_rows, warm.full_data, warm.from_cache
    );
}

#[test]
#[ignore = "needs generated fixtures"]
fn perf_open_100mb_csv() {
    measure("sales_100mb.csv");
}

#[test]
#[ignore = "needs generated fixtures"]
fn perf_open_100mb_csv_gz() {
    measure("sales_100mb.csv.gz");
}

#[test]
#[ignore = "needs generated fixtures"]
fn perf_open_100mb_ndjson_gz() {
    measure("logs_100mb.ndjson.gz");
}

#[test]
#[ignore = "needs generated fixtures"]
fn perf_open_1gb_csv() {
    measure("sales_1gb.csv");
}
