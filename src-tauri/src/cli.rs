//! Command line: `dataliq [files...]`. Files from a second launch are
//! forwarded to the running app by the single-instance plugin.

use std::path::{Path, PathBuf};

/// Files named on a command line (`args[0]` is the program). Relative paths
/// are resolved against `cwd`, URLs kept as they are; flags (`-x`, `--y`)
/// are ignored, and `--` ends flag parsing so a file may start with a dash.
pub fn files_from_args<S: AsRef<str>>(args: &[S], cwd: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut flags_done = false;
    for arg in args.iter().skip(1).map(AsRef::as_ref) {
        if !flags_done && arg == "--" {
            flags_done = true;
            continue;
        }
        if !flags_done && arg.starts_with('-') {
            continue;
        }
        let path = Path::new(arg);
        let abs = if path.is_absolute() || crate::remote::is_url(path) {
            path.to_path_buf()
        } else {
            cwd.join(path)
        };
        if !files.contains(&abs) {
            files.push(abs);
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::report::{format_of, parse};
    use super::*;
    use crate::export::ExportFormat;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn report_arguments() {
        let cwd = Path::new("/work");
        let r = parse(
            &args(&[
                "monthly.json",
                "--in",
                "calls.csv.gz",
                "--out",
                "/out/report.xlsx",
            ]),
            cwd,
        )
        .unwrap();
        assert_eq!(r.recipe, Some(PathBuf::from("/work/monthly.json")));
        assert_eq!(r.input, PathBuf::from("/work/calls.csv.gz"));
        assert_eq!(r.output, PathBuf::from("/out/report.xlsx"));
        assert_eq!(r.format, ExportFormat::Xlsx);
        assert!(!r.overwrite);
        // No recipe: a conversion; the format named, replacing the output.
        let r = parse(
            &args(&[
                "-i",
                "a.csv",
                "-o",
                "b.data",
                "--format",
                "parquet",
                "--overwrite",
            ]),
            cwd,
        )
        .unwrap();
        assert_eq!(
            (r.recipe, r.format, r.overwrite),
            (None, ExportFormat::Parquet, true)
        );
        for bad in [
            &["--in", "a.csv"][..],
            &["--out", "b.csv"],
            &["--in", "a.csv", "--out", "b.unknown"],
            &["--in", "a.csv", "--out", "b.csv", "--colour"],
            &["r.json", "extra", "--in", "a.csv", "--out", "b.csv"],
            &["--in"],
        ] {
            assert!(parse(&args(bad), cwd).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn formats_from_names_and_extensions() {
        assert_eq!(format_of("report.csv.gz"), Some(ExportFormat::CsvGz));
        assert_eq!(format_of("x.PARQUET"), Some(ExportFormat::Parquet));
        assert_eq!(format_of("ndjson"), Some(ExportFormat::Ndjson));
        assert_eq!(format_of("notes.txt"), None);
    }

    #[test]
    fn resolves_relative_paths_and_skips_flags() {
        let cwd = Path::new("/work");
        let got = files_from_args(
            &[
                "dataliq",
                "a.csv",
                "--verbose",
                "/abs/b.parquet",
                "dir/c.csv.gz",
                "a.csv",
            ],
            cwd,
        );
        assert_eq!(
            got,
            vec![
                PathBuf::from("/work/a.csv"),
                PathBuf::from("/abs/b.parquet"),
                PathBuf::from("/work/dir/c.csv.gz"),
            ]
        );
    }

    #[test]
    fn double_dash_allows_dash_names_and_no_args_is_empty() {
        let cwd = Path::new("/w");
        assert_eq!(
            files_from_args(&["dataliq", "--", "-odd.csv"], cwd),
            vec![PathBuf::from("/w/-odd.csv")]
        );
        assert!(files_from_args(&["dataliq"], cwd).is_empty());
    }

    #[test]
    fn urls_are_kept_as_they_are() {
        assert_eq!(
            files_from_args(
                &["dataliq", "https://x.org/a.csv?t=1", "s3://b/k.parquet"],
                Path::new("/w")
            ),
            vec![
                PathBuf::from("https://x.org/a.csv?t=1"),
                PathBuf::from("s3://b/k.parquet"),
            ]
        );
    }
}

/// `dataliq run`: a recipe applied to a file and the result written, with
/// no window (reports on a schedule, in scripts).
pub mod report {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    use crate::engine::{Engine, EngineConfig, RequestKey};
    use crate::error::{AppError, Result};
    use crate::export::{self, ExportFormat, ExportOptions, ExportRequest, Exports};
    use crate::recipe::{RecipeStep, load_recipe};
    use crate::settings::Settings;
    use crate::sources::{OpenOptions, Source};
    use crate::view::ViewSpec;

    pub const USAGE: &str = "\
Usage: dataliq run [RECIPE] --in FILE --out FILE [--format FORMAT] [--overwrite]

Applies a cleaning recipe (saved from DataLiq) to FILE and writes the result
to --out, without opening a window. Without a recipe, FILE is converted.

  --in FILE        CSV, TSV, JSON, NDJSON or Parquet (also .gz / .zst)
  --out FILE       where to write; the format comes from its extension
  --format FORMAT  csv, csv.gz, tsv, parquet, json, ndjson or xlsx
  --overwrite      replace --out if it exists

Exit status: 0 when written, 1 when the recipe or a file failed, 2 for
wrong arguments.
";

    /// What `dataliq run` was asked to do.
    #[derive(Debug, Clone, PartialEq)]
    pub struct RunArgs {
        pub recipe: Option<PathBuf>,
        pub input: PathBuf,
        pub output: PathBuf,
        pub format: ExportFormat,
        pub overwrite: bool,
    }

    /// The format of `name`: a format name or a file name's extension.
    pub fn format_of(name: &str) -> Option<ExportFormat> {
        let n = name.to_ascii_lowercase();
        let n = n.trim_start_matches('.');
        let pick = |ext: &str| match ext {
            "csv" => Some(ExportFormat::Csv),
            "csv.gz" | "csvgz" => Some(ExportFormat::CsvGz),
            "tsv" | "tab" => Some(ExportFormat::Tsv),
            "parquet" | "pq" => Some(ExportFormat::Parquet),
            "json" => Some(ExportFormat::Json),
            "ndjson" | "jsonl" => Some(ExportFormat::Ndjson),
            "xlsx" => Some(ExportFormat::Xlsx),
            _ => None,
        };
        if let Some(f) = pick(n) {
            return Some(f);
        }
        if n.ends_with(".csv.gz") {
            return Some(ExportFormat::CsvGz);
        }
        n.rsplit_once('.').and_then(|(_, ext)| pick(ext))
    }

    /// Reads the arguments after `run`, relative paths against `cwd`.
    pub fn parse(args: &[String], cwd: &Path) -> std::result::Result<RunArgs, String> {
        let abs = |p: &str| {
            let p = Path::new(p);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                cwd.join(p)
            }
        };
        let (mut recipe, mut input, mut output, mut format, mut overwrite) =
            (None, None, None, None, false);
        let mut it = args.iter();
        while let Some(a) = it.next() {
            let mut value = |flag: &str| {
                it.next()
                    .cloned()
                    .ok_or_else(|| format!("{flag} needs a value."))
            };
            match a.as_str() {
                "--in" | "-i" => input = Some(abs(&value("--in")?)),
                "--out" | "-o" => output = Some(abs(&value("--out")?)),
                "--format" | "-f" => {
                    let f = value("--format")?;
                    format = Some(format_of(&f).ok_or_else(|| format!("Unknown format \"{f}\"."))?);
                }
                "--overwrite" => overwrite = true,
                flag if flag.starts_with('-') => return Err(format!("Unknown option {flag}.")),
                path if recipe.is_none() => recipe = Some(abs(path)),
                extra => return Err(format!("Unexpected \"{extra}\".")),
            }
        }
        let input = input.ok_or("Give the file to read with --in.")?;
        let output = output.ok_or("Give the file to write with --out.")?;
        let format = match format {
            Some(f) => f,
            None => format_of(&output.file_name().unwrap_or_default().to_string_lossy()).ok_or(
                "Say the format with --format, or end --out with .csv, .parquet, .xlsx, …",
            )?,
        };
        Ok(RunArgs {
            recipe,
            input,
            output,
            format,
            overwrite,
        })
    }

    /// Runs `args`, telling progress on `say`. The rows written.
    pub fn run(engine: &Engine, args: &RunArgs, say: &mut dyn FnMut(String)) -> Result<u64> {
        if args.output.exists() && !args.overwrite {
            return Err(AppError::Query(format!(
                "{} already exists; add --overwrite to replace it.",
                args.output.display()
            )));
        }
        let steps: Vec<RecipeStep> = match &args.recipe {
            Some(path) => {
                let recipe = load_recipe(path)?;
                say(format!(
                    "Recipe {}: {} step{}",
                    path.display(),
                    recipe.steps.len(),
                    if recipe.steps.len() == 1 { "" } else { "s" }
                ));
                recipe.steps
            }
            None => Vec::new(),
        };
        let source = Source::new(&args.input, OpenOptions::default())?.resolve_dialect(engine)?;
        let dataset = crate::import::open_query(engine, &source)?;
        say(format!(
            "Read {}: {} rows",
            args.input.display(),
            dataset.row_count
        ));
        let key = RequestKey::default();
        let dataset_id = if steps.is_empty() {
            dataset.id.clone()
        } else {
            let out = engine.apply_recipe(&dataset.id, &steps, &key)?;
            if let Some((i, err)) = out
                .steps
                .iter()
                .enumerate()
                .find_map(|(i, s)| s.error.as_ref().map(|e| (i, e)))
            {
                return Err(AppError::Query(format!("Step {} failed: {err}", i + 1)));
            }
            for (i, s) in out.steps.iter().enumerate() {
                if let Some(n) = s.failed.filter(|n| *n > 0) {
                    say(format!(
                        "Step {}: {n} values couldn't be converted (now empty)",
                        i + 1
                    ));
                }
            }
            out.dataset.id
        };
        if args.overwrite {
            let _ = std::fs::remove_file(&args.output);
        }
        let request = ExportRequest {
            dataset_id,
            spec: ViewSpec::default(),
            labels: HashMap::new(),
            path: args.output.clone(),
            format: args.format,
            options: ExportOptions::default(),
            total_rows: None,
        };
        let done = export::export(engine, &Exports::default(), &request, "cli", &|_| {})?;
        say(format!(
            "Wrote {} rows to {} in {} ms",
            done.rows,
            done.path.display(),
            done.elapsed_ms
        ));
        Ok(done.rows)
    }

    /// `dataliq run …` from `main`: parses, runs, prints, and gives the exit status.
    pub fn main(args: &[String]) -> i32 {
        if args.iter().any(|a| a == "--help" || a == "-h") || args.is_empty() {
            print!("{USAGE}");
            return if args.is_empty() { 2 } else { 0 };
        }
        let cwd = std::env::current_dir().unwrap_or_default();
        let parsed = match parse(args, &cwd) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("dataliq run: {e}\n\n{USAGE}");
                return 2;
            }
        };
        let settings = dirs::config_dir()
            .map(|d| {
                Settings::load_or_default(&d.join("app.dataliq.desktop").join("settings.json"))
            })
            .unwrap_or_default();
        let spill = std::env::temp_dir().join(format!("dataliq-run-{}", std::process::id()));
        let engine = match Engine::open_in_memory(&EngineConfig {
            temp_dir: spill.clone(),
            ..EngineConfig::from_settings(&settings)
        }) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("dataliq run: {e}");
                return 1;
            }
        };
        let status = match run(&engine, &parsed, &mut |line| println!("{line}")) {
            Ok(_) => 0,
            Err(e) => {
                eprintln!("dataliq run: {e}");
                1
            }
        };
        drop(engine);
        let _ = std::fs::remove_dir_all(spill);
        status
    }
}
