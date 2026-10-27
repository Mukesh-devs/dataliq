//! Background import and dataset cache, end to end through the engine.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use arrow::array::AsArray;
use arrow::datatypes::Int64Type;
use arrow::ipc::reader::StreamReader;
use bigview_lib::cache::{Cache, CacheConfig};
use bigview_lib::engine::{Engine, EngineConfig, RequestKey};
use bigview_lib::error::AppError;
use bigview_lib::import::{self, ImportOutcome, ImportProgress, ImportTarget, Imports};
use bigview_lib::sources::{OpenOptions, Source};

struct Env {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    cache_dir: PathBuf,
}

fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    Env {
        cache_dir: dir.join("cache"),
        dir,
        _tmp: tmp,
    }
}

fn engine(env: &Env) -> Engine {
    Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 2 << 30,
        temp_dir: env.dir.join("spill"),
        threads: Some(2),
    })
    .unwrap()
}

fn cache(env: &Env, max_bytes: u64, enabled: bool) -> Cache {
    Cache::new(CacheConfig {
        dir: env.cache_dir.clone(),
        max_bytes,
        enabled,
    })
    .unwrap()
}

fn run(
    engine: &Engine,
    cache: &Cache,
    env: &Env,
    path: &Path,
    on_progress: &(dyn Fn(ImportProgress) + Sync),
) -> Result<ImportOutcome, AppError> {
    let source = Source::new(path, OpenOptions::default())?.resolve_dialect(engine)?;
    let target = ImportTarget {
        cache,
        temp_dir: env.dir.join("tmp-import"),
    };
    import::import(
        engine,
        &Imports::default(),
        &target,
        &source,
        "job",
        on_progress,
    )
}

fn write_csv(engine: &Engine, path: &Path, rows: u64) {
    engine
        .execute_batch(&format!(
            "COPY (SELECT range AS id, 'name ' || range AS name, range * 0.5 AS amount \
             FROM range({rows})) TO '{}' (HEADER)",
            path.display()
        ))
        .unwrap();
}

fn page_ids(engine: &Engine, id: &str, start: u64, count: u64) -> Vec<i64> {
    let bytes = engine
        .fetch_rows(id, start, count, &RequestKey::default())
        .unwrap();
    StreamReader::try_new(Cursor::new(bytes), None)
        .unwrap()
        .flat_map(|b| {
            b.unwrap()
                .column(0)
                .as_primitive::<Int64Type>()
                .values()
                .to_vec()
        })
        .collect()
}

fn files_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

#[test]
fn import_then_reopen_from_cache_is_instant() {
    let env = env();
    let path = env.dir.join("data.csv");
    {
        let e = engine(&env);
        write_csv(&e, &path, 200_000);
        let c = cache(&env, 1 << 30, true);
        let out = run(&e, &c, &env, &path, &|_| {}).unwrap();
        assert!(!out.from_cache);
        assert_eq!(out.dataset.row_count, 200_000);
        assert_eq!(
            page_ids(&e, &out.dataset.id, 123_000, 3),
            vec![123_000, 123_001, 123_002]
        );
        assert_eq!(c.info().entries, 1);
    }
    // A new session (new engine) reuses the cached database.
    let e = engine(&env);
    let c = cache(&env, 1 << 30, true);
    let t = Instant::now();
    let out = run(&e, &c, &env, &path, &|_| {}).unwrap();
    assert!(out.from_cache, "second open must come from the cache");
    assert!(
        t.elapsed() < Duration::from_secs(1),
        "reopen took {:?}",
        t.elapsed()
    );
    assert_eq!(out.dataset.row_count, 200_000);
    assert_eq!(
        page_ids(&e, &out.dataset.id, 199_998, 5),
        vec![199_998, 199_999]
    );
}

#[test]
fn editing_the_file_triggers_reimport() {
    let env = env();
    let path = env.dir.join("data.csv");
    let e = engine(&env);
    write_csv(&e, &path, 1000);
    let c = cache(&env, 1 << 30, true);
    let first = run(&e, &c, &env, &path, &|_| {}).unwrap();
    import::close_dataset(&e, &first.dataset.id).unwrap();
    // Change size and modification time.
    std::thread::sleep(Duration::from_millis(20));
    write_csv(&e, &path, 1500);
    let second = run(&e, &c, &env, &path, &|_| {}).unwrap();
    assert!(!second.from_cache);
    assert_ne!(first.dataset.id, second.dataset.id);
    assert_eq!(second.dataset.row_count, 1500);
}

#[test]
fn cancel_leaves_no_broken_cache() {
    let env = env();
    let path = env.dir.join("big.csv");
    let e = Arc::new(engine(&env));
    write_csv(&e, &path, 8_000_000);
    let c = cache(&env, 1 << 34, true);
    let imports = Arc::new(Imports::default());
    let source = Source::new(&path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(&e)
        .unwrap();
    let canceller = {
        let imports = Arc::clone(&imports);
        std::thread::spawn(move || {
            for _ in 0..500 {
                std::thread::sleep(Duration::from_millis(10));
                if imports.cancel("job") {
                    return true;
                }
            }
            false
        })
    };
    let target = ImportTarget {
        cache: &c,
        temp_dir: env.dir.join("tmp-import"),
    };
    let result = import::import(&e, &imports, &target, &source, "job", &|_| {});
    assert!(canceller.join().unwrap(), "import never started");
    assert!(
        matches!(result, Err(AppError::Cancelled)),
        "{:?}",
        result.map(|o| o.dataset)
    );
    assert_eq!(
        files_in(&env.cache_dir),
        Vec::<String>::new(),
        "cache dir must be empty"
    );
    assert_eq!(c.info().entries, 0);
    // A later import of the same file works normally.
    let out = run(&e, &c, &env, &path, &|_| {}).unwrap();
    assert_eq!(out.dataset.row_count, 8_000_000);
}

/// A cancel that lands just before the statement starts (where DuckDB's
/// interrupt is a no-op) or as it finishes must still cancel.
#[test]
fn cancel_racing_a_short_import_still_cancels() {
    let env = env();
    let path = env.dir.join("small.csv");
    let e = Arc::new(engine(&env));
    write_csv(&e, &path, 2000);
    let c = cache(&env, 1 << 30, true);
    let source = Source::new(&path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(&e)
        .unwrap();
    let target = ImportTarget {
        cache: &c,
        temp_dir: env.dir.join("tmp-import"),
    };
    let mut caught = 0;
    for i in 0..20 {
        let job = format!("job{i}");
        let imports = Arc::new(Imports::default());
        let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let canceller = {
            let (imports, finished, job) =
                (Arc::clone(&imports), Arc::clone(&finished), job.clone());
            std::thread::spawn(move || {
                while !finished.load(Ordering::SeqCst) {
                    if imports.cancel(&job) {
                        return true;
                    }
                    std::hint::spin_loop();
                }
                false
            })
        };
        let result = import::import(&e, &imports, &target, &source, &job, &|_| {});
        finished.store(true, Ordering::SeqCst);
        if canceller.join().unwrap() {
            caught += 1;
            assert!(
                matches!(result, Err(AppError::Cancelled)),
                "cancel accepted but import returned {:?}",
                result.map(|o| o.dataset)
            );
            assert_eq!(c.info().entries, 0);
        } else if let Ok(out) = result {
            // The import beat the canceller: drop it so the next round imports again.
            import::close_dataset(&e, &out.dataset.id).unwrap();
            c.clear(&[]);
        }
    }
    assert!(caught > 0, "the canceller never caught a running import");
}

#[test]
fn progress_is_reported_for_long_imports() {
    let env = env();
    let path = env.dir.join("big.csv");
    let e = engine(&env);
    write_csv(&e, &path, 6_000_000);
    let c = cache(&env, 1 << 34, true);
    let events = AtomicUsize::new(0);
    let max_percent = parking_lot::Mutex::new(0.0f64);
    run(&e, &c, &env, &path, &|p| {
        events.fetch_add(1, Ordering::Relaxed);
        if let Some(pct) = p.percent {
            let mut m = max_percent.lock();
            *m = m.max(pct);
        }
    })
    .unwrap();
    assert!(events.load(Ordering::Relaxed) > 0, "no progress events");
    let m = *max_percent.lock();
    assert!((0.0..=100.0).contains(&m), "percent out of range: {m}");
}

#[test]
fn truncated_gzip_import_fails_plainly_and_caches_nothing() {
    let env = env();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/csv/corrupted.csv.gz");
    let e = engine(&env);
    let c = cache(&env, 1 << 30, true);
    let err = run(&e, &c, &env, &path, &|_| {}).err().unwrap();
    assert!(err.to_string().contains("damaged or incomplete"), "{err}");
    assert_eq!(c.info().entries, 0);
    assert_eq!(files_in(&env.cache_dir), Vec::<String>::new());
}

#[test]
fn gzip_import_matches_plain_rows() {
    let env = env();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/csv");
    let e = engine(&env);
    let c = cache(&env, 1 << 30, true);
    let plain = run(&e, &c, &env, &root.join("comma.csv"), &|_| {}).unwrap();
    let gz = run(&e, &c, &env, &root.join("comma.csv.gz"), &|_| {}).unwrap();
    assert_eq!(plain.dataset.row_count, 3);
    assert_eq!(gz.dataset.row_count, 3);
    assert_eq!(page_ids(&e, &gz.dataset.id, 0, 10), vec![1, 2, 3]);
}

#[test]
fn caching_disabled_imports_to_temp_only() {
    let env = env();
    let path = env.dir.join("data.csv");
    let e = engine(&env);
    write_csv(&e, &path, 5000);
    let c = cache(&env, 1 << 30, false);
    let out = run(&e, &c, &env, &path, &|_| {}).unwrap();
    assert_eq!(out.dataset.row_count, 5000);
    assert_eq!(c.info().entries, 0);
    assert_eq!(files_in(&env.cache_dir), Vec::<String>::new());
    assert_eq!(files_in(&env.dir.join("tmp-import")).len(), 1);
}

#[test]
fn lru_cleanup_keeps_cache_under_its_limit() {
    let env = env();
    let e = engine(&env);
    let a = env.dir.join("a.csv");
    let b = env.dir.join("b.csv");
    write_csv(&e, &a, 300_000);
    write_csv(&e, &b, 300_000);
    // Room for roughly one entry.
    let c = cache(&env, 1, true);
    let first = run(&e, &c, &env, &a, &|_| {}).unwrap();
    import::close_dataset(&e, &first.dataset.id).unwrap();
    run(&e, &c, &env, &b, &|_| {}).unwrap();
    // `a` was closed and least recently used; `b` is open and kept.
    assert_eq!(c.info().entries, 1);
    assert!(c.lookup(&first.dataset.id).is_none());
}

#[test]
fn direct_mode_pages_without_import() {
    let env = env();
    let path = env.dir.join("data.csv");
    let e = engine(&env);
    write_csv(&e, &path, 10_000);
    let source = Source::new(&path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(&e)
        .unwrap();
    let ds = import::open_direct(&e, &source).unwrap();
    assert!(!ds.cached);
    assert_eq!(ds.row_count, 10_000);
    assert_eq!(
        page_ids(&e, &ds.id, 9_990, 20),
        (9_990..10_000).collect::<Vec<i64>>()
    );
}

#[test]
fn low_disk_message_is_plain() {
    let err = AppError::LowDisk {
        needed: 12 << 30,
        available: 3 << 30,
    };
    assert_eq!(
        err.to_string(),
        "Not enough free disk space to import this file: about 12.0 GB needed, 3.0 GB free. \
         You can read it directly from the file instead (slower), or free up space."
    );
}
