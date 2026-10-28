//! Views end to end: SQL built from a ViewSpec runs in DuckDB and returns the
//! expected rows, including on columns whose names need quoting.

use dataliq_lib::engine::{DatasetSource, Engine, EngineConfig, Param};
use dataliq_lib::sources::ColumnMeta;
use dataliq_lib::view::{self, Filter, FilterOp, Relation, SortKey, ViewSpec};

const NAME: &str = "first name";
const QUOTE: &str = "say \"hi\"";
const KEYWORD: &str = "select";
const UNICODE: &str = "日本語";

struct Fixture {
    engine: Engine,
    relation: Relation,
    schema: Vec<ColumnMeta>,
    _tmp: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let engine = Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: tmp.path().join("spill"),
        threads: Some(2),
    })
    .unwrap();
    // Rows 5 and 6 are recent, for "last N days" (relative to the local date,
    // as the view builder uses).
    let today = chrono::Local::now().date_naive();
    let recent = today - chrono::Days::new(3);
    engine
        .execute_batch(&format!(
            r#"CREATE TABLE data AS SELECT * FROM (VALUES
                (1, 'Ann',      'x',     'k1', 'あ',  10.0,  DATE '2024-01-01',     true),
                (2, 'anna',     '',      'k2', NULL,  20.5,  DATE '2024-01-15',     false),
                (3, 'Bob',      NULL,    'k1', 'い',  NULL,  DATE '2024-02-01',     true),
                (4, 'Zed''s',   'hello', 'k3', 'う',  5.0,   NULL,                  NULL),
                (5, NULL,       'x',     'k2', 'あ',  30.0,  DATE '{recent}',       true),
                (6, 'Annie 42', 'y',     'k1', 'え',  -1.0,  DATE '{today}',        true)
            ) t("id", "first name", "say ""hi""", "select", "日本語", "amount", "joined", "active")"#,
        ))
        .unwrap();
    let conn = engine.connection().unwrap();
    let mut stmt = conn
        .prepare("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'data' ORDER BY ordinal_position")
        .unwrap();
    let schema = stmt
        .query_map([], |r| {
            Ok(ColumnMeta {
                name: r.get(0)?,
                r#type: r.get(1)?,
            })
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    Fixture {
        engine,
        relation: Relation {
            sql: "data".into(),
            params: vec![],
            row_order: Some("rowid".into()),
        },
        schema,
        _tmp: tmp,
    }
}

impl Fixture {
    /// Ids of the view's rows, in view order, checked against its count query.
    fn ids(&self, spec: &ViewSpec) -> Vec<i32> {
        self.ids_on(&self.relation, spec)
    }

    fn ids_on(&self, relation: &Relation, spec: &ViewSpec) -> Vec<i32> {
        let v = view::build(spec, relation, &self.schema).unwrap();
        let conn = self.engine.connection().unwrap();
        let params = || duckdb::params_from_iter(v.params.iter());
        let mut stmt = conn.prepare(&v.select).unwrap();
        let ids: Vec<i32> = stmt
            .query_map(params(), |r| r.get(0))
            .unwrap_or_else(|e| panic!("{}: {e}", v.select))
            .collect::<Result<_, _>>()
            .unwrap();
        let count: i64 = conn.query_row(&v.count, params(), |r| r.get(0)).unwrap();
        assert_eq!(
            count as usize,
            ids.len(),
            "count query disagrees: {}",
            v.count
        );
        ids
    }

    fn matching(&self, filter: Filter) -> Vec<i32> {
        let mut ids = self.ids(&ViewSpec {
            filters: vec![filter],
            ..ViewSpec::default()
        });
        ids.sort();
        ids
    }
}

fn f(column: &str, op: FilterOp) -> Filter {
    Filter {
        column: column.into(),
        op,
        not: false,
    }
}

fn not(filter: Filter) -> Filter {
    Filter {
        not: true,
        ..filter
    }
}

fn contains(column: &str, value: &str, case_sensitive: bool) -> Filter {
    f(
        column,
        FilterOp::Contains {
            value: value.into(),
            case_sensitive,
        },
    )
}

fn text(s: &str) -> Param {
    Param::Text(s.into())
}

#[test]
fn text_filters() {
    let fx = fixture();
    assert_eq!(fx.matching(contains(NAME, "ann", false)), [1, 2, 6]);
    assert_eq!(fx.matching(contains(NAME, "Ann", true)), [1, 6]);
    assert_eq!(
        fx.matching(f(
            NAME,
            FilterOp::StartsWith {
                value: "AN".into(),
                case_sensitive: false
            }
        )),
        [1, 2, 6]
    );
    assert_eq!(
        fx.matching(f(
            NAME,
            FilterOp::EndsWith {
                value: "'S".into(),
                case_sensitive: false
            }
        )),
        [4]
    );
    assert_eq!(
        fx.matching(f(
            NAME,
            FilterOp::Regex {
                pattern: "^[AB]".into()
            }
        )),
        [1, 3, 6]
    );
    assert_eq!(
        fx.matching(f(
            NAME,
            FilterOp::Equals {
                value: text("Zed's")
            }
        )),
        [4]
    );
    // Text tests on a number column use its text form.
    assert_eq!(fx.matching(contains("amount", "20.5", false)), [2]);
    // "Doesn't contain" keeps NULL cells.
    assert_eq!(fx.matching(not(contains(NAME, "ann", false))), [3, 4, 5]);
}

#[test]
fn null_and_empty_filters() {
    let fx = fixture();
    assert_eq!(fx.matching(f(QUOTE, FilterOp::Empty)), [2, 3]);
    assert_eq!(fx.matching(not(f(QUOTE, FilterOp::Empty))), [1, 4, 5, 6]);
    assert_eq!(fx.matching(f("amount", FilterOp::Empty)), [3]);
    assert_eq!(fx.matching(f(UNICODE, FilterOp::IsNull)), [2]);
    assert_eq!(fx.matching(f(UNICODE, FilterOp::NotNull)), [1, 3, 4, 5, 6]);
    assert_eq!(
        fx.matching(f("joined", FilterOp::Equals { value: Param::Null })),
        [4]
    );
}

#[test]
fn number_filters() {
    let fx = fixture();
    let cmp = |op: FilterOp| fx.matching(f("amount", op));
    assert_eq!(
        cmp(FilterOp::Equals {
            value: Param::Float(20.5)
        }),
        [2]
    );
    assert_eq!(
        cmp(FilterOp::Range {
            min: Some(Param::Int(5)),
            max: Some(Param::Float(20.5))
        }),
        [1, 2, 4]
    );
    assert_eq!(
        cmp(FilterOp::Range {
            min: Some(Param::Int(10)),
            max: None
        }),
        [1, 2, 5]
    );
    assert_eq!(
        cmp(FilterOp::Gt {
            value: Param::Int(0)
        }),
        [1, 2, 4, 5]
    );
    assert_eq!(
        cmp(FilterOp::Gte {
            value: Param::Int(10)
        }),
        [1, 2, 5]
    );
    assert_eq!(
        cmp(FilterOp::Lt {
            value: Param::Int(10)
        }),
        [4, 6]
    );
    assert_eq!(
        cmp(FilterOp::Lte {
            value: Param::Float(-1.0)
        }),
        [6]
    );
}

#[test]
fn date_filters() {
    let fx = fixture();
    let cmp = |op: FilterOp| fx.matching(f("joined", op));
    assert_eq!(
        cmp(FilterOp::Lt {
            value: text("2024-01-31")
        }),
        [1, 2]
    );
    assert_eq!(
        cmp(FilterOp::Gte {
            value: text("2024-01-01")
        }),
        [1, 2, 3, 5, 6]
    );
    assert_eq!(
        cmp(FilterOp::Range {
            min: Some(text("2024-01-10")),
            max: Some(text("2024-02-01"))
        }),
        [2, 3]
    );
    assert_eq!(cmp(FilterOp::LastDays { days: 7 }), [5, 6]);
    assert_eq!(cmp(FilterOp::LastDays { days: 0 }), [6]);
}

#[test]
fn boolean_and_value_list_filters() {
    let fx = fixture();
    let yes = f(
        "active",
        FilterOp::Equals {
            value: Param::Bool(true),
        },
    );
    assert_eq!(fx.matching(yes.clone()), [1, 3, 5, 6]);
    assert_eq!(fx.matching(not(yes)), [2, 4]);
    assert_eq!(
        fx.matching(f(
            KEYWORD,
            FilterOp::In {
                values: vec![text("k1"), text("k3")]
            }
        )),
        [1, 3, 4, 6]
    );
    assert_eq!(
        fx.matching(f(
            UNICODE,
            FilterOp::In {
                values: vec![text("あ"), Param::Null]
            }
        )),
        [1, 2, 5]
    );
    assert_eq!(
        fx.matching(f("id", FilterOp::In { values: vec![] })),
        Vec::<i32>::new()
    );
    assert_eq!(
        fx.matching(f(
            "id",
            FilterOp::In {
                values: vec![Param::Int(2), Param::Int(4)]
            }
        )),
        [2, 4]
    );
}

#[test]
fn search_covers_text_columns_only() {
    let fx = fixture();
    let search = |s: &str| {
        let mut ids = fx.ids(&ViewSpec {
            search: Some(s.into()),
            ..ViewSpec::default()
        });
        ids.sort();
        ids
    };
    assert_eq!(search("x"), [1, 5]);
    assert_eq!(search("K3"), [4]);
    assert_eq!(search("う"), [4]);
    // Numbers are not searched.
    assert_eq!(search("20.5"), Vec::<i32>::new());
}

#[test]
fn multi_column_sort_with_nulls_last() {
    let fx = fixture();
    let sort = |keys: &[(&str, bool)]| {
        fx.ids(&ViewSpec {
            sort: keys
                .iter()
                .map(|(c, d)| SortKey {
                    column: c.to_string(),
                    descending: *d,
                })
                .collect(),
            ..ViewSpec::default()
        })
    };
    assert_eq!(sort(&[("amount", true)]), [5, 2, 1, 4, 6, 3]);
    assert_eq!(sort(&[("amount", false)]), [6, 4, 1, 2, 5, 3]);
    assert_eq!(
        sort(&[(KEYWORD, false), ("amount", true)]),
        [1, 6, 3, 5, 2, 4]
    );
    assert_eq!(sort(&[(NAME, false)]), [1, 6, 3, 4, 2, 5]);
}

#[test]
fn filters_search_sort_and_columns_together() {
    let fx = fixture();
    let spec = ViewSpec {
        filters: vec![
            f(
                "active",
                FilterOp::Equals {
                    value: Param::Bool(true),
                },
            ),
            not(f(UNICODE, FilterOp::IsNull)),
        ],
        search: Some("x".into()),
        sort: vec![SortKey {
            column: "amount".into(),
            descending: true,
        }],
        columns: Some(vec!["id".into(), UNICODE.into(), QUOTE.into()]),
    };
    assert_eq!(fx.ids(&spec), [5, 1]);
    // The projection keeps the requested order and names.
    let v = view::build(&spec, &fx.relation, &fx.schema).unwrap();
    let conn = fx.engine.connection().unwrap();
    let mut stmt = conn.prepare(&format!("DESCRIBE {}", v.select)).unwrap();
    let names: Vec<String> = stmt
        .query_map(duckdb::params_from_iter(v.params.iter()), |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(names, ["id", UNICODE, QUOTE]);
}

#[test]
fn views_work_on_parquet_in_place() {
    let fx = fixture();
    let path = fx._tmp.path().join("data.parquet");
    fx.engine
        .execute_batch(&format!(
            "COPY data TO '{}' (FORMAT parquet)",
            path.to_string_lossy().replace('\'', "''")
        ))
        .unwrap();
    let relation = Relation::of(&DatasetSource::Parquet {
        path: path.to_string_lossy().into_owned(),
    });
    let spec = ViewSpec {
        filters: vec![contains(NAME, "ann", false)],
        sort: vec![SortKey {
            column: "amount".into(),
            descending: true,
        }],
        ..ViewSpec::default()
    };
    assert_eq!(fx.ids_on(&relation, &spec), [2, 1, 6]);
}
