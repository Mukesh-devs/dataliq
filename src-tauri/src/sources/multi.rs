//! Several files opened as one table: a folder (the data files directly in
//! it) or a glob pattern such as `logs/*.csv.gz` or `data/**/*.parquet`.
//!
//! The files of the most common format are read together, columns matched
//! by name, with a column saying which file each row came from. Files of
//! other formats, and empty files, are left out and counted.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::detect::{self, Compression, Detected, FileFormat};
use crate::error::{AppError, Result};

/// The files a folder or pattern stands for.
#[derive(Debug, Clone, PartialEq)]
pub struct FileSet {
    /// The folder the files are in (for a pattern, the part before the first
    /// wildcard); the file column shows paths relative to it.
    pub root: PathBuf,
    /// In name order.
    pub files: Vec<PathBuf>,
    /// The format they share, and their compression (`Mixed` if it varies).
    pub detected: Detected,
    /// Data files left out: another format, or empty.
    pub skipped: usize,
}

/// A path with wildcards (`*`, `?`, `[…]`) is a pattern, not a file.
pub fn is_pattern(path: &Path) -> bool {
    path.to_string_lossy().contains(['*', '?', '['])
}

/// The folder of a pattern: its components before the first wildcard.
fn pattern_root(pattern: &Path) -> PathBuf {
    let mut root = PathBuf::new();
    for c in pattern.components() {
        if c.as_os_str().to_string_lossy().contains(['*', '?', '[']) {
            break;
        }
        root.push(c);
    }
    root
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|n| n.to_string_lossy().starts_with('.'))
}

/// A data file by its extension (before detecting it from its contents).
fn looks_like_data(path: &Path) -> bool {
    detect::extensions(path)
        .0
        .as_deref()
        .and_then(detect::format_from_ext)
        .is_some()
}

/// The files of a folder (not its subfolders) or matching a pattern.
pub fn resolve(path: &Path) -> Result<FileSet> {
    let (root, candidates) = if path.is_dir() {
        let mut files: Vec<PathBuf> = std::fs::read_dir(path)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_file() && !is_hidden(p) && looks_like_data(p))
            .collect();
        files.sort();
        (path.to_path_buf(), files)
    } else if is_pattern(path) {
        let text = path.to_string_lossy();
        let paths = glob::glob(&text)
            .map_err(|e| AppError::Query(format!("This pattern isn't valid: {}.", e.msg)))?;
        let mut files: Vec<PathBuf> = paths
            .filter_map(|p| p.ok())
            .filter(|p| p.is_file() && !is_hidden(p))
            .collect();
        files.sort();
        (pattern_root(path), files)
    } else {
        return Err(AppError::Query(format!(
            "File not found: {}",
            path.display()
        )));
    };

    // Each file's format from its contents; the most common one wins.
    let mut found: Vec<(PathBuf, Detected)> = Vec::new();
    let mut empty = 0;
    for f in candidates {
        if std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0) == 0 {
            empty += 1;
            continue;
        }
        if let Ok(d) = detect::detect(&f) {
            found.push((f, d));
        }
    }
    let mut counts: HashMap<FileFormat, usize> = HashMap::new();
    for (_, d) in &found {
        *counts.entry(d.format).or_default() += 1;
    }
    let order = [
        FileFormat::Csv,
        FileFormat::Tsv,
        FileFormat::Parquet,
        FileFormat::Ndjson,
        FileFormat::Json,
        FileFormat::Xlsx,
        FileFormat::Xls,
    ];
    let Some(format) = order
        .iter()
        .copied()
        .filter(|f| counts.contains_key(f))
        .max_by_key(|f| {
            (
                counts[f],
                std::cmp::Reverse(order.iter().position(|o| o == f)),
            )
        })
    else {
        return Err(AppError::Query(if path.is_dir() {
            "This folder has no CSV, TSV, JSON or Parquet files.".into()
        } else {
            format!("No data files match {}.", path.display())
        }));
    };
    if matches!(format, FileFormat::Xlsx | FileFormat::Xls) {
        return Err(AppError::Query(
            "Excel workbooks can't be opened together as one table; open them one at a time."
                .into(),
        ));
    }
    let chosen: Vec<(PathBuf, Detected)> = found
        .iter()
        .filter(|(_, d)| d.format == format)
        .cloned()
        .collect();
    let first = chosen[0].1.compression;
    let compression = if chosen.iter().all(|(_, d)| d.compression == first) {
        first
    } else {
        Compression::Mixed
    };
    Ok(FileSet {
        root,
        skipped: empty + found.len() - chosen.len(),
        files: chosen.into_iter().map(|(p, _)| p).collect(),
        detected: Detected {
            format,
            compression,
        },
    })
}

/// The line a CSV file's header is on (after `skip` lines), without its
/// line ending; gzipped files are read through. None when it can't be read
/// cheaply (zstd, no line in the first megabyte).
fn header_line(path: &Path, skip: usize) -> Option<Vec<u8>> {
    use std::io::{BufRead, BufReader, Read};
    let mut file = std::fs::File::open(path).ok()?;
    let mut magic = [0u8; 4];
    let n = file.read(&mut magic).ok()?;
    let file = std::fs::File::open(path).ok()?;
    let reader: Box<dyn Read> = if magic[..n].starts_with(&[0x1f, 0x8b]) {
        Box::new(flate2::read::MultiGzDecoder::new(file))
    } else if magic[..n].starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        return None;
    } else {
        Box::new(file)
    };
    let mut lines = BufReader::new(reader.take(1 << 20));
    let mut line = Vec::new();
    for _ in 0..=skip {
        line.clear();
        if lines.read_until(b'\n', &mut line).ok()? == 0 || !line.ends_with(b"\n") {
            return None;
        }
    }
    while matches!(line.last(), Some(b'\n' | b'\r')) {
        line.pop();
    }
    Some(line)
}

/// Every file starts with the same header line, so the first file's
/// dialect and types can be used for all of them. Not for files without a
/// header (nothing to compare).
pub fn same_header(files: &[PathBuf], csv: &super::CsvOptions) -> bool {
    if files.len() < 2 || csv.header == Some(false) {
        return false;
    }
    let skip = csv.skip_rows.unwrap_or(0) as usize;
    let strip_bom = |l: Vec<u8>| {
        l.strip_prefix(b"\xef\xbb\xbf")
            .map(<[u8]>::to_vec)
            .unwrap_or(l)
    };
    let Some(first) = header_line(&files[0], skip).map(strip_bom) else {
        return false;
    };
    !first.is_empty()
        && files[1..]
            .iter()
            .all(|f| header_line(f, skip).map(strip_bom).as_ref() == Some(&first))
}

/// `path` relative to `root`, with `/` between folders, for showing.
pub fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
        let p = dir.join(name);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&p, text).unwrap();
        p
    }

    #[test]
    fn a_folder_is_its_most_common_format() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        write(d, "b.csv", "a\n1\n");
        write(d, "a.csv", "a\n2\n");
        write(d, "c.json", "[{\"a\": 3}]");
        write(d, "empty.csv", "");
        write(d, ".hidden.csv", "a\n4\n");
        write(d, "notes.md", "# not data");
        write(d, "sub/d.csv", "a\n5\n");
        let set = resolve(d).unwrap();
        let names: Vec<String> = set.files.iter().map(|f| relative(d, f)).collect();
        assert_eq!(names, ["a.csv", "b.csv"]);
        assert_eq!(set.detected.format, FileFormat::Csv);
        assert_eq!(set.detected.compression, Compression::None);
        // The JSON file and the empty CSV.
        assert_eq!(set.skipped, 2);
        assert_eq!(set.root, d);
    }

    #[test]
    fn patterns_reach_into_folders() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        write(d, "2024/jan.csv", "a\n1\n");
        write(d, "2024/feb.csv", "a\n2\n");
        write(d, "2023/dec.csv", "a\n3\n");
        write(d, "2024/readme.txt", "x\n");
        let pattern = d.join("*/*.csv");
        assert!(is_pattern(&pattern));
        let set = resolve(&pattern).unwrap();
        let names: Vec<String> = set.files.iter().map(|f| relative(d, f)).collect();
        assert_eq!(names, ["2023/dec.csv", "2024/feb.csv", "2024/jan.csv"]);
        assert_eq!(set.root, d);
        let deep = resolve(&d.join("**/j*.csv")).unwrap();
        assert_eq!(deep.files.len(), 1);
    }

    #[test]
    fn same_headers_are_found_through_gzip() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let a = write(d, "a.csv", "id,name\r\n1,x\r\n");
        let b = d.join("b.csv.gz");
        {
            use std::io::Write;
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            e.write_all(b"\xef\xbb\xbfid,name\n2,y\n").unwrap();
            std::fs::write(&b, e.finish().unwrap()).unwrap();
        }
        let csv = crate::sources::CsvOptions::default();
        assert!(same_header(&[a.clone(), b.clone()], &csv));
        let c = write(d, "c.csv", "id,name,extra\n3,z,!\n");
        assert!(!same_header(&[a.clone(), b.clone(), c], &csv));
        // Nothing to compare without a header; one file needs no check.
        let no_header = crate::sources::CsvOptions {
            header: Some(false),
            ..Default::default()
        };
        assert!(!same_header(&[a.clone(), b], &no_header));
        assert!(!same_header(std::slice::from_ref(&a), &csv));
        // A header after skipped lines.
        let p = write(d, "p.csv", "exported 2024-01-01\nid,name\n1,x\n");
        let q = write(d, "q.csv", "exported 2024-02-01\nid,name\n2,y\n");
        assert!(!same_header(&[p.clone(), q.clone()], &csv));
        let skip = crate::sources::CsvOptions {
            skip_rows: Some(1),
            ..Default::default()
        };
        assert!(same_header(&[p, q], &skip));
    }

    #[test]
    fn mixed_compression_and_nothing_to_open() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        write(d, "a.csv", "a\n1\n");
        let gz = {
            use std::io::Write;
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            e.write_all(b"a\n2\n").unwrap();
            e.finish().unwrap()
        };
        std::fs::write(d.join("b.csv.gz"), gz).unwrap();
        assert_eq!(resolve(d).unwrap().detected.compression, Compression::Mixed);

        let none = tempfile::tempdir().unwrap();
        write(none.path(), "notes.md", "x");
        let err = resolve(none.path()).unwrap_err().to_string();
        assert!(err.contains("no CSV, TSV, JSON or Parquet"), "{err}");
        let err = resolve(&none.path().join("*.csv")).unwrap_err().to_string();
        assert!(err.contains("No data files match"), "{err}");
        write(none.path(), "book.xlsx", "PK\x03\x04 not really");
        let err = resolve(none.path()).unwrap_err().to_string();
        assert!(err.contains("Excel"), "{err}");
    }
}
