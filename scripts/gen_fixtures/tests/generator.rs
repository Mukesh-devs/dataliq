//! The generator must produce files with the expected row counts and
//! checksums, deterministically.

use std::io::Read;

use gen_fixtures::{Format, MB, Size, Target, generate, sha256_file};

fn count_lines(bytes: &[u8]) -> usize {
    bytes.iter().filter(|&&b| b == b'\n').count()
}

fn duckdb_count(sql: &str) -> (u64, u64) {
    let conn = duckdb::Connection::open_in_memory().unwrap();
    conn.query_row(sql, [], |r| {
        Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64))
    })
    .unwrap()
}

#[test]
fn csv_by_rows_is_deterministic_and_pinned() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let t = Target {
        name: "tiny",
        format: Format::Csv,
        size: Size::Rows(1000),
    };
    let ea = generate(&t, a.path()).unwrap();
    let eb = generate(&t, b.path()).unwrap();
    assert_eq!(ea, eb, "same target must give the same file");
    assert_eq!(ea.rows, 1000);
    assert_eq!(ea.id_sum, 1000 * 1001 / 2);
    assert_eq!(ea.sha256, sha256_file(&a.path().join("tiny.csv")).unwrap());
    // Pinned: if this changes, the generator changed and every recorded
    // benchmark number refers to different data. Update deliberately.
    assert_eq!(
        ea.sha256, PINNED_TINY_CSV_SHA256,
        "generator output changed"
    );

    // DuckDB reads exactly the rows we wrote (quoted commas, quotes and
    // embedded newlines included).
    let path = a.path().join("tiny.csv");
    let (rows, sum) = duckdb_count(&format!(
        "SELECT count(*), sum(order_id) FROM read_csv('{}')",
        path.display()
    ));
    assert_eq!((rows, sum), (ea.rows, ea.id_sum));
}

const PINNED_TINY_CSV_SHA256: &str =
    "f38f63205c8d8db5fdb41b96de62930a3372293cc253be05f14dcd48a2168fcc";

#[test]
fn csv_by_bytes_reaches_target_size() {
    let dir = tempfile::tempdir().unwrap();
    let t = Target {
        name: "sized",
        format: Format::Csv,
        size: Size::Bytes(2 * MB),
    };
    let e = generate(&t, dir.path()).unwrap();
    assert!(
        e.bytes >= 2 * MB && e.bytes < 2 * MB + 512 * 1024,
        "{} bytes",
        e.bytes
    );
    assert_eq!(
        e.bytes,
        std::fs::metadata(dir.path().join("sized.csv"))
            .unwrap()
            .len()
    );
}

#[test]
fn gzip_csv_decompresses_to_the_plain_csv() {
    let dir = tempfile::tempdir().unwrap();
    let plain = generate(
        &Target {
            name: "s",
            format: Format::Csv,
            size: Size::Rows(5000),
        },
        dir.path(),
    )
    .unwrap();
    let gz = generate(
        &Target {
            name: "s",
            format: Format::CsvGz,
            size: Size::Rows(5000),
        },
        dir.path(),
    )
    .unwrap();
    assert_eq!(gz.rows, plain.rows);
    assert!(gz.bytes < plain.bytes / 2, "gzip should compress");
    let mut decoded = Vec::new();
    flate2::read::GzDecoder::new(std::fs::File::open(dir.path().join("s.csv.gz")).unwrap())
        .read_to_end(&mut decoded)
        .unwrap();
    assert_eq!(decoded, std::fs::read(dir.path().join("s.csv")).unwrap());
}

#[test]
fn gzip_by_bytes_counts_compressed_size() {
    let dir = tempfile::tempdir().unwrap();
    let t = Target {
        name: "g",
        format: Format::CsvGz,
        size: Size::Bytes(MB),
    };
    let e = generate(&t, dir.path()).unwrap();
    let on_disk = std::fs::metadata(dir.path().join("g.csv.gz"))
        .unwrap()
        .len();
    assert_eq!(e.bytes, on_disk);
    assert!((MB..2 * MB).contains(&on_disk), "{on_disk} bytes");
}

#[test]
fn ndjson_gz_has_one_object_per_row() {
    let dir = tempfile::tempdir().unwrap();
    let t = Target {
        name: "logs",
        format: Format::NdjsonGz,
        size: Size::Rows(2000),
    };
    let e = generate(&t, dir.path()).unwrap();
    let path = dir.path().join("logs.ndjson.gz");
    let mut text = Vec::new();
    flate2::read::GzDecoder::new(std::fs::File::open(&path).unwrap())
        .read_to_end(&mut text)
        .unwrap();
    assert_eq!(count_lines(&text), 2000);
    let (rows, sum) = duckdb_count(&format!(
        "SELECT count(*), sum(id) FROM read_ndjson('{}') WHERE http.status > 0",
        path.display()
    ));
    assert_eq!((rows, sum), (e.rows, e.id_sum));
}

#[test]
fn parquet_has_expected_rows() {
    let dir = tempfile::tempdir().unwrap();
    let t = Target {
        name: "p",
        format: Format::Parquet,
        size: Size::Rows(100_000),
    };
    let e = generate(&t, dir.path()).unwrap();
    let (rows, sum) = duckdb_count(&format!(
        "SELECT count(*), sum(order_id) FROM read_parquet('{}')",
        dir.path().join("p.parquet").display()
    ));
    assert_eq!((rows, sum), (100_000, e.id_sum));
}

#[test]
fn xlsx_is_a_valid_zip_with_expected_size() {
    let dir = tempfile::tempdir().unwrap();
    let t = Target {
        name: "x",
        format: Format::Xlsx,
        size: Size::Rows(1000),
    };
    let e = generate(&t, dir.path()).unwrap();
    assert_eq!(e.rows, 1000);
    let bytes = std::fs::read(dir.path().join("x.xlsx")).unwrap();
    assert_eq!(&bytes[..4], b"PK\x03\x04");
}

/// The committed `fixtures/` files must be exactly what the generator writes,
/// so nobody hand-edits them by accident. Parquet is skipped: its bytes depend
/// on the DuckDB version, so it is compared by content instead.
#[test]
fn committed_fixtures_are_up_to_date() {
    let fresh = tempfile::tempdir().unwrap();
    gen_fixtures::committed::write_all(fresh.path()).unwrap();
    let committed = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut checked = 0;
    for entry in walk(fresh.path()) {
        let rel = entry.strip_prefix(fresh.path()).unwrap();
        let old = committed.join(rel);
        if rel.extension().is_some_and(|e| e == "parquet") {
            let q = |p: &std::path::Path| {
                let conn = duckdb::Connection::open_in_memory().unwrap();
                conn.query_row(
                    &format!("SELECT count(*), md5(string_agg(t::VARCHAR, '|' ORDER BY id)) FROM read_parquet('{}') t", p.display()),
                    [],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                )
                .unwrap()
            };
            assert_eq!(q(&entry), q(&old), "{} differs", rel.display());
        } else {
            assert!(
                std::fs::read(&entry).unwrap() == std::fs::read(&old).unwrap_or_default(),
                "{} is stale: run `pnpm fixtures committed`",
                rel.display()
            );
        }
        checked += 1;
    }
    assert!(checked >= 20, "only {checked} fixtures checked");
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}
