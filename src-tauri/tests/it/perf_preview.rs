//! Preview speed budgets on generated large files (`pnpm fixtures ...`).
//! Ignored by default; run with:
//!   cargo test -p dataliq --test it perf_preview -- --ignored --nocapture

use std::path::PathBuf;
use std::time::{Duration, Instant};

use dataliq_lib::engine::{Engine, EngineConfig, RequestKey};
use dataliq_lib::settings::Settings;
use dataliq_lib::sources::{OpenOptions, Source};

fn generated(name: &str) -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/generated")
        .join(name);
    p.is_file().then_some(p)
}

/// Opens the file the way the UI does (inspect + 1,000-row preview) and
/// returns the time to first rows.
fn time_to_first_rows(name: &str) -> Option<Duration> {
    let path = generated(name)?;
    let tmp = tempfile::tempdir().unwrap();
    let mut cfg = EngineConfig::from_settings(&Settings::default());
    cfg.temp_dir = tmp.path().to_path_buf();
    let engine = Engine::open_in_memory(&cfg).unwrap();
    let start = Instant::now();
    let source = Source::new(&path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(&engine)
        .unwrap();
    let info = source.inspect(&engine).unwrap();
    let bytes = source
        .preview_ipc(&engine, 1000, &RequestKey::default())
        .unwrap();
    let elapsed = start.elapsed();
    println!(
        "{name}: {} columns, {} IPC bytes, first rows in {:.3} s",
        info.columns.len(),
        bytes.len(),
        elapsed.as_secs_f64()
    );
    Some(elapsed)
}

fn check(name: &str, budget: Duration) {
    match time_to_first_rows(name) {
        Some(t) => assert!(t < budget, "{name}: {t:?} exceeds budget {budget:?}"),
        None => eprintln!("{name}: not generated, skipping (run `pnpm fixtures {name}`)"),
    }
}

#[test]
#[ignore = "needs generated fixtures"]
fn preview_100mb_csv() {
    check("sales_100mb.csv", Duration::from_secs(1));
}

#[test]
#[ignore = "needs generated fixtures"]
fn preview_5gb_csv() {
    check("sales_5gb.csv", Duration::from_secs(1));
}

#[test]
#[ignore = "needs generated fixtures"]
fn preview_5gb_csv_gz() {
    check("sales_5gb.csv.gz", Duration::from_secs(2));
}

#[test]
#[ignore = "needs generated fixtures"]
fn preview_5gb_ndjson_gz() {
    check("logs_5gb.ndjson.gz", Duration::from_secs(2));
}

#[test]
#[ignore = "needs generated fixtures"]
fn parquet_50m_open_and_page() {
    use dataliq_lib::import;
    let Some(path) = generated("sales_50m.parquet") else {
        eprintln!("sales_50m.parquet: not generated, skipping");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let mut cfg = EngineConfig::from_settings(&Settings::default());
    cfg.temp_dir = tmp.path().to_path_buf();
    let engine = Engine::open_in_memory(&cfg).unwrap();
    let start = Instant::now();
    let source = Source::new(&path, OpenOptions::default()).unwrap();
    source.inspect(&engine).unwrap();
    let ds = import::open_in_place(&engine, &source).unwrap();
    source
        .preview_ipc(&engine, 1000, &RequestKey::default())
        .unwrap();
    let open = start.elapsed();
    assert_eq!(ds.row_count, 50_000_000);
    let t = Instant::now();
    let n = 50;
    for i in 0..n {
        let row = (i * 997_331) % (ds.row_count - 500);
        engine
            .fetch_rows(&ds.id, row, 500, &RequestKey::default())
            .unwrap();
    }
    let per_page = t.elapsed() / n as u32;
    println!(
        "sales_50m.parquet: open (inspect + row count + preview) {:.3} s, {:.1} ms per random 500-row page",
        open.as_secs_f64(),
        per_page.as_secs_f64() * 1000.0
    );
    assert!(open < Duration::from_secs(1), "open took {open:?}");
    assert!(
        per_page < Duration::from_millis(100),
        "page took {per_page:?}"
    );
}

/// No budget in the plan for Excel; recorded in docs/BENCHMARKS.md. The
/// preview streams only the first rows, so it stays fast for big sheets.
#[test]
#[ignore = "needs generated fixtures"]
fn preview_1m_row_xlsx() {
    check("sales_1m.xlsx", Duration::from_secs(2));
}
