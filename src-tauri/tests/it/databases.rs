//! SQLite and DuckDB files: attached read-only, their tables listed and
//! one shown at a time; DuckDB tables queried in place, SQLite tables
//! imported (and cached), the reader SQL running in plain DuckDB.
//!
//! The databases are made here: DuckDB files with the duckdb crate, SQLite
//! files through DuckDB's sqlite extension (installed into
//! `target/duckdb-extensions` the first time, as for httpfs).

use std::path::{Path, PathBuf};

use arrow::array::{Array, AsArray};
use dataliq_lib::cache::{Cache, CacheConfig};
use dataliq_lib::engine::{Dataset, Engine, EngineConfig, RequestKey};
use dataliq_lib::import::{self, ImportTarget, Imports};
use dataliq_lib::sources::{DatabaseOptions, FileFormat, OpenOptions, Source};
use dataliq_lib::view::Relation;

fn extension_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/duckdb-extensions")
}

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
    engine.set_extension_dir(&extension_dir());
    Fx { engine, dir }
}

/// A DuckDB file: two tables, a view, and a table in another schema.
fn make_duckdb(path: &Path) {
    let conn = duckdb::Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE orders AS SELECT range AS id, 'c' || (range % 7) AS customer, \
             range * 1.5 AS amount FROM range(1000);
         CREATE TABLE customers (id INTEGER, name VARCHAR);
         INSERT INTO customers VALUES (1, 'Ann'), (2, 'Bob');
         CREATE VIEW big_orders AS SELECT * FROM orders WHERE amount > 1000;
         CREATE SCHEMA archive;
         CREATE TABLE archive.orders_2023 AS SELECT * FROM orders LIMIT 10;",
    )
    .unwrap();
}

/// A SQLite file written through DuckDB's sqlite extension, on an engine
/// of its own (which installs the extension one test at a time).
fn make_sqlite(path: &Path, sql: &str) {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: dir.path().join("spill"),
        threads: Some(1),
    })
    .unwrap();
    engine.set_extension_dir(&extension_dir());
    engine
        .load_extension("sqlite", "Writing SQLite files")
        .unwrap();
    engine
        .execute_batch(&format!(
            "ATTACH '{}' AS s (TYPE sqlite); USE s; {sql} USE memory; DETACH s;",
            path.display()
        ))
        .unwrap();
}

impl Fx {
    fn open(&self, path: &Path, table: Option<(&str, &str)>) -> dataliq_lib::error::Result<Source> {
        let options = OpenOptions {
            database: DatabaseOptions {
                schema: table.map(|t| t.0.to_string()),
                table: table.map(|t| t.1.to_string()),
            },
            ..OpenOptions::default()
        };
        Source::new(path, options)?.resolve_dialect(&self.engine)
    }

    fn cache(&self) -> Cache {
        Cache::new(CacheConfig {
            dir: self.dir.path().join("cache"),
            max_bytes: 1 << 30,
            enabled: true,
        })
        .unwrap()
    }

    fn import(&self, cache: &Cache, source: &Source) -> (Dataset, bool) {
        let target = ImportTarget {
            cache,
            temp_dir: self.dir.path().join("tmp"),
        };
        let out = import::import(
            &self.engine,
            &Imports::default(),
            &target,
            source,
            "j",
            &|_| {},
        )
        .unwrap();
        (out.dataset, out.from_cache)
    }

    /// One column of a query, as text.
    fn texts(&self, sql: &str) -> Vec<Option<String>> {
        let q = self
            .engine
            .query(
                &format!("SELECT CAST(v AS VARCHAR) FROM ({sql}) t(v)"),
                &[],
                usize::MAX,
                &RequestKey::default(),
            )
            .unwrap();
        let mut out = Vec::new();
        for b in &q.batches {
            let a = b.column(0).as_string::<i32>();
            for r in 0..b.num_rows() {
                out.push((!a.is_null(r)).then(|| a.value(r).to_string()));
            }
        }
        out
    }

    fn count(&self, ds: &Dataset) -> String {
        let rel = Relation::of(&ds.source);
        let from = dataliq_lib::sources::inline_params(&rel.sql, &rel.params);
        self.texts(&format!("SELECT count(*) FROM {from}"))[0]
            .clone()
            .unwrap()
    }
}

fn s(v: &str) -> Option<String> {
    Some(v.to_string())
}

#[test]
fn a_duckdb_file_lists_its_tables_and_is_queried_in_place() {
    let fx = fx();
    let path = fx.dir.path().join("Shop Data.duckdb");
    make_duckdb(&path);

    let source = fx.open(&path, None).unwrap();
    assert_eq!(source.detected.format, FileFormat::Duckdb);
    assert!(source.is_queried_in_place());
    let info = source.inspect(&fx.engine).unwrap();
    let db = info.database.as_ref().unwrap();
    assert_eq!(db.alias, "shop_data");
    let listed: Vec<(String, String, String, Option<u64>)> = db
        .tables
        .iter()
        .map(|t| (t.schema.clone(), t.name.clone(), t.kind.clone(), t.rows))
        .collect();
    assert_eq!(
        listed,
        [
            ("main".into(), "customers".into(), "table".into(), Some(2)),
            ("main".into(), "orders".into(), "table".into(), Some(1000)),
            ("main".into(), "big_orders".into(), "view".into(), None),
            (
                "archive".into(),
                "orders_2023".into(),
                "table".into(),
                Some(10)
            ),
        ]
    );
    // The first table is shown.
    assert_eq!(
        (db.schema.as_str(), db.table.as_str()),
        ("main", "customers")
    );
    let names: Vec<&str> = info.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["id", "name"]);
    assert_eq!(info.reader_sql, "\"shop_data\".\"main\".\"customers\"");

    // Another table, a view and another schema, in place.
    let orders = fx.open(&path, Some(("main", "orders"))).unwrap();
    let ds = import::open_in_place(&fx.engine, &orders).unwrap();
    assert_eq!(ds.row_count, 1000);
    assert!(
        fx.engine
            .fetch_rows(&ds.id, 990, 10, &RequestKey::default())
            .is_ok()
    );
    let view = fx.open(&path, Some(("main", "big_orders"))).unwrap();
    let ds = import::open_in_place(&fx.engine, &view).unwrap();
    assert_eq!(fx.count(&ds), "333");
    let old = fx.open(&path, Some(("archive", "orders_2023"))).unwrap();
    assert_eq!(
        import::open_in_place(&fx.engine, &old).unwrap().row_count,
        10
    );

    // Attached once, under its name: the SQL panel can use it.
    assert_eq!(
        fx.texts("SELECT name FROM shop_data.customers ORDER BY id"),
        [s("Ann"), s("Bob")]
    );
    assert_eq!(
        fx.texts("SELECT count(*) FROM duckdb_databases() WHERE database_name LIKE 'shop_data%'"),
        [s("1")]
    );
    // Read-only.
    let write = fx
        .engine
        .execute_batch("INSERT INTO shop_data.customers VALUES (3, 'x')");
    assert!(write.is_err());

    let err = fx
        .open(&path, Some(("main", "nothing")))
        .unwrap_err()
        .to_string();
    assert!(err.contains("no table called \"nothing\""), "{err}");
}

#[test]
fn a_sqlite_file_is_imported_and_cached() {
    let fx = fx();
    let path = fx.dir.path().join("shop.sqlite");
    make_sqlite(
        &path,
        "CREATE TABLE orders (id INTEGER, customer TEXT, amount REAL, placed DATE);
         INSERT INTO orders VALUES (1, 'Ann', 10.5, '2024-01-02'), (2, 'Bob', NULL, '2024-02-03');
         CREATE TABLE notes (body TEXT);
         CREATE VIEW paid AS SELECT * FROM orders WHERE amount IS NOT NULL;",
    );

    let source = fx.open(&path, None).unwrap();
    assert_eq!(source.detected.format, FileFormat::Sqlite);
    assert!(!source.is_queried_in_place());
    let info = source.inspect(&fx.engine).unwrap();
    let db = info.database.as_ref().unwrap();
    let names: Vec<&str> = db.tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["notes", "orders", "paid"]);
    assert!(db.tables.iter().all(|t| t.rows.is_none()));
    assert_eq!(db.table, "notes");

    let orders = fx.open(&path, Some(("main", "orders"))).unwrap();
    let info = orders.inspect(&fx.engine).unwrap();
    let cols: Vec<(&str, &str)> = info
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.r#type.as_str()))
        .collect();
    assert_eq!(
        cols,
        [
            ("id", "BIGINT"),
            ("customer", "VARCHAR"),
            ("amount", "DOUBLE"),
            // SQLite has no date type: dates are text (Clean can change it).
            ("placed", "VARCHAR"),
        ]
    );
    assert!(
        !orders
            .preview_ipc(&fx.engine, 10, &RequestKey::default())
            .unwrap()
            .is_empty()
    );
    let cache = fx.cache();
    let (ds, cached) = fx.import(&cache, &orders);
    assert!(!cached);
    assert_eq!(ds.row_count, 2);
    let (again, cached) = fx.import(&cache, &orders);
    assert!(cached);
    assert_eq!(again.id, ds.id);
    // Each table is its own cache entry.
    let (paid, cached) = fx.import(&cache, &fx.open(&path, Some(("main", "paid"))).unwrap());
    assert!(!cached);
    assert_eq!(paid.row_count, 1);

    // "Copy as SQL" runs in plain DuckDB with the sqlite extension.
    assert!(
        info.reader_sql.starts_with("sqlite_scan("),
        "{}",
        info.reader_sql
    );
    let plain = duckdb::Connection::open_in_memory().unwrap();
    plain
        .execute_batch(&format!(
            "SET extension_directory = '{}'; LOAD sqlite;",
            extension_dir().display()
        ))
        .unwrap();
    let n: i64 = plain
        .query_row(
            &format!("SELECT count(*) FROM {}", info.reader_sql),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 2);
}

#[test]
fn a_changed_sqlite_file_is_read_again() {
    let fx = fx();
    let path = fx.dir.path().join("log.db");
    make_sqlite(
        &path,
        "CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1);",
    );
    let cache = fx.cache();
    let (first, _) = fx.import(&cache, &fx.open(&path, None).unwrap());
    assert_eq!(first.row_count, 1);
    std::thread::sleep(std::time::Duration::from_millis(20));
    make_sqlite(&path, "INSERT INTO t VALUES (2), (3);");
    let (second, cached) = fx.import(&cache, &fx.open(&path, None).unwrap());
    assert!(!cached);
    assert_ne!(second.id, first.id);
    assert_eq!(second.row_count, 3);
}

#[test]
fn an_empty_database_or_one_from_a_url_is_said_in_words() {
    let fx = fx();
    let path = fx.dir.path().join("empty.duckdb");
    duckdb::Connection::open(&path)
        .unwrap()
        .execute_batch("CHECKPOINT")
        .unwrap();
    let err = fx.open(&path, None).unwrap_err().to_string();
    assert!(err.contains("This database has no tables."), "{err}");
    let err = Source::new(
        Path::new("https://example.com/shop.sqlite"),
        OpenOptions::default(),
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("Databases can't be read from a URL"), "{err}");
}
