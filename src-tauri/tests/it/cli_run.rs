//! `dataliq run`: a saved recipe applied to a file with no window.

use std::path::PathBuf;

use dataliq_lib::cli::report::{RunArgs, run};
use dataliq_lib::export::ExportFormat;
use dataliq_lib::recipe::{Case, RecipeFile, RecipeStep, Step, save_recipe};

fn fixture(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures")
        .join(rel)
}

#[test]
fn a_recipe_is_applied_and_written_without_a_window() {
    let fx = crate::filters::fx();
    let tmp = tempfile::tempdir().unwrap();
    let recipe = tmp.path().join("monthly.json");
    save_recipe(
        &recipe,
        &RecipeFile {
            format: String::new(),
            version: 0,
            source: None,
            columns: Vec::new(),
            steps: vec![
                RecipeStep {
                    step: Step::ChangeCase {
                        column: "city".into(),
                        case: Case::Upper,
                    },
                    enabled: true,
                },
                RecipeStep {
                    step: Step::RemoveDuplicates {
                        columns: Some(vec!["city".into()]),
                    },
                    enabled: true,
                },
            ],
        },
    )
    .unwrap();
    let out = tmp.path().join("cities.parquet");
    let args = RunArgs {
        recipe: Some(recipe.clone()),
        input: fixture("csv/people.csv"),
        output: out.clone(),
        format: ExportFormat::Parquet,
        overwrite: false,
    };
    let mut lines = Vec::new();
    let rows = run(&fx.engine, &args, &mut |l| lines.push(l)).unwrap();
    let cities: std::collections::HashSet<_> = fx.people.iter().map(|p| &p.city).collect();
    assert_eq!(rows as usize, cities.len());
    assert!(lines[0].contains("2 steps"), "{lines:?}");
    assert!(
        lines
            .last()
            .unwrap()
            .starts_with(&format!("Wrote {rows} rows"))
    );
    let upper: i64 = fx
        .engine
        .connection()
        .unwrap()
        .query_row(
            &format!(
                "SELECT count(*) FROM read_parquet('{}') WHERE city = upper(city)",
                out.display()
            ),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(upper as usize, cities.len() - 1, "every city but NULL");

    // The output exists: refused without --overwrite.
    let again = run(&fx.engine, &args, &mut |_| {});
    assert!(again.unwrap_err().to_string().contains("--overwrite"));
    let replace = RunArgs {
        overwrite: true,
        ..args.clone()
    };
    run(&fx.engine, &replace, &mut |_| {}).unwrap();

    // A step that can't apply fails the run, naming it.
    let broken = RunArgs {
        input: fixture("csv/comma.csv"),
        output: tmp.path().join("x.csv"),
        format: ExportFormat::Csv,
        ..args
    };
    let err = run(&fx.engine, &broken, &mut |_| {})
        .unwrap_err()
        .to_string();
    assert!(err.starts_with("Step 1 failed"), "{err}");
    assert!(!tmp.path().join("x.csv").exists());
}
