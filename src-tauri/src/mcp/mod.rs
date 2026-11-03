//! `dataliq mcp`: a Model Context Protocol server on stdin/stdout, so an AI
//! assistant (Claude Desktop, Claude Code, any MCP client) can look at the
//! user's data files with DataLiq's engine: list and describe files, run
//! read-only SQL, profile columns, count values, summarize, and (when
//! allowed) export a query or open a file in the app.
//!
//! Safety (docs/DECISIONS.md D60):
//! - Off unless turned on in Settings › AI assistants; it re-reads the
//!   settings on every call, so turning it off takes effect at once.
//! - Its own DuckDB, sandboxed: no file access outside the allowed folders
//!   (`allowed_directories` + `enable_external_access = false`), no
//!   extensions, no network, and the configuration locked so SQL can't
//!   change that.
//! - Queries must be a single SELECT (checked by DuckDB's own parser).
//! - Writing files only with "allow exports", and only into the folders.
//! - Every call is logged (`mcp-log.jsonl` in the app's data folder).

mod protocol;

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{Value, json};

use crate::engine::sql::{inline_params, literal, quote_ident};
use crate::engine::{Engine, EngineConfig, Param, RequestKey};
use crate::error::{AppError, Result};
use crate::export::ExportFormat;
use crate::settings::Settings;
use crate::sources::{OpenOptions, Source};
use crate::view::ViewSpec;

pub use protocol::{PROTOCOL_VERSIONS, tools};

/// Rows a query answers with by default, and at most.
pub const DEFAULT_ROWS: usize = 100;
pub const MAX_ROWS: usize = 1_000;
/// Longest cell text in an answer (longer is cut with "…").
const MAX_CELL: usize = 200;
pub const LOG_FILE: &str = "mcp-log.jsonl";

/// What the server may do, from the settings.
#[derive(Debug, Clone, PartialEq)]
pub struct McpConfig {
    pub enabled: bool,
    /// Folders it may read (and with `allow_export`, write) in; canonical.
    pub folders: Vec<PathBuf>,
    pub allow_export: bool,
    /// Where calls are logged; none in tests.
    pub log: Option<PathBuf>,
}

impl McpConfig {
    pub fn from_settings(s: &Settings, log: Option<PathBuf>) -> McpConfig {
        McpConfig {
            enabled: s.mcp_enabled,
            folders: s
                .mcp_folders
                .iter()
                .filter_map(|f| std::fs::canonicalize(f).ok())
                .filter(|f| f.is_dir())
                .collect(),
            allow_export: s.mcp_allow_export,
            log,
        }
    }
}

/// The app's settings file and data folder, as the app itself uses them.
pub fn app_paths() -> (Option<PathBuf>, Option<PathBuf>) {
    let id = "app.dataliq.desktop";
    (
        dirs::config_dir().map(|d| d.join(id).join(crate::settings::SETTINGS_FILE)),
        dirs::data_dir().map(|d| d.join(id)),
    )
}

/// Column names, rows of text cells (NULL as None), and whether there were more.
type Rows = (Vec<String>, Vec<Vec<Option<String>>>, bool);

/// A file opened as a table (`describe_file`).
struct Table {
    path: PathBuf,
    dataset: String,
}

pub struct Server {
    engine: Engine,
    config: McpConfig,
    /// Re-reads the settings (on, folders, exports); none keeps `config`.
    reload: Option<Box<dyn Fn() -> McpConfig>>,
    tables: HashMap<String, Table>,
    /// DuckDB's spill folder for this server, removed when it ends.
    spill: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.spill);
    }
}

/// `path` with a trailing separator, so `/data` doesn't allow `/data2`.
fn dir_prefix(path: &Path) -> String {
    let mut s = path.to_string_lossy().into_owned();
    if !s.ends_with(std::path::MAIN_SEPARATOR) {
        s.push(std::path::MAIN_SEPARATOR);
    }
    s
}

/// A table name from a file name: `Calls 2024-10.csv.gz` → `calls_2024_10`.
pub fn table_name(path: &Path) -> String {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let stem = name.split('.').next().unwrap_or_default().to_lowercase();
    let clean: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let clean = clean.trim_matches('_').to_string();
    match clean.chars().next() {
        None => "data".into(),
        Some(c) if c.is_ascii_digit() => format!("t_{clean}"),
        Some(_) => clean,
    }
}

/// Whether `sql` is one SELECT (or FROM / WITH / VALUES …), by DuckDB's parser.
fn check_select(conn: &duckdb::Connection, sql: &str) -> Result<()> {
    let out: String = conn.query_row(
        "SELECT json_serialize_sql(CAST(? AS VARCHAR))",
        [sql],
        |r| r.get(0),
    )?;
    let v: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
    if v.get("error").and_then(Value::as_bool) != Some(false) {
        let why = v
            .get("error_message")
            .and_then(Value::as_str)
            .unwrap_or("not a query");
        return Err(AppError::Query(format!(
            "Only one read-only query (SELECT …) is allowed here ({why})."
        )));
    }
    if v["statements"].as_array().map_or(0, Vec::len) != 1 {
        return Err(AppError::Query("Send one query at a time.".into()));
    }
    Ok(())
}

/// Rows as a Markdown table (cells as text, long ones cut).
fn markdown(columns: &[String], rows: &[Vec<Option<String>>]) -> String {
    let cell = |s: &str| {
        let s = s.replace('|', "\\|").replace(['\n', '\r'], " ");
        if s.chars().count() > MAX_CELL {
            format!("{}…", s.chars().take(MAX_CELL - 1).collect::<String>())
        } else {
            s
        }
    };
    let mut out = format!(
        "| {} |\n",
        columns
            .iter()
            .map(|c| cell(c))
            .collect::<Vec<_>>()
            .join(" | ")
    );
    out.push_str(&format!("|{}\n", " --- |".repeat(columns.len())));
    for r in rows {
        let cells: Vec<String> = r
            .iter()
            .map(|v| v.as_deref().map_or_else(|| "NULL".to_string(), cell))
            .collect();
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
    }
    out
}

impl Server {
    /// A server with its own sandboxed engine for `config`.
    pub fn new(config: McpConfig, settings: &Settings) -> Result<Server> {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let spill = std::env::temp_dir().join(format!(
            "dataliq-mcp-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&spill)?;
        let engine = Engine::open_in_memory(&EngineConfig {
            temp_dir: spill.clone(),
            ..EngineConfig::from_settings(settings)
        })?;
        let mut dirs: Vec<String> = config.folders.iter().map(|f| dir_prefix(f)).collect();
        // DuckDB spills big sorts here.
        dirs.push(dir_prefix(&spill));
        let list = dirs
            .iter()
            .map(|d| literal(&Param::Text(d.clone())))
            .collect::<Vec<_>>()
            .join(", ");
        engine.execute_batch(&format!(
            "SET allowed_directories = [{list}]; \
             SET enable_external_access = false; \
             SET autoinstall_known_extensions = false; \
             SET autoload_known_extensions = false; \
             SET lock_configuration = true;"
        ))?;
        Ok(Server {
            engine,
            config,
            reload: None,
            tables: HashMap::new(),
            spill,
        })
    }

    /// Re-read the settings before each call (the app may change them).
    pub fn reload_with(&mut self, f: impl Fn() -> McpConfig + 'static) {
        self.reload = Some(Box::new(f));
    }

    /// `path` if it is inside an allowed folder (resolved, so `..` can't escape).
    fn allowed(&self, path: &str) -> Result<PathBuf> {
        let p = PathBuf::from(path);
        let resolved = std::fs::canonicalize(&p)
            .or_else(|_| {
                // A file to be written: its folder must exist.
                let parent = p.parent().ok_or(std::io::ErrorKind::NotFound)?;
                std::fs::canonicalize(parent).map(|d| d.join(p.file_name().unwrap_or_default()))
            })
            .map_err(|_| AppError::Query(format!("{path} doesn't exist.")))?;
        if self.config.folders.iter().any(|f| resolved.starts_with(f)) {
            Ok(resolved)
        } else {
            Err(AppError::Query(format!(
                "{path} is outside the folders DataLiq shares ({}). Add its folder in DataLiq › \
                 Settings › AI assistants.",
                self.folder_list()
            )))
        }
    }

    fn folder_list(&self) -> String {
        if self.config.folders.is_empty() {
            "none yet".into()
        } else {
            self.config
                .folders
                .iter()
                .map(|f| f.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        }
    }

    /// Up to `max` rows of `sql` (already checked), as text, and whether there were more.
    fn rows(&self, sql: &str, max: usize) -> Result<Rows> {
        let conn = self.engine.connection()?;
        let q = format!(
            "SELECT CAST(COLUMNS(*) AS VARCHAR) FROM (\n{}\n) LIMIT {}",
            sql.trim().trim_end_matches(';'),
            max + 1
        );
        let mut stmt = conn.prepare(&q)?;
        let mut out = Vec::new();
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let n = r.as_ref().column_count();
            out.push(
                (0..n)
                    .map(|i| r.get::<_, Option<String>>(i))
                    .collect::<std::result::Result<_, _>>()?,
            );
        }
        drop(rows);
        let names = stmt.column_names();
        let more = out.len() > max;
        out.truncate(max);
        Ok((names, out, more))
    }

    /// A file as a table named after it (kept for later queries).
    fn open_table(&mut self, path: &str) -> Result<(String, &Table)> {
        let resolved = self.allowed(path)?;
        if let Some((name, _)) = self.tables.iter().find(|(_, t)| t.path == resolved) {
            let name = name.clone();
            return Ok((name.clone(), &self.tables[&name]));
        }
        let source =
            Source::new(&resolved, OpenOptions::default())?.resolve_dialect(&self.engine)?;
        let dataset = crate::import::open_query(&self.engine, &source)?;
        let (reader, params) = source.reader()?;
        let base = table_name(&resolved);
        let mut name = base.clone();
        for i in 2.. {
            if !self.tables.contains_key(&name) {
                break;
            }
            name = format!("{base}_{i}");
        }
        self.engine.execute_batch(&format!(
            "CREATE OR REPLACE VIEW {} AS SELECT * FROM {}",
            quote_ident(&name),
            inline_params(&reader, &params)
        ))?;
        self.tables.insert(
            name.clone(),
            Table {
                path: resolved,
                dataset: dataset.id,
            },
        );
        Ok((name.clone(), &self.tables[&name]))
    }

    fn table(&self, name: &str) -> Result<&Table> {
        self.tables.get(name).ok_or_else(|| {
            AppError::Query(format!(
                "No table named \"{name}\": describe_file opens a file as a table first."
            ))
        })
    }

    /// Answers one JSON-RPC message; None for notifications.
    pub fn handle(&mut self, msg: &Value) -> Option<Value> {
        let id = msg.get("id").cloned();
        let method = msg
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let id = id?;
        let result = match method {
            "initialize" => Ok(protocol::initialize(msg)),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools(self.config.allow_export) })),
            "tools/call" => Ok(self.call(&msg["params"])),
            _ => Err((-32601, format!("Method not found: {method}"))),
        };
        Some(match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
            }
        })
    }

    /// A tool call: its text, or the error as a tool error (the assistant reads it).
    fn call(&mut self, params: &Value) -> Value {
        if let Some(reload) = &self.reload {
            let fresh = reload();
            self.config.enabled = fresh.enabled;
            self.config.allow_export = fresh.allow_export;
            // Folders can only shrink while running (DuckDB's list is fixed).
            self.config.folders.retain(|f| fresh.folders.contains(f));
        }
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let args = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let started = Instant::now();
        let out = if self.config.enabled {
            self.tool(name, &args)
        } else {
            Err(AppError::Query(
                "DataLiq's AI access is turned off (DataLiq › Settings › AI assistants).".into(),
            ))
        };
        self.log(name, &args, &out, started);
        match out {
            Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
            Err(e) => {
                json!({ "content": [{ "type": "text", "text": e.to_string() }], "isError": true })
            }
        }
    }

    fn log(&self, tool: &str, args: &Value, out: &Result<String>, started: Instant) {
        let Some(path) = &self.config.log else { return };
        let line = json!({
            "time": chrono::Local::now().to_rfc3339(),
            "tool": tool,
            "arguments": args,
            "ok": out.is_ok(),
            "error": out.as_ref().err().map(ToString::to_string),
            "ms": started.elapsed().as_millis() as u64,
        });
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(f, "{line}");
        }
    }

    fn tool(&mut self, name: &str, args: &Value) -> Result<String> {
        let text = |k: &str| -> Result<String> {
            args.get(k)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| AppError::Query(format!("\"{k}\" is missing.")))
        };
        let number = |k: &str, default: usize, max: usize| {
            args.get(k)
                .and_then(Value::as_u64)
                .map_or(default, |n| (n as usize).clamp(1, max))
        };
        match name {
            "list_files" => self.list_files(args.get("folder").and_then(Value::as_str)),
            "describe_file" => {
                let (table, t) = self.open_table(&text("path")?)?;
                let (path, dataset) = (t.path.clone(), t.dataset.clone());
                let columns = self.engine.dataset_columns(&dataset)?;
                let rows = self.engine.datasets.get(&dataset)?.row_count;
                let (names, sample, _) =
                    self.rows(&format!("SELECT * FROM {}", quote_ident(&table)), 5)?;
                let cols = columns
                    .iter()
                    .map(|c| format!("- {} ({})", c.name, c.r#type))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(format!(
                    "{}: {rows} rows, {} columns. Query it as the table `{table}`.\n\nColumns:\n{cols}\n\nFirst rows:\n{}",
                    path.display(),
                    columns.len(),
                    markdown(&names, &sample)
                ))
            }
            "query" => {
                let sql = text("sql")?;
                check_select(&self.engine.connection()?, &sql)?;
                let max = number("max_rows", DEFAULT_ROWS, MAX_ROWS);
                let (names, rows, more) = self.rows(&sql, max)?;
                let note = if more {
                    format!("First {max} rows (there are more; aggregate or add LIMIT/WHERE).")
                } else {
                    format!(
                        "{} row{}.",
                        rows.len(),
                        if rows.len() == 1 { "" } else { "s" }
                    )
                };
                Ok(format!("{note}\n\n{}", markdown(&names, &rows)))
            }
            "profile_column" => {
                let t = self.table(&text("table")?)?;
                let p = self.engine.column_profile(
                    &t.dataset,
                    &ViewSpec::default(),
                    &text("column")?,
                    &RequestKey::default(),
                )?;
                let top = p
                    .top
                    .iter()
                    .map(|v| format!("- {}: {}", v.value.as_deref().unwrap_or("NULL"), v.count))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(format!(
                    "{} ({}): {} rows, {} empty, {}{} distinct\nmin {} · max {}{}\n\nMost common:\n{top}",
                    p.column,
                    p.r#type,
                    p.rows,
                    p.nulls,
                    if p.distinct_approx { "≈" } else { "" },
                    p.distinct.map_or("?".into(), |d| d.to_string()),
                    p.min.as_deref().unwrap_or("–"),
                    p.max.as_deref().unwrap_or("–"),
                    p.mean
                        .map(|m| format!(" · mean {m:.4} · std dev {:.4}", p.stddev.unwrap_or(0.0)))
                        .unwrap_or_default(),
                ))
            }
            "value_counts" => {
                let table = text("table")?;
                self.table(&table)?;
                let col = quote_ident(&text("column")?);
                let limit = number("limit", 20, MAX_ROWS);
                let sql = format!(
                    "SELECT {col} AS value, count(*) AS \"count\", \
                     round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS \"percent\" \
                     FROM {} GROUP BY 1 ORDER BY 2 DESC, 1 NULLS FIRST",
                    quote_ident(&table)
                );
                let (names, rows, more) = self.rows(&sql, limit)?;
                Ok(format!(
                    "{}\n\n{}",
                    if more {
                        format!("The {limit} most common values.")
                    } else {
                        "Every value.".into()
                    },
                    markdown(&names, &rows)
                ))
            }
            "summarize" => {
                let table = text("table")?;
                self.table(&table)?;
                let (names, rows, _) = self.rows(
                    &format!("SUMMARIZE SELECT * FROM {}", quote_ident(&table)),
                    MAX_ROWS,
                )?;
                Ok(markdown(&names, &rows))
            }
            "export_query" => self.export_query(&text("sql")?, &text("path")?),
            "open_in_dataliq" => {
                let path = self.allowed(&text("path")?)?;
                let exe = std::env::current_exe()?;
                std::process::Command::new(exe)
                    .arg(&path)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()?;
                Ok(format!("Opened {} in DataLiq.", path.display()))
            }
            other => Err(AppError::Query(format!(
                "There is no tool named \"{other}\"."
            ))),
        }
    }

    fn list_files(&self, folder: Option<&str>) -> Result<String> {
        let folders = match folder {
            Some(f) => vec![self.allowed(f)?],
            None => self.config.folders.clone(),
        };
        if folders.is_empty() {
            return Ok(
                "No folders are shared yet: add some in DataLiq › Settings › AI assistants.".into(),
            );
        }
        let mut out = String::new();
        for f in folders {
            out.push_str(&format!("{}\n", f.display()));
            let files = crate::export::convert::list_data_files(&f)?;
            if files.is_empty() {
                out.push_str("  (no data files)\n");
            }
            for file in files {
                out.push_str(&format!(
                    "  {} · {:?} · {} bytes\n",
                    file.path.display(),
                    file.format,
                    file.size_bytes
                ));
            }
            let mut subdirs: Vec<String> = std::fs::read_dir(&f)?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.is_dir()
                        && !p
                            .file_name()
                            .is_some_and(|n| n.to_string_lossy().starts_with('.'))
                })
                .map(|p| format!("  {}/ (folder)\n", p.display()))
                .collect();
            subdirs.sort();
            out.extend(subdirs);
        }
        Ok(out)
    }

    fn export_query(&self, sql: &str, path: &str) -> Result<String> {
        if !self.config.allow_export {
            return Err(AppError::Query(
                "Writing files is turned off (DataLiq › Settings › AI assistants).".into(),
            ));
        }
        let target = self.allowed(path)?;
        if target.exists() {
            return Err(AppError::Query(format!(
                "{} already exists; choose a new name.",
                target.display()
            )));
        }
        let conn = self.engine.connection()?;
        check_select(&conn, sql)?;
        let format = crate::cli::report::format_of(
            &target.file_name().unwrap_or_default().to_string_lossy(),
        )
        .filter(|f| *f != ExportFormat::Xlsx)
        .ok_or_else(|| {
            AppError::Query(
                "End the file name with .csv, .csv.gz, .tsv, .parquet, .json or .ndjson.".into(),
            )
        })?;
        let options = crate::export::copy_options_for(format)?;
        let rows = conn.execute(
            &format!(
                "COPY (\n{}\n) TO {} ({options})",
                sql.trim().trim_end_matches(';'),
                literal(&Param::Text(target.to_string_lossy().into_owned()))
            ),
            [],
        )?;
        Ok(format!("Wrote {rows} rows to {}.", target.display()))
    }
}

/// `dataliq mcp`: serves until stdin closes. The exit status.
pub fn main() -> i32 {
    let (settings_path, data_dir) = app_paths();
    let read = move || {
        settings_path
            .as_deref()
            .map(Settings::load_or_default)
            .unwrap_or_default()
    };
    let settings = read();
    let log = data_dir.map(|d| d.join(LOG_FILE));
    let config = McpConfig::from_settings(&settings, log.clone());
    if !config.enabled {
        eprintln!(
            "DataLiq's AI access is off. Turn it on in DataLiq › Settings › AI assistants, \
             then restart your assistant."
        );
        return 1;
    }
    let mut server = match Server::new(config, &settings) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("dataliq mcp: {e}");
            return 1;
        }
    };
    server.reload_with(move || McpConfig::from_settings(&read(), log.clone()));
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => server.handle(&msg),
            Err(e) => Some(json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32700, "message": format!("Parse error: {e}") }
            })),
        };
        if let Some(reply) = reply {
            if writeln!(stdout, "{reply}")
                .and_then(|()| stdout.flush())
                .is_err()
            {
                break;
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_names_from_file_names() {
        assert_eq!(
            table_name(Path::new("/d/Calls 2024-10.csv.gz")),
            "calls_2024_10"
        );
        assert_eq!(table_name(Path::new("/d/2024.parquet")), "t_2024");
        assert_eq!(table_name(Path::new("/d/.csv")), "data");
    }

    #[test]
    fn rows_as_markdown() {
        let md = markdown(
            &["a".into(), "b|c".into()],
            &[
                vec![Some("x\ny".into()), None],
                vec![Some("é".repeat(300)), Some("1".into())],
            ],
        );
        let lines: Vec<&str> = md.lines().collect();
        assert_eq!(lines[0], "| a | b\\|c |");
        assert_eq!(lines[1], "| --- | --- |");
        assert_eq!(lines[2], "| x y | NULL |");
        assert!(lines[3].contains('…') && lines[3].chars().count() < 220);
    }

    #[test]
    fn initialize_answers_a_known_version() {
        let ask = |v: &str| protocol::initialize(&json!({"params": {"protocolVersion": v}}));
        assert_eq!(ask("2024-11-05")["protocolVersion"], "2024-11-05");
        assert_eq!(ask("1999-01-01")["protocolVersion"], PROTOCOL_VERSIONS[0]);
        assert!(tools(false).iter().all(|t| t["name"] != "export_query"));
        assert!(tools(true).iter().any(|t| t["name"] == "export_query"));
    }
}
