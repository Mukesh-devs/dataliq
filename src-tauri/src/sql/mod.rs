//! The SQL panel's tables: every open file's dataset is queryable under a
//! name, as a view in the in-memory main schema.

pub mod library;

use std::sync::atomic::{AtomicU64, Ordering};

use crate::engine::sql::{inline_params, quote_ident};
use crate::engine::{Dataset, DatasetSource, Engine, RequestKey};
use crate::error::{AppError, Result};
use crate::view::Relation;

static NEXT_RESULT: AtomicU64 = AtomicU64::new(1);

/// DuckDB's error context ("LINE n: …" and a caret) counts lines of the SQL
/// it was given; `lines` were added in front of the user's query. Puts the
/// line number (and the caret under it) back in terms of the user's text.
pub fn shift_error_lines(message: &str, lines: usize) -> String {
    let Some(start) = message.find("\nLINE ") else {
        return message.to_string();
    };
    let rest = &message[start + 1..];
    let Some(colon) = rest.find(": ") else {
        return message.to_string();
    };
    let Ok(n) = rest["LINE ".len()..colon].parse::<usize>() else {
        return message.to_string();
    };
    let new_n = n.saturating_sub(lines).max(1);
    let old_prefix = format!("LINE {n}: ");
    let new_prefix = format!("LINE {new_n}: ");
    let mut out = message[..start + 1].to_string();
    let mut parts = rest.splitn(2, '\n');
    let line = parts.next().unwrap_or_default();
    out.push_str(&new_prefix);
    out.push_str(&line[old_prefix.len().min(line.len())..]);
    if let Some(after) = parts.next() {
        out.push('\n');
        // The caret line: keep it under the same character.
        let spaces = after.len() - after.trim_start_matches(' ').len();
        let shifted = (spaces + new_prefix.len()).saturating_sub(old_prefix.len());
        out.push_str(&" ".repeat(shifted));
        out.push_str(after.trim_start_matches(' '));
    }
    out
}

impl Engine {
    /// Makes dataset `id` queryable as `name` (replacing an older table of
    /// that name). The view reads the dataset itself, so it costs nothing.
    pub fn register_table(&self, id: &str, name: &str) -> Result<()> {
        let ds = self.datasets.get(id)?;
        let rel = Relation::of(&ds.source);
        let from = inline_params(&rel.sql, &rel.params);
        self.connection()?.execute_batch(&format!(
            "CREATE OR REPLACE VIEW main.{} AS SELECT * FROM {from}",
            quote_ident(name)
        ))?;
        Ok(())
    }

    /// Removes a table made by [`Engine::register_table`]; no error if it is gone.
    pub fn unregister_table(&self, name: &str) -> Result<()> {
        self.connection()?
            .execute_batch(&format!("DROP VIEW IF EXISTS main.{}", quote_ident(name)))?;
        Ok(())
    }

    /// Runs a query on the SQL panel's session and keeps its rows as a
    /// dataset the grid can page through (written once into the session's
    /// scratch database, in the query's order). Errors point into `sql`.
    pub fn sql_result(&self, sql: &str, key: &RequestKey) -> Result<Dataset> {
        let n = NEXT_RESULT.fetch_add(1, Ordering::Relaxed);
        let table = format!(
            "{}.{}",
            self.scratch_schema()?,
            quote_ident(&format!("r_{n}"))
        );
        let dataset = self.with_session(key, |conn| {
            // The query on lines of its own, so a trailing comment can't
            // swallow the closing parenthesis.
            let create = format!("CREATE TABLE {table} AS SELECT * FROM (\n{sql}\n)");
            self.execute_on(conn, &create, &[], key)
                .map_err(|e| match e {
                    AppError::Query(m) => AppError::Query(shift_error_lines(&m, 1)),
                    other => other,
                })?;
            let rows: i64 =
                conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?;
            Ok(Dataset {
                id: format!("sql-{n}"),
                source: DatasetSource::Materialized { table },
                row_count: rows as u64,
                cached: true,
            })
        })?;
        self.datasets.insert(dataset.clone());
        Ok(dataset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_lines_point_into_the_users_text() {
        let m = "Binder Error: no \"nope\"\n\nLINE 2: SELECT nope FROM t\n               ^";
        assert_eq!(
            shift_error_lines(m, 1),
            "Binder Error: no \"nope\"\n\nLINE 1: SELECT nope FROM t\n               ^"
        );
        // Line 10 -> 9: the prefix gets shorter, so does the caret's indent.
        let m = "E\nLINE 10: x nope\n            ^";
        assert_eq!(shift_error_lines(m, 1), "E\nLINE 9: x nope\n           ^");
        assert_eq!(shift_error_lines("No position", 1), "No position");
    }
}
