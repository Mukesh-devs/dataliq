//! Turns DuckDB reader errors into plain messages with a suggested fix.

use crate::error::AppError;

fn number_after<'a>(msg: &'a str, label: &str) -> Option<&'a str> {
    let rest = &msg[msg.find(label)? + label.len()..];
    let rest = rest.trim_start();
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    (end > 0).then(|| &rest[..end])
}

pub(crate) fn group_digits(n: &str) -> String {
    let mut out = String::new();
    for (i, c) in n.chars().enumerate() {
        if i > 0 && (n.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Maps a raw DuckDB error message to a user-facing [`AppError`].
pub fn friendly_error(raw: &str) -> AppError {
    if raw.contains("Interrupted") {
        return AppError::Cancelled;
    }
    let lower = raw.to_lowercase();
    let msg = if lower.contains("expected number of columns") {
        let line = number_after(raw, "Line:").map(group_digits);
        let expected = number_after(raw, "Expected Number of Columns:");
        let found = number_after(raw, "Found:");
        match (line, expected, found) {
            (Some(l), Some(e), Some(f)) => format!(
                "Line {l} has {f} columns, expected {e}. Try \"Ignore bad rows\" in Import settings."
            ),
            _ => "Some rows have a different number of columns. Try \"Ignore bad rows\" in Import settings.".to_string(),
        }
    } else if lower.contains("invalid unicode")
        || lower.contains("not utf-8")
        || lower.contains("byte sequence")
    {
        "This file isn't valid UTF-8 text. Try a different Encoding (for example latin-1) in Import settings.".to_string()
    } else if lower.contains("gzip") || lower.contains("zlib") || lower.contains("inflate") {
        "This compressed file looks damaged or incomplete, so it can't be fully read.".to_string()
    } else if lower.contains("could not convert") || lower.contains("conversion error") {
        let line = number_after(raw, "Line:").map(group_digits);
        match line {
            Some(l) => format!(
                "A value on line {l} doesn't match the detected column type. Try \"Ignore bad rows\", or set the Date format in Import settings."
            ),
            None => "A value doesn't match the detected column type. Try \"Ignore bad rows\" in Import settings.".to_string(),
        }
    } else if lower.contains("no files found") || lower.contains("no such file") {
        "The file could not be found. It may have been moved or deleted.".to_string()
    } else {
        // Keep DuckDB's first line; the rest is usually internal detail.
        raw.lines().next().unwrap_or(raw).to_string()
    };
    AppError::Query(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(e: AppError) -> String {
        e.to_string()
    }

    #[test]
    fn column_count_error_names_the_row() {
        let raw = "Invalid Input Error: CSV Error on Line: 1204551\nOriginal Line: a,b\nExpected Number of Columns: 12 Found: 14\nPossible fixes: ...";
        assert_eq!(
            text(friendly_error(raw)),
            "Line 1,204,551 has 14 columns, expected 12. Try \"Ignore bad rows\" in Import settings."
        );
    }

    #[test]
    fn interrupted_is_cancelled() {
        assert!(matches!(
            friendly_error("INTERRUPT Error: Interrupted!"),
            AppError::Cancelled
        ));
    }

    #[test]
    fn unknown_errors_keep_the_first_line() {
        assert_eq!(
            text(friendly_error("Binder Error: x\nmore")),
            "Binder Error: x"
        );
    }
}
