//! Cleaning recipes: an ordered list of steps (rename, change type, trim,
//! …) applied to a dataset as one chain of SQL, `WITH step_1 AS (…),
//! step_2 AS (… FROM step_1) …`. The original file and its cached copy never
//! change: the recipe's output is a new dataset, read through its query and
//! then written to a session table in the background, like a view.

mod sql;

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::engine::sql::{inline_params, literal, quote_ident};
use crate::engine::{Dataset, DatasetSource, Engine, Param, RequestKey};
use crate::error::{AppError, Result};
use crate::sources::ColumnMeta;
use crate::view::{Filter, Relation};

pub use sql::{convert, duckdb_type, step_sql};

static NEXT_RECIPE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NewType {
    Integer,
    Number,
    Text,
    Date,
    Timestamp,
    Boolean,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Case {
    Upper,
    Lower,
    Title,
}

/// One cleaning step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Step {
    Rename {
        column: String,
        to: String,
    },
    /// Values that can't be converted become NULL (and are counted).
    ChangeType {
        column: String,
        to: NewType,
        /// strptime format for text to dates, e.g. `%d/%m/%Y`.
        #[serde(default)]
        format: Option<String>,
    },
    Trim {
        column: String,
    },
    ChangeCase {
        column: String,
        case: Case,
    },
    Replace {
        column: String,
        find: String,
        #[serde(default)]
        replace: String,
        #[serde(default)]
        regex: bool,
        #[serde(default)]
        case_sensitive: bool,
    },
    /// The column split into new text columns at each `delimiter`.
    Split {
        column: String,
        delimiter: String,
        into: Vec<String>,
        /// Keep the original column too.
        #[serde(default)]
        keep: bool,
    },
    /// NULLs (and empty text) replaced by `value`, read as the column's type.
    FillEmpty {
        column: String,
        value: String,
    },
    /// Keeps the first row of each set with equal `columns` (all if none).
    RemoveDuplicates {
        #[serde(default)]
        columns: Option<Vec<String>>,
    },
    /// Removes the rows the filter matches.
    RemoveRows {
        filter: Filter,
    },
    /// A new column from a DuckDB SQL expression over the columns.
    Calculate {
        name: String,
        expression: String,
    },
}

/// A step and whether it runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeStep {
    #[serde(flatten)]
    pub step: Step,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
}

fn enabled_default() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepOutcome {
    /// What went wrong; the steps after it were not applied.
    pub error: Option<String>,
    /// Change type: values that couldn't be converted (now NULL).
    pub failed: Option<u64>,
    /// Not applied: disabled, or after a failing step.
    pub skipped: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeOutcome {
    /// The cleaned rows (every step up to the first that failed).
    pub dataset: Dataset,
    pub columns: Vec<ColumnMeta>,
    pub steps: Vec<StepOutcome>,
    pub elapsed_ms: u64,
}

/// `WITH step_1 AS (…), … SELECT * FROM step_n` over `base` (a table
/// expression), with the schema after each step. Stops at the first step
/// that fails, with its index and message.
pub(crate) struct Chain {
    pub ctes: Vec<String>,
    pub schema: Vec<ColumnMeta>,
}

impl Chain {
    fn last(&self) -> String {
        if self.ctes.is_empty() {
            "base".into()
        } else {
            format!("step_{}", self.ctes.len())
        }
    }

    /// `WITH base AS (…), step_1 AS (…), …` for the chain so far.
    fn with_clause(&self, base: &str) -> String {
        let mut withs = vec![format!("base AS (SELECT * FROM {base})")];
        for (i, cte) in self.ctes.iter().enumerate() {
            withs.push(format!("step_{} AS (\n  {cte}\n)", i + 1));
        }
        format!("WITH {}", withs.join(",\n"))
    }

    /// The query of the chain so far.
    fn query(&self, base: &str) -> String {
        format!("{}\nSELECT * FROM {}", self.with_clause(base), self.last())
    }
}

impl Engine {
    fn describe(&self, sql: &str) -> Result<Vec<ColumnMeta>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare(&format!("DESCRIBE {sql}"))?;
        let cols = stmt
            .query_map([], |r| {
                Ok(ColumnMeta {
                    name: r.get(0)?,
                    r#type: r.get(1)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(cols)
    }

    /// Builds the chain of enabled steps over `base` (a table expression
    /// with values inlined) whose columns are `schema`. Change-type steps
    /// count the values they can't convert when `key` is given.
    pub(crate) fn recipe_chain(
        &self,
        base: &str,
        schema: Vec<ColumnMeta>,
        steps: &[RecipeStep],
        key: Option<&RequestKey>,
    ) -> Result<(Chain, Vec<StepOutcome>)> {
        let mut chain = Chain {
            ctes: Vec::new(),
            schema,
        };
        let mut outcomes = Vec::with_capacity(steps.len());
        let mut failed = false;
        for s in steps {
            if failed || !s.enabled {
                outcomes.push(StepOutcome {
                    error: None,
                    failed: None,
                    skipped: true,
                });
                continue;
            }
            let prev = chain.last();
            let attempt = (|| -> Result<(String, Vec<ColumnMeta>, Option<u64>)> {
                let cte = step_sql(&s.step, &prev, &chain.schema)?;
                if let Step::FillEmpty { column, value } = &s.step {
                    // The fill value must be readable as the column's type.
                    let meta = chain.schema.iter().find(|c| &c.name == column).unwrap();
                    let lit = literal(&Param::Text(value.clone()));
                    let ok = self.count(
                        &format!(
                            "SELECT (TRY_CAST({lit} AS {}) IS NOT NULL)::BIGINT",
                            meta.r#type
                        ),
                        &[],
                        &RequestKey::default(),
                    )?;
                    if ok == 0 {
                        return Err(AppError::Query(format!(
                            "\"{value}\" is not a valid {} value for \"{column}\".",
                            meta.r#type
                        )));
                    }
                }
                let mut next = Chain {
                    ctes: chain.ctes.clone(),
                    schema: Vec::new(),
                };
                next.ctes.push(cte);
                let schema = self.describe(&next.query(base))?;
                let failures = match (&s.step, key) {
                    (Step::ChangeType { column, to, format }, Some(key)) => {
                        let meta = chain.schema.iter().find(|c| &c.name == column).unwrap();
                        let col = quote_ident(column);
                        let conv = convert(&col, meta, *to, format.as_deref());
                        Some(self.count(
                            &format!(
                                "{}\nSELECT count(*) FILTER ({col} IS NOT NULL AND {conv} IS NULL)::BIGINT FROM {prev}",
                                chain.with_clause(base)
                            ),
                            &[],
                            key,
                        )?)
                    }
                    _ => None,
                };
                Ok((next.ctes.pop().unwrap(), schema, failures))
            })();
            match attempt {
                Ok((cte, schema, failures)) => {
                    chain.ctes.push(cte);
                    chain.schema = schema;
                    outcomes.push(StepOutcome {
                        error: None,
                        failed: failures,
                        skipped: false,
                    });
                }
                Err(AppError::Cancelled) => return Err(AppError::Cancelled),
                Err(e) => {
                    failed = true;
                    outcomes.push(StepOutcome {
                        error: Some(match e {
                            AppError::Query(m) => m,
                            other => other.to_string(),
                        }),
                        failed: None,
                        skipped: false,
                    });
                }
            }
        }
        Ok((chain, outcomes))
    }

    /// Applies `steps` to dataset `id`: a new dataset of the cleaned rows.
    pub fn apply_recipe(
        &self,
        id: &str,
        steps: &[RecipeStep],
        key: &RequestKey,
    ) -> Result<RecipeOutcome> {
        let started = std::time::Instant::now();
        let ds = self.datasets.get(id)?;
        let rel = Relation::of(&ds.source);
        let base = inline_params(&rel.sql, &rel.params);
        let schema = self.dataset_columns(id)?;
        let (chain, outcomes) = self.recipe_chain(&base, schema, steps, Some(key))?;
        let sql = format!("({})", chain.query(&base));
        let rows = self.count(&format!("SELECT count(*)::BIGINT FROM {sql}"), &[], key)?;
        let dataset = Dataset {
            id: format!("recipe-{}", NEXT_RECIPE.fetch_add(1, Ordering::Relaxed)),
            source: DatasetSource::Query {
                sql,
                params: Vec::new(),
            },
            row_count: rows,
            cached: ds.cached,
        };
        self.datasets.insert(dataset.clone());
        Ok(RecipeOutcome {
            dataset,
            columns: chain.schema,
            steps: outcomes,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// The recipe as one standalone script over `reader` (the file's reader
    /// call): it runs as-is in plain DuckDB and gives the cleaned rows.
    pub fn recipe_script(&self, id: &str, steps: &[RecipeStep], reader: &str) -> Result<String> {
        let schema = self.dataset_columns(id)?;
        let (chain, outcomes) = self.recipe_chain(reader, schema, steps, None)?;
        if let Some((i, e)) = outcomes
            .iter()
            .enumerate()
            .find_map(|(i, o)| o.error.as_ref().map(|e| (i, e)))
        {
            return Err(AppError::Query(format!("Step {} fails: {e}", i + 1)));
        }
        Ok(format!("{};", chain.query(reader)))
    }
}
