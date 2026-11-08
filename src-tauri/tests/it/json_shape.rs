//! The structure of JSON files for the graph view, counted by DuckDB.

use std::path::{Path, PathBuf};

use dataliq_lib::engine::{Engine, EngineConfig, RequestKey};
use dataliq_lib::sources::{OpenOptions, Source};
use dataliq_lib::view::{JsonShape, ShapeKind, ShapeNode, ViewSpec};

fn engine(dir: &Path) -> Engine {
    Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: dir.join("spill"),
        threads: Some(2),
    })
    .unwrap()
}

fn shape(engine: &Engine, path: &Path) -> JsonShape {
    let source = Source::new(path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(engine)
        .unwrap();
    let ds = dataliq_lib::import::open_query(engine, &source).unwrap();
    engine
        .json_shape(&ds.id, &ViewSpec::default(), &RequestKey::default())
        .unwrap()
}

fn find<'a>(nodes: &'a [ShapeNode], path: &[&str]) -> &'a ShapeNode {
    let (first, rest) = path.split_first().unwrap();
    let n = nodes
        .iter()
        .find(|n| n.name == *first)
        .unwrap_or_else(|| panic!("{first}"));
    if rest.is_empty() {
        n
    } else {
        find(&n.children, rest)
    }
}

#[test]
fn nested_keys_with_presence_and_array_lengths() {
    let tmp = tempfile::tempdir().unwrap();
    let e = engine(tmp.path());
    let s = shape(
        &e,
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/json/nested.json"),
    );
    assert_eq!(s.rows, 3);
    let user = find(&s.fields, &["user"]);
    assert_eq!(
        (user.kind, user.r#type.as_str(), user.present),
        (ShapeKind::Object, "object", Some(2))
    );
    let city = find(&s.fields, &["user", "address", "city"]);
    assert_eq!((city.r#type.as_str(), city.present), ("text", Some(1)));
    assert_eq!(
        city.sql.as_deref(),
        Some("struct_extract(struct_extract(\"user\", 'address'), 'city')")
    );
    let scores = find(&s.fields, &["scores"]);
    assert_eq!(
        (scores.kind, scores.r#type.as_str()),
        (ShapeKind::Array, "integer[]")
    );
    // [1,2,3], [4] and [] (NULL lists don't count): 4 items over 3 arrays.
    assert_eq!(scores.max_len, Some(3));
    assert!((scores.avg_len.unwrap() - 4.0 / 3.0).abs() < 1e-9);
    let tags = find(&s.fields, &["tags"]);
    assert_eq!(tags.present, Some(2));
}

#[test]
fn arrays_of_objects_list_their_keys() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("orders.ndjson");
    std::fs::write(
        &path,
        "{\"id\":1,\"items\":[{\"sku\":\"a\",\"qty\":2,\"opts\":[{\"k\":\"x\"}]}],\"note\":\"hi\"}\n\
         {\"id\":2,\"items\":[{\"sku\":\"b\",\"qty\":1},{\"sku\":\"c\",\"qty\":5}]}\n",
    )
    .unwrap();
    let e = engine(tmp.path());
    let s = shape(&e, &path);
    let items = find(&s.fields, &["items"]);
    assert_eq!(
        (items.kind, items.r#type.as_str()),
        (ShapeKind::Array, "object[]")
    );
    assert_eq!((items.max_len, items.avg_len), (Some(2), Some(1.5)));
    // Keys inside arrays: their type, no counts.
    let qty = find(&items.children, &["qty"]);
    assert_eq!(
        (qty.r#type.as_str(), qty.present, qty.sql.as_deref()),
        ("integer", None, None)
    );
    let opts = find(&items.children, &["opts"]);
    assert_eq!(opts.r#type, "object[]");
    assert_eq!(find(&opts.children, &["k"]).r#type, "text");
    assert_eq!(find(&s.fields, &["note"]).present, Some(1));
}
