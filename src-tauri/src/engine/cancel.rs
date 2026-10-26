//! Tracks running requests so they can be interrupted.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use duckdb::InterruptHandle;
use parking_lot::Mutex;

use super::RequestKey;

struct Entry {
    group: Option<String>,
    handle: Arc<InterruptHandle>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct RequestRegistry {
    running: Mutex<HashMap<String, Entry>>,
    next_anon: AtomicU64,
}

/// Unregisters the request when dropped.
pub struct RequestGuard<'a> {
    registry: &'a RequestRegistry,
    id: String,
    cancelled: Arc<AtomicBool>,
}

impl RequestGuard<'_> {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        self.registry.running.lock().remove(&self.id);
    }
}

impl RequestRegistry {
    /// Registers a request. Any running request in the same group is cancelled:
    /// a newer request for the same view always wins.
    pub fn register(&self, key: &RequestKey, handle: Arc<InterruptHandle>) -> RequestGuard<'_> {
        let id = key
            .id
            .clone()
            .unwrap_or_else(|| format!("anon-{}", self.next_anon.fetch_add(1, Ordering::Relaxed)));
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut running = self.running.lock();
        if let Some(group) = &key.group {
            for entry in running.values() {
                if entry.group.as_deref() == Some(group) {
                    entry.cancelled.store(true, Ordering::SeqCst);
                    entry.handle.interrupt();
                }
            }
        }
        running.insert(
            id.clone(),
            Entry {
                group: key.group.clone(),
                handle,
                cancelled: cancelled.clone(),
            },
        );
        RequestGuard {
            registry: self,
            id,
            cancelled,
        }
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.running.lock().contains_key(id)
    }

    pub fn cancel(&self, id: &str) -> bool {
        match self.running.lock().get(id) {
            Some(entry) => {
                // The flag covers the window before DuckDB starts executing,
                // where an interrupt alone could be missed.
                entry.cancelled.store(true, Ordering::SeqCst);
                entry.handle.interrupt();
                true
            }
            None => false,
        }
    }
}
