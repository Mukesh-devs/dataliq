//! Records real backend responses for the Playwright UI flows, which run the
//! frontend against a mocked Tauri IPC (e2e/tauri-mock.ts). Regenerate with
//! `RECORD_UI=1 cargo test -p bigview --test ui_recordings`; a normal run
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
        info["path"] = (*fake).into();
        info["readerSql"] = info["readerSql"]
            .as_str()
            .unwrap()
            .replace(&real_str, fake)
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

#[test]
fn ui_recordings_are_up_to_date() {
    let path = root().join("e2e/recordings/backend.json");
    let fresh = serde_json::to_string_pretty(&record()).unwrap() + "\n";
    if std::env::var_os("RECORD_UI").is_some() {
        std::fs::write(&path, &fresh).unwrap();
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == fresh,
        "e2e/recordings/backend.json is stale: rerun with RECORD_UI=1"
    );
}
