//! File format detection from the extension and magic bytes.
//! Handles double extensions such as `.csv.gz` and mislabeled files.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileFormat {
    Csv,
    Tsv,
    Json,
    Ndjson,
    Parquet,
    Xlsx,
    Xls,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Compression {
    None,
    Gzip,
    Zstd,
    /// Several files, some compressed and some not: DuckDB tells per file.
    Mixed,
}

impl Compression {
    /// Value for `read_json`'s `compression` option (a FileCompressionType).
    pub fn duckdb_file_compression(self) -> &'static str {
        match self {
            Compression::None => "uncompressed",
            Compression::Gzip => "gzip",
            Compression::Zstd => "zstd",
            Compression::Mixed => "auto_detect",
        }
    }

    /// Value for `read_csv`'s `compression` option.
    pub fn duckdb_name(self) -> &'static str {
        match self {
            Compression::None => "none",
            Compression::Gzip => "gzip",
            Compression::Zstd => "zstd",
            Compression::Mixed => "auto",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Detected {
    pub format: FileFormat,
    pub compression: Compression,
}

const GZIP_MAGIC: &[u8] = &[0x1f, 0x8b];
const ZSTD_MAGIC: &[u8] = &[0x28, 0xb5, 0x2f, 0xfd];
const PARQUET_MAGIC: &[u8] = b"PAR1";
const ZIP_MAGIC: &[u8] = b"PK\x03\x04";
const OLE_MAGIC: &[u8] = &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

pub(crate) fn format_from_ext(ext: &str) -> Option<FileFormat> {
    Some(match ext {
        "csv" | "txt" | "dat" => FileFormat::Csv,
        "tsv" | "tab" => FileFormat::Tsv,
        "json" => FileFormat::Json,
        "ndjson" | "jsonl" => FileFormat::Ndjson,
        "parquet" | "pq" => FileFormat::Parquet,
        "xlsx" | "xlsm" => FileFormat::Xlsx,
        "xls" => FileFormat::Xls,
        _ => return None,
    })
}

/// Splits `sales.CSV.gz` into ("csv", Some("gz")), lowercased.
pub(crate) fn extensions(path: &Path) -> (Option<String>, Option<Compression>) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mut parts: Vec<&str> = name.split('.').skip(1).collect();
    let compression = match parts.last() {
        Some(&("gz" | "gzip")) => Some(Compression::Gzip),
        Some(&("zst" | "zstd")) => Some(Compression::Zstd),
        _ => None,
    };
    if compression.is_some() {
        parts.pop();
    }
    (parts.last().map(|s| s.to_string()), compression)
}

/// Guesses a text format from the first bytes of (decompressed) content.
fn sniff_text(head: &[u8]) -> FileFormat {
    let text = head.strip_prefix(b"\xef\xbb\xbf").unwrap_or(head);
    match text.iter().find(|b| !b.is_ascii_whitespace()) {
        Some(b'[') => FileFormat::Json,
        Some(b'{') => FileFormat::Ndjson,
        _ => {
            let first_line = text.split(|&b| b == b'\n').next().unwrap_or_default();
            let tabs = first_line.iter().filter(|&&b| b == b'\t').count();
            let commas = first_line.iter().filter(|&&b| b == b',').count();
            if tabs > commas {
                FileFormat::Tsv
            } else {
                FileFormat::Csv
            }
        }
    }
}

fn read_head(path: &Path, n: usize) -> io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(n);
    File::open(path)?.take(n as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

fn gunzip_head(path: &Path, n: usize) -> Vec<u8> {
    let mut buf = Vec::with_capacity(n);
    if let Ok(f) = File::open(path) {
        // Errors (e.g. truncated data) just leave a shorter head.
        let _ = flate2::read::GzDecoder::new(f)
            .take(n as u64)
            .read_to_end(&mut buf);
    }
    buf
}

/// The format a file name says (`sales.csv.gz`), for files that can't be
/// read first (URLs).
pub fn detect_from_name(name: &str) -> Option<Detected> {
    let (ext, compression) = extensions(Path::new(name));
    Some(Detected {
        format: format_from_ext(ext.as_deref()?)?,
        compression: compression.unwrap_or(Compression::None),
    })
}

/// Detects the format of a file. Magic bytes win over a wrong extension.
pub fn detect(path: &Path) -> io::Result<Detected> {
    let head = read_head(path, 4096)?;
    let (ext, ext_compression) = extensions(path);
    let ext_format = ext.as_deref().and_then(format_from_ext);

    let magic_compression = if head.starts_with(GZIP_MAGIC) {
        Some(Compression::Gzip)
    } else if head.starts_with(ZSTD_MAGIC) {
        Some(Compression::Zstd)
    } else {
        None
    };
    let compression = magic_compression
        .or(ext_compression)
        .unwrap_or(Compression::None);

    if compression == Compression::None {
        if head.starts_with(PARQUET_MAGIC) {
            return Ok(Detected {
                format: FileFormat::Parquet,
                compression,
            });
        }
        if head.starts_with(OLE_MAGIC) {
            return Ok(Detected {
                format: FileFormat::Xls,
                compression,
            });
        }
        if head.starts_with(ZIP_MAGIC) {
            return Ok(Detected {
                format: FileFormat::Xlsx,
                compression,
            });
        }
    }

    let format = match ext_format {
        // Binary formats are never compressed with an outer .gz in practice;
        // trust content sniffing if the extension claims one but bytes disagree.
        Some(FileFormat::Parquet | FileFormat::Xlsx | FileFormat::Xls) | None => {
            let text_head = match compression {
                Compression::Gzip => gunzip_head(path, 4096),
                // zstd heads are not sniffed; DuckDB detects the format itself.
                Compression::Zstd | Compression::Mixed => Vec::new(),
                Compression::None => head,
            };
            sniff_text(&text_head)
        }
        Some(f) => f,
    };
    Ok(Detected {
        format,
        compression,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn gz(bytes: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        e.write_all(bytes).unwrap();
        e.finish().unwrap()
    }

    fn d(format: FileFormat, compression: Compression) -> Detected {
        Detected {
            format,
            compression,
        }
    }

    #[test]
    fn splits_double_extensions() {
        assert_eq!(
            extensions(Path::new("/a/Sales.CSV.GZ")),
            (Some("csv".into()), Some(Compression::Gzip))
        );
        assert_eq!(
            extensions(Path::new("x.ndjson.zst")),
            (Some("ndjson".into()), Some(Compression::Zstd))
        );
        assert_eq!(
            extensions(Path::new("archive.2024.tsv")),
            (Some("tsv".into()), None)
        );
        assert_eq!(extensions(Path::new("noext")), (None, None));
    }

    #[test]
    fn detects_by_extension_and_magic() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path();
        assert_eq!(
            detect(&write(p, "a.csv", b"a,b\n1,2\n")).unwrap(),
            d(FileFormat::Csv, Compression::None)
        );
        assert_eq!(
            detect(&write(p, "a.tsv", b"a\tb\n")).unwrap(),
            d(FileFormat::Tsv, Compression::None)
        );
        assert_eq!(
            detect(&write(p, "a.csv.gz", &gz(b"a,b\n"))).unwrap(),
            d(FileFormat::Csv, Compression::Gzip)
        );
        assert_eq!(
            detect(&write(p, "a.ndjson.gz", &gz(b"{}\n"))).unwrap(),
            d(FileFormat::Ndjson, Compression::Gzip)
        );
        assert_eq!(
            detect(&write(p, "a.json", b"[]")).unwrap(),
            d(FileFormat::Json, Compression::None)
        );
        assert_eq!(
            detect(&write(p, "a.parquet", b"PAR1....")).unwrap(),
            d(FileFormat::Parquet, Compression::None)
        );
        assert_eq!(
            detect(&write(p, "a.xlsx", b"PK\x03\x04....")).unwrap(),
            d(FileFormat::Xlsx, Compression::None)
        );
        assert_eq!(
            detect(&write(p, "a.xls", OLE_MAGIC)).unwrap(),
            d(FileFormat::Xls, Compression::None)
        );
    }

    #[test]
    fn magic_bytes_beat_wrong_extensions() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path();
        // gzip data without a .gz extension
        assert_eq!(
            detect(&write(p, "data.csv", &gz(b"a,b\n"))).unwrap(),
            d(FileFormat::Csv, Compression::Gzip)
        );
        // Parquet named .csv
        assert_eq!(
            detect(&write(p, "oops.csv", b"PAR1xxxx")).unwrap(),
            d(FileFormat::Parquet, Compression::None)
        );
        // No extension: sniff content
        assert_eq!(
            detect(&write(p, "export", b"x\ty\tz\n1\t2\t3\n")).unwrap(),
            d(FileFormat::Tsv, Compression::None)
        );
        assert_eq!(
            detect(&write(p, "dump.gz", &gz(b"[{\"a\":1}]"))).unwrap(),
            d(FileFormat::Json, Compression::Gzip)
        );
        assert_eq!(
            detect(&write(p, "log", b"\xef\xbb\xbf{\"a\":1}\n")).unwrap(),
            d(FileFormat::Ndjson, Compression::None)
        );
    }

    #[test]
    fn empty_and_missing_files() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(
            detect(&write(t.path(), "e.csv", b"")).unwrap(),
            d(FileFormat::Csv, Compression::None)
        );
        assert!(detect(&t.path().join("missing.csv")).is_err());
    }
}
