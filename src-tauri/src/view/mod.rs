//! Views: a filtered, sorted, searched and projected window on a dataset.
//!
//! The UI sends a [`ViewSpec`]; [`build`] turns it into DuckDB SQL. Column
//! names only ever reach SQL through `quote_ident`, after being checked
//! against the dataset's schema, and every user value is a bound parameter.

mod open;
mod profile;
mod sql;

use serde::{Deserialize, Serialize};

pub use open::{MAX_VALUES, OpenedView, ValueCount, ValueList, materialize_request_id};
pub use profile::{
    BINS, Bin, ColumnHistogram, ColumnProfile, EXACT_DISTINCT_ROWS, ProfileKind, TOP_VALUES,
};
pub use sql::{BuiltView, Relation, build, build_at, standalone_sql};

pub(crate) use profile::numeric_expr;

use crate::engine::Param;

/// What the user asked to see. Filters are combined with AND.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ViewSpec {
    pub filters: Vec<Filter>,
    /// Sort keys, most significant first.
    pub sort: Vec<SortKey>,
    /// Text searched for in every text column (case-insensitive).
    pub search: Option<String>,
    /// Visible columns in display order; `None` shows all columns.
    pub columns: Option<Vec<String>>,
}

impl ViewSpec {
    /// True when the view shows the dataset unchanged (all rows, file order).
    pub fn is_identity(&self) -> bool {
        self.filters.is_empty()
            && self.sort.is_empty()
            && self.search.as_deref().is_none_or(|s| s.is_empty())
            && self.columns.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    pub column: String,
    #[serde(default)]
    pub descending: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: String,
    #[serde(flatten)]
    pub op: FilterOp,
    /// Keep the rows that do *not* match (rows where the test is NULL are
    /// kept too, e.g. "doesn't contain" includes empty cells).
    #[serde(default)]
    pub not: bool,
}

/// One test on a column. Text tests work on any column (its text form);
/// comparisons use the column's own type, so dates are given as ISO text
/// (`2024-01-31`) and numbers as numbers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FilterOp {
    Contains {
        value: String,
        #[serde(default)]
        case_sensitive: bool,
    },
    StartsWith {
        value: String,
        #[serde(default)]
        case_sensitive: bool,
    },
    EndsWith {
        value: String,
        #[serde(default)]
        case_sensitive: bool,
    },
    /// RE2 regular expression (DuckDB `regexp_matches`), matched anywhere.
    Regex {
        pattern: String,
    },
    /// NULL, or an empty string in a text column.
    Empty,
    IsNull,
    NotNull,
    /// Equal to a value; `null` means IS NULL.
    Equals {
        value: Param,
    },
    Gt {
        value: Param,
    },
    Gte {
        value: Param,
    },
    Lt {
        value: Param,
    },
    Lte {
        value: Param,
    },
    /// Inclusive range; either end may be open.
    Range {
        #[serde(default)]
        min: Option<Param>,
        #[serde(default)]
        max: Option<Param>,
    },
    /// Dates in the last N days, today included (date and timestamp columns).
    LastDays {
        days: u32,
    },
    /// Any of these values (`null` in the list matches NULL cells).
    In {
        values: Vec<Param>,
    },
}
