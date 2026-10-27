//! Small SQL helpers. User values are always bound as parameters; only
//! identifiers are written into SQL text, and always through `quote_ident`.

/// Quotes an identifier for DuckDB: `my "col"` -> `"my ""col"""`.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// `schema.table` with both parts quoted.
pub fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

#[cfg(test)]
mod tests {
    use super::*;

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
