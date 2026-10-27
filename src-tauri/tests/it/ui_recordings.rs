//! Records real backend responses for the Playwright UI flows, which run the
//! frontend against a mocked Tauri IPC (e2e/tauri-mock.ts). Regenerate with
//! `RECORD_UI=1 cargo test -p bigview --test it ui_recordings`; a normal run
//! checks the recordings are still what the backend returns.

use std::path::PathBuf;

use bigview_lib::engine::{Engine, EngineConfig, RequestKey};
use bigview_lib::sources::{OpenOptions, Source};

/// Fixtures used by the UI flows, recorded under a stable fake path.
const FILES: &[(&str, &str)] = &[
    ("csv/comma.csv", "/data/comma.csv"),
    ("csv/semicolon.csv", "/data/semicolon.csv"),
    ("csv/quoted.csv.gz", "/data/quoted.csv.gz"),
    ("csv/nulls.csv", "/data/nulls.csv"),
    ("json/nested.json", "/data/nested.json"),
    ("parquet/types.parquet", "/data/types.parquet"),
    ("excel/multi_sheet.xlsx", "/data/multi_sheet.xlsx"),
];

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn record() -> serde_json::Value {
    let tmp = tempfile::tempdir().unwrap();
    let engine = Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: tmp.path().into(),
        threads: Some(1),
    })
    .unwrap();
    let mut files = serde_json::Map::new();
    for (rel, fake) in FILES {
        let real = root().join("fixtures").join(rel);
        let source = Source::new(&real, OpenOptions::default())
            .unwrap()
            .resolve_dialect(&engine)
            .unwrap();
        let mut info = serde_json::to_value(source.inspect(&engine).unwrap()).unwrap();
        let real_str = real.to_string_lossy().replace('\'', "''");
        let real_display = real.display().to_string();
        info["path"] = (*fake).into();
        // Mirror `open_file`: Parquet is queried in place, so it has a dataset
        // at once (with a stable id; real ids hash the file's mtime).
        if source.is_queried_in_place() {
            let ds = bigview_lib::import::open_in_place(&engine, &source).unwrap();
            info["dataset"] = serde_json::json!({
                "id": "pq-recorded",
                "rowCount": ds.row_count,
                "cached": false,
            });
        }
        info["readerSql"] = info["readerSql"]
            .as_str()
            .unwrap()
            .replace(&real_str, fake)
            .replace(&real_display, fake)
            .into();
        let preview = source
            .preview_ipc(&engine, 1000, &RequestKey::default())
            .unwrap();
        files.insert(
            (*fake).to_string(),
            serde_json::json!({ "info": info, "preview": b64(&preview) }),
        );
    }
    let version = engine
        .query_ipc("SELECT version() AS v", &[], 1, &RequestKey::default())
        .unwrap();
    serde_json::json!({ "version": b64(&version), "files": files })
}

fn unb64(s: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        _ => 63,
    };
    let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let n = chunk
            .iter()
            .fold(0u32, |n, &c| (n << 6) | u32::from(val(c)))
            << (6 * (4 - chunk.len()));
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    out
}

fn decode(b64_text: &str) -> Vec<arrow::record_batch::RecordBatch> {
    arrow::ipc::reader::StreamReader::try_new(std::io::Cursor::new(unb64(b64_text)), None)
        .unwrap()
        .map(|b| b.unwrap())
        .collect()
}

/// Arrow IPC bytes are not byte-stable (buffers under NULL slots hold
/// whatever memory DuckDB left there), so previews are compared decoded.
fn same_recording(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    let strip = |v: &serde_json::Value| {
        let mut v = v.clone();
        v["version"] = serde_json::Value::Null;
        for f in v["files"]
            .as_object_mut()
            .into_iter()
            .flat_map(|m| m.values_mut())
        {
            f["preview"] = serde_json::Value::Null;
        }
        v
    };
    if strip(a) != strip(b) {
        return false;
    }
    let files = a["files"].as_object().unwrap();
    files.iter().all(|(k, f)| {
        decode(f["preview"].as_str().unwrap()) == decode(b["files"][k]["preview"].as_str().unwrap())
    }) && decode(a["version"].as_str().unwrap()) == decode(b["version"].as_str().unwrap())
}

#[test]
fn ui_recordings_are_up_to_date() {
    let path = root().join("e2e/recordings/backend.json");
    let fresh = record();
    if std::env::var_os("RECORD_UI").is_some() {
        std::fs::write(&path, serde_json::to_string_pretty(&fresh).unwrap() + "\n").unwrap();
    }
    let committed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_default())
            .unwrap_or_default();
    assert!(
        committed.is_object() && same_recording(&committed, &fresh),
        "e2e/recordings/backend.json is stale: rerun with RECORD_UI=1"
    );
}
