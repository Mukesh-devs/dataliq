//! Comparing two files: fixtures with known differences (duplicate keys,
//! a column that is a number in one file and text in the other), and
//! people.csv against an edited copy, with the expected differences worked
//! out here in Rust.

use std::path::{Path, PathBuf};

use arrow::array::{Array, AsArray};
use dataliq_lib::cache::{Cache, CacheConfig};
use dataliq_lib::compare::{CompareSpec, Comparison};
use dataliq_lib::engine::{Dataset, DatasetSource, Engine, EngineConfig, RequestKey};
use dataliq_lib::import::{self, ImportTarget, Imports};
use dataliq_lib::sources::{OpenOptions, Source};

use crate::filters::people;

struct Fx {
    engine: Engine,
    dir: tempfile::TempDir,
}

fn fx() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: dir.path().join("spill"),
        threads: Some(2),
    })
    .unwrap();
    Fx { engine, dir }
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures")
        .join(name)
}

impl Fx {
    /// A CSV imported into the cache, as the app does.
    fn import(&self, path: &Path) -> Dataset {
        let cache = Cache::new(CacheConfig {
            dir: self.dir.path().join("cache"),
            max_bytes: 1 << 30,
            enabled: true,
        })
        .unwrap();
        let source = Source::new(path, OpenOptions::default())
            .unwrap()
            .resolve_dialect(&self.engine)
            .unwrap();
        let target = ImportTarget {
            cache: &cache,
            temp_dir: self.dir.path().join("tmp"),
        };
        let job = path.file_name().unwrap().to_string_lossy().to_string();
        import::import(
            &self.engine,
            &Imports::default(),
            &target,
            &source,
            &job,
            &|_| {},
        )
        .unwrap()
        .dataset
    }

    fn reader(&self, path: &Path) -> String {
        Source::new(path, OpenOptions::default())
            .unwrap()
            .resolve_dialect(&self.engine)
            .unwrap()
            .reader_display_sql()
            .unwrap()
    }

    fn compare(&self, left: &Dataset, right: &Dataset, keys: &[&str]) -> Comparison {
        self.engine
            .compare(
                &left.id,
                &right.id,
                &CompareSpec {
                    keys: keys.iter().map(|k| k.to_string()).collect(),
                },
                &RequestKey::default(),
            )
            .unwrap()
    }

    /// Every row of a comparison's dataset, every value as text.
    fn rows(&self, c: &Comparison) -> Vec<Vec<Option<String>>> {
        let DatasetSource::Query { sql, .. } = &c.dataset.source else {
            panic!("{:?}", c.dataset.source)
        };
        self.text_rows(&format!("SELECT * FROM {sql}"), c)
    }

    fn text_rows(&self, sql: &str, c: &Comparison) -> Vec<Vec<Option<String>>> {
        let cols = c
            .columns
            .iter()
            .map(|m| format!("CAST(\"{}\" AS VARCHAR)", m.name.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");
        let q = self
            .engine
            .query(
                &format!("SELECT {cols} FROM ({sql})"),
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
                        .map(|i| {
                            let a = b.column(i).as_string::<i32>();
                            (!a.is_null(r)).then(|| a.value(r).to_string())
                        })
                        .collect(),
                );
            }
        }
        out
    }
}

fn s(v: &str) -> Option<String> {
    Some(v.to_string())
}

#[test]
fn known_differences_with_duplicate_keys_and_a_retyped_column() {
    let fx = fx();
    let v1 = fx.import(&fixture("compare/orders_v1.csv"));
    let v2 = fx.import(&fixture("compare/orders_v2.csv"));
    let c = fx.compare(&v1, &v2, &["id"]);
    assert_eq!(
        (c.added, c.removed, c.changed, c.same),
        (2, 1, 4, 2),
        "{c:?}"
    );
    assert_eq!((c.left_rows, c.right_rows), (7, 8));
    assert_eq!((c.duplicate_left, c.duplicate_right), (2, 3));
    assert_eq!(c.compared, ["name", "qty", "price", "note"]);
    assert_eq!(c.retyped.len(), 1);
    assert_eq!(c.retyped[0].name, "qty");
    assert_eq!(
        (c.retyped[0].left.as_str(), c.retyped[0].right.as_str()),
        ("BIGINT", "VARCHAR")
    );
    let changes: Vec<(&str, u64)> = c
        .changes
        .iter()
        .map(|x| (x.name.as_str(), x.rows))
        .collect();
    assert_eq!(changes, [("qty", 1), ("price", 1), ("note", 2)]);
    let names: Vec<&str> = c.columns.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "status",
            "id",
            "changed",
            "name",
            "qty",
            "qty (before)",
            "price",
            "price (before)",
            "note",
            "note (before)"
        ]
    );
    // In v1's order, then v2's added rows; old values only where they changed.
    let n = None;
    assert_eq!(
        fx.rows(&c),
        vec![
            vec![
                s("changed"),
                s("2"),
                s("price"),
                s("Banana"),
                s("12"),
                n.clone(),
                s("0.3"),
                s("0.25"),
                s("ripe"),
                n.clone()
            ],
            vec![
                s("changed"),
                s("3"),
                s("qty"),
                s("Cherry"),
                s("n/a"),
                s("100"),
                s("0.1"),
                n.clone(),
                n.clone(),
                n.clone()
            ],
            vec![
                s("removed"),
                s("4"),
                n.clone(),
                s("Date"),
                s("7"),
                n.clone(),
                s("2.0"),
                n.clone(),
                s("dry"),
                n.clone()
            ],
            vec![
                s("changed"),
                s("5"),
                s("note"),
                s("Elder"),
                s("2"),
                n.clone(),
                s("9.99"),
                n.clone(),
                s("updated"),
                s("dup")
            ],
            vec![
                s("changed"),
                s("6"),
                s("note"),
                s("Fig"),
                s("4"),
                n.clone(),
                s("3.2"),
                n.clone(),
                s("new note"),
                n.clone()
            ],
            vec![
                s("added"),
                s("5"),
                n.clone(),
                s("Elder"),
                s("3"),
                n.clone(),
                s("9.99"),
                n.clone(),
                n.clone(),
                n.clone()
            ],
            vec![
                s("added"),
                s("7"),
                n.clone(),
                s("Grape"),
                s("10"),
                n.clone(),
                s("4.0"),
                n.clone(),
                n.clone(),
                n.clone()
            ],
        ]
    );
    assert_eq!(c.dataset.row_count, 7);

    // Nothing differs from itself.
    let same = fx.compare(&v1, &v1, &["id"]);
    assert_eq!(
        (same.added, same.removed, same.changed, same.same),
        (0, 0, 0, 7)
    );
    assert!(fx.rows(&same).is_empty());
}

#[test]
fn keys_must_exist_on_both_sides() {
    let fx = fx();
    let v1 = fx.import(&fixture("compare/orders_v1.csv"));
    let people = fx.import(&fixture("csv/people.csv"));
    let spec = |keys: &[&str]| CompareSpec {
        keys: keys.iter().map(|k| k.to_string()).collect(),
    };
    let err = |keys: &[&str]| {
        fx.engine
            .compare(&v1.id, &people.id, &spec(keys), &RequestKey::default())
            .unwrap_err()
            .to_string()
    };
    assert!(err(&[]).contains("at least one key"));
    assert!(err(&["qty"]).contains("Both files need the key column \"qty\""));
    // Two files with only `id` and `name` in common: still comparable.
    let c = fx.compare(&v1, &people, &["id", "name"]);
    assert_eq!(c.compared, Vec::<String>::new());
    assert_eq!(c.only_left, ["qty", "price", "note"]);
    assert_eq!(c.only_right, ["city", "amount", "joined", "active"]);
}

#[test]
fn people_against_an_edited_copy() {
    let fx = fx();
    let rows = people();
    let text = std::fs::read_to_string(fixture("csv/people.csv")).unwrap();
    let mut lines = text.lines();
    let header = lines.next().unwrap();
    // Every 50th row removed, every 7th row's amount raised by 1, two rows added.
    let mut edited = format!("{header}\n");
    let (mut removed, mut changed) = (Vec::new(), Vec::new());
    for (line, p) in lines.zip(&rows) {
        if p.id % 50 == 0 {
            removed.push(p.id);
            continue;
        }
        let mut f: Vec<String> = line.split(',').map(String::from).collect();
        if let Some(amount) = p.amount.filter(|_| p.id % 7 == 0) {
            f[3] = format!("{:.2}", amount + 1.0);
            changed.push(p.id);
        }
        edited.push_str(&f.join(","));
        edited.push('\n');
    }
    edited.push_str("5001,New One,Paris,1.00,2024-01-01,true\n");
    edited.push_str("5002,New Two,,2.00,2024-01-02,false\n");
    let path = fx.dir.path().join("people-edited.csv");
    std::fs::write(&path, edited).unwrap();

    let left = fx.import(&fixture("csv/people.csv"));
    let right = fx.import(&path);
    let c = fx.compare(&left, &right, &["id"]);
    assert_eq!(c.added, 2);
    assert_eq!(c.removed, removed.len() as u64);
    assert_eq!(c.changed, changed.len() as u64);
    assert_eq!(
        c.same,
        rows.len() as u64 - removed.len() as u64 - changed.len() as u64
    );
    let changes: Vec<(&str, u64)> = c
        .changes
        .iter()
        .map(|x| (x.name.as_str(), x.rows))
        .collect();
    assert_eq!(changes, [("amount", changed.len() as u64)]);

    let got = fx.rows(&c);
    let id = |r: &Vec<Option<String>>| r[1].clone().unwrap().parse::<i64>().unwrap();
    let of = |status: &str| -> Vec<i64> {
        got.iter()
            .filter(|r| r[0].as_deref() == Some(status))
            .map(id)
            .collect()
    };
    assert_eq!(of("removed"), removed);
    assert_eq!(of("changed"), changed);
    assert_eq!(of("added"), [5001, 5002]);
    // Each changed row: the new amount, and the old one beside it.
    let at = |name: &str| c.columns.iter().position(|m| m.name == name).unwrap();
    for r in got.iter().filter(|r| r[0].as_deref() == Some("changed")) {
        let p = rows.iter().find(|p| p.id == id(r)).unwrap();
        let new: f64 = r[at("amount")].as_ref().unwrap().parse().unwrap();
        let old: f64 = r[at("amount (before)")].as_ref().unwrap().parse().unwrap();
        assert!((old - p.amount.unwrap()).abs() < 1e-9);
        assert!(
            (new - (p.amount.unwrap() + 1.0)).abs() < 0.006,
            "{new} {old}"
        );
        assert_eq!(r[at("changed")].as_deref(), Some("amount"));
    }

    // The standalone SQL over the two files gives the same rows in plain DuckDB.
    let sql = fx
        .engine
        .compare_sql(
            &left.id,
            &right.id,
            &CompareSpec {
                keys: vec!["id".into()],
            },
            &fx.reader(&fixture("csv/people.csv")),
            &fx.reader(&path),
        )
        .unwrap();
    let conn = duckdb::Connection::open_in_memory().unwrap();
    let cols = c
        .columns
        .iter()
        .map(|m| format!("CAST(\"{}\" AS VARCHAR)", m.name))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {cols} FROM ({})",
            sql.trim_end_matches(';')
        ))
        .unwrap();
    let mut plain = Vec::new();
    let mut q = stmt.query([]).unwrap();
    while let Some(r) = q.next().unwrap() {
        plain.push(
            (0..c.columns.len())
                .map(|i| r.get::<_, Option<String>>(i).unwrap())
                .collect::<Vec<_>>(),
        );
    }
    assert_eq!(plain, got, "{sql}");
}
