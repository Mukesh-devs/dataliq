//! Open datasets as named tables for the SQL panel.

use arrow::array::AsArray;
use arrow::datatypes::Int64Type;
use bigview_lib::engine::{Engine, RequestKey};
use bigview_lib::import;
use bigview_lib::sources::Source;

use crate::filters::fx;

fn count(engine: &Engine, sql: &str) -> bigview_lib::error::Result<i64> {
    let out = engine.query(sql, &[], 1, &RequestKey::default())?;
    Ok(out.batches[0]
        .column(0)
        .as_primitive::<Int64Type>()
        .value(0))
}

#[test]
fn datasets_are_queryable_by_name_until_unregistered() {
    let fx = fx();
    fx.engine.register_table(&fx.dataset.id, "people").unwrap();
    assert_eq!(
        count(&fx.engine, "SELECT count(*) FROM people").unwrap(),
        1000
    );
    // Names that need quoting, and re-registering under the same name.
    fx.engine
        .register_table(&fx.dataset.id, "my \"people\" 2024")
        .unwrap();
    fx.engine
        .register_table(&fx.dataset.id, "my \"people\" 2024")
        .unwrap();
    assert_eq!(
        count(
            &fx.engine,
            "SELECT count(*) FROM \"my \"\"people\"\" 2024\" WHERE active"
        )
        .unwrap(),
        fx.people.iter().filter(|p| p.active == Some(true)).count() as i64
    );
    // A join between two names of the same data.
    assert_eq!(
        count(
            &fx.engine,
            "SELECT count(*) FROM people a JOIN \"my \"\"people\"\" 2024\" b USING (id)"
        )
        .unwrap(),
        1000
    );
    fx.engine.unregister_table("people").unwrap();
    fx.engine.unregister_table("people").unwrap();
    assert!(count(&fx.engine, "SELECT count(*) FROM people").is_err());
}

#[test]
fn parquet_queried_in_place_is_a_table_too() {
    let tmp = tempfile::tempdir().unwrap();
    let fx = fx();
    // A path with a quote, to check the inlined literal.
    let path = tmp.path().join("it's.parquet");
    fx.engine
        .execute_batch(&format!(
            "COPY (SELECT range AS id FROM range(42)) TO '{}' (FORMAT parquet)",
            path.to_string_lossy().replace('\'', "''")
        ))
        .unwrap();
    let source = Source::new(&path, Default::default()).unwrap();
    let ds = import::open_in_place(&fx.engine, &source).unwrap();
    fx.engine.register_table(&ds.id, "ids").unwrap();
    assert_eq!(count(&fx.engine, "SELECT count(*) FROM ids").unwrap(), 42);
}

#[test]
fn the_sql_session_keeps_temp_tables_and_settings() {
    let fx = fx();
    let key = RequestKey {
        id: None,
        group: Some("sql".into()),
    };
    fx.engine
        .query_session("CREATE TEMP TABLE picks AS SELECT 7 AS n", &[], 10, &key)
        .unwrap();
    fx.engine
        .query_session("SET VARIABLE answer = 42", &[], 10, &key)
        .unwrap();
    let out = fx
        .engine
        .query_session(
            "SELECT (n + getvariable('answer'))::BIGINT FROM picks",
            &[],
            10,
            &key,
        )
        .unwrap();
    assert_eq!(
        out.batches[0]
            .column(0)
            .as_primitive::<Int64Type>()
            .value(0),
        49
    );
    // Other queries use their own connections: no temp table there.
    assert!(count(&fx.engine, "SELECT count(*) FROM picks").is_err());
}

#[test]
fn a_newer_panel_query_cancels_the_running_one() {
    let fx = fx();
    let key = |id: &str| RequestKey {
        id: Some(id.into()),
        group: Some("sql".into()),
    };
    std::thread::scope(|s| {
        let slow = s.spawn(|| {
            fx.engine.query_session(
                "SELECT sum(range) FROM range(100000000000)",
                &[],
                1,
                &key("slow"),
            )
        });
        while !fx.engine.is_running("slow") {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let started = std::time::Instant::now();
        let fast = fx
            .engine
            .query_session("SELECT 1::BIGINT", &[], 1, &key("fast"))
            .unwrap();
        assert_eq!(
            fast.batches[0]
                .column(0)
                .as_primitive::<Int64Type>()
                .value(0),
            1
        );
        assert!(started.elapsed().as_secs() < 5, "waited for the slow query");
        assert!(matches!(
            slow.join().unwrap(),
            Err(bigview_lib::error::AppError::Cancelled)
        ));
    });
}
