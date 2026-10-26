//! Bound query parameters sent from the UI. User values always travel as
//! parameters, never spliced into SQL text.

use duckdb::ToSql;
use duckdb::types::{ToSqlOutput, Value};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Param {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
}

impl ToSql for Param {
    fn to_sql(&self) -> duckdb::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Owned(match self {
            Param::Null => Value::Null,
            Param::Bool(b) => Value::Boolean(*b),
            Param::Int(i) => Value::BigInt(*i),
            Param::Float(f) => Value::Double(*f),
            Param::Text(s) => Value::Text(s.clone()),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_json_values() {
        let p: Vec<Param> = serde_json::from_str(r#"[null, true, 3, 2.5, "x"]"#).unwrap();
        assert_eq!(
            p,
            vec![
                Param::Null,
                Param::Bool(true),
                Param::Int(3),
                Param::Float(2.5),
                Param::Text("x".into())
            ]
        );
    }
}
