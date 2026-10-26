//! Command line: `bigview [files...]`. Files from a second launch are
//! forwarded to the running app by the single-instance plugin.

use std::path::{Path, PathBuf};

/// Files named on a command line (`args[0]` is the program). Relative paths
/// are resolved against `cwd`; flags (`-x`, `--y`) are ignored, and `--`
/// ends flag parsing so a file may start with a dash.
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
        let abs = if path.is_absolute() {
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
    use super::*;

    #[test]
    fn resolves_relative_paths_and_skips_flags() {
        let cwd = Path::new("/work");
        let got = files_from_args(
            &[
                "bigview",
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
            files_from_args(&["bigview", "--", "-odd.csv"], cwd),
            vec![PathBuf::from("/w/-odd.csv")]
        );
        assert!(files_from_args(&["bigview"], cwd).is_empty());
    }
}
