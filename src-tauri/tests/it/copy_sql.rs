//! "Copy as SQL": the standalone SQL of a view, run in a fresh plain DuckDB
//! over the file, returns exactly the rows the app shows for that view.

use std::collections::HashMap;
use std::path::PathBuf;

use arrow::array::{Array, AsArray};
use bigview_lib::engine::{Param, RequestKey};
use bigview_lib::sources::{OpenOptions, Source};
use bigview_lib::view::{self, Filter, FilterOp, Relation, SortKey, ViewSpec};

use crate::filters::{Fx, fx};

fn people_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/csv/people.csv")
}

/// Every value as text (NULL as None), computed by DuckDB on both sides.
type Rows = Vec<Vec<Option<String>>>;

fn as_text(sql: &str) -> String {
    format!(
        "SELECT CAST(COLUMNS(*) AS VARCHAR) FROM ({})",
        sql.trim_end_matches(';')
    )
}

/// The app's rows for `spec`: the view built over the imported table.
fn app_rows(fx: &Fx, spec: &ViewSpec) -> Rows {
    let schema = fx.engine.dataset_columns(&fx.dataset.id).unwrap();
    let built = view::build(spec, &Relation::of(&fx.dataset.source), &schema).unwrap();
    let out = fx
        .engine
        .query(
            &as_text(&built.select),
            &built.params,
            usize::MAX,
            &RequestKey::default(),
        )
        .unwrap();
    let mut rows = Vec::new();
    for b in &out.batches {
        for r in 0..b.num_rows() {
            rows.push(
                (0..b.num_columns())
                    .map(|c| {
                        let a = b.column(c).as_string::<i32>();
                        (!a.is_null(r)).then(|| a.value(r).to_string())
                    })
                    .collect(),
            );
        }
    }
    rows
}

/// Runs standalone SQL in a new in-memory DuckDB, as a user would.
fn plain_rows(sql: &str) -> (Vec<String>, Rows) {
    let conn = duckdb::Connection::open_in_memory().unwrap();
    let mut stmt = conn.prepare(&as_text(sql)).unwrap();
    let mut rows = Vec::new();
    let mut q = stmt.query([]).unwrap();
    while let Some(row) = q.next().unwrap() {
        let n = row.as_ref().column_count();
        rows.push(
            (0..n)
                .map(|i| row.get::<_, Option<String>>(i).unwrap())
                .collect(),
        );
    }
    drop(q);
    let names = stmt.column_names();
    (names, rows)
}

fn standalone(fx: &Fx, spec: &ViewSpec, labels: &HashMap<String, String>) -> String {
    let reader = Source::new(&people_path(), OpenOptions::default())
        .unwrap()
        .resolve_dialect(&fx.engine)
        .unwrap()
        .reader_display_sql()
        .unwrap();
    fx.engine
        .view_sql(&fx.dataset.id, spec, &reader, labels)
        .unwrap()
}

fn sort(column: &str, descending: bool) -> SortKey {
    SortKey {
        column: column.into(),
        descending,
    }
}

fn filter(column: &str, op: FilterOp, not: bool) -> Filter {
    Filter {
        column: column.into(),
        op,
        not,
    }
}

#[test]
fn copied_sql_reproduces_the_view() {
    let fx = fx();
    let specs = [
        ViewSpec::default(),
        ViewSpec {
            filters: vec![filter(
                "amount",
                FilterOp::Gt {
                    value: Param::Float(250.5),
                },
                false,
            )],
            ..ViewSpec::default()
        },
        // Sorted with many ties (city, active): file order breaks them.
        ViewSpec {
            sort: vec![sort("city", false), sort("active", true)],
            ..ViewSpec::default()
        },
        ViewSpec {
            filters: vec![
                filter(
                    "name",
                    FilterOp::Contains {
                        value: "o'n".into(),
                        case_sensitive: false,
                    },
                    true,
                ),
                filter(
                    "joined",
                    FilterOp::Range {
                        min: Some(Param::Text("2023-01-01".into())),
                        max: Some(Param::Text("2023-12-31".into())),
                    },
                    false,
                ),
                filter(
                    "city",
                    FilterOp::In {
                        values: vec![Param::Text("東京".into()), Param::Null],
                    },
                    false,
                ),
            ],
            search: Some("a".into()),
            sort: vec![sort("amount", true)],
            columns: Some(vec!["amount".into(), "name".into(), "id".into()]),
        },
        ViewSpec {
            filters: vec![filter(
                "name",
                FilterOp::Regex {
                    pattern: "^(Zoë|Søren) ".into(),
                },
                false,
            )],
            sort: vec![sort("joined", false)],
            ..ViewSpec::default()
        },
    ];
    for spec in &specs {
        let sql = standalone(&fx, spec, &HashMap::new());
        let (_, plain) = plain_rows(&sql);
        let app = app_rows(&fx, spec);
        assert!(!app.is_empty(), "spec matches no rows: {spec:?}");
        assert_eq!(plain, app, "rows differ for\n{sql}");
    }
}

#[test]
fn copied_sql_uses_display_names_and_reads_like_sql() {
    let fx = fx();
    let spec = ViewSpec {
        filters: vec![filter(
            "id",
            FilterOp::Lte {
                value: Param::Int(10),
            },
            false,
        )],
        sort: vec![sort("name", false)],
        columns: Some(vec!["name".into(), "id".into()]),
        ..ViewSpec::default()
    };
    let labels = HashMap::from([("name".to_string(), "Full \"name\"".to_string())]);
    let sql = standalone(&fx, &spec, &labels);
    let path = people_path().to_string_lossy().replace('\'', "''");
    assert_eq!(
        sql,
        format!(
            "SELECT \"name\" AS \"Full \"\"name\"\"\", \"id\"\n\
             FROM (SELECT *, row_number() OVER () AS \"bigview_row\" FROM {reader})\n\
             WHERE \"id\" <= 10\n\
             ORDER BY \"name\" ASC NULLS LAST, \"bigview_row\";",
            reader = Source::new(&people_path(), OpenOptions::default())
                .unwrap()
                .resolve_dialect(&fx.engine)
                .unwrap()
                .reader_display_sql()
                .unwrap()
        )
    );
    assert!(sql.contains(&path));
    let (names, rows) = plain_rows(&sql);
    assert_eq!(names, ["Full \"name\"", "id"]);
    assert_eq!(rows.len(), 10);
}
