//! Quality warnings over `fixtures/quality/messy.csv`, whose problems are
//! known (see its README): each warning's count, and its filters showing
//! exactly that many rows, and its fix removing it.

use std::path::PathBuf;

use bigview_lib::cache::{Cache, CacheConfig};
use bigview_lib::engine::{Dataset, Engine, EngineConfig, RequestKey};
use bigview_lib::import::{self, ImportTarget, Imports};
use bigview_lib::quality::{QualityReport, WarningKind};
use bigview_lib::recipe::RecipeStep;
use bigview_lib::sources::{OpenOptions, Source};
use bigview_lib::view::ViewSpec;

struct Fx {
    engine: Engine,
    dataset: Dataset,
    _dir: tempfile::TempDir,
}

fn fx(name: &str) -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: dir.path().join("spill"),
        threads: Some(2),
    })
    .unwrap();
    let cache = Cache::new(CacheConfig {
        dir: dir.path().join("cache"),
        max_bytes: 1 << 30,
        enabled: true,
    })
    .unwrap();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures")
        .join(name);
    let source = Source::new(&path, OpenOptions::default())
        .unwrap()
        .resolve_dialect(&engine)
        .unwrap();
    let target = ImportTarget {
        cache: &cache,
        temp_dir: dir.path().join("tmp"),
    };
    let dataset = import::import(&engine, &Imports::default(), &target, &source, "q", &|_| {})
        .unwrap()
        .dataset;
    Fx {
        engine,
        dataset,
        _dir: dir,
    }
}

fn report(fx: &Fx, id: &str) -> QualityReport {
    fx.engine.quality(id, &RequestKey::default()).unwrap()
}

#[test]
fn every_known_problem_is_found_and_its_rows_shown() {
    let fx = fx("quality/messy.csv");
    let r = report(&fx, &fx.dataset.id);
    assert_eq!(r.rows, 22);
    let found: Vec<(WarningKind, Option<&str>, u64)> = r
        .warnings
        .iter()
        .map(|w| (w.kind, w.column.as_deref(), w.rows))
        .collect();
    assert_eq!(
        found,
        [
            (WarningKind::Spaces, Some("name"), 3),
            (WarningKind::MixedTypes, Some("amount"), 2),
            (WarningKind::DateFormats, Some("signup"), 3),
            (WarningKind::Empty, Some("note"), 18),
            (WarningKind::Outliers, Some("score"), 1),
            (WarningKind::Duplicates, None, 2),
        ],
        "{:#?}",
        r.warnings
    );
    let msg = |k: WarningKind| &r.warnings.iter().find(|w| w.kind == k).unwrap().message;
    assert_eq!(
        msg(WarningKind::Spaces),
        "3 values have spaces at the start or end"
    );
    assert_eq!(
        msg(WarningKind::MixedTypes),
        "Mostly numbers, but 2 values are not (9% of 22 values)"
    );
    assert_eq!(
        msg(WarningKind::DateFormats),
        "Dates in 2 formats: 19 like 2024-01-31, 3 like 31/01/2024"
    );
    assert_eq!(msg(WarningKind::Empty), "18 of 22 rows are empty (82%)");
    assert!(msg(WarningKind::Outliers).starts_with("1 value far outside the usual range"));
    assert_eq!(
        msg(WarningKind::Duplicates),
        "2 rows are exact copies of an earlier row"
    );

    // "Show rows": exactly the rows each warning counts.
    for w in r.warnings.iter().filter(|w| !w.filters.is_empty()) {
        let view = fx
            .engine
            .open_view(
                &fx.dataset.id,
                &ViewSpec {
                    filters: w.filters.clone(),
                    ..ViewSpec::default()
                },
                &RequestKey::default(),
            )
            .unwrap();
        assert_eq!(view.dataset.row_count, w.rows, "{w:?}");
    }
}

#[test]
fn each_fix_clears_its_warning() {
    let fx = fx("quality/messy.csv");
    let r = report(&fx, &fx.dataset.id);
    let fixes: Vec<RecipeStep> = r
        .warnings
        .iter()
        .filter_map(|w| w.fix.clone())
        .map(|step| RecipeStep {
            step,
            enabled: true,
        })
        .collect();
    assert_eq!(fixes.len(), 3, "trim, change type, remove duplicates");
    let cleaned = fx
        .engine
        .apply_recipe(&fx.dataset.id, &fixes, &RequestKey::default())
        .unwrap();
    assert!(cleaned.steps.iter().all(|s| s.error.is_none()));
    let after = report(&fx, &cleaned.dataset.id);
    let kinds: Vec<WarningKind> = after.warnings.iter().map(|w| w.kind).collect();
    // Left: what has no automatic fix.
    assert_eq!(
        kinds,
        [
            WarningKind::DateFormats,
            WarningKind::Empty,
            WarningKind::Outliers
        ],
        "{:#?}",
        after.warnings
    );
    assert_eq!(after.rows, 20);
}

#[test]
fn clean_files_have_no_warnings() {
    // Every column of comma.csv is complete and consistent.
    let fx = fx("csv/comma.csv");
    let r = report(&fx, &fx.dataset.id);
    assert!(r.warnings.is_empty(), "{:#?}", r.warnings);
}
