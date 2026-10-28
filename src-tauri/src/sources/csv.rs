//! CSV/TSV reader options and the DuckDB `read_csv(...)` call built from them.

use serde::{Deserialize, Serialize};

use super::detect::{Compression, FileFormat};
use crate::engine::Param;

/// User-facing CSV import settings. `None` means "let DuckDB's sniffer decide".
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CsvOptions {
    pub delimiter: Option<String>,
    pub header: Option<bool>,
    pub quote: Option<String>,
    pub escape: Option<String>,
    /// `utf-8`, `latin-1` or `utf-16`.
    pub encoding: Option<String>,
    pub skip_rows: Option<u32>,
    /// Skip rows that don't parse (wrong column count, bad values).
    pub ignore_errors: bool,
    pub date_format: Option<String>,
    pub timestamp_format: Option<String>,
}

/// Encodings DuckDB can decode without downloading the `encodings` extension.
pub const ENCODINGS: &[&str] = &["utf-8", "latin-1", "utf-16"];

impl CsvOptions {
    /// Validates values a user typed, with plain messages.
    pub fn validate(&self) -> Result<(), String> {
        for (name, v) in [
            ("Delimiter", &self.delimiter),
            ("Quote", &self.quote),
            ("Escape", &self.escape),
        ] {
            if let Some(v) = v {
                if v.is_empty() || v.chars().count() > 4 {
                    return Err(format!("{name} must be 1 to 4 characters."));
                }
            }
        }
        if let Some(e) = &self.encoding {
            if !ENCODINGS.contains(&e.as_str()) {
                return Err(format!(
                    "Encoding must be one of: {}.",
                    ENCODINGS.join(", ")
                ));
            }
        }
        Ok(())
    }
}

/// Builds `read_csv(?, opt = ?, ...)` (or `sniff_csv(...)`) with every value bound.
pub fn reader_call(
    function: &str,
    path: &str,
    format: FileFormat,
    compression: Compression,
    opts: &CsvOptions,
) -> (String, Vec<Param>) {
    reader_call_with(function, path, format, compression, opts, &[])
}

/// Like [`reader_call`], with extra fixed options (names must be constants).
pub fn reader_call_with(
    function: &str,
    path: &str,
    format: FileFormat,
    compression: Compression,
    opts: &CsvOptions,
    extra: &[(&'static str, Param)],
) -> (String, Vec<Param>) {
    let mut sql = format!("{function}(?");
    let mut params = vec![Param::Text(path.to_string())];
    let mut add = |name: &str, value: Param| {
        sql.push_str(", ");
        sql.push_str(name); // option names are fixed identifiers from this function
        sql.push_str(" = ?");
        params.push(value);
    };

    let delimiter = opts
        .delimiter
        .clone()
        .or_else(|| (format == FileFormat::Tsv).then(|| "\t".to_string()));
    if let Some(d) = delimiter {
        add("delim", Param::Text(d));
    }
    if let Some(h) = opts.header {
        add("header", Param::Bool(h));
    }
    if let Some(q) = &opts.quote {
        add("quote", Param::Text(q.clone()));
    }
    if let Some(e) = &opts.escape {
        add("escape", Param::Text(e.clone()));
    }
    if let Some(e) = &opts.encoding {
        add("encoding", Param::Text(e.clone()));
    }
    if let Some(s) = opts.skip_rows {
        add("skip", Param::Int(i64::from(s)));
    }
    if opts.ignore_errors {
        add("ignore_errors", Param::Bool(true));
    }
    if let Some(f) = &opts.date_format {
        add("dateformat", Param::Text(f.clone()));
    }
    if let Some(f) = &opts.timestamp_format {
        add("timestampformat", Param::Text(f.clone()));
    }
    // Set explicitly so content-detected gzip works without a .gz extension.
    add(
        "compression",
        Param::Text(compression.duckdb_name().to_string()),
    );
    // A quoted empty field (`""`) is an empty string, not NULL; only an
    // empty unquoted field is NULL (D28).
    add("allow_quoted_nulls", Param::Bool(false));
    for (name, value) in extra {
        add(name, value.clone());
    }
    sql.push(')');
    (sql, params)
}

/// A list of paths as a DuckDB list literal, `['a', 'b']`.
pub fn path_list(paths: &[String]) -> String {
    let items = paths
        .iter()
        .map(|p| format!("'{}'", p.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ");
    format!("[{items}]")
}

/// Like [`reader_call_with`] over several files, given as a list literal.
pub fn reader_call_files(
    function: &str,
    paths: &[String],
    format: FileFormat,
    compression: Compression,
    opts: &CsvOptions,
    extra: &[(&'static str, Param)],
) -> (String, Vec<Param>) {
    let (sql, mut params) = reader_call_with(function, "", format, compression, opts, extra);
    params.remove(0);
    let sql = sql.replacen(
        &format!("{function}(?"),
        &format!("{function}({}", path_list(paths)),
        1,
    );
    (sql, params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_call_only_sets_compression() {
        let (sql, params) = reader_call(
            "read_csv",
            "/d/a.csv",
            FileFormat::Csv,
            Compression::None,
            &CsvOptions::default(),
        );
        assert_eq!(sql, "read_csv(?, compression = ?, allow_quoted_nulls = ?)");
        assert_eq!(
            params,
            vec![
                Param::Text("/d/a.csv".into()),
                Param::Text("none".into()),
                Param::Bool(false)
            ]
        );
    }

    #[test]
    fn tsv_defaults_to_tab_and_options_are_bound() {
        let opts = CsvOptions {
            header: Some(false),
            skip_rows: Some(2),
            ignore_errors: true,
            encoding: Some("latin-1".into()),
            ..CsvOptions::default()
        };
        let (sql, params) = reader_call(
            "read_csv",
            "x.tsv.gz",
            FileFormat::Tsv,
            Compression::Gzip,
            &opts,
        );
        assert_eq!(
            sql,
            "read_csv(?, delim = ?, header = ?, encoding = ?, skip = ?, ignore_errors = ?, compression = ?, allow_quoted_nulls = ?)"
        );
        assert_eq!(params[1], Param::Text("\t".into()));
        assert_eq!(params[params.len() - 2], Param::Text("gzip".into()));
    }

    #[test]
    fn user_text_never_reaches_sql() {
        let opts = CsvOptions {
            delimiter: Some("';--".into()),
            ..CsvOptions::default()
        };
        let (sql, _) = reader_call(
            "read_csv",
            "it's.csv",
            FileFormat::Csv,
            Compression::None,
            &opts,
        );
        assert!(!sql.contains("it's") && !sql.contains("--"), "{sql}");
    }

    #[test]
    fn validates_user_input() {
        assert!(
            CsvOptions {
                delimiter: Some(String::new()),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            CsvOptions {
                encoding: Some("ebcdic".into()),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            CsvOptions {
                delimiter: Some(";".into()),
                encoding: Some("utf-16".into()),
                ..Default::default()
            }
            .validate()
            .is_ok()
        );
    }
}
