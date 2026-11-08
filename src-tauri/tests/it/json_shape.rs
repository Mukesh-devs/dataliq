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
        .json_shape(&ds.id, &ViewSpec::default(), false, &RequestKey::default())
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

fn orders(dir: &Path) -> PathBuf {
    let path = dir.join("orders.ndjson");
    std::fs::write(
        &path,
        "{\"id\":1,\"user\":{\"name\":\"Ann\",\"city\":\"Berlin\"},\"items\":[{\"sku\":\"a\",\"qty\":2,\"opts\":[{\"k\":\"x\"},{\"k\":null}]},{\"sku\":\"b\"}]}\n\
         {\"id\":2,\"user\":{\"name\":\"Bo\",\"city\":\"Oslo\"},\"items\":[{\"sku\":\"c\",\"qty\":5}]}\n\
         {\"id\":3,\"user\":{\"name\":\"Cy\",\"city\":null},\"items\":[]}\n",
    )
    .unwrap();
    path
}

fn open(e: &Engine, path: &Path) -> dataliq_lib::engine::Dataset {
    let source = Source::new(path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(e)
        .unwrap();
    dataliq_lib::import::open_query(e, &source).unwrap()
}

#[test]
fn the_deep_count_counts_keys_among_array_items() {
    let tmp = tempfile::tempdir().unwrap();
    let e = engine(tmp.path());
    let ds = open(&e, &orders(tmp.path()));
    let s = e
        .json_shape(&ds.id, &ViewSpec::default(), true, &RequestKey::default())
        .unwrap();
    let items = find(&s.fields, &["items"]);
    // 2 + 1 + 0 items in all.
    assert_eq!(items.items, Some(3));
    assert_eq!(find(&items.children, &["sku"]).present, Some(3));
    assert_eq!(find(&items.children, &["qty"]).present, Some(2));
    let opts = find(&items.children, &["opts"]);
    assert_eq!((opts.present, opts.max_len), (Some(1), Some(2)));
    // One level further: the options' items.
    assert_eq!(opts.items, Some(2));
    assert_eq!(find(&opts.children, &["k"]).present, Some(1));
    // Without the deep count, keys inside arrays have no counts.
    let plain = e
        .json_shape(&ds.id, &ViewSpec::default(), false, &RequestKey::default())
        .unwrap();
    let items = find(&plain.fields, &["items"]);
    assert_eq!(
        (items.items, find(&items.children, &["sku"]).present),
        (None, None)
    );
}

#[test]
fn filters_reach_keys_inside_nested_columns() {
    use dataliq_lib::engine::Param;
    use dataliq_lib::view::{Filter, FilterOp};
    let tmp = tempfile::tempdir().unwrap();
    let e = engine(tmp.path());
    let ds = open(&e, &orders(tmp.path()));
    let rows = |filters: Vec<Filter>| {
        let spec = ViewSpec {
            filters,
            ..ViewSpec::default()
        };
        e.json_shape(&ds.id, &spec, false, &RequestKey::default())
            .unwrap()
            .rows
    };
    let at = |op: FilterOp| Filter {
        column: "user".into(),
        path: Some(vec!["city".into()]),
        op,
        not: false,
    };
    assert_eq!(
        rows(vec![at(FilterOp::Equals {
            value: Param::Text("Berlin".into())
        })]),
        1
    );
    assert_eq!(rows(vec![at(FilterOp::NotNull)]), 2);
    assert_eq!(
        rows(vec![at(FilterOp::Contains {
            value: "O".into(),
            case_sensitive: false
        })]),
        1
    );
    assert_eq!(
        rows(vec![Filter {
            not: true,
            ..at(FilterOp::NotNull)
        }]),
        1
    );
}

#[test]
fn unnest_gives_one_row_per_item_and_keeps_empty_records() {
    use dataliq_lib::recipe::{RecipeStep, Step};
    let tmp = tempfile::tempdir().unwrap();
    let e = engine(tmp.path());
    let ds = open(&e, &orders(tmp.path()));
    let step = |step: Step| RecipeStep {
        step,
        enabled: true,
    };
    let out = e
        .apply_recipe(
            &ds.id,
            &[
                step(Step::Unnest {
                    column: "items".into(),
                    path: vec![],
                    into: None,
                }),
                step(Step::Calculate {
                    name: "sku".into(),
                    expression: "struct_extract(\"items\", 'sku')".into(),
                }),
            ],
            &RequestKey::default(),
        )
        .unwrap();
    assert!(
        out.steps.iter().all(|s| s.error.is_none()),
        "{:?}",
        out.steps
    );
    // Order 1 has two items, order 2 one, order 3 none (kept, as NULL).
    assert_eq!(out.dataset.row_count, 4);
    // A nested array as a new column; a plain column can't be unnested.
    let out = e
        .apply_recipe(
            &ds.id,
            &[step(Step::Unnest {
                column: "user".into(),
                path: vec!["name".into()],
                into: Some("letters".into()),
            })],
            &RequestKey::default(),
        )
        .unwrap();
    assert!(out.steps[0].error.is_some(), "a text value isn't an array");
    let out = e
        .apply_recipe(
            &ds.id,
            &[step(Step::Unnest {
                column: "id".into(),
                path: vec![],
                into: None,
            })],
            &RequestKey::default(),
        )
        .unwrap();
    assert!(
        out.steps[0]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("isn't an array")
    );
}
