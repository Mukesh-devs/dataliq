//! Small SQL helpers. User values are always bound as parameters; only
//! identifiers are written into SQL text, and always through `quote_ident`.

use super::Param;

/// Quotes an identifier for DuckDB: `my "col"` -> `"my ""col"""`.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// `schema.table` with both parts quoted.
pub fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

/// A parameter as a SQL literal: strings quoted with `'` doubled, floats in
/// their shortest exact form, non-finite floats as typed strings.
pub fn literal(p: &Param) -> String {
    match p {
        Param::Null => "NULL".into(),
        Param::Bool(b) => if *b { "true" } else { "false" }.into(),
        Param::Int(i) => i.to_string(),
        Param::Float(f) if f.is_finite() => format!("{f:?}"),
        Param::Float(f) => format!("'{f}'::DOUBLE"),
        Param::Text(s) => format!("'{}'", s.replace('\'', "''")),
    }
}

/// Replaces each `?` placeholder in `sql` with its parameter as a literal,
/// so the statement runs on its own (e.g. pasted into DuckDB). Question
/// marks inside quoted strings and identifiers are left alone. Only for SQL
/// we built (placeholders in order); never executed by the app.
pub fn inline_params(sql: &str, params: &[Param]) -> String {
    let mut out = String::with_capacity(sql.len() + 64);
    let mut it = params.iter();
    let mut quote: Option<char> = None;
    for ch in sql.chars() {
        match quote {
            // A doubled quote inside a quoted part closes and reopens it,
            // which leaves the state right either way.
            Some(q) if ch == q => quote = None,
            Some(_) => {}
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch == '?' => {
                if let Some(p) = it.next() {
                    out.push_str(&literal(p));
                    continue;
                }
            }
            None => {}
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inlines_params_outside_quotes_only() {
        let sql = inline_params(
            "SELECT \"what?\" FROM read_csv('/a/b?.csv') WHERE x = ? AND y = ? AND z = ? AND \"it\"\"s?\" = ?",
            &[
                Param::Text("it's ?".into()),
                Param::Float(0.1),
                Param::Float(f64::NAN),
                Param::Int(-3),
            ],
        );
        assert_eq!(
            sql,
            "SELECT \"what?\" FROM read_csv('/a/b?.csv') WHERE x = 'it''s ?' AND y = 0.1 AND z = 'NaN'::DOUBLE AND \"it\"\"s?\" = -3"
        );
        assert_eq!(literal(&Param::Float(1e300)), "1e300");
        assert_eq!(literal(&Param::Float(5.0)), "5.0");
        assert_eq!(literal(&Param::Bool(false)), "false");
        assert_eq!(literal(&Param::Null), "NULL");
    }

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_ident("plain"), "\"plain\"");
        assert_eq!(quote_ident("with space"), "\"with space\"");
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(quote_ident("select"), "\"select\"");
        assert_eq!(quote_ident("日本"), "\"日本\"");
        assert_eq!(qualified("main", "t"), "\"main\".\"t\"");
    }
}
