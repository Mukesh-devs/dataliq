//! Row generators for realistic sales and log data.

use std::io::{self, Write};

use crate::rng::{Rng, civil_from_days};

const COUNTRIES: &[&str] = &[
    "United States",
    "Germany",
    "France",
    "India",
    "Japan",
    "Brazil",
    "Canada",
    "United Kingdom",
    "Australia",
    "Spain",
    "Italy",
    "Mexico",
    "Netherlands",
    "Sweden",
    "South Korea",
    "Poland",
    "Türkiye",
    "Côte d'Ivoire",
    "Norway",
    "Chile",
];
const PRODUCTS: &[(&str, &str)] = &[
    ("Widget", "Hardware"),
    ("Widget, large", "Hardware"),
    ("Gadget", "Hardware"),
    ("Sprocket", "Hardware"),
    ("Cable 2m", "Accessories"),
    ("Charger", "Accessories"),
    ("Case \"Pro\"", "Accessories"),
    ("Keyboard", "Peripherals"),
    ("Mouse", "Peripherals"),
    ("Monitor 27\"", "Peripherals"),
    ("Laptop", "Computers"),
    ("Desktop", "Computers"),
    ("Tablet", "Computers"),
    ("Support plan", "Services"),
    ("Installation", "Services"),
    ("Training", "Services"),
    ("Notebook", "Office"),
    ("Pen set", "Office"),
    ("Desk lamp", "Office"),
    ("Chair", "Furniture"),
];
const NOTES: &[&str] = &[
    "gift wrap",
    "deliver after 5pm",
    "customer said \"urgent\"",
    "call before delivery",
    "leave at door, back porch",
    "fragile",
    "multi-line\nnote",
    "repeat customer",
];

pub const SALES_HEADER: &[&str] = &[
    "order_id",
    "order_date",
    "order_ts",
    "customer",
    "country",
    "product",
    "category",
    "quantity",
    "unit_price",
    "discount",
    "total",
    "returned",
    "note",
];

/// One generated sales row.
pub struct Sale {
    pub order_id: u64,
    pub days: i64,
    pub seconds: u32,
    pub customer: u32,
    pub country: &'static str,
    pub product: &'static str,
    pub category: &'static str,
    pub quantity: u32,
    /// Cents.
    pub unit_price: u64,
    /// Percent, `None` = missing.
    pub discount: Option<u32>,
    /// Cents.
    pub total: u64,
    pub returned: bool,
    pub note: Option<&'static str>,
}

/// 2020-01-01 as days since the Unix epoch.
const START_DAY: i64 = 18_262;

pub fn sale(rng: &mut Rng, index: u64) -> Sale {
    let (product, category) = PRODUCTS[rng.below(PRODUCTS.len() as u64) as usize];
    let quantity = 1 + rng.below(20) as u32;
    let unit_price = 99 + rng.below(250_000);
    let discount = if rng.chance(5) {
        None
    } else {
        Some(rng.below(31) as u32)
    };
    let gross = unit_price * u64::from(quantity);
    let total = gross * u64::from(100 - discount.unwrap_or(0)) / 100;
    Sale {
        order_id: index + 1,
        days: START_DAY + rng.below(1826) as i64,
        seconds: rng.below(86_400) as u32,
        customer: rng.below(100_000) as u32,
        country: rng.pick(COUNTRIES),
        product,
        category,
        quantity,
        unit_price,
        discount,
        total,
        returned: rng.chance(3),
        note: if rng.chance(25) {
            Some(rng.pick(NOTES))
        } else {
            None
        },
    }
}

pub fn date_string(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn time_string(seconds: u32) -> String {
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    )
}

fn cents(v: u64) -> String {
    format!("{}.{:02}", v / 100, v % 100)
}

/// Writes one delimited field, quoting it when needed (RFC 4180).
fn field(out: &mut impl Write, value: &str, delim: u8) -> io::Result<()> {
    if value
        .bytes()
        .any(|b| b == delim || b == b'"' || b == b'\n' || b == b'\r')
    {
        out.write_all(b"\"")?;
        out.write_all(value.replace('"', "\"\"").as_bytes())?;
        out.write_all(b"\"")
    } else {
        out.write_all(value.as_bytes())
    }
}

pub fn write_sales_header(out: &mut impl Write, delim: u8) -> io::Result<()> {
    for (i, h) in SALES_HEADER.iter().enumerate() {
        if i > 0 {
            out.write_all(&[delim])?;
        }
        out.write_all(h.as_bytes())?;
    }
    out.write_all(b"\n")
}

pub fn write_sale_csv(out: &mut impl Write, s: &Sale, delim: u8) -> io::Result<()> {
    let date = date_string(s.days);
    let fields: [String; 13] = [
        s.order_id.to_string(),
        date.clone(),
        format!("{date} {}", time_string(s.seconds)),
        format!("Customer {:05}", s.customer),
        s.country.to_string(),
        s.product.to_string(),
        s.category.to_string(),
        s.quantity.to_string(),
        cents(s.unit_price),
        s.discount.map(|d| format!("0.{d:02}")).unwrap_or_default(),
        cents(s.total),
        s.returned.to_string(),
        s.note.unwrap_or("").to_string(),
    ];
    for (i, f) in fields.iter().enumerate() {
        if i > 0 {
            out.write_all(&[delim])?;
        }
        field(out, f, delim)?;
    }
    out.write_all(b"\n")
}

const LEVELS: &[&str] = &["INFO", "INFO", "INFO", "INFO", "DEBUG", "WARN", "ERROR"];
const SERVICES: &[&str] = &["api", "auth", "billing", "search", "worker"];
const METHODS: &[&str] = &["GET", "GET", "GET", "POST", "PUT", "DELETE"];
const PATHS: &[&str] = &[
    "/v1/orders",
    "/v1/users",
    "/v1/search",
    "/v1/invoices",
    "/healthz",
];
const TAGS: &[&str] = &["canary", "eu", "us", "beta", "mobile", "web"];

/// Writes one NDJSON log line with nested objects and arrays.
pub fn write_log_ndjson(out: &mut impl Write, rng: &mut Rng, index: u64) -> io::Result<()> {
    // Logs advance ~1 s per line from 2024-01-01T00:00:00Z.
    let t = 1_704_067_200 + index + rng.below(3);
    let days = (t / 86_400) as i64;
    let level = rng.pick(LEVELS);
    let status = match level {
        "ERROR" => 500 + rng.below(4) as u32,
        "WARN" => 400 + rng.below(30) as u32,
        _ => 200 + rng.below(5) as u32,
    };
    let user = if rng.chance(20) {
        "null".to_string()
    } else {
        rng.below(50_000).to_string()
    };
    let ntags = rng.below(3) as usize;
    let tags: Vec<String> = (0..ntags)
        .map(|_| format!("\"{}\"", rng.pick(TAGS)))
        .collect();
    writeln!(
        out,
        r#"{{"id":{},"ts":"{}T{}.{:03}Z","level":"{}","service":"{}","latency_ms":{},"user_id":{},"http":{{"method":"{}","path":"{}/{}","status":{},"bytes":{}}},"tags":[{}]}}"#,
        index + 1,
        date_string(days),
        time_string((t % 86_400) as u32),
        rng.below(1000),
        level,
        rng.pick(SERVICES),
        rng.below(2000),
        user,
        rng.pick(METHODS),
        rng.pick(PATHS),
        rng.below(100_000),
        status,
        rng.below(1 << 20),
        tags.join(",")
    )
}
