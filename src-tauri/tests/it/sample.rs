//! The sample dataset: written once, the same every time, and opened like
//! any CSV with the types and values the tips rely on.

use bigview_lib::engine::{Engine, EngineConfig};
use bigview_lib::sample::{SAMPLE_FILE, SAMPLE_ROWS, sample_dataset};
use bigview_lib::sources::{OpenOptions, Source};

fn engine(tmp: &tempfile::TempDir) -> Engine {
    Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: tmp.path().join("spill"),
        threads: Some(2),
    })
    .unwrap()
}

#[test]
fn sample_dataset_is_written_once_and_opens_as_csv() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = engine(&tmp);
    let dir = tmp.path().join("samples");
    let path = sample_dataset(&engine, &dir).unwrap();
    assert_eq!(path, dir.join(SAMPLE_FILE));
    let bytes = std::fs::read(&path).unwrap();
    assert!(!dir.join(format!("{SAMPLE_FILE}.partial")).exists());

    // The same file each time it's generated.
    let other = tmp.path().join("again");
    let again = std::fs::read(sample_dataset(&engine, &other).unwrap()).unwrap();
    assert_eq!(bytes, again);

    // Asked again, the existing file is kept.
    std::fs::write(&path, "kept\n").unwrap();
    assert_eq!(sample_dataset(&engine, &dir).unwrap(), path);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "kept\n");

    // It opens like any CSV, with typed columns.
    let source = Source::new(&other.join(SAMPLE_FILE), OpenOptions::default())
        .unwrap()
        .resolve_dialect(&engine)
        .unwrap();
    let info = source.inspect(&engine).unwrap();
    let columns: Vec<(&str, &str)> = info
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.r#type.as_str()))
        .collect();
    assert_eq!(
        columns,
        [
            ("order_id", "BIGINT"),
            ("order_date", "DATE"),
            ("region", "VARCHAR"),
            ("product", "VARCHAR"),
            ("category", "VARCHAR"),
            ("quantity", "BIGINT"),
            ("unit_price", "DOUBLE"),
            ("discount", "DOUBLE"),
            ("customer", "VARCHAR"),
            ("returned", "BOOLEAN"),
        ]
    );

    let conn = engine.connection().unwrap();
    let (rows, first, last, regions, categories, empty, returned): (
        i64,
        String,
        String,
        i64,
        i64,
        i64,
        i64,
    ) = conn
        .query_row(
            &format!(
                "SELECT count(*), min(order_date)::VARCHAR, max(order_date)::VARCHAR, \
                   count(DISTINCT region), count(DISTINCT category), \
                   count(*) FILTER (customer IS NULL), count(*) FILTER (returned) \
                 FROM {}",
                info.reader_sql
            ),
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(rows as u64, SAMPLE_ROWS);
    assert_eq!(
        (first.as_str(), last.as_str()),
        ("2023-01-01", "2024-12-31")
    );
    assert_eq!((regions, categories), (5, 4));
    // About 0.5 % empty customers and 4 % returns, for the quality check.
    assert!((150..=350).contains(&empty), "{empty} empty customers");
    assert!((1_500..=2_500).contains(&returned), "{returned} returned");
}
