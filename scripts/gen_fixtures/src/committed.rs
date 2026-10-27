//! Small fixtures committed to the repo (each < 1 MB). Regenerate with
//! `cargo run -p gen_fixtures -- committed`; output is deterministic.

use std::io::{self, Write};
use std::path::Path;

use flate2::Compression;

/// (relative path, contents) of the handwritten text fixtures.
pub const TEXT_FIXTURES: &[(&str, &str)] = &[
    (
        "csv/comma.csv",
        "id,name,amount,joined\n1,Alice,10.5,2024-01-15\n2,Bob,-3,2023-12-31\n3,Carol,0,2024-02-29\n",
    ),
    (
        "csv/semicolon.csv",
        "id;name;amount;city\n1;Alice;10,5;Berlin\n2;Bob;-3;München\n3;Carol;0;Köln\n",
    ),
    (
        "csv/tab.tsv",
        "id\tname\tamount\n1\tAlice\t10.5\n2\tBob\t-3\n3\tCarol\t0\n",
    ),
    (
        "csv/pipe.csv",
        "id|name|amount\n1|Alice|10.5\n2|Bob|-3\n3|Carol|0\n",
    ),
    (
        "csv/quoted.csv",
        "id,text,comment\n1,\"Hello, world\",\"She said \"\"hi\"\"\"\n2,\"line one\nline two\",plain\n3,\"\",\"trailing, comma,\"\n",
    ),
    (
        "csv/utf8_bom.csv",
        "\u{feff}id,name\n1,Zoë\n2,Łukasz\n3,日本\n",
    ),
    // Empty fields vs the literal NULL marker vs an empty quoted string.
    ("csv/nulls.csv", "id,a,b\n1,,x\n2,NULL,\"\"\n3,value,\n"),
    (
        "csv/mixed_types.csv",
        "id,maybe_number,flag\n1,10,true\n2,11.5,false\n3,n/a,TRUE\n4,,0\n5,1e3,yes\n",
    ),
    (
        "csv/dates.csv",
        "id,iso,us,eu,ts,ts_tz\n1,2024-01-31,01/31/2024,31.01.2024,2024-01-31 12:34:56,2024-01-31T12:34:56Z\n2,1999-12-31,12/31/1999,31.12.1999,1999-12-31 23:59:59,1999-12-31T23:59:59+02:00\n3,2000-02-29,02/29/2000,29.02.2000,2000-02-29 00:00:00,2000-02-29T00:00:00-05:00\n",
    ),
    ("csv/header_only.csv", "id,name,amount\n"),
    ("csv/empty.csv", ""),
    // Enough good rows for the sniffer to lock onto 3 columns; line 7 has 4.
    (
        "csv/bad_rows.csv",
        "id,name,amount\n1,Alice,10\n2,Bob,20\n3,Carol,30\n4,Dave,40\n5,Erin,50\n6,Frank,60,extra\n7,Grace,70\n8,Heidi,80\n9,Ivan,90\n10,Judy,100\n",
    ),
    (
        "json/array.json",
        "[\n  {\"id\": 1, \"name\": \"Alice\", \"amount\": 10.5, \"active\": true},\n  {\"id\": 2, \"name\": \"Bob\", \"amount\": null, \"active\": false},\n  {\"id\": 3, \"name\": \"Carol\", \"amount\": 0, \"active\": true}\n]\n",
    ),
    (
        "json/records.ndjson",
        "{\"id\": 1, \"name\": \"Alice\", \"amount\": 10.5}\n{\"id\": 2, \"name\": \"Bob\", \"amount\": null}\n{\"id\": 3, \"name\": \"Carol\", \"amount\": 0}\n",
    ),
    (
        "json/nested.json",
        "[\n  {\"id\": 1, \"user\": {\"name\": \"Alice\", \"address\": {\"city\": \"Berlin\"}}, \"tags\": [\"a\", \"b\"], \"scores\": [1, 2, 3]},\n  {\"id\": 2, \"user\": {\"name\": \"Bob\", \"address\": {\"city\": null}}, \"tags\": [], \"scores\": [4]},\n  {\"id\": 3, \"user\": null, \"tags\": null, \"scores\": []}\n]\n",
    ),
];

/// Text fixtures that also get a `.gz` twin.
const GZ_TWINS: &[&str] = &[
    "csv/comma.csv",
    "csv/tab.tsv",
    "csv/quoted.csv",
    "json/array.json",
    "json/records.ndjson",
];

fn write(root: &Path, rel: &str, bytes: &[u8]) -> io::Result<()> {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(path, bytes)
}

/// Gzip with a fixed header (no mtime/filename) so output is reproducible.
fn gzip(bytes: &[u8]) -> io::Result<Vec<u8>> {
    let mut enc = flate2::GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), Compression::default());
    enc.write_all(bytes)?;
    enc.finish()
}

pub fn write_all(root: &Path) -> io::Result<()> {
    for (rel, text) in TEXT_FIXTURES {
        write(root, rel, text.as_bytes())?;
    }
    for rel in GZ_TWINS {
        let text = TEXT_FIXTURES.iter().find(|(r, _)| r == rel).unwrap().1;
        write(root, &format!("{rel}.gz"), &gzip(text.as_bytes())?)?;
    }

    // Latin-1 (ISO-8859-1) bytes: "Zoë", "Müller", "Ångström".
    let latin1: Vec<u8> = "id,name\n1,Zo\u{eb}\n2,M\u{fc}ller\n3,\u{c5}ngstr\u{f6}m\n"
        .chars()
        .map(|c| c as u32 as u8)
        .collect();
    write(root, "csv/latin1.csv", &latin1)?;

    // A truncated gzip stream: valid header, cut off mid-data.
    let mut long = String::from("id,name,amount\n");
    for i in 0..5000 {
        long.push_str(&format!("{i},name {i},{}\n", i * 7 % 1000));
    }
    let full = gzip(long.as_bytes())?;
    write(root, "csv/corrupted.csv.gz", &full[..full.len() / 2])?;

    // Wide file: 500 columns x 20 rows.
    let mut wide = (1..=500)
        .map(|c| format!("col_{c:03}"))
        .collect::<Vec<_>>()
        .join(",");
    wide.push('\n');
    for r in 0..20 {
        let row: Vec<String> = (1..=500).map(|c| (r * 500 + c).to_string()).collect();
        wide.push_str(&row.join(","));
        wide.push('\n');
    }
    write(root, "csv/wide_500.csv", wide.as_bytes())?;

    write(root, "csv/people.csv", people_csv().as_bytes())?;
    write_parquet_types(&root.join("parquet/types.parquet"))?;
    write_multi_sheet_xlsx(&root.join("excel/multi_sheet.xlsx"))?;
    Ok(())
}

/// 1,000 rows for filter tests: text with case and unicode variants, numbers,
/// dates, booleans, NULLs (empty field) and empty strings (`""`). Tests
/// compute expected counts by parsing this file themselves.
fn people_csv() -> String {
    const FIRST: &[&str] = &[
        "Ann", "anna", "Bob", "Zoë", "Émile", "Li", "O'Neil", "Søren",
    ];
    const LAST: &[&str] = &["Smith", "smith", "Müller", "Nakamura", "Diaz", "Ng"];
    const CITY: &[&str] = &[
        "Berlin",
        "München",
        "Paris",
        "São Paulo",
        "New York",
        "東京",
    ];
    let mut rng = crate::rng::Rng::new(0x5EED_F17E);
    // 2022-01-01 as days since 1970-01-01.
    let start = 18_993;
    let mut out = String::from("id,name,city,amount,joined,active\n");
    for id in 1..=1000u64 {
        let name = if id % 97 == 0 {
            "\"\"".to_string()
        } else if id % 89 == 0 {
            String::new()
        } else {
            format!("{} {}", rng.pick(FIRST), rng.pick(LAST))
        };
        let city = if id % 31 == 0 { "" } else { rng.pick(CITY) };
        let cents = rng.below(110_000) as i64 - 10_000;
        let amount = if id % 50 == 0 {
            String::new()
        } else {
            let sign = if cents < 0 { "-" } else { "" };
            format!("{sign}{}.{:02}", cents.abs() / 100, cents.abs() % 100)
        };
        let (y, m, d) = crate::rng::civil_from_days(start + rng.below(1095) as i64);
        let joined = if id % 40 == 0 {
            String::new()
        } else {
            format!("{y:04}-{m:02}-{d:02}")
        };
        let active = if id % 25 == 0 {
            ""
        } else if rng.chance(40) {
            "true"
        } else {
            "false"
        };
        out.push_str(&format!("{id},{name},{city},{amount},{joined},{active}\n"));
    }
    out
}

/// Parquet with many DuckDB types, nulls included.
fn write_parquet_types(path: &Path) -> io::Result<()> {
    std::fs::create_dir_all(path.parent().unwrap())?;
    let conn = duckdb::Connection::open_in_memory().map_err(io::Error::other)?;
    let sql = format!(
        "COPY (SELECT * FROM (VALUES
            (1, true, 1::TINYINT, 100::SMALLINT, 100000::INTEGER, 10000000000::BIGINT, 1.5::FLOAT,
             2.25::DOUBLE, 12.34::DECIMAL(10,2), 'text', DATE '2024-01-31',
             TIMESTAMP '2024-01-31 12:34:56', TIME '12:34:56', '\\xAA\\xBB'::BLOB,
             [1, 2, 3], {{'a': 1, 'b': 'x'}}, MAP {{'k': 1}}, '7d1c2a4b-9f3e-4c5d-8a6b-1e2f3a4b5c6d'::UUID),
            (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL),
            (3, false, -1, -100, -100000, -10000000000, -0.5, -1e300, -0.01, 'ünïcødé ✓',
             DATE '1970-01-01', TIMESTAMP '1970-01-01 00:00:00', TIME '00:00:00', ''::BLOB,
             [], {{'a': NULL, 'b': NULL}}, MAP {{}}, NULL)
          ) t(id, c_bool, c_tinyint, c_smallint, c_int, c_bigint, c_float, c_double, c_decimal,
              c_varchar, c_date, c_timestamp, c_time, c_blob, c_list, c_struct, c_map, c_uuid))
         TO '{}' (FORMAT parquet)",
        path.display().to_string().replace('\'', "''")
    );
    conn.execute_batch(&sql).map_err(io::Error::other)
}

/// Two sheets with dates, a formula (with cached value) and empty rows.
fn write_multi_sheet_xlsx(path: &Path) -> io::Result<()> {
    use rust_xlsxwriter::{ExcelDateTime, Format, Formula};
    std::fs::create_dir_all(path.parent().unwrap())?;
    let x = |e: rust_xlsxwriter::XlsxError| io::Error::other(e);
    let mut wb = crate::fixed_workbook()?;
    let date = Format::new().set_num_format("yyyy-mm-dd");

    let s = wb.add_worksheet().set_name("Orders").map_err(x)?;
    for (c, h) in ["id", "customer", "date", "qty", "price", "total"]
        .iter()
        .enumerate()
    {
        s.write_string(0, c as u16, *h).map_err(x)?;
    }
    let rows = [
        (1, "Alice", "2024-01-15", 2, 9.5),
        (2, "Bob", "2024-02-29", 1, 100.0),
        (3, "Carol", "2023-12-31", 5, 1.25),
    ];
    for (i, (id, cust, d, qty, price)) in rows.iter().enumerate() {
        let r = (i + 1) as u32;
        s.write_number(r, 0, f64::from(*id)).map_err(x)?;
        s.write_string(r, 1, *cust).map_err(x)?;
        let dt = ExcelDateTime::parse_from_str(d).map_err(x)?;
        s.write_datetime_with_format(r, 2, &dt, &date).map_err(x)?;
        s.write_number(r, 3, f64::from(*qty)).map_err(x)?;
        s.write_number(r, 4, *price).map_err(x)?;
        // Cached result so readers that don't evaluate formulas see the value.
        let total = f64::from(*qty) * price;
        s.write_formula(
            r,
            5,
            Formula::new(format!("=D{}*E{}", r + 1, r + 1)).set_result(total.to_string()),
        )
        .map_err(x)?;
    }
    // Row 5 left empty on purpose, then one more data row.
    s.write_number(5, 0, 4.0).map_err(x)?;
    s.write_string(5, 1, "Dave").map_err(x)?;

    let s = wb.add_worksheet().set_name("Notes").map_err(x)?;
    s.write_string(0, 0, "Title row, not a header").map_err(x)?;
    s.write_string(2, 0, "key").map_err(x)?;
    s.write_string(2, 1, "value").map_err(x)?;
    s.write_string(3, 0, "a").map_err(x)?;
    s.write_boolean(3, 1, true).map_err(x)?;

    wb.save(path).map_err(x)
}
