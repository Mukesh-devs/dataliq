//! Folders and patterns opened as one table: columns matched by name, a
//! file column relative to the folder, other formats and empty files left
//! out, the cache following every file, and the reader SQL running in
//! plain DuckDB.

use std::io::Write;
use std::path::{Path, PathBuf};

use arrow::array::{Array, AsArray};
use bigview_lib::cache::{Cache, CacheConfig};
use bigview_lib::engine::{Dataset, Engine, EngineConfig, RequestKey};
use bigview_lib::import::{self, ImportTarget, Imports};
use bigview_lib::sources::{Compression, FileFormat, OpenOptions, Source};
use bigview_lib::view::Relation;

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

fn write(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

fn gzip(text: &str) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(text.as_bytes()).unwrap();
    e.finish().unwrap()
}

impl Fx {
    fn data(&self) -> PathBuf {
        self.dir.path().join("data")
    }

    fn source(&self, path: &Path) -> Source {
        Source::new(path, OpenOptions::default())
            .unwrap()
            .resolve_dialect(&self.engine)
            .unwrap()
    }

    fn import(&self, source: &Source) -> (Dataset, bool) {
        let cache = Cache::new(CacheConfig {
            dir: self.dir.path().join("cache"),
            max_bytes: 1 << 30,
            enabled: true,
        })
        .unwrap();
        let target = ImportTarget {
            cache: &cache,
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

    /// `SELECT cols FROM rel ORDER BY order`, every value as text.
    fn rows(&self, from: &str, cols: &[&str], order: &str) -> Vec<Vec<Option<String>>> {
        let list = cols
            .iter()
            .map(|c| format!("CAST(\"{c}\" AS VARCHAR)"))
            .collect::<Vec<_>>()
            .join(", ");
        let q = self
            .engine
            .query(
                &format!("SELECT {list} FROM {from} ORDER BY {order}"),
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

    fn dataset_rows(&self, ds: &Dataset, cols: &[&str], order: &str) -> Vec<Vec<Option<String>>> {
        let rel = Relation::of(&ds.source);
        let from = bigview_lib::sources::inline_params(&rel.sql, &rel.params);
        self.rows(&from, cols, order)
    }
}

fn s(v: &str) -> Option<String> {
    Some(v.to_string())
}

#[test]
fn a_folder_of_csv_files_is_one_table() {
    let fx = fx();
    let d = fx.data();
    write(&d.join("2024-01.csv"), b"id,amount\n1,10.5\n2,20\n");
    write(
        &d.join("2024-02.csv.gz"),
        &gzip("id,amount,note\n3,30,late\n"),
    );
    write(&d.join("2024-03.csv"), b"id,note\n4,x\n");
    write(&d.join("empty.csv"), b"");
    write(&d.join("meta.json"), b"[{\"a\": 1}]");
    write(&d.join("README.md"), b"# not data");

    let source = fx.source(&d);
    assert!(source.is_multi());
    assert_eq!(source.detected.format, FileFormat::Csv);
    assert_eq!(source.detected.compression, Compression::Mixed);
    let info = source.inspect(&fx.engine).unwrap();
    assert_eq!(info.file_name, "data");
    let files = info.files.as_ref().unwrap();
    assert_eq!(
        files.names,
        ["2024-01.csv", "2024-02.csv.gz", "2024-03.csv"]
    );
    assert_eq!((files.count, files.skipped), (3, 2));
    assert_eq!(files.column, "filename");
    // Every file's columns, by name, and the file column last.
    let names: Vec<&str> = info.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["id", "amount", "note", "filename"]);

    let (ds, cached) = fx.import(&source);
    assert!(!cached);
    assert_eq!(ds.row_count, 4);
    let want = vec![
        vec![s("1"), s("10.5"), None, s("2024-01.csv")],
        vec![s("2"), s("20.0"), None, s("2024-01.csv")],
        vec![s("3"), s("30.0"), s("late"), s("2024-02.csv.gz")],
        vec![s("4"), None, s("x"), s("2024-03.csv")],
    ];
    assert_eq!(
        fx.dataset_rows(&ds, &["id", "amount", "note", "filename"], "id"),
        want
    );

    // "Copy as SQL" reads the same rows in plain DuckDB.
    let sql = source.reader_display_sql().unwrap();
    let plain = duckdb::Connection::open_in_memory().unwrap();
    let mut stmt = plain
        .prepare(&format!(
            "SELECT CAST(id AS VARCHAR), CAST(amount AS VARCHAR), note, filename FROM {sql} ORDER BY id"
        ))
        .unwrap();
    let got: Vec<Vec<Option<String>>> = stmt
        .query_map([], |r| Ok((0..4).map(|i| r.get(i).unwrap()).collect()))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(got, want);
}

#[test]
fn the_cache_follows_every_file() {
    let fx = fx();
    let d = fx.data();
    write(&d.join("a.csv"), b"id\n1\n");
    write(&d.join("b.csv"), b"id\n2\n");
    let (first, cached) = fx.import(&fx.source(&d));
    assert!(!cached);
    // Unchanged: from the cache (a new engine session would attach it).
    let (again, cached) = fx.import(&fx.source(&d));
    assert!(cached);
    assert_eq!(again.id, first.id);
    // A new file: a new version.
    write(&d.join("c.csv"), b"id\n3\n");
    let (more, cached) = fx.import(&fx.source(&d));
    assert!(!cached);
    assert_ne!(more.id, first.id);
    assert_eq!(more.row_count, 3);
    // One file changed (size and time): another.
    std::thread::sleep(std::time::Duration::from_millis(20));
    write(&d.join("a.csv"), b"id\n1\n10\n");
    let (changed, cached) = fx.import(&fx.source(&d));
    assert!(!cached);
    assert_eq!(changed.row_count, 4);
}

#[test]
fn patterns_pick_files_across_folders() {
    let fx = fx();
    let d = fx.data();
    write(&d.join("logs/2023/dec.csv"), b"t,level\n1,info\n");
    write(&d.join("logs/2024/jan.csv"), b"t,level\n2,warn\n");
    write(&d.join("logs/2024/jan.txt"), b"not,this\n9,x\n");
    let pattern = d.join("logs/*/*.csv");
    let source = fx.source(&pattern);
    let info = source.inspect(&fx.engine).unwrap();
    assert_eq!(info.file_name, "*/*.csv");
    assert_eq!(
        info.files.as_ref().unwrap().names,
        ["2023/dec.csv", "2024/jan.csv"]
    );
    let (ds, _) = fx.import(&source);
    assert_eq!(
        fx.dataset_rows(&ds, &["t", "level", "filename"], "t"),
        vec![
            vec![s("1"), s("info"), s("2023/dec.csv")],
            vec![s("2"), s("warn"), s("2024/jan.csv")],
        ]
    );
}

#[test]
fn ndjson_and_parquet_folders() {
    let fx = fx();
    let d = fx.data();
    write(&d.join("j/a.ndjson"), b"{\"x\": 1}\n{\"x\": 2}\n");
    write(
        &d.join("j/b.ndjson.gz"),
        &gzip("{\"x\": 3, \"y\": \"z\"}\n"),
    );
    let (ds, _) = fx.import(&fx.source(&d.join("j")));
    assert_eq!(
        fx.dataset_rows(&ds, &["x", "y", "filename"], "x"),
        vec![
            vec![s("1"), None, s("a.ndjson")],
            vec![s("2"), None, s("a.ndjson")],
            vec![s("3"), s("z"), s("b.ndjson.gz")],
        ]
    );

    // Parquet files are queried in place, together.
    let pq = d.join("p");
    std::fs::create_dir_all(&pq).unwrap();
    for (i, name) in ["one", "two"].iter().enumerate() {
        fx.engine
            .execute_batch(&format!(
                "COPY (SELECT range + {} AS n FROM range(3)) TO '{}' (FORMAT parquet)",
                i * 10,
                pq.join(format!("{name}.parquet")).display()
            ))
            .unwrap();
    }
    let source = fx.source(&pq);
    assert!(source.is_queried_in_place());
    let ds = import::open_in_place(&fx.engine, &source).unwrap();
    assert_eq!(ds.row_count, 6);
    let rows = fx.dataset_rows(&ds, &["n", "filename"], "n");
    assert_eq!(rows.len(), 6);
    assert_eq!(rows[0], vec![s("0"), s("one.parquet")]);
    assert_eq!(rows[5], vec![s("12"), s("two.parquet")]);
}

#[test]
fn a_file_column_of_the_same_name_is_kept() {
    let fx = fx();
    let d = fx.data();
    write(&d.join("a.csv"), b"filename,size\nx.txt,1\n");
    write(&d.join("b.csv"), b"filename,size\ny.txt,2\n");
    let source = fx.source(&d);
    assert_eq!(source.file_column, "source_file");
    let (ds, _) = fx.import(&source);
    assert_eq!(
        fx.dataset_rows(&ds, &["filename", "source_file"], "size"),
        vec![vec![s("x.txt"), s("a.csv")], vec![s("y.txt"), s("b.csv")]]
    );
}

#[test]
fn nothing_to_open_is_said_in_words() {
    let fx = fx();
    let d = fx.data();
    write(&d.join("notes.md"), b"x");
    let err = Source::new(&d, OpenOptions::default())
        .unwrap_err()
        .to_string();
    assert!(err.contains("no CSV, TSV, JSON or Parquet files"), "{err}");
    let err = Source::new(&d.join("*.parquet"), OpenOptions::default())
        .unwrap_err()
        .to_string();
    assert!(err.contains("No data files match"), "{err}");
}
