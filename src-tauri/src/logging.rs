//! Logging: `tracing` to stderr and a daily-rolling file in the app log dir.

use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt;
use tracing_subscriber::prelude::*;

/// Keeps the background log writer alive; dropping it flushes the file.
pub struct LogGuard(#[allow(dead_code)] Option<WorkerGuard>);

pub fn init(log_dir: &Path) -> LogGuard {
    let filter = EnvFilter::try_from_env("BIGVIEW_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let (file_layer, guard) = match std::fs::create_dir_all(log_dir) {
        Ok(()) => {
            let appender = tracing_appender::rolling::daily(log_dir, "bigview.log");
            let (writer, guard) = tracing_appender::non_blocking(appender);
            (
                Some(fmt::layer().with_ansi(false).with_writer(writer)),
                Some(guard),
            )
        }
        Err(_) => (None, None),
    };
    // `try_init` so tests or a second call don't panic.
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(std::io::stderr))
        .with(file_layer)
        .try_init();
    LogGuard(guard)
}
