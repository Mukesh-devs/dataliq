//! Sorting and filtering 50M cached rows (budget: sort < 10 s, filter < 2 s).
//! Needs `pnpm fixtures sales_50m.parquet`. Ignored by default:
//!   cargo test -p bigview --test it perf_sort -- --ignored --nocapture --test-threads=1
//! Set `PERF_CACHE_DB=<path>` to keep the imported database between runs.

use std::path::PathBuf;
use std::time::Instant;

use bigview_lib::engine::{Engine, EngineConfig};
use bigview_lib::settings::Settings;

fn generated(name: &str) -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/generated")
        .join(name);
    p.is_file().then_some(p)
}

/// Engine with the 50M-row Parquet imported into an on-disk database (as the
/// cache does), attached as `cache`.
fn setup() -> Option<(Engine, tempfile::TempDir)> {
    let parquet = generated("sales_50m.parquet")?;
    let tmp = tempfile::tempdir().unwrap();
    let mut cfg = EngineConfig::from_settings(&Settings::default());
    cfg.temp_dir = tmp.path().join("spill");
    let engine = Engine::open_in_memory(&cfg).unwrap();
    let db = std::env::var_os("PERF_CACHE_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| tmp.path().join("cache.duckdb"));
    let fresh = !db.is_file();
    engine
        .execute_batch(&format!("ATTACH '{}' AS cache", db.display()))
        .unwrap();
    if fresh {
        let t = Instant::now();
        engine
            .execute_batch(&format!(
                "CREATE TABLE cache.data AS SELECT * FROM read_parquet('{}')",
                parquet.display()
            ))
            .unwrap();
        println!("import 50M rows: {:.1} s", t.elapsed().as_secs_f64());
    }
    Some((engine, tmp))
}

fn time(engine: &Engine, label: &str, sql: &str) -> f64 {
    let t = Instant::now();
    engine.execute_batch(sql).unwrap();
    let s = t.elapsed().as_secs_f64();
    println!("{label}: {s:.2} s");
    s
}

/// Average time of a 500-row page query; `{start}` is replaced per page.
fn page_ms(engine: &Engine, sql: &str) -> f64 {
    let conn = engine.connection().unwrap();
    let n = 10;
    let t = Instant::now();
    for i in 0..n {
        let start = (i * 4_999_997 + 12_345) % 49_999_000;
        let q = sql.replace("{start}", &start.to_string());
        let mut stmt = conn.prepare(&q).unwrap();
        let rows = stmt.query_map([], |_| Ok(())).unwrap().count();
        assert_eq!(rows, 500, "{q}");
    }
    t.elapsed().as_secs_f64() * 1000.0 / n as f64
}

#[test]
#[ignore = "needs generated fixtures; several minutes"]
fn perf_sort_strategies() {
    let Some((engine, _tmp)) = setup() else {
        eprintln!("sales_50m.parquet not generated, skipping");
        return;
    };
    let only = std::env::var("PERF_ONLY").unwrap_or_default();
    let run = |name: &str| only.is_empty() || only.split(',').any(|o| o == name);

    if run("topn") {
        // First screen of a sort: one scan with a top-N heap.
        time(
            &engine,
            "top 500 ORDER BY customer DESC",
            "SELECT * FROM cache.data ORDER BY customer DESC NULLS LAST, rowid LIMIT 500",
        );
        time(
            &engine,
            "top 500 ORDER BY unit_price, order_ts DESC",
            "SELECT * FROM cache.data ORDER BY unit_price NULLS LAST, order_ts DESC NULLS LAST, rowid LIMIT 500",
        );
    }
    if run("mem") {
        // Full rows sorted into an in-memory catalog (no compression on write;
        // spills to the temp dir past the memory limit).
        engine.execute_batch("ATTACH ':memory:' AS mem").unwrap();
        time(
            &engine,
            "mem: full rows ORDER BY customer DESC",
            "CREATE TABLE mem.s AS SELECT * FROM cache.data ORDER BY customer DESC NULLS LAST, rowid",
        );
        let p = page_ms(
            &engine,
            "SELECT * FROM mem.s WHERE rowid >= {start} AND rowid < {start} + 500",
        );
        println!("mem: page {p:.1} ms");
        time(
            &engine,
            "mem: full rows ORDER BY order_date, unit_price DESC",
            "CREATE OR REPLACE TABLE mem.s AS SELECT * FROM cache.data ORDER BY order_date NULLS LAST, unit_price DESC NULLS LAST, rowid",
        );
        time(
            &engine,
            "mem: full rows ORDER BY quantity",
            "CREATE OR REPLACE TABLE mem.s AS SELECT * FROM cache.data ORDER BY quantity NULLS LAST, rowid",
        );
        engine.execute_batch("DROP TABLE mem.s").unwrap();
    }
    if run("rowids") {
        // Sorted row numbers only, then pages fetched by rowid list.
        engine.execute_batch("ATTACH ':memory:' AS mem2").unwrap();
        time(
            &engine,
            "rowids ORDER BY customer DESC (mem)",
            "CREATE TABLE mem2.r AS SELECT rowid AS r FROM cache.data ORDER BY customer DESC NULLS LAST, rowid",
        );
        let conn = engine.connection().unwrap();
        let n = 10;
        let t = Instant::now();
        for i in 0..n {
            let start = (i * 4_999_997 + 12_345) % 49_999_000;
            let ids: Vec<i64> = conn
                .prepare(&format!(
                    "SELECT r FROM mem2.r WHERE rowid >= {start} AND rowid < {start} + 500"
                ))
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let list = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
            let rows = conn
                .prepare(&format!("SELECT * FROM cache.data WHERE rowid IN ({list})"))
                .unwrap()
                .query_map([], |_| Ok(()))
                .unwrap()
                .count();
            assert_eq!(rows, 500);
        }
        println!(
            "rowids: page via IN list {:.1} ms",
            t.elapsed().as_secs_f64() * 1000.0 / n as f64
        );
    }
    if run("filter") {
        // Filter-only views: a selective and a broad filter, counted, written
        // out, and paged deep without materializing.
        for (label, filter) in [
            ("country = 'DE'", "country = 'DE'"),
            ("quantity > 5", "quantity > 5"),
        ] {
            time(
                &engine,
                &format!("count where {label}"),
                &format!("SELECT count(*) FROM cache.data WHERE {filter}"),
            );
            engine
                .execute_batch("ATTACH IF NOT EXISTS ':memory:' AS memf")
                .unwrap();
            time(
                &engine,
                &format!("mem: write where {label}"),
                &format!(
                    "CREATE OR REPLACE TABLE memf.f AS SELECT * FROM cache.data WHERE {filter}"
                ),
            );
            let n: i64 = engine
                .connection()
                .unwrap()
                .query_row("SELECT count(*) FROM memf.f", [], |r| r.get(0))
                .unwrap();
            let deep = (n / 2).max(0);
            let t = Instant::now();
            let conn = engine.connection().unwrap();
            let rows = conn
                .prepare(&format!(
                    "SELECT * FROM (SELECT * FROM cache.data WHERE {filter}) LIMIT 500 OFFSET {deep}"
                ))
                .unwrap()
                .query_map([], |_| Ok(()))
                .unwrap()
                .count();
            assert_eq!(rows, 500);
            println!(
                "deep LIMIT/OFFSET page where {label} (offset {deep}): {:.0} ms",
                t.elapsed().as_secs_f64() * 1000.0
            );
        }
    }
}
