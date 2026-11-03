//! Live databases against real servers. Each needs its connection in
//! `DATALIQ_TEST_POSTGRES` / `DATALIQ_TEST_MYSQL` as
//! `host:port:database:user:password`, a `calls` table of 500 rows (id,
//! account, minutes, started) and a view named `totals`, and the internet
//! once for DuckDB's extension.
//! Run: `cargo test -p dataliq --test it live_ -- --ignored`.

use dataliq_lib::connect::{DbConnection, Driver};
use dataliq_lib::engine::RequestKey;

fn server(var: &str, driver: Driver) -> Option<(DbConnection, String)> {
    let v = std::env::var(var).ok()?;
    let mut p = v.splitn(5, ':');
    let (host, port, database, user, password) =
        (p.next()?, p.next()?, p.next()?, p.next()?, p.next()?);
    Some((
        DbConnection {
            name: "cdr".into(),
            driver,
            host: host.into(),
            port: port.parse().ok()?,
            database: database.into(),
            user: user.into(),
        },
        password.into(),
    ))
}

#[test]
#[ignore = "needs a PostgreSQL server in DATALIQ_TEST_POSTGRES"]
fn live_postgres_is_queried_read_only() {
    let Some((conn, password)) = server("DATALIQ_TEST_POSTGRES", Driver::Postgres) else {
        panic!("set DATALIQ_TEST_POSTGRES=host:port:database:user:password");
    };
    check_live(conn, &password, "PostgreSQL", "public");
}

#[test]
#[ignore = "needs a MySQL or MariaDB server in DATALIQ_TEST_MYSQL"]
fn live_mysql_is_queried_read_only() {
    let Some((conn, password)) = server("DATALIQ_TEST_MYSQL", Driver::Mysql) else {
        panic!("set DATALIQ_TEST_MYSQL=host:port:database:user:password");
    };
    // MySQL's database is the schema.
    let schema = conn.database.clone();
    check_live(conn, &password, "MySQL", &schema);
}

/// `calls` (500 rows) in `schema`, and a view whose name ends in `totals`.
fn check_live(conn: DbConnection, password: &str, label: &str, schema: &str) {
    let fx = crate::filters::fx();
    let engine = &fx.engine;
    let tmp = tempfile::tempdir().unwrap();
    engine.set_extension_dir(&tmp.path().join("ext"));

    // A wrong password says what failed, and leaves nothing attached.
    let err = engine.attach_live(&conn, "nope").unwrap_err().to_string();
    assert!(
        err.starts_with(&format!("Couldn't connect to {label} at")),
        "{err}"
    );

    let out = engine.attach_live(&conn, password).unwrap();
    let names: Vec<String> = out
        .tables
        .iter()
        .map(|t| format!("{}.{} ({})", t.schema, t.name, t.kind))
        .collect();
    assert!(
        names.contains(&format!("{schema}.calls (BASE TABLE)")),
        "{names:?}"
    );
    assert!(names.iter().any(|n| n.contains(".totals")), "{names:?}");

    // Queried like any table, joined with an open file, as a result dataset.
    engine.register_table(&fx.dataset.id, "people").unwrap();
    let key = RequestKey::default();
    let ds = engine
        .sql_result(
            &format!(
                "SELECT c.account, sum(c.minutes) AS m, count(p.id) AS people FROM cdr.\"{schema}\".calls c \
                 LEFT JOIN people p ON p.id = c.id GROUP BY 1 ORDER BY 1"
            ),
            &key,
        )
        .unwrap();
    assert_eq!(ds.row_count, 3);
    let n: i64 = engine
        .connection()
        .unwrap()
        .query_row("SELECT count(*) FROM cdr.calls", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 500);
    // Read-only: no writes reach the server.
    let write = engine.execute_batch("INSERT INTO cdr.calls VALUES (9999, 'x', 1, now())");
    assert!(write.is_err());
    let delete = engine.execute_batch("DELETE FROM cdr.calls");
    assert!(delete.is_err());

    // Reconnecting replaces it; detaching removes it.
    engine.attach_live(&conn, password).unwrap();
    engine.detach_live("cdr").unwrap();
    assert!(engine.execute_batch("SELECT * FROM cdr.calls").is_err());
}
