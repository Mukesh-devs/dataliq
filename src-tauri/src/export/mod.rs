//! Export a view (or a SQL result) to a file: CSV, CSV.gz, TSV, Parquet,
//! JSON, NDJSON through DuckDB's `COPY`, and XLSX through rust_xlsxwriter.
//! Files are written next to the target as `.partial` and renamed when
//! complete, so a cancelled or failed export never leaves half a file.

mod xlsx;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::engine::sql::{inline_params, literal, quote_ident};
use crate::engine::{Engine, Param};
use crate::error::{AppError, Result};
use crate::view::{Relation, ViewSpec, build};

pub use xlsx::MAX_SHEET_ROWS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Csv,
    CsvGz,
    Tsv,
    Parquet,
    Json,
    Ndjson,
    Xlsx,
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::Csv => "csv",
            ExportFormat::CsvGz => "csv.gz",
            ExportFormat::Tsv => "tsv",
            ExportFormat::Parquet => "parquet",
            ExportFormat::Json => "json",
            ExportFormat::Ndjson => "ndjson",
            ExportFormat::Xlsx => "xlsx",
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    /// A header row with the column names (CSV, TSV, XLSX). Default true.
    pub header: Option<bool>,
    /// CSV only; one character. Default ",".
    pub delimiter: Option<String>,
    /// Quote every value instead of only those that need it (CSV, TSV).
    pub quote_all: bool,
    /// strftime formats for dates and timestamps (CSV, TSV, JSON).
    pub date_format: Option<String>,
    pub timestamp_format: Option<String>,
    /// XLSX past 1,048,575 rows: more sheets (default), or stop there.
    pub split_sheets: Option<bool>,
    /// Only these positions of the view, as `[start, end)` ranges.
    pub rows: Option<Vec<[u64; 2]>>,
}

/// What to export: a view (`spec`) of a dataset, its columns (in
/// `spec.columns` order) under their display names (`labels`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub dataset_id: String,
    pub spec: ViewSpec,
    #[serde(default)]
    pub labels: HashMap<String, String>,
    pub path: PathBuf,
    pub format: ExportFormat,
    #[serde(default)]
    pub options: ExportOptions,
    /// Rows to expect, for progress (XLSX); optional.
    #[serde(default)]
    pub total_rows: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub path: PathBuf,
    pub rows: u64,
    /// XLSX: sheets written.
    pub sheets: u32,
    /// XLSX without splitting: rows left out past the sheet limit.
    pub rows_left_out: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub job_id: String,
    /// 0–100, or null while it can't be estimated.
    pub percent: Option<f64>,
    pub elapsed_ms: u64,
}

struct Job {
    cancelled: Arc<AtomicBool>,
    /// Interrupts the running statement.
    interrupt: Box<dyn Fn() + Send + Sync>,
}

/// Running exports by job id, for Cancel.
#[derive(Default)]
pub struct Exports {
    jobs: Mutex<HashMap<String, Job>>,
}

impl Exports {
    pub fn cancel(&self, job_id: &str) -> bool {
        match self.jobs.lock().get(job_id) {
            Some(job) => {
                job.cancelled.store(true, Ordering::SeqCst);
                (job.interrupt)();
                true
            }
            None => false,
        }
    }
}

/// Display names made unique ("amount", "amount (2)") so every format can
/// hold them.
fn output_names(columns: &[String], labels: &HashMap<String, String>) -> Vec<String> {
    let mut seen = HashSet::new();
    columns
        .iter()
        .map(|c| {
            let base = labels.get(c).cloned().unwrap_or_else(|| c.clone());
            let mut name = base.clone();
            let mut n = 2;
            while !seen.insert(name.to_lowercase()) {
                name = format!("{base} ({n})");
                n += 1;
            }
            name
        })
        .collect()
}

/// The rows to write, in the view's order, as one SQL statement with values
/// inlined (COPY takes no parameters).
pub fn export_query(engine: &Engine, req: &ExportRequest) -> Result<String> {
    let ds = engine.datasets.get(&req.dataset_id)?;
    let schema = engine.dataset_columns(&req.dataset_id)?;
    let columns: Vec<String> = match &req.spec.columns {
        Some(c) if !c.is_empty() => c.clone(),
        _ => schema.iter().map(|c| c.name.clone()).collect(),
    };
    let spec = ViewSpec {
        columns: Some(columns.clone()),
        ..req.spec.clone()
    };
    let built = build(&spec, &Relation::of(&ds.source), &schema)?;
    let view = inline_params(&built.select, &built.params);
    let names = output_names(&columns, &req.labels);
    let projection = columns
        .iter()
        .zip(&names)
        .map(|(c, n)| format!("{} AS {}", quote_ident(c), quote_ident(n)))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(match &req.options.rows {
        Some(ranges) if !ranges.is_empty() => {
            let pos = quote_ident("__dataliq_pos");
            let keep = ranges
                .iter()
                .map(|[a, b]| format!("({pos} >= {a} AND {pos} < {b})"))
                .collect::<Vec<_>>()
                .join(" OR ");
            format!(
                "SELECT {projection} FROM (SELECT *, row_number() OVER () - 1 AS {pos} FROM ({view})) WHERE {keep} ORDER BY {pos}"
            )
        }
        _ => format!("SELECT {projection} FROM ({view})"),
    })
}

fn text(s: &str) -> String {
    literal(&Param::Text(s.to_string()))
}

/// `COPY … TO` options for a DuckDB format.
fn copy_options(format: ExportFormat, o: &ExportOptions) -> Result<String> {
    let mut opts = Vec::new();
    let csv_like = matches!(
        format,
        ExportFormat::Csv | ExportFormat::CsvGz | ExportFormat::Tsv
    );
    match format {
        ExportFormat::Parquet => {
            opts.push("FORMAT parquet".to_string());
            opts.push("COMPRESSION zstd".to_string());
        }
        ExportFormat::Json => {
            opts.push("FORMAT json".to_string());
            opts.push("ARRAY true".to_string());
        }
        ExportFormat::Ndjson => opts.push("FORMAT json".to_string()),
        _ => {
            opts.push("FORMAT csv".to_string());
            opts.push(format!("HEADER {}", o.header.unwrap_or(true)));
            let delim = match format {
                ExportFormat::Tsv => "\t".to_string(),
                _ => o.delimiter.clone().unwrap_or_else(|| ",".into()),
            };
            if delim.chars().count() != 1 {
                return Err(AppError::Query(
                    "The delimiter must be a single character.".into(),
                ));
            }
            opts.push(format!("DELIMITER {}", text(&delim)));
            opts.push("QUOTE '\"'".to_string());
            if o.quote_all {
                opts.push("FORCE_QUOTE *".to_string());
            }
            opts.push(format!(
                "COMPRESSION {}",
                if format == ExportFormat::CsvGz {
                    "gzip"
                } else {
                    "none"
                }
            ));
        }
    }
    if csv_like || matches!(format, ExportFormat::Json | ExportFormat::Ndjson) {
        if let Some(f) = o.date_format.as_deref().filter(|f| !f.is_empty()) {
            opts.push(format!("DATEFORMAT {}", text(f)));
        }
        if let Some(f) = o.timestamp_format.as_deref().filter(|f| !f.is_empty()) {
            opts.push(format!("TIMESTAMPFORMAT {}", text(f)));
        }
    }
    Ok(opts.join(", "))
}

/// The temporary file next to `path` that becomes `path` when complete.
fn partial_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".partial");
    path.with_file_name(name)
}

/// Exports `req`, reporting progress, until done or cancelled by `job_id`.
pub fn export(
    engine: &Engine,
    exports: &Exports,
    req: &ExportRequest,
    job_id: &str,
    on_progress: &(dyn Fn(ExportProgress) + Sync),
) -> Result<ExportOutcome> {
    let _busy = engine.busy();
    let started = Instant::now();
    let query = export_query(engine, req)?;
    if let Some(dir) = req.path.parent().filter(|d| !d.as_os_str().is_empty()) {
        if !dir.is_dir() {
            return Err(AppError::Query(format!(
                "The folder {} does not exist.",
                dir.display()
            )));
        }
    }
    let partial = partial_path(&req.path);
    let _ = std::fs::remove_file(&partial);
    let cancelled = Arc::new(AtomicBool::new(false));
    let report = |percent: Option<f64>| {
        on_progress(ExportProgress {
            job_id: job_id.to_string(),
            percent,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    };

    let register = |interrupt: Box<dyn Fn() + Send + Sync>| {
        exports.jobs.lock().insert(
            job_id.to_string(),
            Job {
                cancelled: Arc::clone(&cancelled),
                interrupt,
            },
        );
    };
    let result = if req.format == ExportFormat::Xlsx {
        let conn = engine.connection()?;
        let handle = conn.interrupt_handle();
        register(Box::new(move || handle.interrupt()));
        let header = req.options.header.unwrap_or(true);
        let opts = xlsx::Options {
            header,
            sheet_rows: MAX_SHEET_ROWS - u64::from(header),
            split_sheets: req.options.split_sheets.unwrap_or(true),
            total_rows: req.total_rows,
        };
        xlsx::write(&conn, &query, &partial, &opts, &cancelled, &|p| {
            report(Some(p))
        })
    } else {
        let conn = Arc::new(engine.raw_connection()?);
        let handle = Arc::clone(&conn);
        register(Box::new(move || handle.interrupt()));
        copy(&conn, &query, &partial, req, &cancelled, &report)
    };
    exports.jobs.lock().remove(job_id);
    match result {
        Ok(written) => {
            std::fs::rename(&partial, &req.path)?;
            Ok(ExportOutcome {
                path: req.path.clone(),
                rows: written.rows,
                sheets: written.sheets,
                rows_left_out: written.left_out,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        }
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            Err(if cancelled.load(Ordering::SeqCst) {
                AppError::Cancelled
            } else {
                e
            })
        }
    }
}

/// Rows written (and, for XLSX, sheets and rows left out).
pub(crate) struct Written {
    pub rows: u64,
    pub sheets: u32,
    pub left_out: u64,
}

fn copy(
    conn: &crate::engine::raw::RawConnection,
    query: &str,
    partial: &Path,
    req: &ExportRequest,
    cancelled: &AtomicBool,
    report: &(dyn Fn(Option<f64>) + Sync),
) -> Result<Written> {
    let options = copy_options(req.format, &req.options)?;
    conn.execute("SET enable_progress_bar = true", &[])?;
    conn.execute("SET enable_progress_bar_print = false", &[])?;
    let done = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let reporter = scope.spawn(|| {
            loop {
                std::thread::park_timeout(Duration::from_millis(250));
                if done.load(Ordering::SeqCst) {
                    break;
                }
                report(conn.progress().percent);
            }
        });
        let run = || -> Result<Written> {
            // A cancel before the statement starts isn't seen by the interrupt.
            if cancelled.load(Ordering::SeqCst) {
                return Err(AppError::Cancelled);
            }
            let rows = conn.execute_count(
                &format!(
                    "COPY ({query}) TO {} ({options})",
                    text(&partial.to_string_lossy())
                ),
                &[],
            )?;
            if cancelled.load(Ordering::SeqCst) {
                return Err(AppError::Cancelled);
            }
            Ok(Written {
                rows: rows.max(0) as u64,
                sheets: 0,
                left_out: 0,
            })
        };
        let r = run();
        done.store(true, Ordering::SeqCst);
        reporter.thread().unpark();
        r
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names_are_made_unique() {
        let cols: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let labels = HashMap::from([
            ("a".to_string(), "Total".to_string()),
            ("b".to_string(), "total".to_string()),
        ]);
        assert_eq!(output_names(&cols, &labels), ["Total", "total (2)", "c"]);
    }

    #[test]
    fn copy_options_by_format() {
        let o = ExportOptions {
            header: Some(false),
            delimiter: Some(";".into()),
            quote_all: true,
            date_format: Some("%d/%m/%Y".into()),
            ..Default::default()
        };
        assert_eq!(
            copy_options(ExportFormat::Csv, &o).unwrap(),
            "FORMAT csv, HEADER false, DELIMITER ';', QUOTE '\"', FORCE_QUOTE *, COMPRESSION none, DATEFORMAT '%d/%m/%Y'"
        );
        assert!(
            copy_options(ExportFormat::CsvGz, &ExportOptions::default())
                .unwrap()
                .contains("COMPRESSION gzip")
        );
        assert!(
            copy_options(ExportFormat::Tsv, &o)
                .unwrap()
                .contains("DELIMITER '\t'")
        );
        assert_eq!(
            copy_options(ExportFormat::Parquet, &o).unwrap(),
            "FORMAT parquet, COMPRESSION zstd"
        );
        assert!(
            copy_options(
                ExportFormat::Csv,
                &ExportOptions {
                    delimiter: Some("||".into()),
                    ..Default::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn partial_files_sit_next_to_the_target() {
        assert_eq!(
            partial_path(Path::new("/tmp/out.csv.gz")),
            PathBuf::from("/tmp/out.csv.gz.partial")
        );
    }
}
