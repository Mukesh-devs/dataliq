//! Export round trips: a filtered, sorted view with hidden, reordered and
//! renamed columns is written in every format, opened again the way the app
//! opens files, and compared row by row with rows computed in Rust from the
//! fixture.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use bigview_lib::cache::{Cache, CacheConfig};
use bigview_lib::engine::{Dataset, DatasetSource, Engine, Param};
use bigview_lib::error::AppError;
use bigview_lib::export::{self, ExportFormat, ExportOptions, ExportRequest, Exports};
use bigview_lib::import::{self, ImportTarget, Imports};
use bigview_lib::sources::{OpenOptions, Source};
use bigview_lib::view::{self, Filter, FilterOp, Relation, SortKey, ViewSpec};

use crate::filters::{Fx, Person, fx};

const FORMATS: [ExportFormat; 7] = [
    ExportFormat::Csv,
    ExportFormat::CsvGz,
    ExportFormat::Tsv,
    ExportFormat::Parquet,
    ExportFormat::Json,
    ExportFormat::Ndjson,
    ExportFormat::Xlsx,
];

/// Amount over 500, highest first; city hidden; name shown as "Full name".
fn spec() -> ViewSpec {
    ViewSpec {
        filters: vec![Filter {
            column: "amount".into(),
            op: FilterOp::Gt {
                value: Param::Float(500.0),
            },
            not: false,
        }],
        sort: vec![
            SortKey {
                column: "amount".into(),
                descending: true,
            },
            SortKey {
                column: "id".into(),
                descending: false,
            },
        ],
        search: None,
        columns: Some(
            ["joined", "name", "id", "amount", "active"]
                .map(String::from)
                .into(),
        ),
    }
}

fn request(fx: &Fx, path: PathBuf, format: ExportFormat, options: ExportOptions) -> ExportRequest {
    ExportRequest {
        dataset_id: fx.dataset.id.clone(),
        spec: spec(),
        labels: HashMap::from([("name".to_string(), "Full name".to_string())]),
        path,
        format,
        options,
        total_rows: None,
    }
}

/// One row as the comparison sees it.
type Row = (Option<String>, Option<String>, i64, f64, Option<bool>);

fn expected(people: &[Person]) -> Vec<Row> {
    let mut rows: Vec<&Person> = people
        .iter()
        .filter(|p| p.amount.is_some_and(|a| a > 500.0))
        .collect();
    rows.sort_by(|a, b| {
        b.amount
            .partial_cmp(&a.amount)
            .unwrap()
            .then(a.id.cmp(&b.id))
    });
    rows.iter()
        .map(|p| {
            (
                p.joined.clone(),
                p.name.clone(),
                p.id,
                p.amount.unwrap(),
                p.active,
            )
        })
        .collect()
}

/// Opens an exported file as the app does (an import into a cache).
fn reopen(engine: &Engine, dir: &Path, path: &Path) -> Dataset {
    let cache = Cache::new(CacheConfig {
        dir: dir.join("cache"),
        max_bytes: 1 << 30,
        enabled: true,
    })
    .unwrap();
    let target = ImportTarget {
        cache: &cache,
        temp_dir: dir.join("tmp"),
    };
    let source = Source::new(path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(engine)
        .unwrap();
    import::import(engine, &Imports::default(), &target, &source, "re", &|_| {})
        .unwrap()
        .dataset
}

/// The column names and rows of a dataset, in file order.
fn read_back(engine: &Engine, ds: &Dataset) -> (Vec<String>, Vec<Row>) {
    let schema = engine.dataset_columns(&ds.id).unwrap();
    let names: Vec<String> = schema.iter().map(|c| c.name.clone()).collect();
    let all = view::build(&ViewSpec::default(), &Relation::of(&ds.source), &schema).unwrap();
    let sql = &all.select;
    let conn = engine.connection().unwrap();
    let q = |c: &str| format!("\"{}\"", c.replace('"', "\"\""));
    let mut stmt = conn
        .prepare(&format!(
            "SELECT CAST({} AS DATE)::VARCHAR, CAST({} AS VARCHAR), CAST({} AS BIGINT), \
             CAST({} AS DOUBLE), CAST({} AS BOOLEAN) FROM ({sql})",
            q(&names[0]),
            q(&names[1]),
            q(&names[2]),
            q(&names[3]),
            q(&names[4]),
        ))
        .unwrap();
    let rows = stmt
        .query_map(duckdb::params_from_iter(all.params.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .collect::<Result<Vec<Row>, _>>()
        .unwrap();
    assert_eq!(rows.len() as u64, ds.row_count);
    (names, rows)
}

#[test]
fn every_format_round_trips_the_view() {
    let fx = fx();
    let want = expected(&fx.people);
    assert!(want.len() > 100 && want.len() < 1000, "{}", want.len());
    assert!(
        want.iter().any(|r| r.1.as_deref() == Some("")),
        "an empty name is exported"
    );
    let exports = Exports::default();
    for format in FORMATS {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(format!("out.{}", format.extension()));
        let req = request(&fx, path.clone(), format, ExportOptions::default());
        let out = export::export(&fx.engine, &exports, &req, "job", &|_| {}).unwrap();
        assert_eq!(out.rows, want.len() as u64, "{format:?}");
        assert!(
            path.exists()
                && !tmp
                    .path()
                    .join(format!("out.{}.partial", format.extension()))
                    .exists()
        );

        let ds = reopen(&fx.engine, tmp.path(), &path);
        let (names, got) = read_back(&fx.engine, &ds);
        assert_eq!(
            names,
            ["joined", "Full name", "id", "amount", "active"],
            "{format:?}"
        );
        let mut want = want.clone();
        if format == ExportFormat::Xlsx {
            // An empty string is an empty Excel cell, which reads back as NULL.
            for r in &mut want {
                r.1 = r.1.take().filter(|s| !s.is_empty());
            }
        }
        assert_eq!(got, want, "{format:?}");
    }
}

#[test]
fn selected_rows_and_csv_options() {
    let fx = fx();
    let want = expected(&fx.people);
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("some.csv");
    let options = ExportOptions {
        header: Some(false),
        delimiter: Some(";".into()),
        quote_all: true,
        date_format: Some("%d/%m/%Y".into()),
        rows: Some(vec![[10, 12], [0, 2]]),
        ..Default::default()
    };
    let req = request(&fx, path.clone(), ExportFormat::Csv, options);
    let out = export::export(&fx.engine, &Exports::default(), &req, "job", &|_| {}).unwrap();
    assert_eq!(out.rows, 4);
    let text = std::fs::read_to_string(&path).unwrap();
    // View order, whatever order the ranges were given in.
    let lines: Vec<String> = [0, 1, 10, 11]
        .iter()
        .map(|&i| {
            let r = &want[i];
            let joined = r.0.as_deref().map(|d| {
                let p: Vec<&str> = d.split('-').collect();
                format!("{}/{}/{}", p[2], p[1], p[0])
            });
            let q = |s: Option<String>| s.map(|s| format!("\"{s}\"")).unwrap_or_default();
            [
                q(joined),
                q(r.1.clone()),
                q(Some(r.2.to_string())),
                q(Some(r.3.to_string())),
                q(r.4.map(|b| b.to_string())),
            ]
            .join(";")
        })
        .collect();
    assert_eq!(text.lines().collect::<Vec<_>>(), lines);
}

#[test]
fn a_cancelled_export_leaves_no_file() {
    let fx = fx();
    let engine = &fx.engine;
    // Read lazily, so the export starts at once and runs for a while.
    let big = Dataset {
        id: "big".into(),
        source: DatasetSource::Query {
            sql: "(SELECT i, md5(i::VARCHAR) AS h FROM range(30000000) t(i))".into(),
            params: vec![],
        },
        row_count: 30_000_000,
        cached: false,
    };
    engine.datasets.insert(big.clone());
    let exports = Exports::default();
    for format in [ExportFormat::Csv, ExportFormat::Xlsx] {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(format!("big.{}", format.extension()));
        let req = ExportRequest {
            dataset_id: big.id.clone(),
            spec: ViewSpec::default(),
            labels: HashMap::new(),
            path: path.clone(),
            format,
            options: ExportOptions::default(),
            total_rows: Some(big.row_count),
        };
        let result = std::thread::scope(|s| {
            let job = s.spawn(|| export::export(engine, &exports, &req, "big", &|_| {}));
            // Cancel once the job is running.
            while !exports.cancel("big") {
                assert!(
                    !job.is_finished(),
                    "{format:?} finished before it was cancelled"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            job.join().unwrap()
        });
        assert!(
            matches!(result, Err(AppError::Cancelled)),
            "{format:?}: {result:?}"
        );
        assert_eq!(
            std::fs::read_dir(tmp.path()).unwrap().count(),
            0,
            "{format:?}"
        );
    }
}

#[test]
fn a_missing_folder_is_reported_in_words() {
    let fx = fx();
    let req = request(
        &fx,
        PathBuf::from("/no/such/folder/out.csv"),
        ExportFormat::Csv,
        ExportOptions::default(),
    );
    let err = export::export(&fx.engine, &Exports::default(), &req, "job", &|_| {}).unwrap_err();
    assert!(err.to_string().contains("does not exist"), "{err}");
}

/// The rows at `positions` of a view, as the grid pages them.
fn grid_rows(engine: &Engine, view_id: &str, positions: &[u64]) -> Vec<(i64, i64)> {
    positions
        .iter()
        .map(|&p| {
            let bytes = engine
                .fetch_rows(view_id, p, 1, &bigview_lib::engine::RequestKey::default())
                .unwrap();
            let batch =
                arrow::ipc::reader::StreamReader::try_new(std::io::Cursor::new(bytes), None)
                    .unwrap()
                    .next()
                    .unwrap()
                    .unwrap();
            let col = |i: usize| {
                arrow::array::AsArray::as_primitive::<arrow::datatypes::Int64Type>(batch.column(i))
                    .value(0)
            };
            (col(0), col(1))
        })
        .collect()
}

#[test]
fn selected_rows_are_the_rows_the_grid_shows() {
    let fx = fx();
    let engine = &fx.engine;
    let ds = engine
        .sql_result(
            "SELECT i, i % 7 AS k FROM range(300000) t(i)",
            &bigview_lib::engine::RequestKey::default(),
        )
        .unwrap();
    let k = |op| Filter {
        column: "k".into(),
        op,
        not: false,
    };
    let views = [
        // Unsorted, filtered: paged through its query.
        ViewSpec {
            filters: vec![k(FilterOp::Equals {
                value: Param::Int(3),
            })],
            ..Default::default()
        },
        // Sorted with many ties (broken by file order).
        ViewSpec {
            filters: vec![k(FilterOp::Gt {
                value: Param::Int(0),
            })],
            sort: vec![SortKey {
                column: "k".into(),
                descending: true,
            }],
            ..Default::default()
        },
    ];
    for spec in views {
        let view = engine
            .open_view(&ds.id, &spec, &bigview_lib::engine::RequestKey::default())
            .unwrap();
        engine.materialize_view(&view.dataset.id).unwrap();
        let ranges = vec![[40_000, 40_003], [7, 9], [30_001, 30_002]];
        let positions = [7, 8, 30_001, 40_000, 40_001, 40_002];
        let want = grid_rows(engine, &view.dataset.id, &positions);

        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("rows.csv");
        let req = ExportRequest {
            dataset_id: ds.id.clone(),
            spec: spec.clone(),
            labels: HashMap::new(),
            path: path.clone(),
            format: ExportFormat::Csv,
            options: ExportOptions {
                header: Some(false),
                rows: Some(ranges),
                ..Default::default()
            },
            total_rows: None,
        };
        export::export(engine, &Exports::default(), &req, "job", &|_| {}).unwrap();
        let got: Vec<(i64, i64)> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|l| {
                let (a, b) = l.split_once(',').unwrap();
                (a.parse().unwrap(), b.parse().unwrap())
            })
            .collect();
        assert_eq!(got, want, "{spec:?}");
    }
}
