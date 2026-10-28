//! Sorting and filtering 50M cached rows (budget: sort < 10 s, filter < 2 s).
//! Needs `pnpm fixtures sales_50m.parquet`. Ignored by default:
//!   cargo test -p dataliq --test it perf_sort -- --ignored --nocapture --test-threads=1
//! Set `PERF_CACHE_DB=<path>` to keep the imported database between runs.

use std::path::PathBuf;
use std::time::Instant;

use dataliq_lib::engine::{Dataset, DatasetSource, Engine, EngineConfig, Param, RequestKey};
use dataliq_lib::settings::Settings;
use dataliq_lib::view::{Filter, FilterOp, SortKey, ViewSpec};

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
            ("quantity = 1", "quantity = 1"),
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

/// The app's own path on 50M cached rows: open a view, show its first page,
/// then finish it in the background.
#[test]
#[ignore = "needs generated fixtures; several minutes"]
fn perf_views_50m() {
    let Some((engine, _tmp)) = setup() else {
        eprintln!("sales_50m.parquet not generated, skipping");
        return;
    };
    engine.datasets.insert(Dataset {
        id: "ds".into(),
        source: DatasetSource::Table("cache.data".into()),
        row_count: 50_000_000,
        cached: true,
    });
    let key = RequestKey::default();
    let sort = |c: &str, d: bool| SortKey {
        column: c.into(),
        descending: d,
    };
    let filter = |c: &str, op: FilterOp| Filter {
        column: c.into(),
        op,
        not: false,
    };
    let cases: Vec<(&str, ViewSpec)> = vec![
        (
            "sort customer desc",
            ViewSpec {
                sort: vec![sort("customer", true)],
                ..ViewSpec::default()
            },
        ),
        (
            "sort order_date, unit_price desc",
            ViewSpec {
                sort: vec![sort("order_date", false), sort("unit_price", true)],
                ..ViewSpec::default()
            },
        ),
        (
            "filter quantity > 5 (broad)",
            ViewSpec {
                filters: vec![filter(
                    "quantity",
                    FilterOp::Gt {
                        value: Param::Int(5),
                    },
                )],
                ..ViewSpec::default()
            },
        ),
        (
            "filter customer contains 'ab' (text)",
            ViewSpec {
                filters: vec![filter(
                    "customer",
                    FilterOp::Contains {
                        value: "ab".into(),
                        case_sensitive: false,
                    },
                )],
                ..ViewSpec::default()
            },
        ),
        (
            "filter quantity = 1 + sort unit_price",
            ViewSpec {
                filters: vec![filter(
                    "quantity",
                    FilterOp::Equals {
                        value: Param::Int(1),
                    },
                )],
                sort: vec![sort("unit_price", false)],
                ..ViewSpec::default()
            },
        ),
    ];
    for (label, spec) in cases {
        let t = Instant::now();
        let v = engine.open_view("ds", &spec, &key).unwrap();
        engine.fetch_rows(&v.dataset.id, 0, 500, &key).unwrap();
        let first = t.elapsed().as_secs_f64();
        let rows = v.dataset.row_count;
        let t2 = Instant::now();
        let deep = if v.materializing && spec.sort.is_empty() {
            engine
                .fetch_rows(&v.dataset.id, rows / 2, 500, &key)
                .unwrap();
            format!(
                ", deep page before write {:.2} s",
                t2.elapsed().as_secs_f64()
            )
        } else if v.materializing {
            // Sorted: the last rows and the order by row id, then any page.
            engine.prepare_sorted_view(&v.dataset.id).unwrap();
            let ready = t2.elapsed().as_secs_f64();
            let t = Instant::now();
            engine
                .fetch_rows(&v.dataset.id, rows / 2, 500, &key)
                .unwrap();
            format!(
                ", every page readable after {ready:.1} s (middle page {:.2} s)",
                t.elapsed().as_secs_f64()
            )
        } else {
            String::new()
        };
        let t3 = Instant::now();
        if v.materializing {
            engine.materialize_view(&v.dataset.id).unwrap();
        }
        let full = t3.elapsed().as_secs_f64();
        let t4 = Instant::now();
        engine
            .fetch_rows(&v.dataset.id, rows / 2, 500, &key)
            .unwrap();
        println!(
            "{label}: {rows} rows; first rows {first:.2} s{deep}; written in background {full:.1} s; \
             then page {:.1} ms",
            t4.elapsed().as_secs_f64() * 1000.0
        );
        dataliq_lib::import::close_dataset(&engine, &v.dataset.id).unwrap();
    }
}

/// Column profiles on 50M cached rows (budget: one column < 3 s).
#[test]
#[ignore = "needs generated fixtures; about a minute"]
fn perf_profile_50m() {
    let Some((engine, _tmp)) = setup() else {
        eprintln!("sales_50m.parquet not generated, skipping");
        return;
    };
    engine.datasets.insert(Dataset {
        id: "ds".into(),
        source: DatasetSource::Table("cache.data".into()),
        row_count: 50_000_000,
        cached: true,
    });
    let key = RequestKey::default();
    for column in [
        "quantity",
        "unit_price",
        "order_ts",
        "customer",
        "country",
        "returned",
    ] {
        let t = Instant::now();
        let p = engine
            .column_profile("ds", &ViewSpec::default(), column, &key)
            .unwrap();
        println!(
            "profile {column} ({}): {:.2} s (distinct {:?}{})",
            p.r#type,
            t.elapsed().as_secs_f64(),
            p.distinct,
            if p.distinct_approx { " ≈" } else { "" }
        );
    }
    let cols: Vec<String> = [
        "order_id",
        "order_date",
        "order_ts",
        "quantity",
        "unit_price",
        "discount",
        "returned",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let t = Instant::now();
    engine
        .column_histograms("ds", &ViewSpec::default(), &cols, &key)
        .unwrap();
    println!(
        "header histograms for {} columns: {:.2} s",
        cols.len(),
        t.elapsed().as_secs_f64()
    );
}

/// Times the pieces of a column profile separately (diagnostics).
#[test]
#[ignore = "needs generated fixtures"]
fn perf_profile_parts() {
    let Some((engine, _tmp)) = setup() else {
        return;
    };
    let q = |label: &str, sql: &str| {
        let t = Instant::now();
        let conn = engine.connection().unwrap();
        let mut stmt = conn.prepare(sql).unwrap();
        let n = stmt.query_map([], |_| Ok(())).unwrap().count();
        println!("{label}: {:.2} s ({n} rows)", t.elapsed().as_secs_f64());
    };
    let from = "FROM (SELECT * FROM cache.data)";
    q("warm-up count", "SELECT count(*) FROM cache.data");
    q(
        "quantity stats",
        &format!(
            "SELECT count(*), count(quantity), CAST(min(quantity) AS VARCHAR), CAST(max(quantity) AS VARCHAR), avg(CAST(quantity AS DOUBLE)), stddev_samp(CAST(quantity AS DOUBLE)), approx_count_distinct(quantity), min(CAST(quantity AS DOUBLE)), max(CAST(quantity AS DOUBLE)) {from}"
        ),
    );
    q(
        "quantity stats, no stddev",
        &format!(
            "SELECT count(*), count(quantity), min(quantity), max(quantity), avg(quantity) {from}"
        ),
    );
    q(
        "quantity approx_count_distinct",
        &format!("SELECT approx_count_distinct(quantity) {from}"),
    );
    q(
        "quantity stddev",
        &format!("SELECT stddev_samp(CAST(quantity AS DOUBLE)) {from}"),
    );
    q(
        "quantity histogram",
        &format!(
            "SELECT b, count(*) FROM (SELECT least(greatest(CAST(floor((x - 1) / 1) AS BIGINT), 0), 20) AS b FROM (SELECT CAST(quantity AS DOUBLE) AS x {from}) WHERE x IS NOT NULL) GROUP BY b"
        ),
    );
    q(
        "quantity top (varchar)",
        &format!(
            "SELECT CAST(quantity AS VARCHAR) v, count(*) n {from} GROUP BY 1 ORDER BY n DESC LIMIT 11"
        ),
    );
    q(
        "quantity top (typed)",
        &format!("SELECT quantity, count(*) n {from} GROUP BY 1 ORDER BY n DESC LIMIT 11"),
    );
    q(
        "order_ts top (typed)",
        &format!("SELECT order_ts, count(*) n {from} GROUP BY 1 ORDER BY n DESC LIMIT 11"),
    );
    q(
        "order_ts approx distinct",
        &format!("SELECT approx_count_distinct(order_ts) {from}"),
    );
}
