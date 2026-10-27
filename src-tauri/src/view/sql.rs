//! ViewSpec -> SQL. Identifiers are checked against the schema and quoted;
//! values are always bound parameters, in the order they appear in the SQL.

use chrono::NaiveDate;

use super::{Filter, FilterOp, SortKey, ViewSpec};
use crate::engine::sql::quote_ident;
use crate::engine::{DatasetSource, Param};
use crate::error::{AppError, Result};
use crate::sources::ColumnMeta;

/// A table expression to build views on, with its own bound parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct Relation {
    pub sql: String,
    pub params: Vec<Param>,
    /// Expression giving the file order (e.g. `rowid`), appended to every
    /// sort so rows with equal keys keep their original order.
    pub row_order: Option<String>,
}

impl Relation {
    pub fn of(source: &DatasetSource) -> Relation {
        match source {
            DatasetSource::Table(name) | DatasetSource::Materialized { table: name } => Relation {
                sql: name.clone(),
                params: Vec::new(),
                row_order: Some("rowid".into()),
            },
            // Ties keep DuckDB's order here; the view is written to a table
            // once, so its pages stay stable either way.
            DatasetSource::Query { sql, params } => Relation {
                sql: sql.clone(),
                params: params.clone(),
                row_order: None,
            },
            DatasetSource::Parquet { path } => Relation {
                sql: "read_parquet(?)".into(),
                params: vec![Param::Text(path.clone())],
                row_order: None,
            },
        }
    }
}

/// SQL for a view. `select` and `count` take the same `params`.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltView {
    /// `SELECT <columns> FROM <relation> [WHERE ...] [ORDER BY ...]`
    pub select: String,
    /// `SELECT count(*) FROM <relation> [WHERE ...]`
    pub count: String,
    pub params: Vec<Param>,
}

/// Builds the SQL for `spec` over `relation`, whose columns are `schema`.
pub fn build(spec: &ViewSpec, relation: &Relation, schema: &[ColumnMeta]) -> Result<BuiltView> {
    build_at(spec, relation, schema, chrono::Local::now().date_naive())
}

/// Like [`build`], with "today" (for relative date filters) given. DuckDB's
/// `current_date` needs the ICU extension, which we don't ship, and binding
/// the user's local date is what they mean anyway.
pub fn build_at(
    spec: &ViewSpec,
    relation: &Relation,
    schema: &[ColumnMeta],
    today: NaiveDate,
) -> Result<BuiltView> {
    let mut b = Builder {
        schema,
        params: relation.params.clone(),
        today,
    };
    let projection = b.projection(spec.columns.as_deref())?;
    let mut conditions = Vec::new();
    for f in &spec.filters {
        conditions.push(b.filter(f)?);
    }
    if let Some(text) = spec.search.as_deref().filter(|s| !s.is_empty()) {
        conditions.push(b.search(text));
    }
    let mut order = b.order_by(&spec.sort)?;
    if let (false, Some(row_order)) = (order.is_empty(), &relation.row_order) {
        order.push_str(", ");
        order.push_str(row_order);
    }

    let mut from = format!("FROM {}", relation.sql);
    if !conditions.is_empty() {
        from.push_str(" WHERE ");
        from.push_str(&conditions.join(" AND "));
    }
    let mut select = format!("SELECT {projection} {from}");
    if !order.is_empty() {
        select.push_str(" ORDER BY ");
        select.push_str(&order);
    }
    Ok(BuiltView {
        select,
        count: format!("SELECT count(*) {from}"),
        params: b.params,
    })
}

struct Builder<'a> {
    schema: &'a [ColumnMeta],
    params: Vec<Param>,
    today: NaiveDate,
}

/// Rough type family of a DuckDB type name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Other,
}

fn kind(duckdb_type: &str) -> Kind {
    if duckdb_type == "VARCHAR" {
        Kind::Text
    } else {
        Kind::Other
    }
}

impl Builder<'_> {
    fn column(&self, name: &str) -> Result<&ColumnMeta> {
        self.schema
            .iter()
            .find(|c| c.name == name)
            .ok_or_else(|| AppError::Query(format!("There is no column named \"{name}\".")))
    }

    fn bind(&mut self, value: Param) -> &'static str {
        self.params.push(value);
        "?"
    }

    fn projection(&self, columns: Option<&[String]>) -> Result<String> {
        let Some(columns) = columns else {
            return Ok("*".into());
        };
        if columns.is_empty() {
            return Err(AppError::Query(
                "Choose at least one column to show.".into(),
            ));
        }
        let mut out = Vec::with_capacity(columns.len());
        for name in columns {
            out.push(quote_ident(&self.column(name)?.name));
        }
        Ok(out.join(", "))
    }

    fn order_by(&self, keys: &[SortKey]) -> Result<String> {
        let mut out = Vec::with_capacity(keys.len());
        for k in keys {
            let col = quote_ident(&self.column(&k.column)?.name);
            let dir = if k.descending { "DESC" } else { "ASC" };
            out.push(format!("{col} {dir} NULLS LAST"));
        }
        Ok(out.join(", "))
    }

    /// The column as text: itself for VARCHAR, otherwise cast.
    fn text_of(col: &ColumnMeta) -> String {
        let q = quote_ident(&col.name);
        match kind(&col.r#type) {
            Kind::Text => q,
            Kind::Other => format!("CAST({q} AS VARCHAR)"),
        }
    }

    /// A text test `func(text, ?)`, lower-cased on both sides unless case-sensitive.
    fn text_test(
        &mut self,
        func: &str,
        col: &ColumnMeta,
        value: &str,
        case_sensitive: bool,
    ) -> String {
        let text = Self::text_of(col);
        let p = self.bind(Param::Text(value.to_string()));
        if case_sensitive {
            format!("{func}({text}, {p})")
        } else {
            format!("{func}(lower({text}), lower({p}))")
        }
    }

    fn compare(&mut self, col: &ColumnMeta, op: &str, value: &Param) -> String {
        let q = quote_ident(&col.name);
        let p = self.bind(value.clone());
        format!("{q} {op} {p}")
    }

    fn filter(&mut self, f: &Filter) -> Result<String> {
        let col = self.column(&f.column)?.clone();
        let q = quote_ident(&col.name);
        let test = match &f.op {
            FilterOp::Contains {
                value,
                case_sensitive,
            } => self.text_test("contains", &col, value, *case_sensitive),
            FilterOp::StartsWith {
                value,
                case_sensitive,
            } => self.text_test("starts_with", &col, value, *case_sensitive),
            FilterOp::EndsWith {
                value,
                case_sensitive,
            } => self.text_test("ends_with", &col, value, *case_sensitive),
            FilterOp::Regex { pattern } => {
                let text = Self::text_of(&col);
                let p = self.bind(Param::Text(pattern.clone()));
                format!("regexp_matches({text}, {p})")
            }
            FilterOp::Empty => match kind(&col.r#type) {
                Kind::Text => format!("({q} IS NULL OR {q} = '')"),
                Kind::Other => format!("{q} IS NULL"),
            },
            FilterOp::IsNull => format!("{q} IS NULL"),
            FilterOp::NotNull => format!("{q} IS NOT NULL"),
            FilterOp::Equals { value: Param::Null } => format!("{q} IS NULL"),
            FilterOp::Equals { value } => self.compare(&col, "=", value),
            FilterOp::Gt { value } => self.compare(&col, ">", value),
            FilterOp::Gte { value } => self.compare(&col, ">=", value),
            FilterOp::Lt { value } => self.compare(&col, "<", value),
            FilterOp::Lte { value } => self.compare(&col, "<=", value),
            FilterOp::Range { min, max } => {
                let mut parts = Vec::new();
                if let Some(v) = min {
                    parts.push(self.compare(&col, ">=", v));
                }
                if let Some(v) = max {
                    parts.push(self.compare(&col, "<=", v));
                }
                match parts.len() {
                    0 => "TRUE".to_string(),
                    1 => parts.remove(0),
                    _ => format!("({})", parts.join(" AND ")),
                }
            }
            FilterOp::LastDays { days } => {
                let from = self.today - chrono::Days::new(u64::from(*days));
                let a = self.bind(Param::Text(from.to_string()));
                let b = self.bind(Param::Text(self.today.to_string()));
                format!("CAST({q} AS DATE) BETWEEN CAST({a} AS DATE) AND CAST({b} AS DATE)")
            }
            FilterOp::In { values } => {
                let with_null = values.contains(&Param::Null);
                let mut marks = Vec::new();
                for v in values.iter().filter(|v| **v != Param::Null) {
                    marks.push(self.bind(v.clone()));
                }
                let list = (!marks.is_empty()).then(|| format!("{q} IN ({})", marks.join(", ")));
                match (list, with_null) {
                    (Some(l), true) => format!("({l} OR {q} IS NULL)"),
                    (Some(l), false) => l,
                    (None, true) => format!("{q} IS NULL"),
                    (None, false) => "FALSE".to_string(),
                }
            }
        };
        Ok(if f.not {
            format!("NOT coalesce({test}, FALSE)")
        } else {
            test
        })
    }

    /// Case-insensitive "contains" over every text column.
    fn search(&mut self, text: &str) -> String {
        let cols: Vec<ColumnMeta> = self
            .schema
            .iter()
            .filter(|c| kind(&c.r#type) == Kind::Text)
            .cloned()
            .collect();
        if cols.is_empty() {
            return "FALSE".into();
        }
        let tests: Vec<String> = cols
            .iter()
            .map(|c| self.text_test("contains", c, text, false))
            .collect();
        format!("({})", tests.join(" OR "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::{Filter, FilterOp, SortKey, ViewSpec};

    fn col(name: &str, t: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            r#type: t.into(),
        }
    }

    fn schema() -> Vec<ColumnMeta> {
        vec![
            col("id", "BIGINT"),
            col("name", "VARCHAR"),
            col("amount", "DOUBLE"),
            col("joined", "DATE"),
            col("active", "BOOLEAN"),
            col("note", "VARCHAR"),
        ]
    }

    fn table() -> Relation {
        Relation {
            sql: "\"ds\".\"main\".\"data\"".into(),
            params: vec![],
            row_order: Some("rowid".into()),
        }
    }

    fn render(v: &BuiltView) -> String {
        format!(
            "{}\n{}\nparams: {}",
            v.select,
            v.count,
            serde_json::to_string(&v.params).unwrap()
        )
    }

    fn f(column: &str, op: FilterOp) -> Filter {
        Filter {
            column: column.into(),
            op,
            not: false,
        }
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2024, 3, 15).unwrap()
    }

    fn sql_for(spec: &ViewSpec) -> String {
        render(&build_at(spec, &table(), &schema(), today()).unwrap())
    }

    fn filter_sql(filter: Filter) -> String {
        sql_for(&ViewSpec {
            filters: vec![filter],
            ..ViewSpec::default()
        })
    }

    #[test]
    fn identity_view() {
        let spec = ViewSpec::default();
        assert!(spec.is_identity());
        insta::assert_snapshot!(sql_for(&spec));
    }

    #[test]
    fn text_filters() {
        let ops = [
            f(
                "name",
                FilterOp::Contains {
                    value: "ann".into(),
                    case_sensitive: false,
                },
            ),
            f(
                "name",
                FilterOp::Contains {
                    value: "Ann".into(),
                    case_sensitive: true,
                },
            ),
            f(
                "name",
                FilterOp::StartsWith {
                    value: "a".into(),
                    case_sensitive: false,
                },
            ),
            f(
                "name",
                FilterOp::EndsWith {
                    value: "z".into(),
                    case_sensitive: false,
                },
            ),
            f(
                "name",
                FilterOp::Regex {
                    pattern: "^a.*\\d$".into(),
                },
            ),
            f(
                "id",
                FilterOp::Contains {
                    value: "42".into(),
                    case_sensitive: false,
                },
            ),
            f(
                "name",
                FilterOp::Equals {
                    value: Param::Text("Ann".into()),
                },
            ),
        ];
        let out: Vec<String> = ops.into_iter().map(filter_sql).collect();
        insta::assert_snapshot!(out.join("\n\n"));
    }

    #[test]
    fn number_date_and_boolean_filters() {
        let ops = [
            f(
                "amount",
                FilterOp::Equals {
                    value: Param::Float(2.5),
                },
            ),
            f(
                "amount",
                FilterOp::Range {
                    min: Some(Param::Int(10)),
                    max: Some(Param::Int(20)),
                },
            ),
            f(
                "amount",
                FilterOp::Range {
                    min: None,
                    max: Some(Param::Int(20)),
                },
            ),
            f(
                "amount",
                FilterOp::Range {
                    min: None,
                    max: None,
                },
            ),
            f(
                "amount",
                FilterOp::Gt {
                    value: Param::Int(0),
                },
            ),
            f(
                "amount",
                FilterOp::Lte {
                    value: Param::Float(9.75),
                },
            ),
            f(
                "joined",
                FilterOp::Lt {
                    value: Param::Text("2024-01-31".into()),
                },
            ),
            f(
                "joined",
                FilterOp::Gte {
                    value: Param::Text("2024-01-01".into()),
                },
            ),
            f("joined", FilterOp::LastDays { days: 30 }),
            f(
                "active",
                FilterOp::Equals {
                    value: Param::Bool(true),
                },
            ),
        ];
        let out: Vec<String> = ops.into_iter().map(filter_sql).collect();
        insta::assert_snapshot!(out.join("\n\n"));
    }

    #[test]
    fn null_empty_and_value_lists() {
        let ops = [
            f("name", FilterOp::Empty),
            f("amount", FilterOp::Empty),
            f("amount", FilterOp::IsNull),
            f("amount", FilterOp::NotNull),
            f("amount", FilterOp::Equals { value: Param::Null }),
            f(
                "name",
                FilterOp::In {
                    values: vec![Param::Text("a".into()), Param::Text("b".into())],
                },
            ),
            f(
                "name",
                FilterOp::In {
                    values: vec![Param::Text("a".into()), Param::Null],
                },
            ),
            f(
                "name",
                FilterOp::In {
                    values: vec![Param::Null],
                },
            ),
            f("name", FilterOp::In { values: vec![] }),
            Filter {
                not: true,
                ..f(
                    "name",
                    FilterOp::Contains {
                        value: "x".into(),
                        case_sensitive: false,
                    },
                )
            },
        ];
        let out: Vec<String> = ops.into_iter().map(filter_sql).collect();
        insta::assert_snapshot!(out.join("\n\n"));
    }

    #[test]
    fn combined_view_with_sort_search_and_columns() {
        let spec = ViewSpec {
            filters: vec![
                f(
                    "amount",
                    FilterOp::Gt {
                        value: Param::Int(100),
                    },
                ),
                f(
                    "active",
                    FilterOp::Equals {
                        value: Param::Bool(true),
                    },
                ),
            ],
            sort: vec![
                SortKey {
                    column: "joined".into(),
                    descending: true,
                },
                SortKey {
                    column: "name".into(),
                    descending: false,
                },
            ],
            search: Some("smith".into()),
            columns: Some(vec!["name".into(), "amount".into(), "id".into()]),
        };
        insta::assert_snapshot!(sql_for(&spec));
    }

    #[test]
    fn parquet_relation_params_come_first() {
        let rel = Relation::of(&DatasetSource::Parquet {
            path: "/d/x.parquet".into(),
        });
        let spec = ViewSpec {
            filters: vec![f(
                "id",
                FilterOp::Gte {
                    value: Param::Int(5),
                },
            )],
            ..ViewSpec::default()
        };
        insta::assert_snapshot!(render(&build(&spec, &rel, &schema()).unwrap()));
    }

    #[test]
    fn empty_search_is_ignored_and_no_text_columns_match_nothing() {
        let spec = ViewSpec {
            search: Some(String::new()),
            ..ViewSpec::default()
        };
        assert!(spec.is_identity());
        assert_eq!(
            build(&spec, &table(), &schema()).unwrap().select,
            "SELECT * FROM \"ds\".\"main\".\"data\""
        );
        let numbers = vec![col("n", "INTEGER")];
        let spec = ViewSpec {
            search: Some("x".into()),
            ..ViewSpec::default()
        };
        let v = build(&spec, &table(), &numbers).unwrap();
        assert!(v.select.ends_with("WHERE FALSE"), "{}", v.select);
    }

    #[test]
    fn tricky_column_names_are_quoted() {
        let names = [
            "first name",
            "say \"hi\"",
            "it's",
            "select",
            "ORDER",
            "日本語",
            "émoji 🎉",
            "a;DROP TABLE x;--",
        ];
        let schema: Vec<ColumnMeta> = names.iter().map(|n| col(n, "VARCHAR")).collect();
        let spec = ViewSpec {
            filters: names
                .iter()
                .map(|n| {
                    f(
                        n,
                        FilterOp::Equals {
                            value: Param::Text("v".into()),
                        },
                    )
                })
                .collect(),
            sort: names
                .iter()
                .map(|n| SortKey {
                    column: n.to_string(),
                    descending: false,
                })
                .collect(),
            search: None,
            columns: Some(names.iter().map(|n| n.to_string()).collect()),
        };
        let v = build(&spec, &table(), &schema).unwrap();
        insta::assert_snapshot!(render(&v));
    }

    #[test]
    fn user_values_never_reach_sql_text() {
        let evil = "'; DROP TABLE t; --";
        let spec = ViewSpec {
            filters: vec![
                f(
                    "name",
                    FilterOp::Contains {
                        value: evil.into(),
                        case_sensitive: false,
                    },
                ),
                f(
                    "name",
                    FilterOp::Regex {
                        pattern: evil.into(),
                    },
                ),
                f(
                    "name",
                    FilterOp::In {
                        values: vec![Param::Text(evil.into())],
                    },
                ),
            ],
            search: Some(evil.into()),
            ..ViewSpec::default()
        };
        let v = build(&spec, &table(), &schema()).unwrap();
        assert!(!v.select.contains("DROP"), "{}", v.select);
        assert_eq!(v.params.len(), 5); // contains, regex, in, search x2 text columns
    }

    #[test]
    fn unknown_columns_are_plain_errors() {
        for spec in [
            ViewSpec {
                filters: vec![f("nope", FilterOp::IsNull)],
                ..ViewSpec::default()
            },
            ViewSpec {
                sort: vec![SortKey {
                    column: "nope".into(),
                    descending: false,
                }],
                ..ViewSpec::default()
            },
            ViewSpec {
                columns: Some(vec!["nope".into()]),
                ..ViewSpec::default()
            },
        ] {
            let err = build(&spec, &table(), &schema()).unwrap_err();
            assert_eq!(err.to_string(), "There is no column named \"nope\".");
        }
        let none = ViewSpec {
            columns: Some(vec![]),
            ..ViewSpec::default()
        };
        assert!(build(&none, &table(), &schema()).is_err());
    }

    #[test]
    fn view_spec_from_ui_json() {
        let json = r#"{
            "filters": [
                {"column": "name", "op": "contains", "value": "ann", "caseSensitive": true},
                {"column": "amount", "op": "range", "min": 1, "max": null},
                {"column": "joined", "op": "lastDays", "days": 7, "not": true},
                {"column": "name", "op": "in", "values": ["a", null]},
                {"column": "note", "op": "empty"}
            ],
            "sort": [{"column": "amount", "descending": true}, {"column": "id"}],
            "search": "x"
        }"#;
        let spec: ViewSpec = serde_json::from_str(json).unwrap();
        assert_eq!(
            spec.filters[0].op,
            FilterOp::Contains {
                value: "ann".into(),
                case_sensitive: true
            }
        );
        assert_eq!(
            spec.filters[1].op,
            FilterOp::Range {
                min: Some(Param::Int(1)),
                max: None
            }
        );
        assert!(spec.filters[2].not);
        assert_eq!(
            spec.filters[3].op,
            FilterOp::In {
                values: vec![Param::Text("a".into()), Param::Null]
            }
        );
        assert!(!spec.sort[1].descending);
        assert_eq!(spec.columns, None);
        // Round trip.
        let back: ViewSpec = serde_json::from_str(&serde_json::to_string(&spec).unwrap()).unwrap();
        assert_eq!(back, spec);
    }
}
