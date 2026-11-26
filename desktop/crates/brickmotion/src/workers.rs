//! Slow animation work on the `bm-anim` worker thread. A job remembers the key it was started for
//! (the document's generation and version); a result that comes back after the key moved on is
//! stale and is dropped, so a bake or check never lands on a document it was not made from.
use std::sync::mpsc::{Receiver, TryRecvError, channel};

/// The document changed while the job ran.
#[derive(Debug, PartialEq, Eq)]
pub struct Stale;

pub struct Job<K, T> {
    running: Option<(K, Receiver<T>)>,
}

impl<K, T> Default for Job<K, T> {
    fn default() -> Self {
        Job { running: None }
    }
}

impl<K: PartialEq, T: Send + 'static> Job<K, T> {
    /// Runs `work` on its own thread; false when one is already running or no thread starts.
    pub fn start(&mut self, key: K, work: impl FnOnce() -> T + Send + 'static) -> bool {
        if self.running.is_some() {
            return false;
        }
        let (tx, rx) = channel();
        let spawned = std::thread::Builder::new().name("bm-anim".into()).spawn(move || {
            let _ = tx.send(work());
        });
        if spawned.is_err() {
            return false;
        }
        self.running = Some((key, rx));
        true
    }

    /// The result once the work is done: `Err(Stale)` when `current` is no longer the key it
    /// started with (or the thread died).
    pub fn poll(&mut self, current: &K) -> Option<Result<T, Stale>> {
        let (key, rx) = self.running.as_ref()?;
        let out = match rx.try_recv() {
            Ok(v) if key == current => Ok(v),
            Ok(_) | Err(TryRecvError::Disconnected) => Err(Stale),
            Err(TryRecvError::Empty) => return None,
        };
        self.running = None;
        Some(out)
    }

    pub fn busy(&self) -> bool {
        self.running.is_some()
    }

    /// Forgets a running job (its result is dropped when it arrives).
    pub fn cancel(&mut self) {
        self.running = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn wait<T: Send + 'static>(job: &mut Job<u32, T>, key: u32) -> Result<T, Stale> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(r) = job.poll(&key) {
                return r;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn result_for_its_key() {
        let mut job = Job::default();
        assert!(job.start(1, || 7));
        assert!(job.busy());
        assert!(!job.start(1, || 8), "one at a time");
        assert_eq!(wait(&mut job, 1), Ok(7));
        assert!(!job.busy());
    }

    #[test]
    fn moved_key_is_stale() {
        let mut job = Job::default();
        assert!(job.start(1, || 7));
        assert_eq!(wait(&mut job, 2), Err(Stale));
        assert!(!job.busy());
    }
}
