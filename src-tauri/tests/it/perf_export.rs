//! Exports and SQL over 50M cached rows. Needs `pnpm fixtures sales_50m.parquet`,
//! or a database it was imported into (`PERF_CACHE_DB`, as `perf_sort` keeps).
//! Ignored by default:
//!   PERF_CACHE_DB=<path> cargo test -p bigview --test it perf_export -- --ignored --nocapture --test-threads=1
//! `PERF_ONLY=parquet,xlsx,…` runs some of the cases.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use bigview_lib::engine::{Dataset, DatasetSource, Engine, EngineConfig, Param, RequestKey};
use bigview_lib::export::{self, ExportFormat, ExportOptions, ExportRequest, Exports};
use bigview_lib::settings::Settings;
use bigview_lib::view::{Filter, FilterOp, SortKey, ViewSpec};

/// The process's peak resident memory since the last reset, in MiB.
fn peak_mib() -> f64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .find_map(|l| l.strip_prefix("VmHWM:"))
        .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<f64>().ok())
        .map_or(0.0, |kb| kb / 1024.0)
}

/// Starts a new peak-memory measurement (Linux: resets VmHWM to the current RSS).
fn reset_peak() {
    let _ = std::fs::write("/proc/self/clear_refs", "5");
}

fn setup() -> Option<(Engine, Dataset, tempfile::TempDir)> {
    let tmp = tempfile::tempdir().unwrap();
    let db = std::env::var_os("PERF_CACHE_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| tmp.path().join("cache.duckdb"));
    let parquet =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/sales_50m.parquet");
    if !db.is_file() && !parquet.is_file() {
        return None;
    }
    let mut cfg = EngineConfig::from_settings(&Settings::default());
    cfg.temp_dir = tmp.path().join("spill");
    let engine = Engine::open_in_memory(&cfg).unwrap();
    let fresh = !db.is_file();
    engine
        .execute_batch(&format!("ATTACH '{}' AS cache", db.display()))
        .unwrap();
    if fresh {
        engine
            .execute_batch(&format!(
                "CREATE TABLE cache.data AS SELECT * FROM read_parquet('{}')",
                parquet.display()
            ))
            .unwrap();
    }
    let ds = Dataset {
        id: "sales".into(),
        source: DatasetSource::Table("cache.data".into()),
        row_count: 50_000_000,
        cached: true,
    };
    engine.datasets.insert(ds.clone());
    Some((engine, ds, tmp))
}

fn size_mb(path: &Path) -> f64 {
    std::fs::metadata(path).map_or(0.0, |m| m.len() as f64 / 1e6)
}

fn quantity(op: FilterOp) -> ViewSpec {
    ViewSpec {
        filters: vec![Filter {
            column: "quantity".into(),
            op,
            not: false,
        }],
        ..Default::default()
    }
}

#[test]
#[ignore = "needs generated fixtures; several minutes"]
fn perf_export_50m() {
    let Some((engine, ds, tmp)) = setup() else {
        eprintln!("sales_50m.parquet not generated, skipping");
        return;
    };
    let only = std::env::var("PERF_ONLY").unwrap_or_default();
    let run = |name: &str| only.is_empty() || only.split(',').any(|o| o == name);
    let exports = Exports::default();
    let all = ViewSpec::default();
    let q1 = quantity(FilterOp::Equals {
        value: Param::Int(1),
    });
    let q2 = quantity(FilterOp::Lte {
        value: Param::Int(2),
    });
    let sorted = ViewSpec {
        sort: vec![SortKey {
            column: "unit_price".into(),
            descending: true,
        }],
        columns: Some(
            ["order_id", "customer", "unit_price", "order_date"]
                .map(String::from)
                .into(),
        ),
        ..Default::default()
    };
    let cases: Vec<(&str, &str, ViewSpec, ExportFormat, ExportOptions)> = vec![
        (
            "parquet",
            "all 50M rows",
            all.clone(),
            ExportFormat::Parquet,
            Default::default(),
        ),
        (
            "csv",
            "all 50M rows",
            all.clone(),
            ExportFormat::Csv,
            Default::default(),
        ),
        (
            "csvgz",
            "quantity <= 2",
            q2.clone(),
            ExportFormat::CsvGz,
            Default::default(),
        ),
        (
            "tsv",
            "quantity <= 2",
            q2.clone(),
            ExportFormat::Tsv,
            Default::default(),
        ),
        (
            "ndjson",
            "quantity <= 2",
            q2.clone(),
            ExportFormat::Ndjson,
            Default::default(),
        ),
        (
            "json",
            "quantity = 1",
            q1.clone(),
            ExportFormat::Json,
            Default::default(),
        ),
        (
            "sorted",
            "sorted by unit_price, 4 columns",
            sorted,
            ExportFormat::Parquet,
            Default::default(),
        ),
        (
            "xlsx",
            "first sheet of quantity = 1",
            q1.clone(),
            ExportFormat::Xlsx,
            ExportOptions {
                split_sheets: Some(false),
                ..Default::default()
            },
        ),
        (
            "xlsx_split",
            "quantity = 1, split",
            q1,
            ExportFormat::Xlsx,
            Default::default(),
        ),
    ];
    for (name, what, spec, format, options) in cases {
        if !run(name) {
            continue;
        }
        let path = tmp.path().join(format!("{name}.{}", format.extension()));
        let req = ExportRequest {
            dataset_id: ds.id.clone(),
            spec,
            labels: HashMap::new(),
            path: path.clone(),
            format,
            options,
            total_rows: None,
        };
        reset_peak();
        let before = peak_mib();
        let t = Instant::now();
        let out = export::export(&engine, &exports, &req, name, &|_| {}).unwrap();
        let s = t.elapsed().as_secs_f64();
        println!(
            "{name:<10} {what:<32} {:>11} rows  {s:>6.1} s  {:>8.0} rows/s  {:>7.0} MB  {} sheet(s), {} left out  peak +{:.0} MiB",
            out.rows,
            out.rows as f64 / s,
            size_mb(&path),
            out.sheets,
            out.rows_left_out,
            peak_mib() - before,
        );
        std::fs::remove_file(&path).unwrap();
    }

    if run("sql") {
        let key = RequestKey {
            id: None,
            group: Some("sql".into()),
        };
        engine.register_table(&ds.id, "sales").unwrap();
        for (what, sql) in [
            (
                "group by country (8 groups)",
                "SELECT country, count(*) AS n, sum(unit_price * quantity) AS revenue \
                 FROM sales GROUP BY country ORDER BY revenue DESC",
            ),
            (
                "group by customer (100K groups)",
                "SELECT customer, count(*) AS n, avg(unit_price) AS avg_price \
                 FROM sales GROUP BY customer",
            ),
            (
                "filter + top 100",
                "SELECT * FROM sales WHERE returned AND quantity > 15 \
                 ORDER BY unit_price DESC LIMIT 100",
            ),
            ("all rows as a result", "SELECT * FROM sales"),
        ] {
            let t = Instant::now();
            let result = engine.sql_result(sql, &key).unwrap();
            let s = t.elapsed().as_secs_f64();
            let page = Instant::now();
            engine
                .fetch_rows(&result.id, 0, 500, &RequestKey::default())
                .unwrap();
            println!(
                "sql        {what:<32} {:>11} rows  {s:>6.2} s  first page {:.0} ms",
                result.row_count,
                page.elapsed().as_secs_f64() * 1000.0
            );
            bigview_lib::import::close_dataset(&engine, &result.id).unwrap();
        }
    }
}

/// Charts over the same 50M rows (budget: aggregation under 2 s).
#[test]
#[ignore = "needs generated fixtures; a minute or two"]
fn perf_charts_50m() {
    use bigview_lib::chart::{Agg, Bucket, ChartKind, ChartSpec, Measure};
    let Some((engine, ds, _tmp)) = setup() else {
        eprintln!("sales_50m.parquet not generated, skipping");
        return;
    };
    let m = |agg, column: Option<&str>| Measure {
        agg,
        column: column.map(String::from),
    };
    let c = |kind, x: &str| ChartSpec {
        kind,
        x: x.into(),
        bucket: None,
        measures: vec![],
        y: None,
        bins: None,
        limit: None,
        sample: None,
    };
    let filtered = quantity(FilterOp::Lte {
        value: Param::Int(5),
    });
    let cases: Vec<(&str, ViewSpec, ChartSpec)> = vec![
        (
            "bar country: count, sum",
            ViewSpec::default(),
            ChartSpec {
                measures: vec![m(Agg::Count, None), m(Agg::Sum, Some("unit_price"))],
                ..c(ChartKind::Bar, "country")
            },
        ),
        (
            "bar customer (100K groups), top 50",
            ViewSpec::default(),
            c(ChartKind::Bar, "customer"),
        ),
        (
            "bar country: distinct customers",
            ViewSpec::default(),
            ChartSpec {
                measures: vec![m(Agg::CountDistinct, Some("customer"))],
                ..c(ChartKind::Bar, "country")
            },
        ),
        (
            "line order_date by month: avg",
            ViewSpec::default(),
            ChartSpec {
                bucket: Some(Bucket::Month),
                measures: vec![m(Agg::Avg, Some("unit_price"))],
                ..c(ChartKind::Line, "order_date")
            },
        ),
        (
            "line order_ts by day: count",
            ViewSpec::default(),
            ChartSpec {
                bucket: Some(Bucket::Day),
                ..c(ChartKind::Line, "order_ts")
            },
        ),
        (
            "histogram unit_price",
            ViewSpec::default(),
            c(ChartKind::Histogram, "unit_price"),
        ),
        (
            "histogram order_ts",
            ViewSpec::default(),
            c(ChartKind::Histogram, "order_ts"),
        ),
        (
            "scatter unit_price x quantity",
            ViewSpec::default(),
            ChartSpec {
                y: Some("quantity".into()),
                ..c(ChartKind::Scatter, "unit_price")
            },
        ),
        (
            "bar country, quantity <= 5",
            filtered,
            c(ChartKind::Bar, "country"),
        ),
    ];
    for (what, view, chart) in cases {
        let t = Instant::now();
        let data = engine
            .chart_data(&ds.id, &view, &chart, &RequestKey::default())
            .unwrap();
        println!(
            "chart {what:<38} {:>6.2} s  points {:>6} of {:>10}",
            t.elapsed().as_secs_f64(),
            data.x.len().max(data.bins.len()),
            data.total
        );
    }
}

/// Data quality warnings over the same 50M rows (one scan of every column,
/// one for outliers, one for duplicate rows).
#[test]
#[ignore = "needs generated fixtures; a minute or two"]
fn perf_quality_50m() {
    let Some((engine, ds, _tmp)) = setup() else {
        eprintln!("sales_50m.parquet not generated, skipping");
        return;
    };
    for run in ["cold", "warm"] {
        let t = Instant::now();
        let report = engine.quality(&ds.id, &RequestKey::default()).unwrap();
        println!(
            "quality ({run}) {:>6.2} s  warnings {} of {} rows",
            t.elapsed().as_secs_f64(),
            report.warnings.len(),
            report.rows
        );
        for w in &report.warnings {
            println!("  {:?} {:?}: {}", w.kind, w.column, w.message);
        }
    }
}
