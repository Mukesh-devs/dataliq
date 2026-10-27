//! One cleaning step as SQL over the previous step's query. Column names
//! reach SQL only through `quote_ident` after being checked against the
//! current schema; user values are inlined as safely quoted literals, so a
//! recipe is one standalone query (it can be copied as a script).

use super::{Case, NewType, Step};
use crate::engine::Param;
use crate::engine::sql::{inline_params, literal, quote_ident};
use crate::error::{AppError, Result};
use crate::sources::ColumnMeta;
use crate::view::{Filter, ProfileKind, Relation, ViewSpec, build};

/// Row position kept while removing duplicates (not a name users have).
const POS: &str = "__bigview_pos";

fn column<'a>(schema: &'a [ColumnMeta], name: &str) -> Result<&'a ColumnMeta> {
    schema
        .iter()
        .find(|c| c.name == name)
        .ok_or_else(|| AppError::Query(format!("There is no column named \"{name}\".")))
}

fn text(s: &str) -> String {
    literal(&Param::Text(s.to_string()))
}

/// Every column in order, `f` choosing a new expression (or none) for some.
fn project(schema: &[ColumnMeta], f: impl Fn(&ColumnMeta) -> Option<String>) -> String {
    schema
        .iter()
        .map(|c| {
            let q = quote_ident(&c.name);
            match f(c) {
                Some(expr) => format!("{expr} AS {q}"),
                None => q,
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn check_new_name(schema: &[ColumnMeta], name: &str, except: Option<&str>) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Query("Give the column a name.".into()));
    }
    if name == POS {
        return Err(AppError::Query(format!(
            "\"{POS}\" is a name BigView uses itself."
        )));
    }
    if schema
        .iter()
        .any(|c| c.name.eq_ignore_ascii_case(name) && Some(c.name.as_str()) != except)
    {
        return Err(AppError::Query(format!(
            "There is already a column named \"{name}\"."
        )));
    }
    Ok(())
}

fn require_text(meta: &ColumnMeta, what: &str) -> Result<()> {
    if ProfileKind::of(&meta.r#type) == ProfileKind::Text {
        Ok(())
    } else {
        Err(AppError::Query(format!(
            "{what} works on text columns; \"{}\" is {}.",
            meta.name, meta.r#type
        )))
    }
}

/// The DuckDB type for a "change type" step.
pub fn duckdb_type(t: NewType) -> &'static str {
    match t {
        NewType::Integer => "BIGINT",
        NewType::Number => "DOUBLE",
        NewType::Text => "VARCHAR",
        NewType::Date => "DATE",
        NewType::Timestamp => "TIMESTAMP",
        NewType::Boolean => "BOOLEAN",
    }
}

/// `col` converted to `to`: NULL where it can't be (counted by the step).
pub fn convert(col: &str, meta: &ColumnMeta, to: NewType, format: Option<&str>) -> String {
    let format = format.filter(|f| !f.trim().is_empty());
    match (to, format) {
        (NewType::Date | NewType::Timestamp, Some(f))
            if ProfileKind::of(&meta.r#type) == ProfileKind::Text =>
        {
            let parsed = format!("try_strptime({col}, {})", text(f));
            if to == NewType::Date {
                format!("CAST({parsed} AS DATE)")
            } else {
                parsed
            }
        }
        _ => format!("TRY_CAST({col} AS {})", duckdb_type(to)),
    }
}

/// `pattern` as a regular expression matching it literally.
fn regex_escape(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len());
    for ch in pattern.chars() {
        if "\\.+*?()|[]{}^$".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// The query of `step` over the relation `prev` (a name or a parenthesised
/// query), whose columns are `schema`.
pub fn step_sql(step: &Step, prev: &str, schema: &[ColumnMeta]) -> Result<String> {
    let from = format!("FROM {prev}");
    Ok(match step {
        Step::Rename { column: name, to } => {
            column(schema, name)?;
            check_new_name(schema, to, Some(name))?;
            let cols = schema
                .iter()
                .map(|c| {
                    if &c.name == name {
                        format!("{} AS {}", quote_ident(name), quote_ident(to.trim()))
                    } else {
                        quote_ident(&c.name)
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("SELECT {cols} {from}")
        }
        Step::ChangeType {
            column: name,
            to,
            format,
        } => {
            let meta = column(schema, name)?;
            let expr = convert(&quote_ident(name), meta, *to, format.as_deref());
            format!(
                "SELECT {} {from}",
                project(schema, |c| (&c.name == name).then(|| expr.clone()))
            )
        }
        Step::Trim { column: name } => {
            let meta = column(schema, name)?;
            require_text(meta, "Trimming spaces")?;
            let expr = format!("trim({})", quote_ident(name));
            format!(
                "SELECT {} {from}",
                project(schema, |c| (&c.name == name).then(|| expr.clone()))
            )
        }
        Step::ChangeCase { column: name, case } => {
            let meta = column(schema, name)?;
            require_text(meta, "Changing case")?;
            let q = quote_ident(name);
            let expr = match case {
                Case::Upper => format!("upper({q})"),
                Case::Lower => format!("lower({q})"),
                // Each run of letters: first upper case, the rest lower case
                // (as spreadsheets' PROPER: "o'neil-smith" -> "O'Neil-Smith").
                Case::Title => format!(
                    "array_to_string(list_transform(regexp_extract_all(lower({q}), \
                     '\\p{{L}}+|\\P{{L}}+'), w -> upper(w[1]) || w[2:]), '')"
                ),
            };
            format!(
                "SELECT {} {from}",
                project(schema, |c| (&c.name == name).then(|| expr.clone()))
            )
        }
        Step::Replace {
            column: name,
            find,
            replace,
            regex,
            case_sensitive,
        } => {
            let meta = column(schema, name)?;
            require_text(meta, "Find and replace")?;
            if find.is_empty() {
                return Err(AppError::Query("Type what to find.".into()));
            }
            let q = quote_ident(name);
            let expr = if !regex && *case_sensitive {
                format!("replace({q}, {}, {})", text(find), text(replace))
            } else {
                let pattern = if *regex {
                    find.clone()
                } else {
                    regex_escape(find)
                };
                // In a replacement, \ starts a group reference; plain text has none.
                let with = if *regex {
                    replace.clone()
                } else {
                    replace.replace('\\', "\\\\")
                };
                let flags = if *case_sensitive { "g" } else { "gi" };
                format!(
                    "regexp_replace({q}, {}, {}, {})",
                    text(&pattern),
                    text(&with),
                    text(flags)
                )
            };
            format!(
                "SELECT {} {from}",
                project(schema, |c| (&c.name == name).then(|| expr.clone()))
            )
        }
        Step::Split {
            column: name,
            delimiter,
            into,
            keep,
        } => {
            let meta = column(schema, name)?;
            if delimiter.is_empty() {
                return Err(AppError::Query("Type the text to split on.".into()));
            }
            if into.len() < 2 {
                return Err(AppError::Query("Split into at least two columns.".into()));
            }
            let mut taken: Vec<ColumnMeta> = schema
                .iter()
                .filter(|c| *keep || &c.name != name)
                .cloned()
                .collect();
            for n in into {
                check_new_name(&taken, n, None)?;
                taken.push(ColumnMeta {
                    name: n.trim().to_string(),
                    r#type: "VARCHAR".into(),
                });
            }
            let q = quote_ident(name);
            let value = if ProfileKind::of(&meta.r#type) == ProfileKind::Text {
                q.clone()
            } else {
                format!("CAST({q} AS VARCHAR)")
            };
            let parts = into
                .iter()
                .enumerate()
                .map(|(i, n)| {
                    format!(
                        "nullif(split_part({value}, {}, {}), '') AS {}",
                        text(delimiter),
                        i + 1,
                        quote_ident(n.trim())
                    )
                })
                .collect::<Vec<_>>();
            let mut cols = Vec::new();
            for c in schema {
                if &c.name == name {
                    if *keep {
                        cols.push(q.clone());
                    }
                    cols.extend(parts.iter().cloned());
                } else {
                    cols.push(quote_ident(&c.name));
                }
            }
            format!("SELECT {} {from}", cols.join(", "))
        }
        Step::FillEmpty {
            column: name,
            value,
        } => {
            let meta = column(schema, name)?;
            let q = quote_ident(name);
            let fill = format!("CAST({} AS {})", text(value), meta.r#type);
            // Text columns: empty strings count as empty too.
            let expr = if ProfileKind::of(&meta.r#type) == ProfileKind::Text {
                format!("coalesce(nullif({q}, ''), {fill})")
            } else {
                format!("coalesce({q}, {fill})")
            };
            format!(
                "SELECT {} {from}",
                project(schema, |c| (&c.name == name).then(|| expr.clone()))
            )
        }
        Step::RemoveDuplicates { columns } => {
            let keys = match columns {
                Some(cols) if !cols.is_empty() => {
                    for c in cols {
                        column(schema, c)?;
                    }
                    cols.clone()
                }
                _ => schema.iter().map(|c| c.name.clone()).collect(),
            };
            let pos = quote_ident(POS);
            let keys = keys
                .iter()
                .map(|k| quote_ident(k))
                .collect::<Vec<_>>()
                .join(", ");
            // The first of each set of duplicates stays, in file order.
            format!(
                "SELECT * EXCLUDE ({pos}) FROM (SELECT *, row_number() OVER () AS {pos} {from}) \
                 QUALIFY row_number() OVER (PARTITION BY {keys} ORDER BY {pos}) = 1 ORDER BY {pos}"
            )
        }
        Step::RemoveRows { filter } => {
            column(schema, &filter.column)?;
            // Keep the rows the filter doesn't match (its "not", which keeps
            // rows where the test is NULL).
            let keep = Filter {
                not: !filter.not,
                ..filter.clone()
            };
            let relation = Relation {
                sql: prev.to_string(),
                params: Vec::new(),
                row_order: None,
            };
            let built = build(
                &ViewSpec {
                    filters: vec![keep],
                    ..ViewSpec::default()
                },
                &relation,
                schema,
            )?;
            inline_params(&built.select, &built.params)
        }
        Step::Calculate { name, expression } => {
            check_new_name(schema, name, None)?;
            if expression.trim().is_empty() {
                return Err(AppError::Query("Type a SQL expression.".into()));
            }
            if expression.contains(';') {
                return Err(AppError::Query(
                    "A calculated column is one expression, without ';'.".into(),
                ));
            }
            format!(
                "SELECT *, ({}) AS {} {from}",
                expression.trim(),
                quote_ident(name.trim())
            )
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::FilterOp;

    fn schema() -> Vec<ColumnMeta> {
        [
            ("id", "BIGINT"),
            ("name", "VARCHAR"),
            ("amount", "DOUBLE"),
            ("joined", "VARCHAR"),
        ]
        .iter()
        .map(|(n, t)| ColumnMeta {
            name: n.to_string(),
            r#type: t.to_string(),
        })
        .collect()
    }

    const PREV: &str = "t";

    fn sql(step: Step) -> String {
        step_sql(&step, PREV, &schema()).unwrap()
    }

    #[test]
    fn column_steps() {
        let all = [
            sql(Step::Rename {
                column: "name".into(),
                to: "Full name".into(),
            }),
            sql(Step::ChangeType {
                column: "joined".into(),
                to: NewType::Date,
                format: Some("%d/%m/%Y".into()),
            }),
            sql(Step::ChangeType {
                column: "amount".into(),
                to: NewType::Integer,
                format: None,
            }),
            sql(Step::Trim {
                column: "name".into(),
            }),
            sql(Step::ChangeCase {
                column: "name".into(),
                case: Case::Title,
            }),
            sql(Step::Replace {
                column: "name".into(),
                find: "Mr. ".into(),
                replace: "".into(),
                regex: false,
                case_sensitive: false,
            }),
            sql(Step::Replace {
                column: "name".into(),
                find: "(\\w+) (\\w+)".into(),
                replace: "\\2, \\1".into(),
                regex: true,
                case_sensitive: true,
            }),
            sql(Step::Split {
                column: "name".into(),
                delimiter: " ".into(),
                into: vec!["first".into(), "last".into()],
                keep: false,
            }),
            sql(Step::FillEmpty {
                column: "amount".into(),
                value: "0".into(),
            }),
            sql(Step::FillEmpty {
                column: "name".into(),
                value: "O'Neil".into(),
            }),
        ];
        insta::assert_snapshot!(all.join("\n\n"));
    }

    #[test]
    fn row_steps() {
        let all = [
            sql(Step::RemoveDuplicates { columns: None }),
            sql(Step::RemoveDuplicates {
                columns: Some(vec!["name".into()]),
            }),
            sql(Step::RemoveRows {
                filter: Filter {
                    column: "amount".into(),
                    op: FilterOp::Lt {
                        value: Param::Float(0.0),
                    },
                    not: false,
                },
            }),
            sql(Step::Calculate {
                name: "with tax".into(),
                expression: "amount * 1.2".into(),
            }),
        ];
        insta::assert_snapshot!(all.join("\n\n"));
    }

    #[test]
    fn steps_explain_what_is_wrong() {
        let err = |step: Step| step_sql(&step, PREV, &schema()).unwrap_err().to_string();
        assert!(
            err(Step::Trim {
                column: "id".into()
            })
            .contains("text columns")
        );
        assert!(
            err(Step::Rename {
                column: "id".into(),
                to: "NAME".into()
            })
            .contains("already a column named")
        );
        assert!(
            err(Step::Calculate {
                name: "x".into(),
                expression: "1; DROP TABLE t".into()
            })
            .contains("without ';'")
        );
        assert!(
            err(Step::Split {
                column: "name".into(),
                delimiter: " ".into(),
                into: vec!["only".into()],
                keep: false
            })
            .contains("at least two")
        );
        assert!(
            err(Step::Trim {
                column: "nope".into()
            })
            .contains("no column named")
        );
        // Renaming a column to its own name in another case is fine.
        assert!(
            step_sql(
                &Step::Rename {
                    column: "id".into(),
                    to: "ID".into()
                },
                PREV,
                &schema()
            )
            .is_ok()
        );
    }

    #[test]
    fn plain_text_is_matched_literally() {
        assert_eq!(regex_escape("a.b*c"), "a\\.b\\*c");
    }
}
