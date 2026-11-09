//! Never losing work: the session (open tabs, their filters, layouts and
//! recipes) saved as the user works and brought back at the next start;
//! a marker telling a crash from a normal exit; a local crash log; and the
//! diagnostics the user can copy into a bug report. Nothing is sent.

use std::io::Write;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::Serialize;

use crate::error::{AppError, Result};
use crate::workspace::{self, WorkspaceFile};

/// The session, in the workspace format (written atomically).
const SESSION_FILE: &str = "session.dataliq";
/// Present while the app runs; left behind by a crash.
const RUNNING_FILE: &str = "running";
/// Panics and UI errors, newest last.
pub const CRASH_LOG: &str = "crash.log";
/// The crash log is cut to its last half past this size.
const CRASH_LOG_MAX: u64 = 512 << 10;

/// What the UI gets back at startup.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStart {
    /// The tabs open when the app last ran (none, or none saved).
    pub workspace: Option<WorkspaceFile>,
    /// The app didn't close normally last time (it crashed or was killed).
    pub unclean: bool,
}

pub struct Session {
    dir: PathBuf,
    log_dir: PathBuf,
    /// Taken once by the UI (a reload of the window gets nothing).
    start: Mutex<Option<SessionStart>>,
}

impl Session {
    /// Starts a session in `dir` (the app's data folder): reads what the
    /// last one left and marks this one as running.
    pub fn begin(dir: &Path, log_dir: &Path) -> Session {
        let _ = std::fs::create_dir_all(dir);
        let running = dir.join(RUNNING_FILE);
        let unclean = running.exists();
        if unclean {
            tracing::warn!("the previous session did not end normally");
        }
        let _ = std::fs::write(
            &running,
            format!("{} {}", std::process::id(), crate::cache::now_ms()),
        );
        let path = dir.join(SESSION_FILE);
        let workspace = if path.is_file() {
            match workspace::load(&path) {
                Ok(ws) if !ws.tabs.is_empty() => Some(ws),
                Ok(_) => None,
                Err(e) => {
                    tracing::warn!("could not read the last session: {e}");
                    None
                }
            }
        } else {
            None
        };
        Session {
            dir: dir.to_path_buf(),
            log_dir: log_dir.to_path_buf(),
            start: Mutex::new(Some(SessionStart { workspace, unclean })),
        }
    }

    /// What the last session left (once).
    pub fn take_start(&self) -> SessionStart {
        self.start.lock().take().unwrap_or(SessionStart {
            workspace: None,
            unclean: false,
        })
    }

    /// Saves the open tabs (atomically: a crash mid-write keeps the last one).
    pub fn save(&self, ws: &WorkspaceFile) -> Result<()> {
        workspace::save(&self.dir.join(SESSION_FILE), ws)
    }

    /// Forgets the session (the user closed every tab, or chose not to restore).
    pub fn clear(&self) {
        let _ = std::fs::remove_file(self.dir.join(SESSION_FILE));
    }

    /// A normal exit: the next start is not a crash.
    pub fn end(&self) {
        let _ = std::fs::remove_file(self.dir.join(RUNNING_FILE));
    }

    pub fn crash_log(&self) -> PathBuf {
        self.log_dir.join(CRASH_LOG)
    }
}

/// Appends an entry to the crash log in `log_dir`, keeping it small.
pub fn log_crash(log_dir: &Path, what: &str, detail: &str) {
    let path = log_dir.join(CRASH_LOG);
    let _ = std::fs::create_dir_all(log_dir);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > CRASH_LOG_MAX) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let keep = &text[text.len() / 2..];
            let start = keep.find("\n=== ").map(|i| i + 1).unwrap_or(0);
            let _ = std::fs::write(&path, &keep[start..]);
        }
    }
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let _ = writeln!(
        f,
        "=== {} · {what} · DataLiq {} ({} {})\n{}\n",
        timestamp(),
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        detail.trim_end()
    );
}

/// Writes every panic to the crash log (and the normal log), then lets the
/// default hook print it.
pub fn install_panic_hook(log_dir: PathBuf) {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let detail = format!(
            "thread '{}' panicked: {info}\n{}",
            thread.name().unwrap_or("unnamed"),
            std::backtrace::Backtrace::force_capture()
        );
        tracing::error!("{detail}");
        log_crash(&log_dir, "panic", &detail);
        default(info);
    }));
}

/// UTC time as `2026-11-09 14:03:07Z`.
fn timestamp() -> String {
    let secs = (crate::cache::now_ms() / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 to (year, month, day) (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The last `max_lines` lines of a text file ("" when missing).
fn tail(path: &Path, max_lines: usize) -> String {
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(max_lines)..].join("\n")
}

/// The newest file of the rolling app log (`dataliq.log.YYYY-MM-DD`).
fn newest_log(log_dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(log_dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("dataliq.log"))
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok())
        .map(|e| e.path())
}

/// What the app knows about itself, for a bug report: versions, system,
/// settings, the cache, the last crashes and the end of the log. File
/// paths in it are the user's own; nothing is sent anywhere.
pub struct DiagnosticsInput<'a> {
    pub engine_version: String,
    pub settings: &'a crate::settings::Settings,
    pub memory: Option<crate::engine::MemoryUsage>,
    pub cache: crate::cache::CacheInfo,
    pub log_dir: &'a Path,
}

pub fn diagnostics(input: &DiagnosticsInput<'_>) -> String {
    let mut out = String::new();
    let mut line = |s: String| {
        out.push_str(&s);
        out.push('\n');
    };
    line(format!("DataLiq {}", env!("CARGO_PKG_VERSION")));
    line(format!(
        "System: {} {} ({} {})",
        sysinfo::System::name().unwrap_or_default(),
        sysinfo::System::os_version().unwrap_or_default(),
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    let sys = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing().with_memory(sysinfo::MemoryRefreshKind::everything()),
    );
    line(format!(
        "Memory: {} MB total, {} MB free; cores: {}",
        sys.total_memory() >> 20,
        sys.available_memory() >> 20,
        std::thread::available_parallelism().map_or(0, |n| n.get())
    ));
    line(format!("DuckDB: {}", input.engine_version));
    if let Some(m) = &input.memory {
        line(format!(
            "DuckDB memory: {} MB used, limit {}, {} MB spilled",
            m.used_bytes >> 20,
            m.limit_bytes
                .map_or_else(|| "none".to_string(), |l| format!("{} MB", l >> 20)),
            m.spilled_bytes >> 20
        ));
    }
    line(format!(
        "Settings: {}",
        serde_json::to_string(input.settings).unwrap_or_default()
    ));
    let c = &input.cache;
    line(format!(
        "Cache: {} ({}), {} entries, {} MB of {} MB",
        c.dir.display(),
        if c.enabled { "on" } else { "off" },
        c.entries,
        c.used_bytes >> 20,
        c.max_bytes >> 20
    ));
    let crashes = tail(&input.log_dir.join(CRASH_LOG), 80);
    line(String::new());
    line("--- Last crashes and errors (crash.log) ---".into());
    line(if crashes.is_empty() {
        "(none)".into()
    } else {
        crashes
    });
    if let Some(log) = newest_log(input.log_dir) {
        line(String::new());
        line(format!(
            "--- End of the log ({}) ---",
            log.file_name().unwrap_or_default().to_string_lossy()
        ));
        line(tail(&log, 60));
    }
    out
}

/// A UI error to keep in the crash log (from the window's error handlers).
pub fn ui_error(log_dir: &Path, message: &str, stack: Option<&str>) -> Result<()> {
    if message.trim().is_empty() {
        return Err(AppError::Query("Nothing to report.".into()));
    }
    // Keep a runaway loop of errors from filling the disk.
    let detail = format!(
        "{}\n{}",
        message.chars().take(2000).collect::<String>(),
        stack
            .unwrap_or_default()
            .chars()
            .take(8000)
            .collect::<String>()
    );
    tracing::error!("UI error: {message}");
    log_crash(log_dir, "UI error", &detail);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(paths: &[&str]) -> WorkspaceFile {
        serde_json::from_value(serde_json::json!({
            "tabs": paths.iter().map(|p| serde_json::json!({ "path": p })).collect::<Vec<_>>(),
            "active": 0,
        }))
        .unwrap()
    }

    #[test]
    fn a_crash_is_told_from_a_normal_exit_and_the_tabs_come_back() {
        let tmp = tempfile::tempdir().unwrap();
        let (dir, logs) = (tmp.path().join("data"), tmp.path().join("logs"));
        let s = Session::begin(&dir, &logs);
        let first = s.take_start();
        assert!(!first.unclean && first.workspace.is_none(), "first run");
        s.save(&ws(&["/data/a.csv", "/data/b.parquet"])).unwrap();
        // No `end`: the process died.
        let s = Session::begin(&dir, &logs);
        let start = s.take_start();
        assert!(start.unclean);
        let tabs: Vec<_> = start
            .workspace
            .unwrap()
            .tabs
            .into_iter()
            .map(|t| t.path)
            .collect();
        assert_eq!(tabs, ["/data/a.csv", "/data/b.parquet"]);
        assert!(s.take_start().workspace.is_none(), "taken once");
        s.end();
        let s = Session::begin(&dir, &logs);
        let start = s.take_start();
        assert!(!start.unclean, "a normal exit");
        assert!(
            start.workspace.is_some(),
            "the tabs come back after a restart too"
        );
        s.clear();
        s.end();
        assert!(Session::begin(&dir, &logs).take_start().workspace.is_none());
    }

    #[test]
    fn the_crash_log_keeps_entries_and_stays_small() {
        let tmp = tempfile::tempdir().unwrap();
        log_crash(tmp.path(), "panic", "thread 'main' panicked at src/x.rs:1");
        ui_error(
            tmp.path(),
            "TypeError: x is undefined",
            Some("at f (app.js:1)"),
        )
        .unwrap();
        let text = std::fs::read_to_string(tmp.path().join(CRASH_LOG)).unwrap();
        assert!(text.contains("· panic · DataLiq"));
        assert!(text.contains("TypeError: x is undefined\nat f (app.js:1)"));
        assert!(ui_error(tmp.path(), " ", None).is_err());
        for _ in 0..400 {
            log_crash(tmp.path(), "panic", &"x".repeat(2000));
        }
        let len = std::fs::metadata(tmp.path().join(CRASH_LOG)).unwrap().len();
        assert!(len < CRASH_LOG_MAX + 4096, "{len}");
        let text = std::fs::read_to_string(tmp.path().join(CRASH_LOG)).unwrap();
        assert!(text.starts_with("=== "), "cut at an entry");
    }

    #[test]
    fn dates_are_civil() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_401), (2025, 11, 9));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(timestamp().len(), "2026-11-09 14:03:07Z".len());
    }

    #[test]
    fn diagnostics_say_what_matters_and_include_the_crashes() {
        let tmp = tempfile::tempdir().unwrap();
        log_crash(tmp.path(), "panic", "boom");
        std::fs::write(tmp.path().join("dataliq.log.2026-11-09"), "INFO started\n").unwrap();
        let text = diagnostics(&DiagnosticsInput {
            engine_version: "v1.5.0".into(),
            settings: &crate::settings::Settings::default(),
            memory: None,
            cache: crate::cache::CacheInfo {
                dir: "/cache".into(),
                enabled: true,
                max_bytes: 1 << 30,
                used_bytes: 0,
                entries: 0,
            },
            log_dir: tmp.path(),
        });
        for want in [
            "DataLiq ",
            "DuckDB: v1.5.0",
            "Cache: /cache (on)",
            "boom",
            "INFO started",
        ] {
            assert!(text.contains(want), "{want} in {text}");
        }
    }
}
