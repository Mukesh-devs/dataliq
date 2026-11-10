//! What DuckDB's sniffer and `DESCRIBE` found for a file version, kept for
//! the session. Opening a file asks for its info, its first rows and its
//! import side by side; each used to sniff the file again, which for a
//! compressed file means decompressing the sample every time.
//!
//! Keyed by the file's stamp (path, size, last change) and every option that
//! changes the reader, so an edited file or other settings start over. One
//! computation per key at a time: a second caller waits for the first.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;

use crate::error::Result;

/// Entries kept; past this the memo starts over (each entry is small).
const MAX_ENTRIES: usize = 512;

type Slot<T> = Arc<Mutex<Option<T>>>;

pub(crate) struct Memo<T> {
    slots: LazyLock<Mutex<HashMap<String, Slot<T>>>>,
}

impl<T: Clone> Memo<T> {
    pub(crate) const fn new() -> Self {
        Memo {
            slots: LazyLock::new(|| Mutex::new(HashMap::new())),
        }
    }

    /// The value for `key`, computed once. Errors are not kept: the next
    /// call tries again (a cancelled or failed read says nothing about the file).
    pub(crate) fn get_or_try(
        &self,
        key: Option<String>,
        f: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let Some(key) = key else {
            return f();
        };
        let slot = {
            let mut slots = self.slots.lock();
            if slots.len() >= MAX_ENTRIES && !slots.contains_key(&key) {
                slots.clear();
            }
            Arc::clone(slots.entry(key).or_default())
        };
        let mut value = slot.lock();
        if let Some(v) = value.as_ref() {
            return Ok(v.clone());
        }
        let v = f()?;
        *value = Some(v.clone());
        Ok(v)
    }

    pub(crate) fn clear(&self) {
        self.slots.lock().clear();
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.slots.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn computes_once_per_key_and_retries_errors() {
        static M: Memo<u32> = Memo::new();
        let calls = AtomicUsize::new(0);
        let get = |k: &str| {
            M.get_or_try(Some(k.into()), || {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(7)
            })
        };
        assert_eq!(get("a").unwrap(), 7);
        assert_eq!(get("a").unwrap(), 7);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(
            M.get_or_try(Some("b".into()), || Err(crate::error::AppError::Cancelled))
                .is_err()
        );
        assert_eq!(get("b").unwrap(), 7, "an error is not kept");
        assert_eq!(M.len(), 2);
        // No key: never kept.
        assert_eq!(M.get_or_try(None, || Ok(1)).unwrap(), 1);
    }

    #[test]
    fn a_second_caller_waits_for_the_first() {
        static M: Memo<u32> = Memo::new();
        let calls = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..4 {
                s.spawn(|| {
                    M.get_or_try(Some("k".into()), || {
                        calls.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        Ok(1)
                    })
                    .unwrap()
                });
            }
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
