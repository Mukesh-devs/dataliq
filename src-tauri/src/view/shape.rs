//! The structure of nested data (JSON and NDJSON files): every key with
//! its type, how often it is present and how long arrays are, for the
//! structure graph. Built from the view's Arrow schema and one aggregate
//! query, so no rows reach the UI however big the file.

use arrow::array::{Array, AsArray};
use arrow::datatypes::{DataType, Float64Type, Int64Type};
use serde::Serialize;

use super::{Relation, ViewSpec, build};
use crate::engine::sql::{literal, quote_ident};
use crate::engine::{Engine, Param, RequestKey};
use crate::error::{AppError, Result};

/// Most statistics computed in one query (wide files keep their structure,
/// the rest go without counts).
pub const MAX_SHAPE_STATS: usize = 600;
/// Most arrays counted inside by the deep count (one query each).
pub const MAX_DEEP_ARRAYS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShapeKind {
    Object,
    Array,
    Value,
}

/// One key (or the items of an array) and what is inside.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeNode {
    pub name: String,
    pub kind: ShapeKind,
    /// "text", "integer", "number[]", "object", "object[]", …
    pub r#type: String,
    /// Records where it is not null (keys outside arrays only).
    pub present: Option<u64>,
    /// Arrays outside arrays: average and largest length.
    pub avg_len: Option<f64>,
    pub max_len: Option<u64>,
    /// SQL that reads it (keys outside arrays), e.g. `"user"."address"."city"`.
    pub sql: Option<String>,
    /// Arrays, with the deep count: items in every record together (the
    /// keys inside count against this).
    pub items: Option<u64>,
    pub children: Vec<ShapeNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonShape {
    /// Records (rows) in the view.
    pub rows: u64,
    /// Top-level keys.
    pub fields: Vec<ShapeNode>,
    pub elapsed_ms: u64,
}

/// A plain type name for a leaf.
fn type_name(t: &DataType) -> String {
    match t {
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => "text".into(),
        DataType::Int8
        | DataType::Int16
        | DataType::Int32
        | DataType::Int64
        | DataType::UInt8
        | DataType::UInt16
        | DataType::UInt32
        | DataType::UInt64 => "integer".into(),
        DataType::Float16
        | DataType::Float32
        | DataType::Float64
        | DataType::Decimal128(..)
        | DataType::Decimal256(..) => "number".into(),
        DataType::Boolean => "boolean".into(),
        DataType::Date32 | DataType::Date64 => "date".into(),
        DataType::Timestamp(..) => "timestamp".into(),
        DataType::Time32(_) | DataType::Time64(_) => "time".into(),
        DataType::Null => "null".into(),
        DataType::Binary | DataType::LargeBinary | DataType::BinaryView => "binary".into(),
        DataType::Struct(_) | DataType::Map(..) => "object".into(),
        DataType::List(f) | DataType::LargeList(f) | DataType::FixedSizeList(f, _) => {
            format!("{}[]", type_name(f.data_type()))
        }
        other => other.to_string().to_lowercase(),
    }
}

/// Statistics to compute: (expression, node to fill, which number).
enum Stat {
    Present,
    AvgLen,
    MaxLen,
}

struct Pending {
    exprs: Vec<String>,
    targets: Vec<(Vec<usize>, Stat)>,
}

/// The node for a value of type `t`, named `name`, read by `sql` when it
/// isn't inside an array. `at` is its position in the tree (for stats).
fn node(
    name: &str,
    t: &DataType,
    sql: Option<String>,
    at: Vec<usize>,
    p: &mut Pending,
) -> ShapeNode {
    let mut stat = |expr: String, which: Stat| {
        if p.exprs.len() < MAX_SHAPE_STATS {
            p.exprs.push(expr);
            p.targets.push((at.clone(), which));
        }
    };
    if let Some(s) = &sql {
        stat(format!("count({s})::BIGINT"), Stat::Present);
    }
    match t {
        DataType::Struct(fields) => ShapeNode {
            name: name.into(),
            kind: ShapeKind::Object,
            r#type: "object".into(),
            present: None,
            avg_len: None,
            max_len: None,
            items: None,
            children: fields
                .iter()
                .enumerate()
                .map(|(i, f)| {
                    let child_sql = sql.as_ref().map(|s| {
                        format!(
                            "struct_extract({s}, {})",
                            literal(&Param::Text(f.name().clone()))
                        )
                    });
                    let mut pos = at.clone();
                    pos.push(i);
                    node(f.name(), f.data_type(), child_sql, pos, p)
                })
                .collect(),
            sql,
        },
        DataType::List(item) | DataType::LargeList(item) | DataType::FixedSizeList(item, _) => {
            if let Some(s) = &sql {
                stat(format!("CAST(avg(len({s})) AS DOUBLE)"), Stat::AvgLen);
                stat(format!("max(len({s}))::BIGINT"), Stat::MaxLen);
            }
            // The items' shape: an array of objects lists their keys.
            let children = match item.data_type() {
                DataType::Struct(fields) => fields
                    .iter()
                    .enumerate()
                    .map(|(i, f)| {
                        let mut pos = at.clone();
                        pos.push(i);
                        node(f.name(), f.data_type(), None, pos, p)
                    })
                    .collect(),
                DataType::List(_) | DataType::LargeList(_) => {
                    let mut pos = at.clone();
                    pos.push(0);
                    vec![node("[]", item.data_type(), None, pos, p)]
                }
                _ => Vec::new(),
            };
            ShapeNode {
                name: name.into(),
                kind: ShapeKind::Array,
                r#type: type_name(t),
                present: None,
                avg_len: None,
                max_len: None,
                items: None,
                sql,
                children,
            }
        }
        DataType::Map(..) => ShapeNode {
            name: name.into(),
            kind: ShapeKind::Object,
            r#type: "map".into(),
            present: None,
            avg_len: None,
            max_len: None,
            items: None,
            sql,
            children: Vec::new(),
        },
        other => ShapeNode {
            name: name.into(),
            kind: ShapeKind::Value,
            r#type: type_name(other),
            present: None,
            avg_len: None,
            max_len: None,
            items: None,
            sql,
            children: Vec::new(),
        },
    }
}

fn at_path<'a>(nodes: &'a mut [ShapeNode], path: &[usize]) -> Option<&'a mut ShapeNode> {
    let (first, rest) = path.split_first()?;
    let n = nodes.get_mut(*first)?;
    if rest.is_empty() {
        Some(n)
    } else {
        at_path(&mut n.children, rest)
    }
}

impl Engine {
    /// The structure of dataset `id` under the view's filters and search.
    pub fn json_shape(
        &self,
        id: &str,
        spec: &ViewSpec,
        deep: bool,
        key: &RequestKey,
    ) -> Result<JsonShape> {
        let started = std::time::Instant::now();
        let base = self.datasets.get(id)?;
        let schema = self.dataset_columns(id)?;
        let unsorted = ViewSpec {
            sort: Vec::new(),
            columns: None,
            ..spec.clone()
        };
        let view = build(&unsorted, &Relation::of(&base.source), &schema)?;
        let empty = self.query(
            &format!("SELECT * FROM ({}) LIMIT 0", view.select),
            &view.params,
            0,
            key,
        )?;
        let mut pending = Pending {
            exprs: vec!["count(*)::BIGINT".into()],
            targets: Vec::new(),
        };
        let mut fields: Vec<ShapeNode> = empty
            .schema
            .fields()
            .iter()
            .enumerate()
            .map(|(i, f)| {
                node(
                    f.name(),
                    f.data_type(),
                    Some(quote_ident(f.name())),
                    vec![i],
                    &mut pending,
                )
            })
            .collect();
        let out = self.query(
            &format!("SELECT {} FROM ({})", pending.exprs.join(", "), view.select),
            &view.params,
            1,
            key,
        )?;
        let b = out
            .batches
            .first()
            .ok_or_else(|| AppError::Internal("structure query returned no rows".into()))?;
        let int = |c: usize| {
            let a = b.column(c).as_primitive::<Int64Type>();
            (!a.is_null(0)).then(|| a.value(0) as u64)
        };
        let rows = int(0).unwrap_or(0);
        for (i, (path, which)) in pending.targets.iter().enumerate() {
            let Some(n) = at_path(&mut fields, path) else {
                continue;
            };
            match which {
                Stat::Present => n.present = int(i + 1),
                Stat::MaxLen => n.max_len = int(i + 1),
                Stat::AvgLen => {
                    let a = b.column(i + 1).as_primitive::<Float64Type>();
                    n.avg_len = (!a.is_null(0)).then(|| a.value(0));
                }
            }
        }
        if deep {
            let mut budget = MAX_DEEP_ARRAYS;
            for f in fields.iter_mut() {
                self.deep_count(f, &view.select, &view.params, &mut budget, key)?;
            }
        }
        Ok(JsonShape {
            rows,
            fields,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// The deep count under `node` (outside arrays): every array of objects
    /// is unnested once, and its keys (and arrays inside them) counted.
    fn deep_count(
        &self,
        node: &mut ShapeNode,
        view: &str,
        params: &[Param],
        budget: &mut usize,
        key: &RequestKey,
    ) -> Result<()> {
        match node.kind {
            ShapeKind::Object => {
                for c in node.children.iter_mut() {
                    self.deep_count(c, view, params, budget, key)?;
                }
                Ok(())
            }
            ShapeKind::Array => match node.sql.clone() {
                Some(sql) if !node.children.is_empty() => {
                    let items = format!("(SELECT unnest({sql}) AS item FROM ({view}))");
                    self.count_items(node, &items, params, budget, key)
                }
                _ => Ok(()),
            },
            ShapeKind::Value => Ok(()),
        }
    }

    /// Counts the items of array `node` (rows of `items`, a relation with
    /// one column `item`): how many, and how often each key inside appears.
    fn count_items(
        &self,
        node: &mut ShapeNode,
        items: &str,
        params: &[Param],
        budget: &mut usize,
        key: &RequestKey,
    ) -> Result<()> {
        if *budget == 0 {
            return Ok(());
        }
        *budget -= 1;
        // Keys of the items (and of objects inside them, not of inner arrays).
        let mut exprs = vec!["count(item)::BIGINT".to_string()];
        let mut targets: Vec<(Vec<usize>, Stat)> = Vec::new();
        fn walk(
            n: &ShapeNode,
            base: &str,
            at: Vec<usize>,
            exprs: &mut Vec<String>,
            targets: &mut Vec<(Vec<usize>, Stat)>,
        ) {
            for (i, c) in n.children.iter().enumerate() {
                if exprs.len() >= MAX_SHAPE_STATS {
                    return;
                }
                let e = format!(
                    "struct_extract({base}, {})",
                    literal(&Param::Text(c.name.clone()))
                );
                let mut pos = at.clone();
                pos.push(i);
                exprs.push(format!("count({e})::BIGINT"));
                targets.push((pos.clone(), Stat::Present));
                match c.kind {
                    ShapeKind::Array => {
                        exprs.push(format!("CAST(avg(len({e})) AS DOUBLE)"));
                        targets.push((pos.clone(), Stat::AvgLen));
                        exprs.push(format!("max(len({e}))::BIGINT"));
                        targets.push((pos, Stat::MaxLen));
                    }
                    ShapeKind::Object => walk(c, &e, pos, exprs, targets),
                    ShapeKind::Value => {}
                }
            }
        }
        walk(node, "item", Vec::new(), &mut exprs, &mut targets);
        let out = self.query(
            &format!("SELECT {} FROM {items}", exprs.join(", ")),
            params,
            1,
            key,
        )?;
        let Some(b) = out.batches.first() else {
            return Ok(());
        };
        let int = |c: usize| {
            let a = b.column(c).as_primitive::<Int64Type>();
            (!a.is_null(0)).then(|| a.value(0) as u64)
        };
        node.items = int(0);
        for (i, (path, which)) in targets.iter().enumerate() {
            let Some(n) = at_path(&mut node.children, path) else {
                continue;
            };
            match which {
                Stat::Present => n.present = int(i + 1),
                Stat::MaxLen => n.max_len = int(i + 1),
                Stat::AvgLen => {
                    let a = b.column(i + 1).as_primitive::<Float64Type>();
                    n.avg_len = (!a.is_null(0)).then(|| a.value(0));
                }
            }
        }
        // Arrays of objects inside the items: their own items, one level down.
        fn inner<'a>(
            n: &'a mut ShapeNode,
            base: String,
            out: &mut Vec<(&'a mut ShapeNode, String)>,
        ) {
            for c in n.children.iter_mut() {
                let e = format!(
                    "struct_extract({base}, {})",
                    literal(&Param::Text(c.name.clone()))
                );
                match c.kind {
                    ShapeKind::Array if !c.children.is_empty() => out.push((c, e)),
                    ShapeKind::Object => inner(c, e, out),
                    _ => {}
                }
            }
        }
        let mut nested = Vec::new();
        inner(node, "item".into(), &mut nested);
        for (child, e) in nested {
            let rel = format!("(SELECT unnest({e}) AS item FROM {items})");
            self.count_items(child, &rel, params, budget, key)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::datatypes::{Field, Fields};
    use std::sync::Arc;

    #[test]
    fn types_read_plainly() {
        assert_eq!(type_name(&DataType::Utf8), "text");
        assert_eq!(type_name(&DataType::Int64), "integer");
        let items = Arc::new(Field::new("item", DataType::Float64, true));
        assert_eq!(type_name(&DataType::List(items)), "number[]");
        let obj = DataType::Struct(Fields::from(vec![Field::new("a", DataType::Utf8, true)]));
        let objs = Arc::new(Field::new("item", obj, true));
        assert_eq!(type_name(&DataType::List(objs)), "object[]");
    }
}
