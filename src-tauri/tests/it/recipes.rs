//! Cleaning recipes over people.csv, imported as the app does: each step's
//! output is checked against values computed here from the parsed CSV, and
//! the exported script gives the same rows in plain DuckDB.

use arrow::array::{Array, AsArray};
use dataliq_lib::cache::{Cache, CacheConfig};
use dataliq_lib::engine::{Dataset, Param, RequestKey};
use dataliq_lib::import::{self, ImportTarget, Imports};
use dataliq_lib::recipe::{
    Case, NewType, RecipeFile, RecipeOutcome, RecipeStep, Step, load_recipe, save_recipe,
};
use dataliq_lib::sources::{OpenOptions, Source};
use dataliq_lib::view::{Filter, FilterOp};

use crate::filters::{Fx, fx};

type Rows = Vec<Vec<Option<String>>>;

fn on(step: Step) -> RecipeStep {
    RecipeStep {
        step,
        enabled: true,
    }
}

fn apply(fx: &Fx, steps: &[RecipeStep]) -> RecipeOutcome {
    fx.engine
        .apply_recipe(&fx.dataset.id, steps, &RequestKey::default())
        .unwrap()
}

/// Every row of a dataset (in its order), every value as text.
fn rows(fx: &Fx, out: &RecipeOutcome) -> Rows {
    let cols = out
        .columns
        .iter()
        .map(|c| format!("CAST(\"{}\" AS VARCHAR)", c.name.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = match &out.dataset.source {
        dataliq_lib::engine::DatasetSource::Query { sql, .. } => sql.clone(),
        other => panic!("{other:?}"),
    };
    let q = fx
        .engine
        .query(
            &format!("SELECT {cols} FROM {sql}"),
            &[],
            usize::MAX,
            &RequestKey::default(),
        )
        .unwrap();
    let mut out = Vec::new();
    for b in &q.batches {
        for r in 0..b.num_rows() {
            out.push(
                (0..b.num_columns())
                    .map(|c| {
                        let a = b.column(c).as_string::<i32>();
                        (!a.is_null(r)).then(|| a.value(r).to_string())
                    })
                    .collect(),
            );
        }
    }
    out
}

fn names(out: &RecipeOutcome) -> Vec<&str> {
    out.columns.iter().map(|c| c.name.as_str()).collect()
}

fn col(out: &RecipeOutcome, name: &str) -> usize {
    out.columns.iter().position(|c| c.name == name).unwrap()
}

#[test]
fn column_steps_change_only_their_column() {
    let fx = fx();
    let out = apply(
        &fx,
        &[
            on(Step::Rename {
                column: "name".into(),
                to: "full name".into(),
            }),
            on(Step::Trim {
                column: "full name".into(),
            }),
            on(Step::ChangeCase {
                column: "full name".into(),
                case: Case::Upper,
            }),
            on(Step::Replace {
                column: "city".into(),
                find: "paris".into(),
                replace: "PARIS (FR)".into(),
                regex: false,
                case_sensitive: false,
            }),
            on(Step::FillEmpty {
                column: "amount".into(),
                value: "0".into(),
            }),
        ],
    );
    assert!(
        out.steps.iter().all(|s| s.error.is_none()),
        "{:?}",
        out.steps
    );
    assert_eq!(
        names(&out),
        ["id", "full name", "city", "amount", "joined", "active"]
    );
    let got = rows(&fx, &out);
    assert_eq!(got.len(), fx.people.len());
    assert_eq!(out.dataset.row_count, fx.people.len() as u64);
    for (r, p) in got.iter().zip(&fx.people) {
        assert_eq!(r[0], Some(p.id.to_string()));
        assert_eq!(
            r[1],
            p.name.as_ref().map(|n| n.trim().to_uppercase()),
            "{}",
            p.id
        );
        let city = p.city.as_ref().map(|c| {
            if c.eq_ignore_ascii_case("paris") {
                "PARIS (FR)".to_string()
            } else {
                c.clone()
            }
        });
        assert_eq!(r[2], city, "{}", p.id);
        let amount: f64 = r[3].as_ref().unwrap().parse().unwrap();
        assert_eq!(amount, p.amount.unwrap_or(0.0), "{}", p.id);
        assert_eq!(r[4], p.joined, "{}", p.id);
    }
}

#[test]
fn change_type_counts_what_fails_to_convert() {
    let fx = fx();
    let out = apply(
        &fx,
        &[
            // Text dates in another format, and numbers with every tenth bad.
            on(Step::Calculate {
                name: "day".into(),
                expression: "strftime(joined, '%d/%m/%Y')".into(),
            }),
            on(Step::Calculate {
                name: "code".into(),
                expression: "CASE WHEN id % 10 = 0 THEN 'n/a' ELSE CAST(id AS VARCHAR) END".into(),
            }),
            on(Step::ChangeType {
                column: "day".into(),
                to: NewType::Date,
                format: Some("%d/%m/%Y".into()),
            }),
            on(Step::ChangeType {
                column: "code".into(),
                to: NewType::Integer,
                format: None,
            }),
        ],
    );
    assert!(
        out.steps.iter().all(|s| s.error.is_none()),
        "{:?}",
        out.steps
    );
    assert_eq!(out.steps[2].failed, Some(0));
    let bad = fx.people.iter().filter(|p| p.id % 10 == 0).count() as u64;
    assert_eq!(out.steps[3].failed, Some(bad));
    let types: Vec<&str> = out.columns.iter().map(|c| c.r#type.as_str()).collect();
    assert_eq!(&types[6..], ["DATE", "BIGINT"]);
    let got = rows(&fx, &out);
    for (r, p) in got.iter().zip(&fx.people) {
        assert_eq!(r[6], p.joined, "{}", p.id);
        let want = (p.id % 10 != 0).then(|| p.id.to_string());
        assert_eq!(r[7], want, "{}", p.id);
    }
}

#[test]
fn split_title_case_and_regex() {
    let fx = fx();
    let out = apply(
        &fx,
        &[
            on(Step::ChangeCase {
                column: "name".into(),
                case: Case::Title,
            }),
            on(Step::Split {
                column: "name".into(),
                delimiter: " ".into(),
                into: vec!["first".into(), "last".into()],
                keep: true,
            }),
            on(Step::Replace {
                column: "last".into(),
                find: "^(.)(.*)$".into(),
                replace: "\\1.".into(),
                regex: true,
                case_sensitive: true,
            }),
        ],
    );
    assert!(
        out.steps.iter().all(|s| s.error.is_none()),
        "{:?}",
        out.steps
    );
    assert_eq!(
        names(&out),
        [
            "id", "name", "first", "last", "city", "amount", "joined", "active"
        ]
    );
    // Spreadsheet PROPER: the first letter of each run of letters.
    let title = |s: &str| {
        let mut out = String::new();
        let mut in_word = false;
        for c in s.chars() {
            if c.is_alphabetic() {
                if in_word {
                    out.extend(c.to_lowercase());
                } else {
                    out.extend(c.to_uppercase());
                }
                in_word = true;
            } else {
                out.push(c);
                in_word = false;
            }
        }
        out
    };
    for (r, p) in rows(&fx, &out).iter().zip(&fx.people) {
        let name = p.name.as_deref().map(title);
        assert_eq!(r[1], name, "{}", p.id);
        let parts: Vec<String> = name
            .as_deref()
            .map(|n| n.split(' ').map(String::from).collect())
            .unwrap_or_default();
        let part = |i: usize| parts.get(i).filter(|s| !s.is_empty()).cloned();
        assert_eq!(r[2], part(0), "{}", p.id);
        let initial = part(1).map(|l| format!("{}.", l.chars().next().unwrap()));
        assert_eq!(r[3], initial, "{}", p.id);
    }
}

#[test]
fn row_steps_keep_file_order() {
    let fx = fx();
    // Duplicates by city: the first row of each city, in file order.
    let out = apply(
        &fx,
        &[on(Step::RemoveDuplicates {
            columns: Some(vec!["city".into()]),
        })],
    );
    let mut seen = std::collections::HashSet::new();
    let want: Vec<String> = fx
        .people
        .iter()
        .filter(|p| seen.insert(p.city.clone()))
        .map(|p| p.id.to_string())
        .collect();
    let got: Vec<String> = rows(&fx, &out)
        .into_iter()
        .map(|r| r[0].clone().unwrap())
        .collect();
    assert_eq!(got, want);
    assert_eq!(out.dataset.row_count, want.len() as u64);

    // Rows matching a filter removed (rows where it can't tell stay).
    let out = apply(
        &fx,
        &[on(Step::RemoveRows {
            filter: Filter {
                column: "amount".into(),
                op: FilterOp::Lt {
                    value: Param::Float(500.0),
                },
                not: false,
            },
        })],
    );
    let want: Vec<String> = fx
        .people
        .iter()
        .filter(|p| !p.amount.is_some_and(|a| a < 500.0))
        .map(|p| p.id.to_string())
        .collect();
    let got: Vec<String> = rows(&fx, &out)
        .into_iter()
        .map(|r| r[0].clone().unwrap())
        .collect();
    assert_eq!(got, want);

    // Exact duplicates: none in the file; the original stays as it was.
    let out = apply(&fx, &[on(Step::RemoveDuplicates { columns: None })]);
    assert_eq!(out.dataset.row_count, fx.people.len() as u64);
    assert_eq!(fx.dataset.row_count, fx.people.len() as u64);
}

#[test]
fn disabled_and_failing_steps() {
    let fx = fx();
    let out = apply(
        &fx,
        &[
            RecipeStep {
                step: Step::Rename {
                    column: "id".into(),
                    to: "key".into(),
                },
                enabled: false,
            },
            on(Step::Calculate {
                name: "double".into(),
                expression: "amount * 2".into(),
            }),
            on(Step::Calculate {
                name: "oops".into(),
                expression: "no_such_column + 1".into(),
            }),
            on(Step::Trim {
                column: "city".into(),
            }),
        ],
    );
    assert!(out.steps[0].skipped);
    assert!(out.steps[1].error.is_none() && !out.steps[1].skipped);
    let err = out.steps[2].error.as_deref().unwrap();
    assert!(err.contains("no_such_column"), "{err}");
    assert!(out.steps[3].skipped);
    // The rows are those of the steps before the failing one.
    assert_eq!(
        names(&out),
        ["id", "name", "city", "amount", "joined", "active", "double"]
    );
    let got = rows(&fx, &out);
    let a = col(&out, "amount");
    for r in got.iter().filter(|r| r[a].is_some()) {
        let amount: f64 = r[a].as_ref().unwrap().parse().unwrap();
        let double: f64 = r[6].as_ref().unwrap().parse().unwrap();
        assert!((double - amount * 2.0).abs() < 1e-9);
    }
    // A fill value that isn't of the column's type.
    let out = apply(
        &fx,
        &[on(Step::FillEmpty {
            column: "amount".into(),
            value: "lots".into(),
        })],
    );
    assert!(
        out.steps[0]
            .error
            .as_deref()
            .unwrap()
            .contains("not a valid DOUBLE")
    );
}

#[test]
fn the_script_gives_the_same_rows_in_plain_duckdb() {
    let fx = fx();
    let steps = [
        on(Step::Trim {
            column: "name".into(),
        }),
        on(Step::Split {
            column: "name".into(),
            delimiter: " ".into(),
            into: vec!["first".into(), "last".into()],
            keep: false,
        }),
        on(Step::RemoveRows {
            filter: Filter {
                column: "city".into(),
                op: FilterOp::IsNull,
                not: false,
            },
        }),
        on(Step::RemoveDuplicates {
            columns: Some(vec!["last".into(), "city".into()]),
        }),
        on(Step::Calculate {
            name: "big".into(),
            expression: "amount > 500".into(),
        }),
    ];
    let app = apply(&fx, &steps);
    let path =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/csv/people.csv");
    let reader = Source::new(&path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(&fx.engine)
        .unwrap()
        .reader_display_sql()
        .unwrap();
    let script = fx
        .engine
        .recipe_script(&fx.dataset.id, &steps, &reader, &[])
        .unwrap();
    assert!(
        script.starts_with("WITH base AS (SELECT * FROM read_csv("),
        "{script}"
    );
    let conn = duckdb::Connection::open_in_memory().unwrap();
    let cols = app
        .columns
        .iter()
        .map(|c| format!("CAST(\"{}\" AS VARCHAR)", c.name))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {cols} FROM ({})",
            script.trim_end_matches(';')
        ))
        .unwrap();
    let mut plain: Rows = Vec::new();
    let mut q = stmt.query([]).unwrap();
    while let Some(r) = q.next().unwrap() {
        plain.push(
            (0..app.columns.len())
                .map(|i| r.get::<_, Option<String>>(i).unwrap())
                .collect(),
        );
    }
    let got = rows(&fx, &app);
    assert!(!got.is_empty());
    assert_eq!(plain, got, "{script}");
}

/// `rows` of people.csv (header kept) written as their own CSV, imported.
fn import_part(fx: &Fx, dir: &std::path::Path, keep: impl Fn(usize) -> bool) -> Dataset {
    let path =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/csv/people.csv");
    let text = std::fs::read_to_string(path).unwrap();
    let mut lines = text.lines();
    let mut out = format!("{}\n", lines.next().unwrap());
    for (i, l) in lines.enumerate() {
        if keep(i) {
            out.push_str(l);
            out.push('\n');
        }
    }
    let part = dir.join("people-part.csv");
    std::fs::write(&part, out).unwrap();
    let cache = Cache::new(CacheConfig {
        dir: dir.join("cache"),
        max_bytes: 1 << 30,
        enabled: true,
    })
    .unwrap();
    let source = Source::new(&part, OpenOptions::default())
        .unwrap()
        .resolve_dialect(&fx.engine)
        .unwrap();
    let target = ImportTarget {
        cache: &cache,
        temp_dir: dir.join("tmp"),
    };
    import::import(
        &fx.engine,
        &Imports::default(),
        &target,
        &source,
        "part",
        &|_| {},
    )
    .unwrap()
    .dataset
}

#[test]
fn a_saved_recipe_cleans_another_file_with_the_same_columns() {
    let fx = fx();
    let dir = tempfile::tempdir().unwrap();
    let steps = vec![
        on(Step::ChangeCase {
            column: "name".into(),
            case: Case::Upper,
        }),
        on(Step::RemoveRows {
            filter: Filter {
                column: "amount".into(),
                op: FilterOp::Lt {
                    value: Param::Float(0.0),
                },
                not: false,
            },
        }),
    ];
    let saved = dir.path().join("clean.json");
    save_recipe(
        &saved,
        &RecipeFile {
            format: String::new(),
            version: 0,
            source: Some("people.csv".into()),
            columns: fx.engine.dataset_columns(&fx.dataset.id).unwrap(),
            steps: steps.clone(),
        },
    )
    .unwrap();

    // The second half of the file, as another file.
    let other = import_part(&fx, dir.path(), |i| i >= 500);
    let loaded = load_recipe(&saved).unwrap();
    assert_eq!(loaded.steps, steps);
    assert_eq!(
        loaded.columns,
        fx.engine.dataset_columns(&other.id).unwrap(),
        "the same columns"
    );
    let out = fx
        .engine
        .apply_recipe(&other.id, &loaded.steps, &RequestKey::default())
        .unwrap();
    assert!(
        out.steps.iter().all(|s| s.error.is_none()),
        "{:?}",
        out.steps
    );
    let want: Vec<(String, Option<String>)> = fx.people[500..]
        .iter()
        .filter(|p| !p.amount.is_some_and(|a| a < 0.0))
        .map(|p| (p.id.to_string(), p.name.as_ref().map(|n| n.to_uppercase())))
        .collect();
    let got: Vec<(String, Option<String>)> = rows(&fx, &out)
        .into_iter()
        .map(|r| (r[0].clone().unwrap(), r[1].clone()))
        .collect();
    assert_eq!(got, want);
}

#[test]
fn the_script_explains_each_step() {
    let fx = fx();
    let steps = [
        on(Step::Trim {
            column: "name".into(),
        }),
        RecipeStep {
            step: Step::Trim {
                column: "city".into(),
            },
            enabled: false,
        },
        on(Step::Calculate {
            name: "double".into(),
            expression: "amount * 2".into(),
        }),
    ];
    let labels = [
        "Trim spaces in “name”".to_string(),
        "Trim spaces in “city”".to_string(),
        "New column “double” = amount * 2\n(evil -- */ comment)".to_string(),
    ];
    let path =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/csv/people.csv");
    let reader = Source::new(&path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(&fx.engine)
        .unwrap()
        .reader_display_sql()
        .unwrap();
    let script = fx
        .engine
        .recipe_script(&fx.dataset.id, &steps, &reader, &labels)
        .unwrap();
    assert!(
        script.contains("-- Trim spaces in “name”\nstep_1 AS ("),
        "{script}"
    );
    // A step that is off isn't in it; labels stay on one line.
    assert!(!script.contains("“city”"), "{script}");
    assert!(
        script.contains("-- New column “double” = amount * 2 (evil -- */ comment)\nstep_2 AS ("),
        "{script}"
    );
    // Still runs in plain DuckDB: the comments don't change the rows.
    let plain = fx
        .engine
        .recipe_script(&fx.dataset.id, &steps, &reader, &[])
        .unwrap();
    let conn = duckdb::Connection::open_in_memory().unwrap();
    let count = |sql: &str| -> i64 {
        conn.query_row(
            &format!("SELECT count(*) FROM ({})", sql.trim_end_matches(';')),
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(count(&script), count(&plain));
    assert_eq!(count(&script), fx.people.len() as i64);
}
