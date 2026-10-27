//! Excel (.xlsx, .xls) via calamine. Sheets are read cell by cell (xlsx
//! streams; only the rows needed for a preview are read), column types are
//! inferred from the values, and rows are written to DuckDB with the
//! Appender API.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use calamine::{Data, DataRef, Reader, Xlsx, open_workbook, open_workbook_auto};
use duckdb::types::{TimeUnit, Value};
use duckdb::{Connection, appender_params_from_iter};
use serde::{Deserialize, Serialize};

use crate::engine::sql::quote_ident;
use crate::error::{AppError, Result};

/// User choices for an Excel file. `None` = detect.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExcelOptions {
    pub sheet: Option<String>,
    /// 1-based row holding the column names; 0 = no header row.
    pub header_row: Option<u32>,
}

/// What was detected, for the sheet picker and header row choice.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcelInfo {
    pub sheets: Vec<String>,
    pub sheet: String,
    /// 1-based header row in use; 0 = none.
    pub header_row: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColType {
    BigInt,
    Double,
    Boolean,
    Date,
    Timestamp,
    Varchar,
}

impl ColType {
    pub fn sql(self) -> &'static str {
        match self {
            ColType::BigInt => "BIGINT",
            ColType::Double => "DOUBLE",
            ColType::Boolean => "BOOLEAN",
            ColType::Date => "DATE",
            ColType::Timestamp => "TIMESTAMP",
            ColType::Varchar => "VARCHAR",
        }
    }
}

/// Spreadsheet column letters for a 1-based index: 1 -> A, 27 -> AA.
pub fn column_letters(mut n: usize) -> String {
    let mut out = Vec::new();
    while n > 0 {
        let r = (n - 1) % 26;
        out.push(b'A' + r as u8);
        n = (n - 1) / 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// A table expression reading the same columns with DuckDB's `excel`
/// extension, for "Copy as SQL": every row below the header except blank
/// ones (as the import does), each column under the name used here (integer
/// columns cast back from DOUBLE). DuckDB reads only .xlsx files; for .xls
/// the result names the sheet as a table to load first.
pub fn reader_sql(path: &Path, is_xlsx: bool, sheet: &Sheet) -> String {
    if !is_xlsx {
        return format!(
            "{} /* DuckDB reads only .xlsx files: load this .xls sheet as a table first */",
            quote_ident(&sheet.info.sheet)
        );
    }
    let width = sheet.names.len().max(1);
    let letters: Vec<String> = (1..=width).map(column_letters).collect();
    let columns: Vec<String> = sheet
        .names
        .iter()
        .zip(&sheet.types)
        .zip(&letters)
        .map(|((name, t), letter)| {
            let src = quote_ident(letter);
            let value = if *t == ColType::BigInt {
                format!("CAST({src} AS BIGINT)")
            } else {
                src
            };
            format!("{value} AS {}", quote_ident(name))
        })
        .collect();
    let blank: Vec<String> = letters
        .iter()
        .map(|l| format!("{} IS NULL", quote_ident(l)))
        .collect();
    let lit = |s: &str| format!("'{}'", s.replace('\'', "''"));
    // An open-ended range ("A2:F") reads to the end of the sheet.
    let range = format!("A{}:{}", sheet.info.header_row + 1, letters[width - 1]);
    format!(
        "(SELECT {} FROM read_xlsx({}, sheet = {}, header = false, range = {}, stop_at_empty = false) WHERE NOT ({}))",
        columns.join(", "),
        lit(&path.to_string_lossy()),
        lit(&sheet.info.sheet),
        lit(&range),
        blank.join(" AND "),
    )
}

/// A sheet read into memory: names, inferred types and data rows.
pub struct Sheet {
    pub info: ExcelInfo,
    pub names: Vec<String>,
    pub types: Vec<ColType>,
    pub rows: Vec<Vec<Data>>,
}

fn excel_error(e: impl std::fmt::Display) -> AppError {
    AppError::Query(format!("This Excel file could not be read: {e}"))
}

fn is_empty_row(row: &[Data]) -> bool {
    row.iter().all(|c| matches!(c, Data::Empty))
}

fn filled(row: &[Data]) -> usize {
    row.iter().filter(|c| !matches!(c, Data::Empty)).count()
}

/// Reads up to `limit` rows (absolute, from Excel row 1) of a sheet.
fn read_rows(path: &Path, sheet: &str, is_xlsx: bool, limit: usize) -> Result<Vec<Vec<Data>>> {
    let mut rows: Vec<Vec<Data>> = Vec::new();
    let mut put = |r: u32, c: u32, v: Data| {
        let (r, c) = (r as usize, c as usize);
        if rows.len() <= r {
            rows.resize_with(r + 1, Vec::new);
        }
        let row = &mut rows[r];
        if row.len() <= c {
            row.resize(c + 1, Data::Empty);
        }
        row[c] = v;
    };
    if is_xlsx {
        // Stream cells in file order and stop once past the rows we need.
        let mut wb: Xlsx<_> = open_workbook(path).map_err(excel_error)?;
        let mut cells = wb.worksheet_cells_reader(sheet).map_err(excel_error)?;
        while let Some(cell) = cells.next_cell().map_err(excel_error)? {
            let (r, c) = cell.get_position();
            if r as usize >= limit {
                break;
            }
            let value: Data = match cell.get_value() {
                DataRef::SharedString(s) => Data::String((*s).to_string()),
                other => other.clone().into(),
            };
            put(r, c, value);
        }
    } else {
        let mut wb = open_workbook_auto(path).map_err(excel_error)?;
        let range = wb.worksheet_range(sheet).map_err(excel_error)?;
        if let Some((r0, c0)) = range.start() {
            for (i, row) in range.rows().enumerate() {
                let r = r0 + i as u32;
                if r as usize >= limit {
                    break;
                }
                for (j, v) in row.iter().enumerate() {
                    if !matches!(v, Data::Empty) {
                        put(r, c0 + j as u32, v.clone());
                    }
                }
            }
        }
    }
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    for row in &mut rows {
        row.resize(width, Data::Empty);
    }
    Ok(rows)
}

fn sheet_names(path: &Path) -> Result<Vec<String>> {
    let wb = open_workbook_auto(path).map_err(excel_error)?;
    Ok(wb.sheet_names())
}

/// Picks the header row: the first non-empty row that is all text, unless it
/// looks like a title (fewer cells than the rows below it).
fn detect_header(rows: &[Vec<Data>]) -> u32 {
    let non_empty: Vec<usize> = (0..rows.len())
        .filter(|&i| !is_empty_row(&rows[i]))
        .collect();
    for (k, &i) in non_empty.iter().enumerate() {
        let next_max = non_empty[k + 1..]
            .iter()
            .take(5)
            .map(|&j| filled(&rows[j]))
            .max()
            .unwrap_or(0);
        if filled(&rows[i]) < next_max {
            continue; // a title or note above the table
        }
        let all_text = rows[i]
            .iter()
            .all(|c| matches!(c, Data::Empty | Data::String(_)));
        return if all_text { i as u32 + 1 } else { 0 };
    }
    0
}

fn header_names(row: Option<&Vec<Data>>, width: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    (0..width)
        .map(|c| {
            let base = match row.and_then(|r| r.get(c)) {
                Some(Data::Empty) | None => format!("column{}", c + 1),
                Some(v) => v.to_string().trim().to_string(),
            };
            let base = if base.is_empty() {
                format!("column{}", c + 1)
            } else {
                base
            };
            let mut name = base.clone();
            let mut n = 2;
            while !seen.insert(name.clone()) {
                name = format!("{base}_{n}");
                n += 1;
            }
            name
        })
        .collect()
}

fn infer(rows: &[Vec<Data>], col: usize) -> ColType {
    let mut kind: Option<ColType> = None;
    for row in rows {
        let t = match &row[col] {
            Data::Empty | Data::Error(_) => continue,
            Data::Int(_) => ColType::BigInt,
            Data::Float(f) => {
                if f.fract() == 0.0 && f.abs() < 9.0e15 {
                    ColType::BigInt
                } else {
                    ColType::Double
                }
            }
            Data::Bool(_) => ColType::Boolean,
            Data::DateTime(dt) if dt.is_datetime() => {
                if dt.as_f64().fract() == 0.0 {
                    ColType::Date
                } else {
                    ColType::Timestamp
                }
            }
            _ => ColType::Varchar,
        };
        kind = Some(match (kind, t) {
            (None, t) => t,
            (Some(a), b) if a == b => a,
            (Some(ColType::BigInt), ColType::Double) | (Some(ColType::Double), ColType::BigInt) => {
                ColType::Double
            }
            (Some(ColType::Date), ColType::Timestamp)
            | (Some(ColType::Timestamp), ColType::Date) => ColType::Timestamp,
            _ => return ColType::Varchar,
        });
    }
    kind.unwrap_or(ColType::Varchar)
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn to_value(v: &Data, t: ColType) -> Value {
    match (v, t) {
        (Data::Empty | Data::Error(_), _) => Value::Null,
        (Data::Int(i), ColType::BigInt) => Value::BigInt(*i),
        (Data::Float(f), ColType::BigInt) => Value::BigInt(*f as i64),
        (Data::Int(i), ColType::Double) => Value::Double(*i as f64),
        (Data::Float(f), ColType::Double) => Value::Double(*f),
        (Data::Bool(b), ColType::Boolean) => Value::Boolean(*b),
        (Data::DateTime(dt), ColType::Date | ColType::Timestamp) => {
            let (y, mo, d, h, mi, s, ms) = dt.to_ymd_hms_milli();
            let days = days_from_civil(i64::from(y), u32::from(mo), u32::from(d));
            if t == ColType::Date {
                Value::Date32(days as i32)
            } else {
                let secs = days * 86_400 + i64::from(h) * 3600 + i64::from(mi) * 60 + i64::from(s);
                Value::Timestamp(
                    TimeUnit::Microsecond,
                    secs * 1_000_000 + i64::from(ms) * 1000,
                )
            }
        }
        (Data::Float(f), ColType::Varchar) => Value::Text(f.to_string()),
        (other, _) => Value::Text(other.to_string()),
    }
}

/// Reads a sheet (all rows, or the first `max_data_rows` data rows).
pub fn load(
    path: &Path,
    opts: &ExcelOptions,
    is_xlsx: bool,
    max_data_rows: Option<usize>,
) -> Result<Sheet> {
    let sheets = sheet_names(path)?;
    if sheets.is_empty() {
        return Err(AppError::Query("This workbook has no sheets.".into()));
    }
    let sheet = match &opts.sheet {
        Some(s) if sheets.contains(s) => s.clone(),
        Some(s) => return Err(AppError::Query(format!("There is no sheet named \"{s}\"."))),
        // First sheet with any data.
        None => sheets
            .iter()
            .find(|s| {
                read_rows(path, s, is_xlsx, 1000)
                    .is_ok_and(|r| r.iter().any(|row| !is_empty_row(row)))
            })
            .unwrap_or(&sheets[0])
            .clone(),
    };
    // For a preview, read a few extra rows to find the header and skip blanks.
    let limit = max_data_rows.map_or(usize::MAX, |n| n.saturating_add(200));
    let mut rows = read_rows(path, &sheet, is_xlsx, limit)?;
    let header_row = opts.header_row.unwrap_or_else(|| detect_header(&rows));
    let width = rows.first().map_or(0, Vec::len);
    let names = header_names(
        header_row.checked_sub(1).and_then(|i| rows.get(i as usize)),
        width,
    );
    let first_data = header_row as usize; // header is row `header_row` (1-based)
    let mut data: Vec<Vec<Data>> = if first_data < rows.len() {
        rows.split_off(first_data)
    } else {
        Vec::new()
    };
    // Rows above a header are titles/notes; fully empty rows are dropped.
    data.retain(|r| !is_empty_row(r));
    if let Some(n) = max_data_rows {
        data.truncate(n);
    }
    let types = (0..width).map(|c| infer(&data, c)).collect();
    Ok(Sheet {
        info: ExcelInfo {
            sheets,
            sheet,
            header_row,
        },
        names,
        types,
        rows: data,
    })
}

/// Creates `table` (optionally in `catalog`) and appends the sheet's rows.
/// Checks `cancel` and reports progress (0–100) every 10,000 rows.
pub fn write_table(
    conn: &Connection,
    catalog: Option<&str>,
    table: &str,
    sheet: &Sheet,
    cancel: &AtomicBool,
    progress: &dyn Fn(f64),
) -> Result<u64> {
    let qualified = match catalog {
        Some(c) => format!("{}.main.{}", quote_ident(c), quote_ident(table)),
        None => quote_ident(table),
    };
    let cols: Vec<String> = sheet
        .names
        .iter()
        .zip(&sheet.types)
        .map(|(n, t)| format!("{} {}", quote_ident(n), t.sql()))
        .collect();
    if sheet.names.is_empty() {
        return Err(AppError::Query("This sheet is empty.".into()));
    }
    let temp = if catalog.is_none() { "TEMP " } else { "" };
    conn.execute_batch(&format!(
        "CREATE {temp}TABLE {qualified} ({})",
        cols.join(", ")
    ))?;
    // Temp tables live in the `temp` catalog's `main` schema.
    let mut appender = conn.appender_to_catalog_and_db(table, catalog.unwrap_or("temp"), "main")?;
    let total = sheet.rows.len().max(1) as f64;
    for (i, row) in sheet.rows.iter().enumerate() {
        if i % 10_000 == 0 {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            progress(i as f64 / total * 100.0);
        }
        let values = row.iter().zip(&sheet.types).map(|(v, t)| to_value(v, *t));
        appender.append_row(appender_params_from_iter(values))?;
    }
    appender.flush()?;
    Ok(sheet.rows.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_letters_like_spreadsheets() {
        assert_eq!(column_letters(1), "A");
        assert_eq!(column_letters(26), "Z");
        assert_eq!(column_letters(27), "AA");
        assert_eq!(column_letters(702), "ZZ");
        assert_eq!(column_letters(16_384), "XFD");
    }

    #[test]
    fn civil_days() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2024, 1, 31), 19_753);
        assert_eq!(days_from_civil(1899, 12, 31), -25_568);
    }

    #[test]
    fn header_detection_skips_titles() {
        let s = |t: &str| Data::String(t.into());
        let rows = vec![
            vec![s("Quarterly report"), Data::Empty],
            vec![Data::Empty, Data::Empty],
            vec![s("key"), s("value")],
            vec![s("a"), Data::Float(1.0)],
        ];
        assert_eq!(detect_header(&rows), 3);
        let numeric_top = vec![vec![Data::Float(1.0), Data::Float(2.0)]];
        assert_eq!(detect_header(&numeric_top), 0);
    }

    #[test]
    fn names_are_unique_and_never_empty() {
        let s = |t: &str| Data::String(t.into());
        let row = vec![s("a"), s("a"), Data::Empty, s(" ")];
        assert_eq!(
            header_names(Some(&row), 5),
            ["a", "a_2", "column3", "column4", "column5"]
        );
    }

    #[test]
    fn type_inference() {
        let rows = |vals: Vec<Data>| vals.into_iter().map(|v| vec![v]).collect::<Vec<_>>();
        assert_eq!(
            infer(&rows(vec![Data::Float(1.0), Data::Float(2.0)]), 0),
            ColType::BigInt
        );
        assert_eq!(
            infer(&rows(vec![Data::Float(1.0), Data::Float(2.5)]), 0),
            ColType::Double
        );
        assert_eq!(
            infer(&rows(vec![Data::Float(1.0), Data::String("x".into())]), 0),
            ColType::Varchar
        );
        assert_eq!(
            infer(&rows(vec![Data::Bool(true), Data::Empty]), 0),
            ColType::Boolean
        );
        assert_eq!(infer(&rows(vec![Data::Empty]), 0), ColType::Varchar);
    }
}
