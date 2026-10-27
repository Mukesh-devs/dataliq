//! Every filter type against `fixtures/csv/people.csv`, imported the way the
//! app does it. Expected counts are computed here by parsing the CSV in
//! Rust, independently of DuckDB.

use std::collections::HashMap;
use std::path::PathBuf;

use bigview_lib::cache::{Cache, CacheConfig};
use bigview_lib::engine::{Dataset, Engine, EngineConfig, Param, RequestKey};
use bigview_lib::import::{self, ImportTarget, Imports};
use bigview_lib::sources::{OpenOptions, Source};
use bigview_lib::view::{Filter, FilterOp, ViewSpec};

#[derive(Debug)]
pub(crate) struct Person {
    pub id: i64,
    pub name: Option<String>,
    pub city: Option<String>,
    pub amount: Option<f64>,
    pub joined: Option<String>,
    pub active: Option<bool>,
}

/// The rows of `fixtures/csv/people.csv`, parsed independently of DuckDB.
pub(crate) fn people() -> Vec<Person> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/csv/people.csv");
    let text = std::fs::read_to_string(path).unwrap();
    let opt = |s: &str| (!s.is_empty()).then(|| s.to_string());
    text.lines()
        .skip(1)
        .map(|line| {
            let f: Vec<&str> = line.split(',').collect();
            assert_eq!(f.len(), 6, "{line}");
            Person {
                id: f[0].parse().unwrap(),
                // `""` is an empty string; an empty field is NULL.
                name: if f[1] == "\"\"" {
                    Some(String::new())
                } else {
                    opt(f[1])
                },
                city: opt(f[2]),
                amount: opt(f[3]).map(|s| s.parse().unwrap()),
                joined: opt(f[4]),
                active: opt(f[5]).map(|s| s == "true"),
            }
        })
        .collect()
}

pub(crate) struct Fx {
    pub engine: Engine,
    pub dataset: Dataset,
    pub people: Vec<Person>,
    _tmp: tempfile::TempDir,
}

/// people.csv imported into the cache, as the app does.
pub(crate) fn fx() -> Fx {
    let tmp = tempfile::tempdir().unwrap();
    let engine = Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: tmp.path().join("spill"),
        threads: Some(2),
    })
    .unwrap();
    let cache = Cache::new(CacheConfig {
        dir: tmp.path().join("cache"),
        max_bytes: 1 << 30,
        enabled: true,
    })
    .unwrap();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/csv/people.csv");
    let source = Source::new(&path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(&engine)
        .unwrap();
    let target = ImportTarget {
        cache: &cache,
        temp_dir: tmp.path().join("tmp"),
    };
    let out = import::import(&engine, &Imports::default(), &target, &source, "j", &|_| {}).unwrap();
    Fx {
        engine,
        dataset: out.dataset,
        people: people(),
        _tmp: tmp,
    }
}

impl Fx {
    fn count(&self, filters: Vec<Filter>) -> u64 {
        let spec = ViewSpec {
            filters,
            ..ViewSpec::default()
        };
        let view = self
            .engine
            .open_view(&self.dataset.id, &spec, &RequestKey::default())
            .unwrap();
        assert_eq!(view.total_rows, 1000);
        view.dataset.row_count
    }

    fn expect(&self, pred: impl Fn(&Person) -> bool) -> u64 {
        self.people.iter().filter(|p| pred(p)).count() as u64
    }

    /// Checks one filter, and its negation (which keeps NULL cells).
    fn check(&self, filter: Filter, pred: impl Fn(&Person) -> bool) {
        let expected = self.expect(&pred);
        assert!(expected > 0, "useless test case: {filter:?}");
        assert_eq!(self.count(vec![filter.clone()]), expected, "{filter:?}");
        let negated = Filter {
            not: true,
            ..filter.clone()
        };
        assert_eq!(self.count(vec![negated]), 1000 - expected, "not {filter:?}");
    }
}

fn f(column: &str, op: FilterOp) -> Filter {
    Filter {
        column: column.into(),
        op,
        not: false,
    }
}

fn text(s: &str) -> Param {
    Param::Text(s.into())
}

fn lower(p: &Person) -> String {
    p.name.as_deref().unwrap_or("").to_lowercase()
}

#[test]
fn fixture_types_are_as_expected() {
    let fx = fx();
    let cols = fx.engine.dataset_columns(&fx.dataset.id).unwrap();
    let types: Vec<(&str, &str)> = cols
        .iter()
        .map(|c| (c.name.as_str(), c.r#type.as_str()))
        .collect();
    assert_eq!(
        types,
        [
            ("id", "BIGINT"),
            ("name", "VARCHAR"),
            ("city", "VARCHAR"),
            ("amount", "DOUBLE"),
            ("joined", "DATE"),
            ("active", "BOOLEAN")
        ]
    );
    assert_eq!(fx.expect(|p| p.name.is_none()), 11);
    assert_eq!(fx.expect(|p| p.name.as_deref() == Some("")), 10);
}

#[test]
fn text_filters() {
    let fx = fx();
    let contains = |v: &str, cs: bool| {
        f(
            "name",
            FilterOp::Contains {
                value: v.into(),
                case_sensitive: cs,
            },
        )
    };
    fx.check(contains("ann", false), |p| lower(p).contains("ann"));
    fx.check(contains("Ann", true), |p| {
        p.name.as_deref().unwrap_or("").contains("Ann")
    });
    fx.check(contains("ÉMILE", false), |p| lower(p).contains("émile"));
    fx.check(
        f(
            "name",
            FilterOp::StartsWith {
                value: "zo".into(),
                case_sensitive: false,
            },
        ),
        |p| lower(p).starts_with("zo"),
    );
    fx.check(
        f(
            "name",
            FilterOp::EndsWith {
                value: "SMITH".into(),
                case_sensitive: false,
            },
        ),
        |p| lower(p).ends_with("smith"),
    );
    fx.check(
        f(
            "name",
            FilterOp::EndsWith {
                value: "Smith".into(),
                case_sensitive: true,
            },
        ),
        |p| p.name.as_deref().unwrap_or("").ends_with("Smith"),
    );
    fx.check(
        f(
            "name",
            FilterOp::Regex {
                pattern: "^(Ann|Bob) ".into(),
            },
        ),
        |p| {
            let n = p.name.as_deref().unwrap_or("");
            n.starts_with("Ann ") || n.starts_with("Bob ")
        },
    );
    fx.check(
        f(
            "name",
            FilterOp::Equals {
                value: text("O'Neil Müller"),
            },
        ),
        |p| p.name.as_deref() == Some("O'Neil Müller"),
    );
    // Text tests on other types use their text form.
    fx.check(
        f(
            "joined",
            FilterOp::StartsWith {
                value: "2023-".into(),
                case_sensitive: false,
            },
        ),
        |p| p.joined.as_deref().is_some_and(|d| d.starts_with("2023-")),
    );
}

#[test]
fn null_and_empty_filters() {
    let fx = fx();
    fx.check(f("name", FilterOp::Empty), |p| {
        p.name.as_deref().is_none_or(str::is_empty)
    });
    fx.check(f("name", FilterOp::IsNull), |p| p.name.is_none());
    fx.check(f("name", FilterOp::NotNull), |p| p.name.is_some());
    fx.check(f("city", FilterOp::IsNull), |p| p.city.is_none());
    fx.check(f("amount", FilterOp::Empty), |p| p.amount.is_none());
    fx.check(f("joined", FilterOp::IsNull), |p| p.joined.is_none());
    fx.check(f("active", FilterOp::IsNull), |p| p.active.is_none());
}

#[test]
fn number_filters() {
    let fx = fx();
    let amount = |op| f("amount", op);
    let a = |p: &Person| p.amount;
    fx.check(
        amount(FilterOp::Range {
            min: Some(Param::Int(0)),
            max: Some(Param::Int(100)),
        }),
        |p| a(p).is_some_and(|v| (0.0..=100.0).contains(&v)),
    );
    fx.check(
        amount(FilterOp::Range {
            min: Some(Param::Float(250.5)),
            max: None,
        }),
        |p| a(p).is_some_and(|v| v >= 250.5),
    );
    fx.check(
        amount(FilterOp::Gt {
            value: Param::Int(500),
        }),
        |p| a(p).is_some_and(|v| v > 500.0),
    );
    fx.check(
        amount(FilterOp::Lte {
            value: Param::Int(-50),
        }),
        |p| a(p).is_some_and(|v| v <= -50.0),
    );
    fx.check(
        amount(FilterOp::Lt {
            value: Param::Int(0),
        }),
        |p| a(p).is_some_and(|v| v < 0.0),
    );
    fx.check(
        amount(FilterOp::Equals {
            value: Param::Float(882.05),
        }),
        |p| a(p) == Some(882.05),
    );
    // Numbers typed as text (as the UI's inputs send them) work too.
    fx.check(
        amount(FilterOp::Gte {
            value: text("990.5"),
        }),
        |p| a(p).is_some_and(|v| v >= 990.5),
    );
}

#[test]
fn date_filters() {
    let fx = fx();
    let joined = |op| f("joined", op);
    let d = |p: &Person| p.joined.clone();
    fx.check(
        joined(FilterOp::Range {
            min: Some(text("2023-01-01")),
            max: Some(text("2023-06-30")),
        }),
        |p| d(p).is_some_and(|v| v.as_str() >= "2023-01-01" && v.as_str() <= "2023-06-30"),
    );
    fx.check(
        joined(FilterOp::Lt {
            value: text("2022-03-01"),
        }),
        |p| d(p).is_some_and(|v| v.as_str() < "2022-03-01"),
    );
    fx.check(
        joined(FilterOp::Gt {
            value: text("2024-06-01"),
        }),
        |p| d(p).is_some_and(|v| v.as_str() > "2024-06-01"),
    );
    // Relative to today; the fixture spans 2022-2024, so pick N to cover part of it.
    let today = chrono::Local::now().date_naive();
    let from = chrono::NaiveDate::from_ymd_opt(2023, 7, 1).unwrap();
    let days = (today - from).num_days() as u32;
    let first = (today - chrono::Days::new(u64::from(days))).to_string();
    fx.check(joined(FilterOp::LastDays { days }), |p| {
        d(p).is_some_and(|v| v >= first && v <= today.to_string())
    });
}

#[test]
fn boolean_and_value_list_filters() {
    let fx = fx();
    fx.check(
        f(
            "active",
            FilterOp::Equals {
                value: Param::Bool(true),
            },
        ),
        |p| p.active == Some(true),
    );
    fx.check(
        f(
            "active",
            FilterOp::In {
                values: vec![text("false")],
            },
        ),
        |p| p.active == Some(false),
    );
    fx.check(
        f(
            "city",
            FilterOp::In {
                values: vec![text("Berlin"), text("東京"), Param::Null],
            },
        ),
        |p| matches!(p.city.as_deref(), Some("Berlin") | Some("東京") | None),
    );
    // Value-list entries for dates and numbers come back as text.
    fx.check(
        f(
            "amount",
            FilterOp::In {
                values: vec![text("882.05"), text("955.78")],
            },
        ),
        |p| matches!(p.amount, Some(v) if v == 882.05 || v == 955.78),
    );
}

#[test]
fn filters_combine_with_and_and_search() {
    let fx = fx();
    let filters = vec![
        f(
            "active",
            FilterOp::Equals {
                value: Param::Bool(true),
            },
        ),
        f(
            "amount",
            FilterOp::Gt {
                value: Param::Int(100),
            },
        ),
        f(
            "city",
            FilterOp::In {
                values: vec![text("Paris"), text("München")],
            },
        ),
    ];
    let expected = fx.expect(|p| {
        p.active == Some(true)
            && p.amount.is_some_and(|v| v > 100.0)
            && matches!(p.city.as_deref(), Some("Paris") | Some("München"))
    });
    assert!(expected > 0);
    assert_eq!(fx.count(filters), expected);

    let spec = ViewSpec {
        search: Some("MÜLLER".into()),
        ..ViewSpec::default()
    };
    let v = fx
        .engine
        .open_view(&fx.dataset.id, &spec, &RequestKey::default())
        .unwrap();
    let expected = fx.expect(|p| {
        lower(p).contains("müller")
            || p.city
                .as_deref()
                .unwrap_or("")
                .to_lowercase()
                .contains("müller")
    });
    assert!(expected > 0);
    assert_eq!(v.dataset.row_count, expected);
}

#[test]
fn value_lists_count_values_under_the_other_filters() {
    let fx = fx();
    let mut expected: HashMap<Option<String>, u64> = HashMap::new();
    for p in &fx.people {
        *expected.entry(p.city.clone()).or_default() += 1;
    }
    let list = fx
        .engine
        .column_values(
            &fx.dataset.id,
            &ViewSpec::default(),
            "city",
            None,
            100,
            &RequestKey::default(),
        )
        .unwrap();
    assert!(!list.truncated);
    let got: HashMap<Option<String>, u64> = list
        .values
        .iter()
        .map(|v| (v.value.clone(), v.count))
        .collect();
    assert_eq!(got, expected);
    // Most frequent first.
    assert!(list.values.windows(2).all(|w| w[0].count >= w[1].count));

    // The column's own filter is ignored; the others apply; search narrows.
    let spec = ViewSpec {
        filters: vec![
            f(
                "active",
                FilterOp::Equals {
                    value: Param::Bool(true),
                },
            ),
            f(
                "city",
                FilterOp::In {
                    values: vec![text("Paris")],
                },
            ),
        ],
        ..ViewSpec::default()
    };
    let list = fx
        .engine
        .column_values(
            &fx.dataset.id,
            &spec,
            "city",
            Some("o"),
            100,
            &RequestKey::default(),
        )
        .unwrap();
    let mut expected: HashMap<Option<String>, u64> = HashMap::new();
    for p in fx.people.iter().filter(|p| p.active == Some(true)) {
        if let Some(c) = p.city.as_deref().filter(|c| c.to_lowercase().contains('o')) {
            *expected.entry(Some(c.to_string())).or_default() += 1;
        }
    }
    let got: HashMap<Option<String>, u64> = list
        .values
        .iter()
        .map(|v| (v.value.clone(), v.count))
        .collect();
    assert_eq!(got, expected);

    // Limits are reported.
    let list = fx
        .engine
        .column_values(
            &fx.dataset.id,
            &ViewSpec::default(),
            "amount",
            None,
            10,
            &RequestKey::default(),
        )
        .unwrap();
    assert_eq!(list.values.len(), 10);
    assert!(list.truncated);
}

#[test]
fn views_page_like_datasets_and_close() {
    let fx = fx();
    let spec = ViewSpec {
        filters: vec![f(
            "active",
            FilterOp::Equals {
                value: Param::Bool(true),
            },
        )],
        ..ViewSpec::default()
    };
    let v = fx
        .engine
        .open_view(&fx.dataset.id, &spec, &RequestKey::default())
        .unwrap();
    let n = v.dataset.row_count;
    assert_eq!(n, fx.expect(|p| p.active == Some(true)));
    // The last page holds the remaining rows.
    let bytes = fx
        .engine
        .fetch_rows(&v.dataset.id, n - 3, 500, &RequestKey::default())
        .unwrap();
    let reader =
        arrow::ipc::reader::StreamReader::try_new(std::io::Cursor::new(bytes), None).unwrap();
    let rows: usize = reader.map(|b| b.unwrap().num_rows()).sum();
    assert_eq!(rows, 3);
    import::close_dataset(&fx.engine, &v.dataset.id).unwrap();
    assert!(fx.engine.datasets.get(&v.dataset.id).is_err());
    // The base dataset is untouched.
    assert!(fx.engine.datasets.get(&fx.dataset.id).is_ok());
}

/// Views over a Parquet file queried in place (not imported), with a schema
/// like a call-detail record: upper-case names, timestamps, phone numbers as
/// text with leading zeros, many NULLs.
#[test]
fn filters_on_parquet_queried_in_place() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: tmp.path().join("spill"),
        threads: Some(2),
    })
    .unwrap();
    let path = tmp.path().join("cdr 2026.parquet");
    engine
        .execute_batch(&format!(
            "COPY (SELECT 2757390105 + i AS RECORD_ID,
                    TIMESTAMP '2026-07-07 00:00:00' + to_seconds(i) AS START_DATETIME,
                    DATE '2026-07-07' AS CALL_DATE,
                    11 AS LOCATION_ID,
                    CASE WHEN i % 3 = 0 THEN NULL ELSE 'x' END AS CLI,
                    '0' || (7552700000 + i % 50)::VARCHAR AS TEL_DIGIT,
                    CASE WHEN i % 4 = 0 THEN TIMESTAMP '2026-07-07 00:00:20' + to_seconds(i) END AS CALLCONNECT
                  FROM range(10000) t(i))
             TO '{}' (FORMAT parquet)",
            path.to_string_lossy().replace('\'', "''")
        ))
        .unwrap();
    let source = Source::new(&path, OpenOptions::default()).unwrap();
    source.inspect(&engine).unwrap();
    let ds = import::open_in_place(&engine, &source).unwrap();
    assert_eq!(ds.row_count, 10_000);
    let count = |filters: Vec<Filter>| {
        let v = engine
            .open_view(
                &ds.id,
                &ViewSpec {
                    filters,
                    ..ViewSpec::default()
                },
                &RequestKey::default(),
            )
            .unwrap();
        // The view pages like any dataset.
        engine
            .fetch_rows(&v.dataset.id, 0, 500, &RequestKey::default())
            .unwrap();
        v.dataset.row_count
    };
    assert_eq!(
        count(vec![f(
            "TEL_DIGIT",
            FilterOp::StartsWith {
                value: "0755270000".into(),
                case_sensitive: false
            }
        )]),
        2000
    );
    assert_eq!(count(vec![f("CALLCONNECT", FilterOp::NotNull)]), 2500);
    assert_eq!(count(vec![f("CLI", FilterOp::IsNull)]), 3334);
    assert_eq!(
        count(vec![f(
            "START_DATETIME",
            FilterOp::Range {
                min: Some(text("2026-07-07 00:01:00")),
                max: Some(text("2026-07-07 00:01:59.999")),
            }
        )]),
        60
    );
    assert_eq!(
        count(vec![f(
            "LOCATION_ID",
            FilterOp::Equals {
                value: Param::Int(11)
            }
        )]),
        10_000
    );
    assert_eq!(
        count(vec![f(
            "RECORD_ID",
            FilterOp::Gt {
                value: Param::Int(2757399104)
            }
        )]),
        1000
    );
    let values = engine
        .column_values(
            &ds.id,
            &ViewSpec::default(),
            "TEL_DIGIT",
            Some("07552700001"),
            10,
            &RequestKey::default(),
        )
        .unwrap();
    assert_eq!(values.values.len(), 1);
    assert_eq!(values.values[0].count, 200);
}

/// Global search: case-insensitive "contains" over the text columns only,
/// with SQL-special characters taken literally, combined with filters and
/// sorting.
#[test]
fn search_covers_text_columns_literally() {
    let fx = fx();
    let count = |search: &str, filters: Vec<Filter>| {
        fx.engine
            .open_view(
                &fx.dataset.id,
                &ViewSpec {
                    search: Some(search.into()),
                    filters,
                    ..ViewSpec::default()
                },
                &RequestKey::default(),
            )
            .unwrap()
            .dataset
            .row_count
    };
    let hit = |p: &Person, s: &str| {
        let s = s.to_lowercase();
        lower(p).contains(&s) || p.city.as_deref().unwrap_or("").to_lowercase().contains(&s)
    };
    for term in ["smith", "PARIS", "ø", "東京", "o'n", "an"] {
        let want = fx.expect(|p| hit(p, term));
        assert!(want > 0, "{term}");
        assert_eq!(count(term, vec![]), want, "search {term:?}");
    }
    // LIKE wildcards and quotes are plain characters.
    for term in ["%", "_", "'", "\"", "\\", "a%n"] {
        assert_eq!(
            count(term, vec![]),
            fx.expect(|p| hit(p, term)),
            "search {term:?}"
        );
    }
    // Numbers and dates are not searched.
    assert_eq!(count("882.05", vec![]), 0);
    assert_eq!(count("2024-", vec![]), 0);
    // Search + filter.
    let active = f(
        "active",
        FilterOp::Equals {
            value: Param::Bool(true),
        },
    );
    assert_eq!(
        count("müller", vec![active]),
        fx.expect(|p| hit(p, "müller") && p.active == Some(true))
    );
}
