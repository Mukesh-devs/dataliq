//! Generator for DataLiq's large test fixtures (git-ignored). Output is
//! deterministic: the same target always produces the same rows, and text
//! formats are byte-identical on every platform.

pub mod committed;
pub mod rng;
pub mod rows;

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::rng::Rng;

pub const MB: u64 = 1024 * 1024;
pub const GB: u64 = 1024 * MB;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Format {
    Csv,
    CsvGz,
    NdjsonGz,
    Parquet,
    Xlsx,
}

#[derive(Debug, Clone, Copy)]
pub enum Size {
    /// Stop once the file on disk reaches this many bytes (compressed size for .gz).
    Bytes(u64),
    Rows(u64),
}

#[derive(Debug, Clone, Copy)]
pub struct Target {
    pub name: &'static str,
    pub format: Format,
    pub size: Size,
}

impl Target {
    pub fn file_name(&self) -> String {
        let ext = match self.format {
            Format::Csv => "csv",
            Format::CsvGz => "csv.gz",
            Format::NdjsonGz => "ndjson.gz",
            Format::Parquet => "parquet",
            Format::Xlsx => "xlsx",
        };
        format!("{}.{ext}", self.name)
    }

    /// Rough output size, used for the free-disk-space check.
    pub fn estimated_bytes(&self) -> u64 {
        match (self.size, self.format) {
            (Size::Bytes(b), _) => b,
            (Size::Rows(r), Format::Parquet) => r * 30,
            (Size::Rows(r), _) => r * 60,
        }
    }
}

/// Fixtures for the small benchmark suite (run in CI).
pub const SMALL: &[Target] = &[
    Target {
        name: "sales_100mb",
        format: Format::Csv,
        size: Size::Bytes(100 * MB),
    },
    Target {
        name: "sales_100mb",
        format: Format::CsvGz,
        size: Size::Bytes(100 * MB),
    },
    Target {
        name: "logs_100mb",
        format: Format::NdjsonGz,
        size: Size::Bytes(100 * MB),
    },
    Target {
        name: "sales_1m",
        format: Format::Parquet,
        size: Size::Rows(1_000_000),
    },
    Target {
        name: "sales_100k",
        format: Format::Xlsx,
        size: Size::Rows(100_000),
    },
];

/// Fixtures for the large-file budgets in BUILD_PLAN.md.
pub const LARGE: &[Target] = &[
    Target {
        name: "sales_1gb",
        format: Format::Csv,
        size: Size::Bytes(GB),
    },
    Target {
        name: "sales_5gb",
        format: Format::Csv,
        size: Size::Bytes(5 * GB),
    },
    Target {
        name: "sales_5gb",
        format: Format::CsvGz,
        size: Size::Bytes(5 * GB),
    },
    Target {
        name: "logs_5gb",
        format: Format::NdjsonGz,
        size: Size::Bytes(5 * GB),
    },
    Target {
        name: "sales_50m",
        format: Format::Parquet,
        size: Size::Rows(50_000_000),
    },
    Target {
        name: "sales_1m",
        format: Format::Xlsx,
        size: Size::Rows(1_000_000),
    },
];

/// One generated file, as recorded in `manifest.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub format: Format,
    pub rows: u64,
    pub bytes: u64,
    pub sha256: String,
    /// Sum of the first column (order_id / id): a cheap check that a reader saw every row.
    pub id_sum: u64,
}

pub type Manifest = BTreeMap<String, Entry>;

pub const MANIFEST: &str = "manifest.json";

pub fn read_manifest(dir: &Path) -> Manifest {
    std::fs::read_to_string(dir.join(MANIFEST))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn write_manifest(dir: &Path, manifest: &Manifest) -> io::Result<()> {
    let text = serde_json::to_string_pretty(manifest).map_err(io::Error::other)?;
    std::fs::write(dir.join(MANIFEST), text + "\n")
}

/// Bottom of every writer chain: counts and hashes the bytes that hit disk.
struct HashCount<W> {
    inner: W,
    hasher: Sha256,
    count: u64,
}

impl<W: Write> Write for HashCount<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.count += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// Seed per dataset so different fixtures don't share rows.
fn seed(name: &str) -> u64 {
    name.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3)
    })
}

fn sales_seed() -> u64 {
    seed("sales")
}

/// Generates one target into `dir` and returns its manifest entry.
pub fn generate(target: &Target, dir: &Path) -> io::Result<Entry> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(target.file_name());
    // Write to a temp name first so an interrupted run never leaves a
    // truncated file that looks complete.
    let tmp = dir.join(format!(".{}.partial", target.file_name()));
    let entry = match target.format {
        Format::Csv => write_text(&tmp, target.size, false, Kind::Sales)?,
        Format::CsvGz => write_text(&tmp, target.size, true, Kind::Sales)?,
        Format::NdjsonGz => write_text(&tmp, target.size, true, Kind::Logs)?,
        Format::Parquet => write_parquet(&tmp, rows_of(target.size))?,
        Format::Xlsx => write_xlsx(&tmp, rows_of(target.size))?,
    };
    std::fs::rename(&tmp, &path)?;
    Ok(Entry {
        format: target.format,
        ..entry
    })
}

fn rows_of(size: Size) -> u64 {
    match size {
        Size::Rows(r) => r,
        Size::Bytes(_) => panic!("binary formats are sized by rows"),
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Sales,
    Logs,
}

/// Rows are formatted into a chunk, and the chunk is written down the chain
/// (optional gzip -> hash/count -> file) so the loop can check how many bytes
/// actually reached disk after each chunk.
const CHUNK: usize = 256 * 1024;

fn write_text(path: &Path, size: Size, gzip: bool, kind: Kind) -> io::Result<Entry> {
    let file = HashCount {
        inner: File::create(path)?,
        hasher: Sha256::new(),
        count: 0,
    };
    let (file, rows, id_sum) = if gzip {
        // Level 1: much faster to generate; real-world .gz files vary anyway.
        let mut enc = GzEncoder::new(file, Compression::fast());
        let (rows, id_sum) = fill(&mut enc, size, kind, |e| e.get_ref().count)?;
        (enc.finish()?, rows, id_sum)
    } else {
        let mut file = file;
        let (rows, id_sum) = fill(&mut file, size, kind, |f| f.count)?;
        (file, rows, id_sum)
    };
    file.inner.sync_all()?;
    Ok(Entry {
        format: Format::Csv, // overwritten by `generate`
        rows,
        bytes: file.count,
        sha256: hex(&file.hasher.finalize()),
        id_sum,
    })
}

/// Writes header + rows until `size` is reached. Returns (rows, sum of ids).
fn fill<W: Write>(
    sink: &mut W,
    size: Size,
    kind: Kind,
    written: impl Fn(&W) -> u64,
) -> io::Result<(u64, u64)> {
    let mut rng = Rng::new(match kind {
        Kind::Sales => sales_seed(),
        Kind::Logs => seed("logs"),
    });
    let mut chunk: Vec<u8> = Vec::with_capacity(CHUNK + 4096);
    if let Kind::Sales = kind {
        rows::write_sales_header(&mut chunk, b',')?;
    }
    let mut rows = 0u64;
    let mut id_sum = 0u64;
    loop {
        let done = match size {
            Size::Rows(n) => rows >= n,
            Size::Bytes(n) => chunk.is_empty() && written(sink) >= n,
        };
        if done {
            break;
        }
        match kind {
            Kind::Sales => rows::write_sale_csv(&mut chunk, &rows::sale(&mut rng, rows), b',')?,
            Kind::Logs => rows::write_log_ndjson(&mut chunk, &mut rng, rows)?,
        }
        rows += 1;
        id_sum += rows;
        if chunk.len() >= CHUNK {
            sink.write_all(&chunk)?;
            chunk.clear();
        }
    }
    sink.write_all(&chunk)?;
    sink.flush()?;
    Ok((rows, id_sum))
}

/// Sales rows built by DuckDB with hash-based columns: fast (multi-threaded)
/// and deterministic for a given DuckDB version.
fn write_parquet(path: &Path, rows: u64) -> io::Result<Entry> {
    let conn = duckdb::Connection::open_in_memory().map_err(io::Error::other)?;
    let sql = format!(
        "COPY (SELECT
            i + 1 AS order_id,
            DATE '2020-01-01' + (hash(i, 1) % 1826)::INTEGER AS order_date,
            TIMESTAMP '2020-01-01' + to_seconds((hash(i, 2) % 157766400)::BIGINT) AS order_ts,
            'Customer ' || lpad((hash(i, 3) % 100000)::VARCHAR, 5, '0') AS customer,
            ['United States','Germany','France','India','Japan','Brazil','Canada','Spain']
                [1 + (hash(i, 4) % 8)::INTEGER] AS country,
            (1 + hash(i, 5) % 20)::INTEGER AS quantity,
            round((99 + hash(i, 6) % 250000) / 100, 2)::DECIMAL(10, 2) AS unit_price,
            CASE WHEN hash(i, 7) % 20 = 0 THEN NULL ELSE (hash(i, 8) % 31) / 100 END AS discount,
            hash(i, 9) % 33 = 0 AS returned
          FROM range({rows}) t(i) ORDER BY i)
         TO '{}' (FORMAT parquet, COMPRESSION zstd)",
        path.display().to_string().replace('\'', "''")
    );
    conn.execute_batch(&sql).map_err(io::Error::other)?;
    binary_entry(path, rows)
}

/// Excel sheet written in constant-memory mode (rows are streamed to disk).
fn write_xlsx(path: &Path, rows: u64) -> io::Result<Entry> {
    use rust_xlsxwriter::Format as XFormat;
    let mut workbook = fixed_workbook()?;
    let date_fmt = XFormat::new().set_num_format("yyyy-mm-dd");
    let sheet = workbook.add_worksheet_with_constant_memory();
    sheet.set_name("Sales").map_err(io::Error::other)?;
    let headers = [
        "order_id",
        "order_date",
        "customer",
        "country",
        "quantity",
        "unit_price",
        "returned",
    ];
    for (c, h) in headers.iter().enumerate() {
        sheet
            .write_string(0, c as u16, *h)
            .map_err(io::Error::other)?;
    }
    let mut rng = Rng::new(sales_seed());
    for r in 0..rows {
        let s = rows::sale(&mut rng, r);
        let row = (r + 1) as u32;
        let x = |e: rust_xlsxwriter::XlsxError| io::Error::other(e);
        sheet.write_number(row, 0, s.order_id as f64).map_err(x)?;
        // Excel serial date: days since 1899-12-30.
        sheet
            .write_number_with_format(row, 1, (s.days + 25_569) as f64, &date_fmt)
            .map_err(x)?;
        sheet
            .write_string(row, 2, format!("Customer {:05}", s.customer))
            .map_err(x)?;
        sheet.write_string(row, 3, s.country).map_err(x)?;
        sheet
            .write_number(row, 4, f64::from(s.quantity))
            .map_err(x)?;
        sheet
            .write_number(row, 5, s.unit_price as f64 / 100.0)
            .map_err(x)?;
        sheet.write_boolean(row, 6, s.returned).map_err(x)?;
    }
    workbook.save(path).map_err(io::Error::other)?;
    binary_entry(path, rows)
}

fn binary_entry(path: &Path, rows: u64) -> io::Result<Entry> {
    Ok(Entry {
        format: Format::Parquet, // overwritten by `generate`
        rows,
        bytes: std::fs::metadata(path)?.len(),
        sha256: sha256_file(path)?,
        id_sum: rows * (rows + 1) / 2,
    })
}

/// Workbook with a fixed creation time so the .xlsx bytes are reproducible.
pub fn fixed_workbook() -> io::Result<rust_xlsxwriter::Workbook> {
    use rust_xlsxwriter::{DocProperties, ExcelDateTime, Workbook};
    let created = ExcelDateTime::from_ymd(2024, 1, 1).map_err(io::Error::other)?;
    let mut workbook = Workbook::new();
    workbook.set_properties(&DocProperties::new().set_creation_datetime(&created));
    Ok(workbook)
}

pub fn default_out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/generated")
}
