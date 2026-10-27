//! The SQL panel's tables: every open file's dataset is queryable under a
//! name, as a view in the in-memory main schema.

use crate::engine::Engine;
use crate::engine::sql::{inline_params, quote_ident};
use crate::error::Result;
use crate::view::Relation;

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
}
