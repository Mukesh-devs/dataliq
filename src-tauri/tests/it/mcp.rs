//! `dataliq mcp`: the MCP server's protocol, tools and sandbox.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use dataliq_lib::mcp::{McpConfig, Server};
use dataliq_lib::settings::Settings;
use serde_json::{Value, json};

fn fixture(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures")
        .join(rel)
}

/// A shared folder with two files, and a folder that isn't shared.
fn folders(root: &Path) -> (PathBuf, PathBuf) {
    let (shared, secret) = (root.join("shared"), root.join("secret"));
    for d in [&shared, &secret] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::copy(fixture("csv/people.csv"), shared.join("people.csv")).unwrap();
    std::fs::copy(fixture("csv/comma.csv.gz"), shared.join("comma.csv.gz")).unwrap();
    std::fs::copy(fixture("csv/people.csv"), secret.join("private.csv")).unwrap();
    (
        std::fs::canonicalize(shared).unwrap(),
        std::fs::canonicalize(secret).unwrap(),
    )
}

fn call(server: &mut Server, tool: &str, args: Value) -> (bool, String) {
    let reply = server
        .handle(&json!({
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": { "name": tool, "arguments": args }
        }))
        .unwrap();
    let r = &reply["result"];
    (
        r["isError"].as_bool().unwrap_or(false),
        r["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    )
}

#[test]
fn tools_read_shared_files_and_nothing_else() {
    let tmp = tempfile::tempdir().unwrap();
    let (shared, secret) = folders(tmp.path());
    let log = tmp.path().join("log.jsonl");
    let config = McpConfig {
        enabled: true,
        folders: vec![shared.clone()],
        allow_export: false,
        log: Some(log.clone()),
    };
    let mut s = Server::new(config.clone(), &Settings::default()).unwrap();

    // Handshake.
    let init = s
        .handle(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}))
        .unwrap();
    assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(init["result"]["serverInfo"]["name"], "dataliq");
    assert!(
        s.handle(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .is_none()
    );
    let list = s
        .handle(&json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        .unwrap();
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"query") && names.contains(&"describe_file"));
    assert!(
        !names.contains(&"export_query"),
        "no exports unless allowed"
    );
    let unknown = s
        .handle(&json!({"jsonrpc": "2.0", "id": 3, "method": "resources/list"}))
        .unwrap();
    assert_eq!(unknown["error"]["code"], -32601);

    // Files and tables.
    let (err, text) = call(&mut s, "list_files", json!({}));
    assert!(
        !err && text.contains("people.csv") && text.contains("comma.csv.gz"),
        "{text}"
    );
    let people = shared.join("people.csv").to_string_lossy().to_string();
    let (err, text) = call(&mut s, "describe_file", json!({ "path": people }));
    assert!(!err, "{text}");
    assert!(
        text.contains("1000 rows, 6 columns") && text.contains("table `people`"),
        "{text}"
    );
    let (err, text) = call(
        &mut s,
        "query",
        json!({ "sql": "SELECT count(*) AS n, count(DISTINCT city) AS c FROM people" }),
    );
    assert!(!err && text.contains("| 1000 |"), "{text}");
    let (_, text) = call(
        &mut s,
        "query",
        json!({ "sql": "SELECT * FROM people", "max_rows": 3 }),
    );
    assert!(text.starts_with("First 3 rows"), "{text}");
    let (err, text) = call(
        &mut s,
        "profile_column",
        json!({ "table": "people", "column": "amount" }),
    );
    assert!(!err && text.contains("mean"), "{text}");
    let (err, text) = call(
        &mut s,
        "value_counts",
        json!({ "table": "people", "column": "city", "limit": 3 }),
    );
    assert!(
        !err && text.contains("| value | count | percent |"),
        "{text}"
    );
    let (err, text) = call(&mut s, "summarize", json!({ "table": "people" }));
    assert!(!err && text.contains("column_name"), "{text}");

    // The sandbox: read-only SQL, only shared folders, settings locked.
    for sql in [
        "DROP VIEW people",
        "CREATE TABLE x AS SELECT 1",
        "SELECT 1; SELECT 2",
        "SET enable_external_access = true",
        "COPY (SELECT 1) TO 'x.csv'",
    ] {
        let (err, text) = call(&mut s, "query", json!({ "sql": sql }));
        assert!(err, "{sql} ran: {text}");
    }
    let private = secret.join("private.csv").to_string_lossy().to_string();
    let (err, text) = call(
        &mut s,
        "query",
        json!({ "sql": format!("SELECT * FROM read_csv('{private}')") }),
    );
    assert!(err && text.contains("Permission"), "{text}");
    let (err, _) = call(
        &mut s,
        "query",
        json!({ "sql": "SELECT * FROM read_text('/etc/hostname')" }),
    );
    assert!(err);
    let escape = shared
        .join("../secret/private.csv")
        .to_string_lossy()
        .to_string();
    let (err, text) = call(&mut s, "describe_file", json!({ "path": escape }));
    assert!(err && text.contains("outside the folders"), "{text}");
    // Reading a shared file directly works.
    let comma = shared.join("comma.csv.gz").to_string_lossy().to_string();
    let (err, text) = call(
        &mut s,
        "query",
        json!({ "sql": format!("SELECT count(*) FROM read_csv('{comma}')") }),
    );
    assert!(!err, "{text}");
    let (err, text) = call(
        &mut s,
        "export_query",
        json!({ "sql": "SELECT 1", "path": shared.join("o.csv") }),
    );
    assert!(err && text.contains("turned off"), "{text}");

    // Every call is logged.
    let lines = std::fs::read_to_string(&log).unwrap();
    assert!(lines.lines().count() >= 14);
    assert!(
        lines
            .lines()
            .all(|l| serde_json::from_str::<Value>(l).is_ok())
    );

    // Turned off in the app: calls are refused at once.
    s.reload_with(move || McpConfig {
        enabled: false,
        ..config.clone()
    });
    let (err, text) = call(&mut s, "query", json!({ "sql": "SELECT 1" }));
    assert!(err && text.contains("turned off"), "{text}");
}

#[test]
fn exports_go_only_into_shared_folders_as_new_files() {
    let tmp = tempfile::tempdir().unwrap();
    let (shared, secret) = folders(tmp.path());
    let config = McpConfig {
        enabled: true,
        folders: vec![shared.clone()],
        allow_export: true,
        log: None,
    };
    let mut s = Server::new(config, &Settings::default()).unwrap();
    let list = s
        .handle(&json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        .unwrap();
    assert!(list.to_string().contains("export_query"));
    let people = shared.join("people.csv").to_string_lossy().to_string();
    call(&mut s, "describe_file", json!({ "path": people }));
    let out = shared.join("by_city.parquet");
    let sql = "SELECT city, count(*) AS n FROM people GROUP BY 1";
    let (err, text) = call(&mut s, "export_query", json!({ "sql": sql, "path": out }));
    assert!(!err && out.exists(), "{text}");
    let (err, text) = call(&mut s, "export_query", json!({ "sql": sql, "path": out }));
    assert!(err && text.contains("already exists"), "{text}");
    let (err, _) = call(
        &mut s,
        "export_query",
        json!({ "sql": sql, "path": secret.join("x.csv") }),
    );
    assert!(err);
    let (err, _) = call(
        &mut s,
        "export_query",
        json!({ "sql": "DELETE FROM people", "path": shared.join("d.csv") }),
    );
    assert!(err);
}

/// The binary over stdio, as an MCP client starts it.
#[test]
fn the_binary_serves_mcp_over_stdio() {
    let tmp = tempfile::tempdir().unwrap();
    let (shared, _) = folders(tmp.path());
    let config_home = tmp.path().join("config");
    let settings = config_home.join("app.dataliq.desktop");
    std::fs::create_dir_all(&settings).unwrap();
    let write = |enabled: bool| {
        std::fs::write(
            settings.join("settings.json"),
            json!({ "mcpEnabled": enabled, "mcpFolders": [shared], "memoryLimitMb": 512 })
                .to_string(),
        )
        .unwrap()
    };
    let start = || {
        Command::new(env!("CARGO_BIN_EXE_dataliq"))
            .arg("mcp")
            .env("XDG_CONFIG_HOME", &config_home)
            .env("XDG_DATA_HOME", tmp.path().join("data"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    };
    // Off: it says how to turn it on, and stops.
    write(false);
    let out = start().wait_with_output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("Settings › AI assistants"));

    write(true);
    let mut child = start();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let send = |stdin: &mut std::process::ChildStdin, msg: Value| {
        writeln!(stdin, "{msg}").unwrap();
        stdin.flush().unwrap();
    };
    let mut ask = |stdin: &mut std::process::ChildStdin, msg: Value| -> Value {
        writeln!(stdin, "{msg}").unwrap();
        stdin.flush().unwrap();
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    };
    let init = ask(
        &mut stdin,
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}),
    );
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    send(
        &mut stdin,
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    );
    let people = shared.join("people.csv").to_string_lossy().to_string();
    let r = ask(
        &mut stdin,
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "describe_file", "arguments": {"path": people}}}),
    );
    assert!(
        r["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("1000 rows"),
        "{r}"
    );
    let r = ask(
        &mut stdin,
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "query", "arguments": {"sql": "SELECT max(amount) FROM people"}}}),
    );
    assert_eq!(r["id"], 3);
    assert!(r["result"]["isError"].is_null(), "{r}");
    drop(stdin);
    assert!(child.wait().unwrap().success());
    // Its calls are in the app's data folder.
    let log = tmp.path().join("data/app.dataliq.desktop/mcp-log.jsonl");
    assert_eq!(std::fs::read_to_string(log).unwrap().lines().count(), 2);
}
