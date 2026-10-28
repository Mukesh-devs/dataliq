//! File sources: format detection and the DuckDB reader call for each format.

pub mod csv;
pub mod detect;
pub mod excel;
mod friendly;
pub mod integrity;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use csv::CsvOptions;
pub use detect::{Compression, Detected, FileFormat};
pub use excel::{ExcelInfo, ExcelOptions};
pub use friendly::friendly_error;

use crate::engine::{Engine, Param, RequestKey};
use crate::error::{AppError, Result};

/// What the user asked to open, plus their import settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenOptions {
    pub csv: CsvOptions,
    pub excel: ExcelOptions,
}

/// CSV settings as detected by DuckDB's sniffer, shown in the Import settings popover.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SniffedCsv {
    pub delimiter: String,
    pub quote: String,
    pub escape: String,
    pub new_line: String,
    pub skip_rows: u32,
    pub has_header: bool,
    pub date_format: Option<String>,
    pub timestamp_format: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    /// DuckDB type name, e.g. `BIGINT`, `VARCHAR`, `DATE`.
    pub r#type: String,
}

/// Everything the UI needs to show a newly opened file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub path: PathBuf,
    pub file_name: String,
    pub size_bytes: u64,
    pub format: FileFormat,
    pub compression: Compression,
    /// Detected CSV settings (CSV/TSV only).
    pub sniffed: Option<SniffedCsv>,
    /// Sheets and header row (Excel only).
    pub excel: Option<ExcelInfo>,
    pub columns: Vec<ColumnMeta>,
    /// The table expression used to read the file, for "Copy as SQL".
    pub reader_sql: String,
    /// Set once the full data can be paged (after import, or at once for Parquet).
    pub dataset: Option<crate::engine::Dataset>,
}

/// A file plus the options to read it: everything needed to build its SQL.
#[derive(Debug, Clone)]
pub struct Source {
    pub path: PathBuf,
    pub detected: Detected,
    pub options: OpenOptions,
}

impl Source {
    /// Validates the path and options and detects the format. Call
    /// [`Source::resolve_dialect`] before reading CSV files.
    pub fn new(path: &Path, options: OpenOptions) -> Result<Source> {
        if !path.is_file() {
            return Err(AppError::Query(format!(
                "File not found: {}",
                path.display()
            )));
        }
        if std::fs::metadata(path)?.len() == 0 {
            return Err(AppError::Query("This file is empty.".into()));
        }
        options.csv.validate().map_err(AppError::Query)?;
        let detected = detect::detect(path)?;
        Ok(Source {
            path: path.to_path_buf(),
            detected,
            options,
        })
    }

    fn path_str(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    /// Table expression and parameters, e.g. `read_csv(?, compression = ?)`.
    pub fn reader(&self) -> Result<(String, Vec<Param>)> {
        let Detected {
            format,
            compression,
        } = self.detected;
        match format {
            FileFormat::Csv | FileFormat::Tsv => Ok(csv::reader_call(
                "read_csv",
                &self.path_str(),
                format,
                compression,
                &self.options.csv,
            )),
            FileFormat::Json | FileFormat::Ndjson => {
                // `auto` accepts both a JSON array and newline-delimited JSON,
                // so a mislabeled .json still opens.
                let layout = if format == FileFormat::Ndjson {
                    "newline_delimited"
                } else {
                    "auto"
                };
                Ok((
                    "read_json(?, format = ?, compression = ?)".to_string(),
                    vec![
                        Param::Text(self.path_str()),
                        Param::Text(layout.into()),
                        Param::Text(compression.duckdb_file_compression().into()),
                    ],
                ))
            }
            FileFormat::Parquet => Ok((
                "read_parquet(?)".to_string(),
                vec![Param::Text(self.path_str())],
            )),
            FileFormat::Xlsx | FileFormat::Xls => Err(AppError::Query(
                "Excel files can't be read in place. Free up some disk space so the sheet can be imported.".into(),
            )),
        }
    }

    /// Parquet is already columnar and fast: it is queried in place instead
    /// of being imported, with the row count read from the file metadata.
    pub fn is_queried_in_place(&self) -> bool {
        self.detected.format == FileFormat::Parquet
    }

    /// Reader SQL with literal values, for display ("Copy as SQL") only.
    pub fn reader_display_sql(&self) -> Result<String> {
        let (sql, params) = self.reader()?;
        Ok(inline_params(&sql, &params))
    }

    fn is_csv(&self) -> bool {
        matches!(self.detected.format, FileFormat::Csv | FileFormat::Tsv)
    }

    /// Runs DuckDB's CSV sniffer. Returns the settings plus (column count,
    /// first column name).
    fn sniff_raw(&self, engine: &Engine) -> Result<(SniffedCsv, usize, String)> {
        let Detected {
            format,
            compression,
        } = self.detected;
        let (call, params) = csv::reader_call(
            "sniff_csv",
            &self.path_str(),
            format,
            compression,
            &self.options.csv,
        );
        let sql = format!(
            "SELECT Delimiter, Quote, Escape, NewLineDelimiter, SkipRows::INTEGER, HasHeader, \
             DateFormat, TimestampFormat, len(Columns)::INTEGER, Columns[1].name FROM {call}"
        );
        let conn = engine.connection()?;
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| self.explain_sniff_error(engine, &e.to_string()))?;
        stmt.query_row(duckdb::params_from_iter(params.iter()), |r| {
            Ok((
                SniffedCsv {
                    delimiter: r.get(0)?,
                    quote: r.get(1)?,
                    escape: r.get(2)?,
                    new_line: r.get(3)?,
                    skip_rows: r.get::<_, i32>(4)? as u32,
                    has_header: r.get(5)?,
                    date_format: r.get::<_, Option<String>>(6)?.filter(|s| !s.is_empty()),
                    timestamp_format: r.get::<_, Option<String>>(7)?.filter(|s| !s.is_empty()),
                },
                r.get::<_, i32>(8)? as usize,
                r.get::<_, Option<String>>(9)?.unwrap_or_default(),
            ))
        })
        .map_err(|e| self.explain_sniff_error(engine, &e.to_string()))
    }

    /// The sniffer only says "could not detect the dialect". When the
    /// delimiter is known, scan the sample with DuckDB's reject tables to name
    /// the first bad line instead.
    fn explain_sniff_error(&self, engine: &Engine, raw: &str) -> AppError {
        if !raw.contains("not possible to automatically detect")
            || self.options.csv.delimiter.is_none()
        {
            return friendly_error(raw);
        }
        self.first_bad_line(engine)
            .map(AppError::Query)
            .unwrap_or_else(|| friendly_error(raw))
    }

    fn first_bad_line(&self, engine: &Engine) -> Option<String> {
        let Detected {
            format,
            compression,
        } = self.detected;
        let mut opts = self.options.csv.clone();
        opts.ignore_errors = false;
        if opts.header.is_none() {
            opts.header = Some(true);
        }
        let (call, params) = csv::reader_call_with(
            "read_csv",
            &self.path_str(),
            format,
            compression,
            &opts,
            &[
                ("store_rejects", Param::Bool(true)),
                ("rejects_table", Param::Text("bv_rejects".into())),
                ("rejects_scan", Param::Text("bv_reject_scans".into())),
            ],
        );
        // Temp tables live only on this connection.
        let conn = engine.connection().ok()?;
        conn.execute(
            &format!("CREATE TEMP TABLE bv_probe AS SELECT * FROM {call} LIMIT 20480"),
            duckdb::params_from_iter(params.iter()),
        )
        .ok()?;
        let expected: i64 = conn
            .query_row("SELECT count(*) FROM (DESCRIBE bv_probe)", [], |r| r.get(0))
            .ok()?;
        let (line, kind, col): (i64, String, i64) = conn
            .query_row(
                "SELECT line, error_type::VARCHAR, column_idx FROM bv_rejects ORDER BY line LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok()?;
        let line = friendly::group_digits(&line.to_string());
        Some(match kind.as_str() {
            "TOO MANY COLUMNS" => format!(
                "Line {line} has {col} columns, expected {expected}. Try \"Ignore bad rows\" in Import settings."
            ),
            "MISSING COLUMNS" => format!(
                "Line {line} has {} columns, expected {expected}. Try \"Ignore bad rows\" in Import settings.",
                col - 1
            ),
            _ => format!(
                "Line {line} has a value that doesn't fit its column. Try \"Ignore bad rows\" in Import settings."
            ),
        })
    }

    /// Runs DuckDB's CSV sniffer on the file (CSV/TSV only).
    pub fn sniff(&self, engine: &Engine) -> Result<Option<SniffedCsv>> {
        if !self.is_csv() {
            return Ok(None);
        }
        Ok(Some(self.sniff_raw(engine)?.0))
    }

    /// DuckDB's sniffer needs every sampled row to have the same number of
    /// columns; one bad row makes it fall back to a single text column. If
    /// that single column's name contains a common delimiter, use that
    /// delimiter explicitly so the real problem (a bad row) is reported and
    /// "Ignore bad rows" can fix it.
    pub fn resolve_dialect(mut self, engine: &Engine) -> Result<Source> {
        if !self.is_csv() || self.options.csv.delimiter.is_some() {
            return Ok(self);
        }
        let (_, columns, first) = self.sniff_raw(engine)?;
        if columns == 1 {
            let candidate = [",", ";", "\t", "|"]
                .into_iter()
                .filter(|d| first.contains(d))
                .max_by_key(|d| first.matches(d).count());
            if let Some(d) = candidate {
                self.options.csv.delimiter = Some(d.to_string());
            }
        }
        Ok(self)
    }

    /// Column names and DuckDB types, via `DESCRIBE`.
    pub fn columns(&self, engine: &Engine) -> Result<Vec<ColumnMeta>> {
        let (reader, params) = self.reader()?;
        let conn = engine.connection()?;
        let mut stmt = conn
            .prepare(&format!("DESCRIBE SELECT * FROM {reader}"))
            .map_err(|e| friendly_error(&e.to_string()))?;
        let rows = stmt
            .query_map(duckdb::params_from_iter(params.iter()), |r| {
                Ok(ColumnMeta {
                    name: r.get(0)?,
                    r#type: r.get(1)?,
                })
            })
            .map_err(|e| friendly_error(&e.to_string()))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| friendly_error(&e.to_string()))
    }

    pub fn is_excel(&self) -> bool {
        matches!(self.detected.format, FileFormat::Xlsx | FileFormat::Xls)
    }

    /// Reads an Excel sheet (all of it, or the first `max_rows` data rows).
    pub fn load_excel(&self, max_rows: Option<usize>) -> Result<excel::Sheet> {
        excel::load(
            &self.path,
            &self.options.excel,
            self.detected.format == FileFormat::Xlsx,
            max_rows,
        )
    }

    /// Detects, sniffs and describes the file.
    pub fn inspect(&self, engine: &Engine) -> Result<SourceInfo> {
        let (sniffed, columns, excel, reader_sql) = if self.is_excel() {
            let sheet = self.load_excel(Some(1000))?;
            let columns = sheet
                .names
                .iter()
                .zip(&sheet.types)
                .map(|(n, t)| ColumnMeta {
                    name: n.clone(),
                    r#type: t.sql().to_string(),
                })
                .collect();
            let sql =
                excel::reader_sql(&self.path, self.detected.format == FileFormat::Xlsx, &sheet);
            (None, columns, Some(sheet.info), sql)
        } else {
            (
                self.sniff(engine)?,
                self.columns(engine)?,
                None,
                self.reader_display_sql()?,
            )
        };
        Ok(SourceInfo {
            file_name: self
                .path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            size_bytes: std::fs::metadata(&self.path)?.len(),
            format: self.detected.format,
            compression: self.detected.compression,
            sniffed,
            excel,
            columns,
            reader_sql,
            dataset: None,
            path: self.path.clone(),
        })
    }

    /// First `limit` rows read straight from the file, as Arrow IPC bytes.
    pub fn preview_ipc(&self, engine: &Engine, limit: usize, key: &RequestKey) -> Result<Vec<u8>> {
        if self.is_excel() {
            // Temp table on one connection, queried on that same connection.
            let sheet = self.load_excel(Some(limit))?;
            if sheet.names.is_empty() {
                // An empty sheet: no columns, no rows.
                return crate::engine::batches_to_ipc(&arrow::datatypes::Schema::empty(), &[]);
            }
            let conn = engine.connection()?;
            let never = std::sync::atomic::AtomicBool::new(false);
            excel::write_table(&conn, None, "bv_preview", &sheet, &never, &|_| {})?;
            return Engine::query_ipc_on(&conn, "SELECT * FROM temp.bv_preview", limit);
        }
        let (reader, params) = self.reader()?;
        let sql = format!("SELECT * FROM {reader} LIMIT {limit}");
        engine
            .query_ipc(&sql, &params, limit, key)
            .map_err(|e| match e {
                AppError::Query(m) => friendly_error(&m),
                other => other,
            })
    }
}

pub use crate::engine::sql::inline_params;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inlines_params_as_escaped_literals() {
        let sql = inline_params(
            "read_csv(?, header = ?, skip = ?)",
            &[
                Param::Text("/a/it's.csv".into()),
                Param::Bool(true),
                Param::Int(2),
            ],
        );
        assert_eq!(sql, "read_csv('/a/it''s.csv', header = true, skip = 2)");
    }
}
