//! Files over HTTP, read by httpfs from a small local server (HEAD and
//! byte ranges, as httpfs asks): CSV, gzipped CSV and Parquet, a missing
//! file, and remote imports staying out of the cache.
//!
//! httpfs is installed into `target/duckdb-extensions` the first time
//! (DuckDB downloads it), then reused.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use dataliq_lib::cache::{Cache, CacheConfig};
use dataliq_lib::engine::{Engine, EngineConfig, RequestKey};
use dataliq_lib::import::{self, ImportTarget, Imports};
use dataliq_lib::sources::{OpenOptions, Source};

/// Serves `dir` on 127.0.0.1; records each request line.
pub(crate) struct Server {
    pub(crate) base: String,
    pub(crate) requests: Arc<Mutex<Vec<String>>>,
}

fn respond(mut stream: TcpStream, dir: &Path, requests: &Mutex<Vec<String>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let line = line.trim_end().to_string();
        let mut range: Option<(u64, Option<u64>)> = None;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" || h == "\n" {
                break;
            }
            let lower = h.to_ascii_lowercase();
            if let Some(r) = lower.strip_prefix("range: bytes=") {
                let r = r.trim();
                let (a, b) = r.split_once('-').unwrap();
                range = Some((a.parse().unwrap(), b.parse().ok()));
            }
        }
        requests.lock().unwrap().push(line.clone());
        let mut parts = line.split(' ');
        let method = parts.next().unwrap_or_default();
        let path = parts.next().unwrap_or("/").trim_start_matches('/');
        let file = dir.join(path.split('?').next().unwrap());
        let Ok(bytes) = std::fs::read(&file) else {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            continue;
        };
        let total = bytes.len() as u64;
        let (status, body, extra) = match range {
            Some((a, b)) => {
                let b = b.unwrap_or(total - 1).min(total - 1);
                (
                    "206 Partial Content",
                    bytes[a as usize..=b as usize].to_vec(),
                    format!("Content-Range: bytes {a}-{b}/{total}\r\n"),
                )
            }
            None => ("200 OK", bytes, String::new()),
        };
        let head = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\
             Last-Modified: Mon, 01 Jan 2024 00:00:00 GMT\r\n{extra}\r\n",
            body.len()
        );
        if stream.write_all(head.as_bytes()).is_err() {
            return;
        }
        if method != "HEAD" && stream.write_all(&body).is_err() {
            return;
        }
    }
}

pub(crate) fn serve(dir: PathBuf) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&requests);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (dir, log) = (dir.clone(), Arc::clone(&log));
            std::thread::spawn(move || respond(stream, &dir, &log));
        }
    });
    Server { base, requests }
}

struct Fx {
    engine: Engine,
    server: Server,
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
    engine.set_extension_dir(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/duckdb-extensions"),
    );
    // What the server has: people.csv, a gzipped copy, and a Parquet version.
    let files = dir.path().join("www");
    std::fs::create_dir_all(&files).unwrap();
    let people = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/csv/people.csv");
    std::fs::copy(&people, files.join("people.csv")).unwrap();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&std::fs::read(&people).unwrap()).unwrap();
    std::fs::write(files.join("people.csv.gz"), gz.finish().unwrap()).unwrap();
    engine
        .execute_batch(&format!(
            "COPY (SELECT * FROM read_csv('{}')) TO '{}' (FORMAT parquet)",
            people.display(),
            files.join("people.parquet").display()
        ))
        .unwrap();
    let server = serve(files);
    Fx {
        engine,
        server,
        dir,
    }
}

impl Fx {
    fn url(&self, name: &str) -> PathBuf {
        PathBuf::from(format!("{}/{name}", self.server.base))
    }

    fn cache(&self) -> Cache {
        Cache::new(CacheConfig {
            dir: self.dir.path().join("cache"),
            max_bytes: 1 << 30,
            enabled: true,
        })
        .unwrap()
    }
}

fn rows_of(engine: &Engine, sql: &str) -> i64 {
    let q = engine
        .query(
            &format!("SELECT count(*) FROM {sql}"),
            &[],
            1,
            &RequestKey::default(),
        )
        .unwrap();
    use arrow::array::AsArray;
    q.batches[0]
        .column(0)
        .as_primitive::<arrow::datatypes::Int64Type>()
        .value(0)
}

#[test]
fn csv_over_http_opens_previews_and_imports_without_caching() {
    let fx = fx();
    assert!(
        !fx.engine.remote_enabled(),
        "nothing loaded before a URL is opened"
    );
    let source = Source::new(&fx.url("people.csv"), OpenOptions::default())
        .unwrap()
        .resolve_dialect(&fx.engine)
        .unwrap();
    assert!(fx.engine.remote_enabled());
    assert!(source.is_remote());
    let info = source.inspect(&fx.engine).unwrap();
    assert_eq!(info.file_name, "people.csv");
    let names: Vec<&str> = info.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["id", "name", "city", "amount", "joined", "active"]);
    assert!(
        info.reader_sql.contains(&fx.server.base),
        "{}",
        info.reader_sql
    );
    let preview = source
        .preview_ipc(&fx.engine, 10, &RequestKey::default())
        .unwrap();
    assert!(!preview.is_empty());

    let cache = fx.cache();
    let target = ImportTarget {
        cache: &cache,
        temp_dir: fx.dir.path().join("tmp"),
    };
    let out = import::import(
        &fx.engine,
        &Imports::default(),
        &target,
        &source,
        "r",
        &|_| {},
    )
    .unwrap();
    assert_eq!(out.dataset.row_count, 1000);
    assert!(!out.from_cache);
    // Nothing kept in the cache: the server's file may change.
    assert_eq!(cache.info().entries, 0);
    assert!(
        fx.server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("people.csv"))
    );
}

#[test]
fn gzip_and_parquet_over_http() {
    let fx = fx();
    let gz = Source::new(&fx.url("people.csv.gz"), OpenOptions::default())
        .unwrap()
        .resolve_dialect(&fx.engine)
        .unwrap();
    assert_eq!(rows_of(&fx.engine, &gz.reader_display_sql().unwrap()), 1000);

    let pq = Source::new(&fx.url("people.parquet"), OpenOptions::default())
        .unwrap()
        .resolve_dialect(&fx.engine)
        .unwrap();
    assert!(pq.is_queried_in_place());
    let ds = import::open_in_place(&fx.engine, &pq).unwrap();
    assert_eq!(ds.row_count, 1000);
    // A page from the middle comes in byte ranges.
    let page = fx
        .engine
        .fetch_rows(&ds.id, 500, 10, &RequestKey::default());
    assert!(page.is_ok(), "{page:?}");
    assert!(
        fx.server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("people.parquet")),
        "{:?}",
        fx.server.requests.lock().unwrap()
    );
}

#[test]
fn a_missing_file_or_type_is_said_in_words() {
    let fx = fx();
    let err = Source::new(&fx.url("nothing.csv"), OpenOptions::default())
        .unwrap()
        .resolve_dialect(&fx.engine)
        .and_then(|s| s.inspect(&fx.engine))
        .unwrap_err()
        .to_string();
    assert!(err.contains("no file at this address (HTTP 404)"), "{err}");
    let err = Source::new(&fx.url("download?id=7"), OpenOptions::default())
        .unwrap_err()
        .to_string();
    assert!(err.contains("tells a file's type from its URL"), "{err}");
    let err = Source::new(&fx.url("book.xlsx"), OpenOptions::default())
        .unwrap_err()
        .to_string();
    assert!(err.contains("Excel"), "{err}");
}
