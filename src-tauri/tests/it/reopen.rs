//! Reopening an imported file from the cache: no sniffing, the data at once,
//! and a background check for edits that kept the size and time of change.

use std::path::{Path, PathBuf};

use dataliq_lib::cache::{Cache, CacheConfig};
use dataliq_lib::engine::{Engine, EngineConfig, RequestKey};
use dataliq_lib::import::{ImportTarget, Imports};
use dataliq_lib::open;
use dataliq_lib::sources::OpenOptions;

struct Env {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
}

fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    Env {
        dir: tmp.path().to_path_buf(),
        _tmp: tmp,
    }
}

fn engine(env: &Env) -> Engine {
    Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: env.dir.join("spill"),
        threads: Some(2),
    })
    .unwrap()
}

fn cache(env: &Env) -> Cache {
    Cache::new(CacheConfig {
        dir: env.dir.join("cache"),
        max_bytes: 1 << 30,
        enabled: true,
    })
    .unwrap()
}

fn import(engine: &Engine, cache: &Cache, env: &Env, path: &Path) -> String {
    let target = ImportTarget {
        cache,
        temp_dir: env.dir.join("tmp"),
    };
    let out = open::import(
        engine,
        &Imports::default(),
        &target,
        path,
        OpenOptions::default(),
        "job",
        &|_| {},
    )
    .unwrap();
    assert!(!out.from_cache);
    out.dataset.id
}

fn ipc_rows(bytes: &[u8]) -> usize {
    arrow::ipc::reader::StreamReader::try_new(std::io::Cursor::new(bytes), None)
        .unwrap()
        .map(|b| b.unwrap().num_rows())
        .sum()
}

/// Keeps the file's size and time of last change, as a copy with `cp -p` does.
fn rewrite_keeping_stamp(path: &Path, text: &str) {
    let modified = std::fs::metadata(path).unwrap().modified().unwrap();
    assert_eq!(std::fs::metadata(path).unwrap().len(), text.len() as u64);
    std::fs::write(path, text).unwrap();
    let f = std::fs::File::options().write(true).open(path).unwrap();
    f.set_modified(modified).unwrap();
}

#[test]
fn a_reopen_comes_with_its_info_and_data_without_reading_the_file() {
    let env = env();
    let path = env.dir.join("sales.csv");
    std::fs::write(&path, "id;name\n1;a\n2;b\n3;c\n").unwrap();
    let engine = engine(&env);
    let cache = cache(&env);
    let first = open::info(&engine, &cache, &path, OpenOptions::default()).unwrap();
    assert!(first.dataset.is_none(), "not imported yet");
    let key = import(&engine, &cache, &env, &path);
    drop(engine);

    // A new session: the info and the data straight from the cache entry.
    let engine = engine_again(&env);
    let r = open::reopen(&engine, &cache, &path, &OpenOptions::default())
        .unwrap()
        .expect("found in the cache");
    let again = &r.info;
    assert_eq!(again.dataset.as_ref().unwrap().id, key);
    assert_eq!(again.dataset.as_ref().unwrap().row_count, 3);
    assert_eq!(again.columns, first.columns);
    assert_eq!(
        again.sniffed.as_ref().unwrap().delimiter,
        ";",
        "detected settings kept"
    );
    assert_eq!(again.reader_sql, first.reader_sql);
    let preview = open::preview(
        &engine,
        &cache,
        &path,
        OpenOptions::default(),
        &RequestKey::default(),
    )
    .unwrap();
    assert_eq!(ipc_rows(&preview), 3);
    // Unchanged file: the background check keeps the entry.
    let mut changed = false;
    r.verify(&cache, || changed = true);
    assert!(!changed);
    assert!(
        open::reopen(&engine, &cache, &path, &OpenOptions::default())
            .unwrap()
            .is_some()
    );
}

fn engine_again(env: &Env) -> Engine {
    engine(env)
}

#[test]
fn an_edit_that_keeps_size_and_time_is_found_in_the_background() {
    let env = env();
    let path = env.dir.join("a.csv");
    std::fs::write(&path, "id,name\n1,a\n2,b\n").unwrap();
    let engine = engine(&env);
    let cache = cache(&env);
    import(&engine, &cache, &env, &path);
    rewrite_keeping_stamp(&path, "id,name\n1,x\n2,y\n");
    let r = open::reopen(&engine, &cache, &path, &OpenOptions::default())
        .unwrap()
        .expect("same stamp: from the cache at first");
    let mut changed = false;
    r.verify(&cache, || changed = true);
    assert!(changed, "the first and last bytes differ");
    // Released by the tab, then opened again: imported afresh.
    dataliq_lib::import::close_dataset(&engine, &r.info.dataset.as_ref().unwrap().id).unwrap();
    assert!(
        open::reopen(&engine, &cache, &path, &OpenOptions::default())
            .unwrap()
            .is_none()
    );
    import(&engine, &cache, &env, &path);
}

#[test]
fn caching_off_or_parquet_never_reopens_from_the_cache() {
    let env = env();
    let engine = engine(&env);
    let path = env.dir.join("p.parquet");
    engine
        .execute_batch(&format!(
            "COPY (SELECT range AS id FROM range(10)) TO '{}' (FORMAT parquet)",
            path.display()
        ))
        .unwrap();
    let cache = cache(&env);
    assert!(
        open::reopen(&engine, &cache, &path, &OpenOptions::default())
            .unwrap()
            .is_none()
    );
    let info = open::info(&engine, &cache, &path, OpenOptions::default()).unwrap();
    assert_eq!(info.dataset.unwrap().row_count, 10, "read in place");

    let csv = env.dir.join("c.csv");
    std::fs::write(&csv, "a\n1\n").unwrap();
    import(&engine, &cache, &env, &csv);
    cache.set_limits(false, 1 << 30);
    assert!(
        open::reopen(&engine, &cache, &csv, &OpenOptions::default())
            .unwrap()
            .is_none()
    );
}

#[test]
fn the_info_carries_the_version_shown_and_a_change_is_seen() {
    let env = env();
    let path = env.dir.join("s.csv");
    std::fs::write(&path, "a,b\n1,2\n").unwrap();
    let engine = engine(&env);
    let cache = cache(&env);
    let info = open::info(&engine, &cache, &path, OpenOptions::default()).unwrap();
    let shown = info.stamp.clone().expect("a local file has a stamp");
    let now = dataliq_lib::sources::Source::current_stamp(&path).unwrap();
    assert_eq!((now.size, now.modified_ms), (shown.size, shown.modified_ms));
    std::fs::write(&path, "a,b\n1,2\n3,4\n").unwrap();
    let now = dataliq_lib::sources::Source::current_stamp(&path).unwrap();
    assert_ne!(now.size, shown.size);
    // From the cache, the stamp is the imported version's.
    import(&engine, &cache, &env, &path);
    let r = open::reopen(&engine, &cache, &path, &OpenOptions::default())
        .unwrap()
        .unwrap();
    assert_eq!(r.info.stamp.unwrap().size, now.size);
    std::fs::remove_file(&path).unwrap();
    assert!(dataliq_lib::sources::Source::current_stamp(&path).is_none());
}
