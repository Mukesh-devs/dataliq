//! Tracks running requests so they can be interrupted.

use std::collections::{HashMap, VecDeque};
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

/// Ids replaced by a newer request, remembered per group.
const SUPERSEDED_KEPT: usize = 64;

#[derive(Default)]
struct GroupState {
    /// The newest request id of the group.
    latest: Option<String>,
    /// Older ids, most recent last.
    superseded: VecDeque<String>,
}

#[derive(Default)]
pub struct RequestRegistry {
    running: Mutex<HashMap<String, Entry>>,
    groups: Mutex<HashMap<String, GroupState>>,
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
    /// Registers a request (one statement of it: a request may run several
    /// in turn under the same id). A newer request for a group always wins:
    /// its first statement cancels whatever the group is running, and later
    /// statements of a replaced request start out cancelled instead of
    /// cancelling the newer one.
    pub fn register(&self, key: &RequestKey, handle: Arc<InterruptHandle>) -> RequestGuard<'_> {
        let id = key
            .id
            .clone()
            .unwrap_or_else(|| format!("anon-{}", self.next_anon.fetch_add(1, Ordering::Relaxed)));
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut running = self.running.lock();
        if let Some(group) = &key.group
            && self.claim_locked(group, &id, &running)
        {
            cancelled.store(true, Ordering::SeqCst);
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

    /// Makes `key` its group's newest request (cancelling what the group is
    /// running) unless a newer one replaced it. Returns true when replaced:
    /// the caller should stop. Requests without a group or id always run.
    pub fn claim(&self, key: &RequestKey) -> bool {
        match (&key.group, &key.id) {
            (Some(group), Some(id)) => {
                let running = self.running.lock();
                self.claim_locked(group, id, &running)
            }
            _ => false,
        }
    }

    fn claim_locked(&self, group: &str, id: &str, running: &HashMap<String, Entry>) -> bool {
        let mut groups = self.groups.lock();
        let state = groups.entry(group.to_string()).or_default();
        if state.superseded.iter().any(|s| s == id) {
            return true;
        }
        if state.latest.as_deref() != Some(id) {
            if let Some(previous) = state.latest.replace(id.to_string()) {
                state.superseded.push_back(previous);
                if state.superseded.len() > SUPERSEDED_KEPT {
                    state.superseded.pop_front();
                }
            }
            for entry in running.values() {
                if entry.group.as_deref() == Some(group) {
                    entry.cancelled.store(true, Ordering::SeqCst);
                    entry.handle.interrupt();
                }
            }
        }
        false
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

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: &str) -> RequestKey {
        RequestKey {
            id: Some(id.into()),
            group: Some("view:tab".into()),
        }
    }

    #[test]
    fn a_replaced_request_never_cancels_the_newer_one() {
        let conn = duckdb::Connection::open_in_memory().unwrap();
        let reg = RequestRegistry::default();
        // The old request's first statement finishes before the new one starts.
        drop(reg.register(&key("old"), conn.interrupt_handle()));
        let new = reg.register(&key("new"), conn.interrupt_handle());
        // The old request's next statement: cancelled from the start, and
        // the newer one keeps running.
        let old_next = reg.register(&key("old"), conn.interrupt_handle());
        assert!(old_next.is_cancelled());
        assert!(!new.is_cancelled());
        assert!(reg.claim(&key("old")));
        // The newer request's own next statements run normally.
        drop(new);
        let new_next = reg.register(&key("new"), conn.interrupt_handle());
        assert!(!new_next.is_cancelled());
        assert!(!reg.claim(&key("new")));
    }

    #[test]
    fn a_newer_request_cancels_the_running_one() {
        let conn = duckdb::Connection::open_in_memory().unwrap();
        let reg = RequestRegistry::default();
        let old = reg.register(&key("old"), conn.interrupt_handle());
        assert!(!reg.claim(&key("new")));
        assert!(old.is_cancelled());
        // Requests without a group are left alone.
        let solo = reg.register(
            &RequestKey {
                id: Some("solo".into()),
                group: None,
            },
            conn.interrupt_handle(),
        );
        drop(reg.register(&key("newest"), conn.interrupt_handle()));
        assert!(!solo.is_cancelled());
    }
}
