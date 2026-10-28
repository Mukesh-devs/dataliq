//! SQLite and DuckDB database files: attached read-only, one table (or
//! view) shown at a time, chosen from a list like an Excel sheet.
//!
//! DuckDB files are attached natively and their tables queried in place.
//! SQLite files need DuckDB's sqlite extension (installed on first use);
//! their tables are imported like a CSV file, since paging through SQLite
//! from DuckDB is slow. Each file is attached once per session under a
//! name made from its file name (`shop.sqlite` → `shop`), which the SQL
//! panel can use too (`SELECT * FROM shop.orders`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use super::FileFormat;
use super::friendly_error;
use crate::cache::SourceStamp;
use crate::engine::sql::{literal, quote_ident};
use crate::engine::{Engine, Param};
use crate::error::{AppError, Result};

/// Which table of a database to show. Unset: the first table.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DatabaseOptions {
    /// `main` when unset.
    pub schema: Option<String>,
    pub table: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTable {
    pub schema: String,
    pub name: String,
    /// `table` or `view`.
    pub kind: String,
    /// Rows, when the database knows without counting (DuckDB tables).
    pub rows: Option<u64>,
}

/// The tables of an opened database and the one shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub tables: Vec<DbTable>,
    pub schema: String,
    pub table: String,
    /// The name the file is attached under, for the SQL panel.
    pub alias: String,
}

/// A database attached for a source: under what name, and which table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub alias: String,
    pub schema: String,
    pub table: String,
    pub tables: Vec<DbTable>,
}

impl Opened {
    /// `"shop"."main"."orders"`.
    pub fn relation(&self) -> String {
        format!(
            "{}.{}.{}",
            quote_ident(&self.alias),
            quote_ident(&self.schema),
            quote_ident(&self.table)
        )
    }

    pub fn info(&self) -> DatabaseInfo {
        DatabaseInfo {
            tables: self.tables.clone(),
            schema: self.schema.clone(),
            table: self.table.clone(),
            alias: self.alias.clone(),
        }
    }
}

/// The files attached this session: path → (name, version when attached).
#[derive(Default)]
pub struct Attached(Mutex<HashMap<PathBuf, (String, SourceStamp)>>);

pub fn is_database(format: FileFormat) -> bool {
    matches!(format, FileFormat::Sqlite | FileFormat::Duckdb)
}

/// A database name from the file name: `Sales 2024.sqlite` → `sales_2024`.
fn base_alias(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mut alias: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    alias = alias.trim_matches('_').to_string();
    if alias.is_empty() || alias.starts_with(|c: char| c.is_ascii_digit()) {
        alias = format!("db_{alias}");
    }
    // Names DuckDB (or the app's cache) already uses.
    if matches!(alias.as_str(), "memory" | "system" | "temp" | "main") || alias.starts_with("dl_") {
        alias = format!("{alias}_db");
    }
    alias
}

/// Attaches `path` read-only (again, if the file changed since) and returns
/// the name it is attached under.
fn attach(engine: &Engine, path: &Path, format: FileFormat) -> Result<String> {
    if format == FileFormat::Sqlite {
        engine.load_extension("sqlite", "Opening SQLite files")?;
    }
    let path = std::fs::canonicalize(path)?;
    let stamp = SourceStamp::of(&path)?;
    let mut attached = engine.attached.0.lock();
    let reuse = match attached.get(&path) {
        Some((alias, s)) if *s == stamp => return Ok(alias.clone()),
        Some((alias, _)) => {
            // Changed on disk: read it afresh under the same name.
            engine.execute_batch(&format!("DETACH DATABASE IF EXISTS {}", quote_ident(alias)))?;
            Some(alias.clone())
        }
        None => None,
    };
    let alias = reuse.unwrap_or_else(|| {
        let base = base_alias(&path);
        let taken = |a: &str| {
            attached.values().any(|(t, _)| t == a)
                || engine
                    .connection()
                    .and_then(|c| {
                        c.query_row(
                            "SELECT count(*) FROM duckdb_databases() WHERE database_name = ?",
                            [a],
                            |r| r.get::<_, i64>(0),
                        )
                        .map_err(|e| AppError::Query(e.to_string()))
                    })
                    .is_ok_and(|n| n > 0)
        };
        let mut alias = base.clone();
        let mut n = 2;
        while taken(&alias) {
            alias = format!("{base}_{n}");
            n += 1;
        }
        alias
    });
    let kind = if format == FileFormat::Sqlite {
        "TYPE sqlite, READ_ONLY"
    } else {
        "READ_ONLY"
    };
    engine
        .execute_batch(&format!(
            "ATTACH {} AS {} ({kind})",
            literal(&Param::Text(path.to_string_lossy().into_owned())),
            quote_ident(&alias)
        ))
        .map_err(|e| attach_error(&e.to_string(), format))?;
    attached.insert(path, (alias.clone(), stamp));
    Ok(alias)
}

/// Why a database file couldn't be opened, in words.
fn attach_error(raw: &str, format: FileFormat) -> AppError {
    let lower = raw.to_lowercase();
    if lower.contains("could not set lock") || lower.contains("conflicting lock") {
        return AppError::Query(
            "Another program has this database open for writing. Close it there (or copy the \
             file) and open it again."
                .into(),
        );
    }
    if format == FileFormat::Duckdb && lower.contains("version") {
        return AppError::Query(format!(
            "This DuckDB file was written by a different DuckDB version than DataLiq's ({}).",
            raw.lines().next().unwrap_or_default()
        ));
    }
    if lower.contains("not a database") || lower.contains("file is not a valid") {
        return AppError::Query("This file isn't a database DataLiq can read.".into());
    }
    friendly_error(raw)
}

/// The tables and views of an attached database, `main` first.
fn list_tables(engine: &Engine, alias: &str, format: FileFormat) -> Result<Vec<DbTable>> {
    let conn = engine.connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT * FROM ( \
               SELECT schema_name AS s, table_name AS n, 'table' AS k, estimated_size AS r \
               FROM duckdb_tables() WHERE database_name = ? \
               UNION ALL \
               SELECT schema_name, view_name, 'view', NULL FROM duckdb_views() \
               WHERE database_name = ? AND NOT internal \
             ) ORDER BY s <> 'main', s, k, lower(n), n",
        )
        .map_err(|e| friendly_error(&e.to_string()))?;
    let rows = stmt
        .query_map([alias, alias], |r| {
            Ok(DbTable {
                schema: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                rows: r.get::<_, Option<i64>>(3)?.map(|n| n.max(0) as u64),
            })
        })
        .map_err(|e| friendly_error(&e.to_string()))?;
    let mut tables = rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| friendly_error(&e.to_string()))?;
    if format == FileFormat::Sqlite {
        // SQLite keeps no row counts; DuckDB's estimate is a guess.
        for t in &mut tables {
            t.rows = None;
        }
    }
    Ok(tables)
}

/// Attaches the file and picks the table to show.
pub fn open(
    engine: &Engine,
    path: &Path,
    format: FileFormat,
    options: &DatabaseOptions,
) -> Result<Opened> {
    let alias = attach(engine, path, format)?;
    let tables = list_tables(engine, &alias, format)?;
    let schema = options.schema.as_deref().unwrap_or("main");
    let chosen = match &options.table {
        Some(name) => tables
            .iter()
            .find(|t| t.schema == schema && &t.name == name)
            .ok_or_else(|| {
                AppError::Query(format!("This database has no table called \"{name}\"."))
            })?,
        None => tables
            .iter()
            .find(|t| t.kind == "table")
            .or_else(|| tables.first())
            .ok_or_else(|| AppError::Query("This database has no tables.".into()))?,
    };
    Ok(Opened {
        alias,
        schema: chosen.schema.clone(),
        table: chosen.name.clone(),
        tables: tables.clone(),
    })
}

/// "Copy as SQL" for a SQLite table: `sqlite_scan`, which runs in plain
/// DuckDB with the sqlite extension. (DuckDB files are read through their
/// attached name, which needs `ATTACH` first; see D45.)
pub fn sqlite_scan_sql(path: &Path, table: &str) -> String {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    format!(
        "sqlite_scan({}, {})",
        literal(&Param::Text(path.to_string_lossy().into_owned())),
        literal(&Param::Text(table.to_string()))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_come_from_file_names() {
        assert_eq!(base_alias(Path::new("/d/shop.sqlite")), "shop");
        assert_eq!(base_alias(Path::new("/d/Sales 2024.duckdb")), "sales_2024");
        assert_eq!(base_alias(Path::new("/d/2024.db")), "db_2024");
        assert_eq!(base_alias(Path::new("/d/memory.db")), "memory_db");
        assert_eq!(base_alias(Path::new("/d/dl_cache.db")), "dl_cache_db");
        assert_eq!(base_alias(Path::new("/d/.db")), "db");
    }

    #[test]
    fn attach_errors_are_said_in_words() {
        let lock = attach_error(
            "IO Error: Could not set lock on file \"/d/shop.duckdb\": Conflicting lock is held",
            FileFormat::Duckdb,
        );
        assert!(lock.to_string().contains("Another program"), "{lock}");
        let version = attach_error(
            "IO Error: Trying to read a database file with version number 99, but we can only read version 64",
            FileFormat::Duckdb,
        );
        assert!(
            version.to_string().contains("different DuckDB version"),
            "{version}"
        );
        let junk = attach_error("file is not a database", FileFormat::Sqlite);
        assert!(junk.to_string().contains("isn't a database"), "{junk}");
    }
}
