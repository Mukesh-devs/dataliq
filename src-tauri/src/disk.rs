//! Free-space checks before writing a lot: an export, a conversion, a sort
//! too big for memory. The size is estimated from a small sample of rows
//! (their width as text) and the format's usual ratio to text; the check
//! only refuses when the estimate clearly doesn't fit, since a wrong
//! refusal costs more than a full disk (which writes to a `.partial` and
//! cleans up).

use std::path::Path;

use crate::cache;
use crate::engine::sql::quote_ident;
use crate::engine::{Engine, Param};
use crate::error::{AppError, Result};
use crate::export::ExportFormat;

/// Rows read to estimate how wide a row is.
const SAMPLE_ROWS: u64 = 2000;
/// Kept free on top of the estimate.
const MARGIN: u64 = 64 << 20;

/// How large a format writes data, relative to the same rows as CSV text.
/// On the low side: an estimate that is too small only lets a write start.
pub fn format_ratio(format: ExportFormat) -> f64 {
    match format {
        ExportFormat::Csv | ExportFormat::Tsv => 1.0,
        // Keys repeated on every row; counted by `json_overhead`.
        ExportFormat::Json | ExportFormat::Ndjson => 1.0,
        // Compressed: real data ranges widely (5–30 % of the text); the low end.
        ExportFormat::CsvGz => 0.15,
        ExportFormat::Parquet => 0.08,
        ExportFormat::Xlsx => 0.5,
    }
}

/// Average bytes per row of `from` (a FROM item) as CSV text, from its
/// first rows; `columns` (names) when only some are written. 0 when empty.
pub fn row_text_bytes(
    engine: &Engine,
    from: &str,
    params: &[Param],
    columns: Option<&[String]>,
) -> Result<f64> {
    let names = match columns {
        Some(c) if !c.is_empty() => c.to_vec(),
        _ => engine
            .connection()?
            .prepare(&format!("DESCRIBE SELECT * FROM {from}"))?
            .query_map(duckdb::params_from_iter(params.iter()), |r| {
                r.get::<_, String>(0)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?,
    };
    if names.is_empty() {
        return Ok(0.0);
    }
    // Each value as text, plus a separator; NULLs as nothing.
    let width = names
        .iter()
        .map(|n| {
            format!(
                "coalesce(strlen(CAST({} AS VARCHAR)), 0) + 1",
                quote_ident(n)
            )
        })
        .collect::<Vec<_>>()
        .join(" + ");
    let sql = format!(
        "SELECT coalesce(avg({width}), 0)::DOUBLE FROM (SELECT * FROM {from} LIMIT {SAMPLE_ROWS})"
    );
    let conn = engine.connection()?;
    let v: f64 = conn.query_row(&sql, duckdb::params_from_iter(params.iter()), |r| r.get(0))?;
    Ok(v)
}

/// JSON writes every column's name on every row.
pub fn json_overhead(columns: &[String]) -> f64 {
    columns.iter().map(|c| c.len() as f64 + 4.0).sum::<f64>() + 2.0
}

/// Refuses when `needed` bytes clearly don't fit on the drive holding
/// `dir`. Unknown free space (an odd mount) lets the write go ahead.
pub fn ensure_space(dir: &Path, needed: u64, what: &str, fix: &str) -> Result<()> {
    let Some(available) = cache::available_space(dir) else {
        return Ok(());
    };
    if available >= needed.saturating_add(MARGIN) {
        return Ok(());
    }
    Err(AppError::NoSpace {
        what: what.to_string(),
        needed,
        available,
        where_: format!(" on the drive of {}", dir.display()),
        fix: fix.to_string(),
    })
}

/// The nearest folder of `path` that exists (where a new file will go).
pub fn existing_dir(path: &Path) -> &Path {
    let mut p = path;
    while !p.is_dir() {
        match p.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => p = parent,
            _ => return Path::new("."),
        }
    }
    p
}

/// A write that ran out of room part way: said as such, for the place
/// written (DuckDB reports it like a full temporary folder).
pub fn full_while_writing(err: AppError, dir: &Path, what: &str) -> AppError {
    match err {
        AppError::SpillDiskFull
            if cache::available_space(dir).is_some_and(|free| free < MARGIN) =>
        {
            AppError::NoSpace {
                what: what.to_string(),
                needed: 0,
                available: cache::available_space(dir).unwrap_or(0),
                where_: format!(
                    " on the drive of {} (it filled up while writing)",
                    dir.display()
                ),
                fix: "Nothing was left half-written. Free up space or choose another folder."
                    .into(),
            }
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_that_clearly_doesnt_fit_is_refused_in_words() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ensure_space(dir.path(), 1 << 20, "export this view", "").is_ok());
        let err = ensure_space(
            dir.path(),
            u64::MAX / 4,
            "export this view",
            "Free up space.",
        )
        .unwrap_err();
        assert_eq!(err.kind(), "no-space");
        let text = err.to_string();
        assert!(text.starts_with("Not enough free disk space to export this view: about"));
        assert!(text.ends_with("Free up space."), "{text}");
    }

    #[test]
    fn the_folder_a_new_file_goes_in() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a/b/out.csv");
        assert_eq!(existing_dir(&file), dir.path());
    }
}
