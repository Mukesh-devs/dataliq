//! Converting many files at once (a folder of CSV.gz to Parquet, …): each
//! file is read with its detected reader and written by DuckDB's `COPY`,
//! one after another, without opening them as tabs.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::{ExportFormat, ExportOptions, Exports, Job, copy_options, partial_path, text};
use crate::engine::Engine;
use crate::engine::sql::inline_params;
use crate::error::{AppError, Result};
use crate::sources::detect::{self, FileFormat};
use crate::sources::{OpenOptions, Source};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    pub files: Vec<PathBuf>,
    pub format: ExportFormat,
    /// Where the new files go; each keeps its name with the new extension.
    pub out_dir: PathBuf,
    /// Replace files that already exist (otherwise they are skipped).
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertProgress {
    pub job_id: String,
    /// Files finished (converted, skipped or failed).
    pub done: usize,
    pub total: usize,
    /// The file being converted.
    pub file: String,
    /// 0–100 over all files.
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertedFile {
    pub source: PathBuf,
    /// The new file; none when it failed or was skipped.
    pub output: Option<PathBuf>,
    pub rows: u64,
    pub source_bytes: u64,
    pub output_bytes: u64,
    /// Why it wasn't converted.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertOutcome {
    pub files: Vec<ConvertedFile>,
    pub elapsed_ms: u64,
}

/// A data file of a folder, for the converter's list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFile {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub format: FileFormat,
}

/// The data files directly in `folder` (no subfolders, no hidden files),
/// by name: CSV, TSV, JSON, NDJSON and Parquet, compressed or not. Excel
/// files and databases are left out (they hold sheets and tables).
pub fn list_data_files(folder: &Path) -> Result<Vec<DataFile>> {
    if !folder.is_dir() {
        return Err(AppError::Query(format!(
            "The folder {} does not exist.",
            folder.display()
        )));
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(folder)? {
        let path = entry?.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if !path.is_file() || name.starts_with('.') || name.ends_with(".partial") {
            continue;
        }
        let Ok(found) = detect::detect(&path) else {
            continue;
        };
        let known_ext = detect::extensions(&path)
            .0
            .as_deref()
            .and_then(detect::format_from_ext)
            .is_some();
        let flat = matches!(
            found.format,
            FileFormat::Csv
                | FileFormat::Tsv
                | FileFormat::Json
                | FileFormat::Ndjson
                | FileFormat::Parquet
        );
        if !known_ext || !flat {
            continue;
        }
        out.push(DataFile {
            size_bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            path,
            format: found.format,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// `sales.csv.gz` -> `sales.parquet` (the data and compression extensions go).
pub fn output_name(source: &Path, format: ExportFormat) -> String {
    let name = source.file_name().unwrap_or_default().to_string_lossy();
    let mut stem = name.to_string();
    for ext in [".gz", ".gzip", ".zst", ".zstd"] {
        if stem.to_lowercase().ends_with(ext) {
            stem.truncate(stem.len() - ext.len());
            break;
        }
    }
    if let Some((base, ext)) = stem.rsplit_once('.') {
        if !base.is_empty() && detect::format_from_ext(&ext.to_lowercase()).is_some() {
            stem = base.to_string();
        }
    }
    format!("{stem}.{}", format.extension())
}

/// Converts `req.files` one by one, reporting progress, until done or
/// cancelled by `job_id` (with `cancel_export`). A file that fails is
/// reported and the others carry on.
pub fn convert(
    engine: &Engine,
    exports: &Exports,
    req: &ConvertRequest,
    job_id: &str,
    on_progress: &(dyn Fn(ConvertProgress) + Sync),
) -> Result<ConvertOutcome> {
    let _busy = engine.busy();
    let started = Instant::now();
    if req.format == ExportFormat::Xlsx {
        return Err(AppError::Query(
            "Convert to CSV, TSV, Parquet or JSON; export to Excel from a tab.".into(),
        ));
    }
    if !req.out_dir.is_dir() {
        return Err(AppError::Query(format!(
            "The folder {} does not exist.",
            req.out_dir.display()
        )));
    }
    let what = "convert these files";
    crate::disk::ensure_space(
        &req.out_dir,
        estimated_bytes(req),
        what,
        "Free up space, choose another folder, or convert fewer files at a time.",
    )?;
    let conn = Arc::new(engine.raw_connection()?);
    conn.execute("SET enable_progress_bar = true", &[])?;
    conn.execute("SET enable_progress_bar_print = false", &[])?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let handle = Arc::clone(&conn);
        exports.jobs.lock().insert(
            job_id.to_string(),
            Job {
                cancelled: Arc::clone(&cancelled),
                interrupt: Box::new(move || handle.interrupt()),
            },
        );
    }
    let options = copy_options(req.format, &ExportOptions::default())?;
    let total = req.files.len();
    let mut files = Vec::with_capacity(total);
    let result = (|| -> Result<()> {
        for (i, source) in req.files.iter().enumerate() {
            if cancelled.load(Ordering::SeqCst) {
                return Err(AppError::Cancelled);
            }
            let name = source.file_name().unwrap_or_default().to_string_lossy();
            let report = |file_percent: f64| {
                on_progress(ConvertProgress {
                    job_id: job_id.to_string(),
                    done: i,
                    total,
                    file: name.to_string(),
                    percent: (i as f64 + file_percent / 100.0) / total.max(1) as f64 * 100.0,
                })
            };
            report(0.0);
            let output = req.out_dir.join(output_name(source, req.format));
            let source_bytes = std::fs::metadata(source).map(|m| m.len()).unwrap_or(0);
            let mut file = ConvertedFile {
                source: source.clone(),
                output: None,
                rows: 0,
                source_bytes,
                output_bytes: 0,
                error: None,
            };
            if output == *source {
                file.error = Some("It is already in this format here.".into());
            } else if output.exists() && !req.overwrite {
                file.error = Some(format!(
                    "{} already exists.",
                    output.file_name().unwrap_or_default().to_string_lossy()
                ));
            } else {
                match convert_one(
                    engine, &conn, source, &output, &options, &cancelled, &report,
                ) {
                    Ok(rows) => {
                        file.output_bytes =
                            std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
                        file.rows = rows;
                        file.output = Some(output);
                    }
                    Err(AppError::Cancelled) => return Err(AppError::Cancelled),
                    Err(_) if cancelled.load(Ordering::SeqCst) => {
                        return Err(AppError::Cancelled);
                    }
                    Err(e) => {
                        let e = crate::disk::full_while_writing(e, &req.out_dir, what);
                        file.error = Some(e.to_string());
                    }
                }
            }
            files.push(file);
        }
        Ok(())
    })();
    exports.jobs.lock().remove(job_id);
    result?;
    on_progress(ConvertProgress {
        job_id: job_id.to_string(),
        done: total,
        total,
        file: String::new(),
        percent: 100.0,
    });
    Ok(ConvertOutcome {
        files,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// About how many bytes converting `req.files` writes: each file's size
/// as text (from its format's usual ratio), then the output's ratio.
pub fn estimated_bytes(req: &ConvertRequest) -> u64 {
    let out = crate::disk::format_ratio(req.format);
    req.files
        .iter()
        .map(|f| {
            let size = std::fs::metadata(f).map(|m| m.len()).unwrap_or(0) as f64;
            let as_text = match detect::detect(f) {
                // The low end of how much these hold (a 4th of their text or more).
                Ok(d) if d.compression != detect::Compression::None => size * 4.0,
                Ok(d) if d.format == FileFormat::Parquet => size * 4.0,
                Ok(d) if matches!(d.format, FileFormat::Json | FileFormat::Ndjson) => size / 1.5,
                _ => size,
            };
            (as_text * out) as u64
        })
        .sum()
}

/// One file: read with its detected reader, written to `output` through a
/// `.partial` file. Returns the rows written.
fn convert_one(
    engine: &Engine,
    conn: &crate::engine::raw::RawConnection,
    source: &Path,
    output: &Path,
    options: &str,
    cancelled: &AtomicBool,
    report: &(dyn Fn(f64) + Sync),
) -> Result<u64> {
    // The same dialect the app would pick when opening it.
    let src = Source::new(source, OpenOptions::default())?.resolve_dialect(engine)?;
    if src.is_excel() {
        return Err(AppError::Query(
            "Excel files are converted from a tab.".into(),
        ));
    }
    let (reader, params) = src.reader()?;
    let partial = partial_path(output);
    let _ = std::fs::remove_file(&partial);
    let sql = format!(
        "COPY (SELECT * FROM {}) TO {} ({options})",
        inline_params(&reader, &params),
        text(&partial.to_string_lossy())
    );
    let done = AtomicBool::new(false);
    let rows = std::thread::scope(|scope| {
        scope.spawn(|| {
            while !done.load(Ordering::SeqCst) {
                std::thread::park_timeout(std::time::Duration::from_millis(250));
                if let Some(p) = conn.progress().percent {
                    report(p);
                }
            }
        });
        let out = if cancelled.load(Ordering::SeqCst) {
            Err(AppError::Cancelled)
        } else {
            conn.execute_count(&sql, &[])
        };
        done.store(true, Ordering::SeqCst);
        out
    });
    match rows {
        Ok(n) => {
            std::fs::rename(&partial, output)?;
            Ok(n.max(0) as u64)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_names_drop_data_and_compression_extensions() {
        let n = |s: &str, f| output_name(Path::new(s), f);
        assert_eq!(n("/d/sales.csv.gz", ExportFormat::Parquet), "sales.parquet");
        assert_eq!(n("/d/Sales.CSV", ExportFormat::Parquet), "Sales.parquet");
        assert_eq!(
            n("/d/logs.2024.ndjson.zst", ExportFormat::Csv),
            "logs.2024.csv"
        );
        assert_eq!(n("/d/v1.2.parquet", ExportFormat::CsvGz), "v1.2.csv.gz");
        assert_eq!(n("/d/noext", ExportFormat::Json), "noext.json");
    }
}
