//! Files on the web (`https://…`) and in S3-compatible storage (`s3://…`),
//! read by DuckDB's httpfs extension.
//!
//! The app is offline by default: extensions are never downloaded on their
//! own. httpfs is installed (once, into the app's cache folder) and loaded
//! only when the user opens a URL. S3 settings live in the OS keychain; the
//! secret key never touches a file. They become a temporary DuckDB secret
//! for this session.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::engine::Engine;
use crate::engine::Param;
use crate::engine::sql::literal;
use crate::error::{AppError, Result};

/// The keychain entry for the S3 settings.
const KEYCHAIN_SERVICE: &str = "BigView";
const KEYCHAIN_USER: &str = "s3";
/// The DuckDB secret made from them.
const SECRET: &str = "bigview_s3";

/// A path that is a URL DuckDB can read: `http(s)://` or `s3://`.
pub fn is_url(path: &Path) -> bool {
    let s = path.to_string_lossy();
    let lower = s.to_ascii_lowercase();
    ["http://", "https://", "s3://"]
        .iter()
        .any(|p| lower.starts_with(p))
}

/// The part of a URL that names the file (no query or fragment), for
/// telling its format from its extension.
pub fn url_file_part(url: &str) -> &str {
    let end = url.find(['?', '#']).unwrap_or(url.len());
    &url[..end]
}

/// The last part of a URL's path, e.g. `sales.csv.gz`.
pub fn url_name(url: &str) -> String {
    let part = url_file_part(url).trim_end_matches('/');
    part.rsplit('/').next().unwrap_or(part).to_string()
}

/// Where and how to reach S3-compatible storage.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct S3Settings {
    pub key_id: String,
    pub secret: String,
    /// e.g. `eu-west-1`.
    pub region: Option<String>,
    /// For S3-compatible services: `minio.local:9000`, `<account>.r2.cloudflarestorage.com`.
    pub endpoint: Option<String>,
    /// `path` for most self-hosted services, `vhost` (the default) for AWS.
    pub url_style: Option<String>,
    /// Plain HTTP to the endpoint (local services).
    pub use_ssl: Option<bool>,
}

/// What the UI is shown of the stored settings: never the secret.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Summary {
    pub key_id: String,
    pub region: Option<String>,
    pub endpoint: Option<String>,
    pub url_style: Option<String>,
    pub use_ssl: Option<bool>,
}

impl From<&S3Settings> for S3Summary {
    fn from(s: &S3Settings) -> S3Summary {
        S3Summary {
            key_id: s.key_id.clone(),
            region: s.region.clone(),
            endpoint: s.endpoint.clone(),
            url_style: s.url_style.clone(),
            use_ssl: s.use_ssl,
        }
    }
}

/// `CREATE OR REPLACE TEMPORARY SECRET …` for the settings.
pub fn secret_sql(s: &S3Settings) -> String {
    let text = |v: &str| literal(&Param::Text(v.to_string()));
    let mut parts = vec![
        "TYPE s3".to_string(),
        format!("KEY_ID {}", text(&s.key_id)),
        format!("SECRET {}", text(&s.secret)),
    ];
    fn nonempty(v: &Option<String>) -> Option<&str> {
        v.as_deref().map(str::trim).filter(|v| !v.is_empty())
    }
    if let Some(r) = nonempty(&s.region) {
        parts.push(format!("REGION {}", text(r)));
    }
    if let Some(e) = nonempty(&s.endpoint) {
        // DuckDB wants the host (and port) without a scheme.
        let host = e
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/');
        parts.push(format!("ENDPOINT {}", text(host)));
    }
    if let Some(u) = nonempty(&s.url_style) {
        parts.push(format!("URL_STYLE {}", text(u)));
    }
    if let Some(ssl) = s.use_ssl {
        parts.push(format!("USE_SSL {ssl}"));
    }
    format!(
        "CREATE OR REPLACE TEMPORARY SECRET {SECRET} ({})",
        parts.join(", ")
    )
}

/// A keychain failure in words: usually no keychain service is running
/// (e.g. Linux without a Secret Service such as GNOME Keyring).
fn keychain_error(what: &str, e: keyring::Error) -> AppError {
    let detail = e.to_string();
    AppError::Query(format!(
        "Your system's keychain isn't available, so the S3 settings couldn't be {what}. \
         Public files still open. ({})",
        detail.lines().next().unwrap_or_default()
    ))
}

fn keychain() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| keychain_error("read", e))
}

/// The S3 settings stored in the OS keychain, if any.
pub fn load_s3() -> Result<Option<S3Settings>> {
    match keychain()?.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| AppError::Internal(format!("the stored S3 settings are damaged: {e}"))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(keychain_error("read", e)),
    }
}

/// Stores the S3 settings in the OS keychain (all of them in one entry).
pub fn save_s3(s: &S3Settings) -> Result<()> {
    let json = serde_json::to_string(s)
        .map_err(|e| AppError::Internal(format!("could not store the S3 settings: {e}")))?;
    keychain()?
        .set_password(&json)
        .map_err(|e| keychain_error("stored", e))
}

/// Removes the S3 settings from the OS keychain.
pub fn clear_s3() -> Result<()> {
    match keychain()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(keychain_error("removed", e)),
    }
}

impl Engine {
    /// Loads httpfs (installing it the first time) and the S3 secret from
    /// the keychain. Called when a URL is opened, never before.
    pub fn enable_remote(&self) -> Result<()> {
        if !self.load_extension("httpfs", "Opening URLs")? {
            return Ok(());
        }
        // Stored S3 settings apply from the first URL on; a broken keychain
        // only means public files.
        match load_s3() {
            Ok(Some(s)) => self.use_s3(Some(&s))?,
            Ok(None) => {}
            Err(e) => tracing::warn!("no S3 settings: {e}"),
        }
        Ok(())
    }

    /// Makes (or with `None`, drops) the session's S3 secret. Only once
    /// httpfs is loaded; before that the settings wait in the keychain.
    pub fn use_s3(&self, s: Option<&S3Settings>) -> Result<()> {
        if !self.remote_enabled() {
            return Ok(());
        }
        match s {
            Some(s) => self.execute_batch(&secret_sql(s)),
            None => self.execute_batch(&format!("DROP SECRET IF EXISTS {SECRET}")),
        }
    }

    pub fn remote_enabled(&self) -> bool {
        self.extension_loaded("httpfs")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_their_names() {
        assert!(is_url(Path::new("https://example.com/a.csv")));
        assert!(is_url(Path::new("HTTP://example.com/a.csv")));
        assert!(is_url(Path::new("s3://bucket/logs/a.parquet")));
        assert!(!is_url(Path::new("/data/https.csv")));
        assert_eq!(
            url_name("https://x.org/data/sales.csv.gz?token=1#top"),
            "sales.csv.gz"
        );
        assert_eq!(
            url_file_part("https://x.org/a.parquet?x=1"),
            "https://x.org/a.parquet"
        );
        assert_eq!(url_name("s3://bucket/"), "bucket");
    }

    #[test]
    fn s3_settings_become_a_secret() {
        let mut s = S3Settings {
            key_id: "AKIA'1".into(),
            secret: "s3cr3t".into(),
            ..S3Settings::default()
        };
        assert_eq!(
            secret_sql(&s),
            "CREATE OR REPLACE TEMPORARY SECRET bigview_s3 (TYPE s3, KEY_ID 'AKIA''1', SECRET 's3cr3t')"
        );
        s.region = Some("eu-west-1".into());
        s.endpoint = Some("http://minio.local:9000/".into());
        s.url_style = Some("path".into());
        s.use_ssl = Some(false);
        assert_eq!(
            secret_sql(&s),
            "CREATE OR REPLACE TEMPORARY SECRET bigview_s3 (TYPE s3, KEY_ID 'AKIA''1', SECRET 's3cr3t', \
             REGION 'eu-west-1', ENDPOINT 'minio.local:9000', URL_STYLE 'path', USE_SSL false)"
        );
        // The UI never sees the secret.
        let summary = serde_json::to_string(&S3Summary::from(&s)).unwrap();
        assert!(!summary.contains("s3cr3t"), "{summary}");
    }

    #[test]
    fn the_keychain_round_trips() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        // The mock keeps nothing between entries; one entry is used throughout.
        let entry = keychain().unwrap();
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
        let s = S3Settings {
            key_id: "id".into(),
            secret: "secret".into(),
            region: Some("us-east-1".into()),
            ..S3Settings::default()
        };
        entry
            .set_password(&serde_json::to_string(&s).unwrap())
            .unwrap();
        let back: S3Settings = serde_json::from_str(&entry.get_password().unwrap()).unwrap();
        assert_eq!(back, s);
    }
}
