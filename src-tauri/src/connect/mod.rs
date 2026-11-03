//! Live MySQL and PostgreSQL databases, read-only. A connection is attached
//! to the engine under a name of the user's choosing (`cdr`), so the SQL
//! panel can query it (`SELECT * FROM cdr.calls`) and its tables can open
//! as tabs. DuckDB's mysql and postgres extensions do the work; they are
//! installed on first use, like httpfs.
//!
//! Credentials reach DuckDB only through a temporary secret, never spliced
//! into the ATTACH string. Saved connections keep everything but the
//! password in `db-connections.json`; the password goes to the OS keychain.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::engine::sql::{literal, quote_ident};
use crate::engine::{Engine, Param, RequestKey};
use crate::error::{AppError, Result};

pub const CONNECTIONS_FILE: &str = "db-connections.json";
const KEYCHAIN_SERVICE: &str = "DataLiq database";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Mysql,
    Postgres,
}

impl Driver {
    fn extension(self) -> &'static str {
        match self {
            Driver::Mysql => "mysql",
            Driver::Postgres => "postgres",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Driver::Mysql => "MySQL",
            Driver::Postgres => "PostgreSQL",
        }
    }
}

/// A database server to connect to; never holds the password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnection {
    /// The name its tables go by in SQL (`cdr` in `cdr.calls`).
    pub name: String,
    pub driver: Driver,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub connection: DbConnection,
    /// Unset: the one saved in the keychain (if any).
    pub password: Option<String>,
    /// Save the connection (and the password, in the keychain).
    #[serde(default)]
    pub remember: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTable {
    pub schema: String,
    pub name: String,
    /// `BASE TABLE` or `VIEW`.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub name: String,
    pub tables: Vec<LiveTable>,
}

/// A saved connection, as the UI lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    #[serde(flatten)]
    pub connection: DbConnection,
    /// A password is in the keychain.
    pub has_password: bool,
    /// Attached right now.
    pub connected: bool,
}

/// A name usable in SQL without quotes, that isn't one of DuckDB's own.
pub fn check_name(name: &str) -> Result<()> {
    let ok = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.len() <= 63;
    let reserved = ["memory", "system", "temp", "main", "current_view"];
    if !ok || reserved.contains(&name.to_ascii_lowercase().as_str()) {
        return Err(AppError::Query(format!(
            "\"{name}\" can't be the connection's name: use letters, digits and _ \
             (starting with a letter), e.g. cdr or sales_db."
        )));
    }
    Ok(())
}

fn secret_name(name: &str) -> String {
    quote_ident(&format!("dataliq_db_{name}"))
}

/// `CREATE OR REPLACE TEMPORARY SECRET …` holding the server and login.
pub fn secret_sql(c: &DbConnection, password: &str) -> String {
    let text = |v: &str| literal(&Param::Text(v.to_string()));
    format!(
        "CREATE OR REPLACE TEMPORARY SECRET {} (TYPE {}, HOST {}, PORT {}, DATABASE {}, USER {}, PASSWORD {})",
        secret_name(&c.name),
        c.driver.extension(),
        text(c.host.trim()),
        c.port,
        text(c.database.trim()),
        text(c.user.trim()),
        text(password)
    )
}

/// `ATTACH '' AS name (TYPE …, SECRET …, READ_ONLY)`.
pub fn attach_sql(c: &DbConnection) -> String {
    format!(
        "ATTACH '' AS {} (TYPE {}, SECRET {}, READ_ONLY)",
        quote_ident(&c.name),
        c.driver.extension(),
        secret_name(&c.name)
    )
}

/// The first line of a driver error, without DuckDB's prefix.
fn friendly(c: &DbConnection, e: &AppError) -> AppError {
    let text = e.to_string();
    let line = text.lines().next().unwrap_or_default();
    let line = line
        .split_once("Error: ")
        .map(|(_, rest)| rest)
        .unwrap_or(line);
    AppError::Query(format!(
        "Couldn't connect to {} at {}:{}: {line}",
        c.driver.label(),
        c.host,
        c.port
    ))
}

/// Saved connections (`db-connections.json` in the app's data folder) and
/// which are attached now.
pub struct Connections {
    dir: PathBuf,
    attached: Mutex<Vec<String>>,
}

impl Connections {
    pub fn new(dir: impl Into<PathBuf>) -> Connections {
        Connections {
            dir: dir.into(),
            attached: Mutex::new(Vec::new()),
        }
    }

    fn path(&self) -> PathBuf {
        self.dir.join(CONNECTIONS_FILE)
    }

    fn read(&self) -> Vec<DbConnection> {
        std::fs::read_to_string(self.path())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn write(&self, list: &[DbConnection]) -> Result<()> {
        write_json(&self.path(), list)
    }

    pub fn list(&self) -> Vec<SavedConnection> {
        let attached = self.attached.lock().clone();
        self.read()
            .into_iter()
            .map(|c| SavedConnection {
                has_password: keychain_password(&c).ok().flatten().is_some(),
                connected: attached.contains(&c.name),
                connection: c,
            })
            .collect()
    }

    fn save(&self, c: &DbConnection, password: Option<&str>) -> Result<()> {
        let mut list = self.read();
        list.retain(|x| x.name != c.name);
        list.push(c.clone());
        list.sort_by(|a, b| a.name.cmp(&b.name));
        self.write(&list)?;
        if let Some(p) = password {
            if let Err(e) = keychain_entry(c).and_then(|k| {
                k.set_password(p)
                    .map_err(|e| AppError::Query(e.to_string()))
            }) {
                tracing::warn!("password not kept in the keychain: {e}");
            }
        }
        Ok(())
    }

    /// Forgets a saved connection and its password.
    pub fn forget(&self, name: &str) -> Result<()> {
        let mut list = self.read();
        if let Some(c) = list.iter().find(|c| c.name == name) {
            if let Ok(k) = keychain_entry(c) {
                let _ = k.delete_credential();
            }
        }
        list.retain(|c| c.name != name);
        self.write(&list)
    }
}

fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| AppError::Internal(format!("serialize connections: {e}")))?;
    std::fs::write(&tmp, text + "\n")?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn keychain_entry(c: &DbConnection) -> Result<keyring::Entry> {
    let user = format!(
        "{}://{}@{}:{}/{}",
        c.driver.extension(),
        c.user,
        c.host,
        c.port,
        c.database
    );
    keyring::Entry::new(KEYCHAIN_SERVICE, &user).map_err(|e| AppError::Query(e.to_string()))
}

fn keychain_password(c: &DbConnection) -> Result<Option<String>> {
    match keychain_entry(c)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Query(e.to_string())),
    }
}

impl Engine {
    /// Attaches a database read-only under `c.name` (replacing an earlier
    /// connection of that name) and lists its tables and views.
    pub fn attach_live(&self, c: &DbConnection, password: &str) -> Result<Connected> {
        check_name(&c.name)?;
        if c.host.trim().is_empty() || c.user.trim().is_empty() {
            return Err(AppError::Query("Fill in the server and the user.".into()));
        }
        self.load_extension(
            c.driver.extension(),
            &format!("Connecting to {}", c.driver.label()),
        )?;
        self.execute_batch(&format!(
            "DETACH DATABASE IF EXISTS {}",
            quote_ident(&c.name)
        ))?;
        self.execute_batch(&secret_sql(c, password))?;
        if let Err(e) = self.execute_batch(&attach_sql(c)) {
            let _ = self.execute_batch(&format!("DROP SECRET IF EXISTS {}", secret_name(&c.name)));
            return Err(friendly(c, &e));
        }
        let tables = self.live_tables(&c.name)?;
        Ok(Connected {
            name: c.name.clone(),
            tables,
        })
    }

    /// The tables and views of an attached database, by schema and name,
    /// without the server's own catalogs (information_schema, mysql, …).
    pub fn live_tables(&self, name: &str) -> Result<Vec<LiveTable>> {
        let out = self.query(
            "SELECT table_schema, table_name, table_type FROM information_schema.tables \
             WHERE table_catalog = ? AND lower(table_schema) NOT IN \
             ('information_schema', 'performance_schema', 'mysql', 'sys', 'pg_catalog', 'pg_toast') \
             ORDER BY 1, 2",
            &[Param::Text(name.to_string())],
            100_000,
            &RequestKey::default(),
        )?;
        use arrow::array::{Array, AsArray};
        let mut tables = Vec::new();
        for b in &out.batches {
            let text = |i: usize| -> Vec<String> {
                let col = arrow::compute::cast(b.column(i), &arrow::datatypes::DataType::Utf8)
                    .expect("text column");
                let a = col.as_string::<i32>();
                (0..a.len())
                    .map(|r| {
                        if a.is_null(r) {
                            String::new()
                        } else {
                            a.value(r).to_string()
                        }
                    })
                    .collect()
            };
            let (s, n, k) = (text(0), text(1), text(2));
            for r in 0..b.num_rows() {
                tables.push(LiveTable {
                    schema: s[r].clone(),
                    name: n[r].clone(),
                    kind: k[r].clone(),
                });
            }
        }
        Ok(tables)
    }

    /// Detaches a database and drops its secret.
    pub fn detach_live(&self, name: &str) -> Result<()> {
        check_name(name)?;
        self.execute_batch(&format!(
            "DETACH DATABASE IF EXISTS {}; DROP SECRET IF EXISTS {};",
            quote_ident(name),
            secret_name(name)
        ))
    }
}

/// Connects (password from the request or the keychain) and, when asked,
/// saves the connection.
pub fn connect(engine: &Engine, saved: &Connections, req: &ConnectRequest) -> Result<Connected> {
    let c = &req.connection;
    let password = match &req.password {
        Some(p) => p.clone(),
        None => keychain_password(c).ok().flatten().unwrap_or_default(),
    };
    let out = engine.attach_live(c, &password)?;
    {
        let mut attached = saved.attached.lock();
        attached.retain(|n| n != &c.name);
        attached.push(c.name.clone());
    }
    if req.remember {
        saved.save(c, req.password.as_deref())?;
    }
    Ok(out)
}

pub fn disconnect(engine: &Engine, saved: &Connections, name: &str) -> Result<()> {
    engine.detach_live(name)?;
    saved.attached.lock().retain(|n| n != name);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> DbConnection {
        DbConnection {
            name: "cdr".into(),
            driver: Driver::Mysql,
            host: " db.local ".into(),
            port: 3306,
            database: "calls".into(),
            user: "o'brien".into(),
        }
    }

    #[test]
    fn credentials_go_into_a_secret_as_literals() {
        assert_eq!(
            secret_sql(&conn(), "p'w"),
            "CREATE OR REPLACE TEMPORARY SECRET \"dataliq_db_cdr\" (TYPE mysql, HOST 'db.local', \
             PORT 3306, DATABASE 'calls', USER 'o''brien', PASSWORD 'p''w')"
        );
        assert_eq!(
            attach_sql(&conn()),
            "ATTACH '' AS \"cdr\" (TYPE mysql, SECRET \"dataliq_db_cdr\", READ_ONLY)"
        );
    }

    #[test]
    fn names_are_plain_identifiers() {
        for ok in ["cdr", "sales_db", "_x1"] {
            assert!(check_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", "1db", "a-b", "a b", "memory", "Main", "x\"y"] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn saved_connections_keep_no_password_in_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let saved = Connections::new(dir.path());
        saved.save(&conn(), None).unwrap();
        let text = std::fs::read_to_string(dir.path().join(CONNECTIONS_FILE)).unwrap();
        assert!(text.contains("\"name\": \"cdr\"") && !text.to_lowercase().contains("password"));
        assert_eq!(saved.list().len(), 1);
        saved.forget("cdr").unwrap();
        assert!(saved.list().is_empty());
    }
}
