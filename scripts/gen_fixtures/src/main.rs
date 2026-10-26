//! Generates the large, git-ignored fixtures into `fixtures/generated/`.
//!
//!   cargo run --release -p gen_fixtures -- small        # 100 MB set (CI benchmarks)
//!   cargo run --release -p gen_fixtures -- large        # 1 GB / 5 GB / 50M-row set
//!   cargo run --release -p gen_fixtures -- sales_5gb.csv.gz
//!   cargo run --release -p gen_fixtures -- verify       # re-check sizes + checksums
//!   cargo run --release -p gen_fixtures -- list
//!   cargo run --release -p gen_fixtures -- committed    # rewrite the small fixtures/ files
//!
//! Options: `--out <dir>` (default fixtures/generated), `--force` (regenerate).

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use gen_fixtures::{
    LARGE, SMALL, Target, default_out_dir, generate, read_manifest, sha256_file, write_manifest,
};

fn main() -> ExitCode {
    let mut out = default_out_dir();
    let mut force = false;
    let mut words = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => out = PathBuf::from(args.next().expect("--out needs a directory")),
            "--force" => force = true,
            "-h" | "--help" => {
                println!(
                    "usage: gen_fixtures [small|large|all|verify|list|committed|<file name>...] [--out DIR] [--force]"
                );
                return ExitCode::SUCCESS;
            }
            _ => words.push(arg),
        }
    }
    if words.is_empty() {
        words.push("small".into());
    }

    let all: Vec<&Target> = SMALL.iter().chain(LARGE).collect();
    match words[0].as_str() {
        "list" => {
            for t in &all {
                println!(
                    "{:28} ~{} MB",
                    t.file_name(),
                    t.estimated_bytes() / gen_fixtures::MB
                );
            }
            return ExitCode::SUCCESS;
        }
        "verify" => return verify(&out),
        "committed" => {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
            return match gen_fixtures::committed::write_all(&root) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("failed: {e}");
                    ExitCode::FAILURE
                }
            };
        }
        _ => {}
    }

    let mut targets: Vec<&Target> = Vec::new();
    for w in &words {
        match w.as_str() {
            "small" => targets.extend(SMALL),
            "large" => targets.extend(LARGE),
            "all" => targets.extend(&all),
            name => match all.iter().find(|t| t.file_name() == name) {
                Some(t) => targets.push(t),
                None => {
                    eprintln!("unknown fixture {name:?}; run `gen_fixtures list`");
                    return ExitCode::FAILURE;
                }
            },
        }
    }

    let mut manifest = read_manifest(&out);
    for t in targets {
        let name = t.file_name();
        let path = out.join(&name);
        let up_to_date = manifest
            .get(&name)
            .is_some_and(|e| std::fs::metadata(&path).is_ok_and(|m| m.len() == e.bytes));
        if up_to_date && !force {
            println!("{name}: up to date");
            continue;
        }
        println!(
            "{name}: generating (~{} MB)…",
            t.estimated_bytes() / gen_fixtures::MB
        );
        let start = Instant::now();
        match generate(t, &out) {
            Ok(entry) => {
                println!(
                    "{name}: {} rows, {} bytes in {:.1} s",
                    entry.rows,
                    entry.bytes,
                    start.elapsed().as_secs_f64()
                );
                manifest.insert(name, entry);
                if let Err(e) = write_manifest(&out, &manifest) {
                    eprintln!("could not write manifest: {e}");
                    return ExitCode::FAILURE;
                }
            }
            Err(e) => {
                eprintln!("{name}: failed: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
    ExitCode::SUCCESS
}

fn verify(out: &std::path::Path) -> ExitCode {
    let manifest = read_manifest(out);
    let mut ok = true;
    for (name, entry) in &manifest {
        let path = out.join(name);
        match sha256_file(&path) {
            Ok(sha) if sha == entry.sha256 => println!("{name}: ok"),
            Ok(_) => {
                println!("{name}: CHECKSUM MISMATCH");
                ok = false;
            }
            Err(e) => {
                println!("{name}: missing ({e})");
                ok = false;
            }
        }
    }
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
