//! The MCP messages DataLiq answers: `initialize` and the tool list.

use serde_json::{Value, json};

/// MCP protocol versions this server speaks, newest first.
pub const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "DataLiq reads the user's data files (CSV, TSV, JSON, NDJSON, \
Parquet, compressed too) in the folders they shared, with DuckDB. Start with list_files, then \
describe_file to open a file as a table and see its columns; then query it with DuckDB SQL \
(SELECT only), or use profile_column, value_counts and summarize. Prefer aggregating in SQL \
over reading many rows. Files can also be read directly in SQL with read_csv('path') or \
read_parquet('path') inside the shared folders.";

/// The answer to `initialize`: the client's protocol version when supported.
pub fn initialize(msg: &Value) -> Value {
    let asked = msg["params"]["protocolVersion"]
        .as_str()
        .unwrap_or_default();
    let version = PROTOCOL_VERSIONS
        .iter()
        .find(|v| **v == asked)
        .copied()
        .unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "dataliq", "title": "DataLiq", "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}

fn tool(name: &str, title: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required },
        "annotations": { "readOnlyHint": name != "export_query" && name != "open_in_dataliq" },
    })
}

/// The tools, with `export_query` only when exports are allowed.
pub fn tools(allow_export: bool) -> Vec<Value> {
    let path = json!({ "type": "string", "description": "Absolute path of a data file in a shared folder" });
    let table = json!({ "type": "string", "description": "A table name from describe_file" });
    let column = json!({ "type": "string", "description": "Column name" });
    let mut list = vec![
        tool(
            "list_files",
            "List data files",
            "Data files (CSV, TSV, JSON, NDJSON, Parquet) in the shared folders, or in one of them or a subfolder.",
            json!({ "folder": { "type": "string", "description": "A shared folder or a folder inside one (optional)" } }),
            &[],
        ),
        tool(
            "describe_file",
            "Describe a file",
            "Opens a data file as a table: its row count, columns with types, the first rows, and the table name to query it by.",
            json!({ "path": path }),
            &["path"],
        ),
        tool(
            "query",
            "Run a query",
            "Runs one read-only DuckDB SQL query (SELECT, WITH, FROM, PIVOT, SUMMARIZE …) over the opened tables or read_csv/read_parquet of shared files. Answers with up to max_rows rows as a table.",
            json!({
                "sql": { "type": "string", "description": "One DuckDB SELECT query" },
                "max_rows": { "type": "integer", "minimum": 1, "maximum": crate::mcp::MAX_ROWS, "default": crate::mcp::DEFAULT_ROWS },
            }),
            &["sql"],
        ),
        tool(
            "profile_column",
            "Profile a column",
            "Statistics of one column of an opened table: rows, empty values, distinct values, min, max, mean, standard deviation and the most common values.",
            json!({ "table": table, "column": column }),
            &["table", "column"],
        ),
        tool(
            "value_counts",
            "Count values",
            "Each value of a column with its count and share, most common first.",
            json!({ "table": table, "column": column, "limit": { "type": "integer", "minimum": 1, "default": 20 } }),
            &["table", "column"],
        ),
        tool(
            "summarize",
            "Summarize a table",
            "One row per column of an opened table: type, min, max, approximate distinct count, mean, quartiles, count and null share.",
            json!({ "table": table }),
            &["table"],
        ),
        tool(
            "open_in_dataliq",
            "Open in DataLiq",
            "Opens a data file in the DataLiq app on the user's screen, as a new tab.",
            json!({ "path": path }),
            &["path"],
        ),
    ];
    if allow_export {
        list.push(tool(
            "export_query",
            "Export a query",
            "Writes the rows of one read-only query to a new file in a shared folder; the format comes from the extension (.csv, .csv.gz, .tsv, .parquet, .json, .ndjson).",
            json!({
                "sql": { "type": "string", "description": "One DuckDB SELECT query" },
                "path": { "type": "string", "description": "Absolute path of the new file, in a shared folder" },
            }),
            &["sql", "path"],
        ));
    }
    list
}
