//! Background worker and bounded LRU texture cache for square part previews.
//!
//! Only tiles asked for during the current frame stay queued; requests scrolled off screen are
//! dropped before the worker renders them.
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Condvar, Mutex};

use egui::{ColorImage, Context, TextureHandle, TextureOptions};

const MAX_TEXTURES: usize = 512;

type Key = (String, i32);

pub enum Preview {
    Ready(TextureHandle),
    Pending,
    Missing,
}

#[derive(Default)]
struct QueueState {
    pending: VecDeque<Key>,
    closed: bool,
}

struct Worker {
    shared: Arc<(Mutex<QueueState>, Condvar)>,
    results: Receiver<(Key, Option<bm::Frame>)>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        let (lock, cv) = &*self.shared;
        if let Ok(mut q) = lock.lock() {
            q.closed = true;
            q.pending.clear();
            cv.notify_all();
        }
    }
}

/// Manages off-thread part preview rendering and a bounded LRU texture cache.
#[derive(Default)]
pub struct Previews {
    worker: Option<Worker>,
    textures: HashMap<Key, (TextureHandle, u64)>,
    missing: HashSet<Key>,
    in_flight: HashSet<Key>,
    asked_this_frame: HashSet<Key>,
    tick: u64,
}

impl Previews {
    pub fn new(ctx: Context) -> Self {
        let mut p = Self::default();
        p.ensure_worker(&ctx);
        p
    }

    fn ensure_worker(&mut self, ctx: &Context) {
        if self.worker.is_some() {
            return;
        }
        let shared = Arc::new((Mutex::new(QueueState::default()), Condvar::new()));
        let worker_shared = shared.clone();
        let (tx, rx) = mpsc::channel();
        let wake = ctx.clone();
        let _ = std::thread::Builder::new().name("bm-previews".into()).spawn(move || {
            let mut renderer = bm::library::PartPreview::new();
            let (lock, cv) = &*worker_shared;
            loop {
                let key = {
                    let mut q = lock.lock().unwrap();
                    while q.pending.is_empty() && !q.closed {
                        q = cv.wait(q).unwrap();
                    }
                    if q.closed {
                        break;
                    }
                    q.pending.pop_front()
                };
                let Some((part, color)) = key else { continue };
                let frame = renderer.as_mut().and_then(|r| r.render(&part, color, true));
                if tx.send(((part, color), frame)).is_err() {
                    break;
                }
                wake.request_repaint();
            }
        });
        self.worker = Some(Worker { shared, results: rx });
    }

    /// Call once at the start of each frame before UI tiles ask for previews.
    pub fn frame_begin(&mut self, ctx: &Context) {
        self.asked_this_frame.clear();
        self.drain_results(ctx);
    }

    /// Returns the cached texture, marks the part pending on the worker, or reports Missing.
    pub fn get(&mut self, ctx: &Context, part: &str, color: i32) -> Preview {
        let key = (part.to_owned(), color);
        self.asked_this_frame.insert(key.clone());
        if let Some((tex, stamp)) = self.textures.get_mut(&key) {
            self.tick += 1;
            *stamp = self.tick;
            return Preview::Ready(tex.clone());
        }
        if self.missing.contains(&key) {
            return Preview::Missing;
        }
        self.ensure_worker(ctx);
        if self.in_flight.insert(key.clone())
            && let Some(w) = &self.worker
        {
            let (lock, _) = &*w.shared;
            let mut q = lock.lock().unwrap();
            q.pending.push_back(key);
        }
        Preview::Pending
    }

    /// Drops queued requests that were not asked for this frame and wakes the worker.
    pub fn frame_end(&mut self) {
        let Some(w) = &self.worker else { return };
        let (lock, cv) = &*w.shared;
        let mut q = lock.lock().unwrap();
        let asked = &self.asked_this_frame;
        q.pending.retain(|k| {
            let keep = asked.contains(k);
            if !keep {
                self.in_flight.remove(k);
            }
            keep
        });
        if !q.pending.is_empty() {
            cv.notify_one();
        }
    }

    /// Number of distinct previews asked for during the latest frame (tests read it).
    pub fn requested_this_frame(&self) -> usize {
        self.asked_this_frame.len()
    }

    fn drain_results(&mut self, ctx: &Context) {
        let Some(w) = &self.worker else { return };
        let mut added = false;
        while let Ok((key, frame)) = w.results.try_recv() {
            self.in_flight.remove(&key);
            match frame {
                Some(f) if f.width > 0 && f.height > 0 => {
                    let image = ColorImage::from_rgba_unmultiplied([f.width as usize, f.height as usize], &f.rgba);
                    let name = format!("part:{}:{}", key.0, key.1);
                    let handle = ctx.load_texture(name, image, TextureOptions::LINEAR);
                    self.tick += 1;
                    self.textures.insert(key, (handle, self.tick));
                    added = true;
                }
                _ => {
                    self.missing.insert(key);
                }
            }
        }
        if added {
            self.evict_lru();
        }
    }

    fn evict_lru(&mut self) {
        while self.textures.len() > MAX_TEXTURES {
            let oldest = self.textures.iter().min_by_key(|(_, (_, stamp))| *stamp).map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                self.textures.remove(&k);
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    fn with_custom_worker(
        render: impl FnMut(&str, i32) -> Option<bm::Frame> + Send + 'static,
    ) -> Previews {
        let shared = Arc::new((Mutex::new(QueueState::default()), Condvar::new()));
        let worker_shared = shared.clone();
        let (tx, rx) = mpsc::channel();
        let mut render = render;
        std::thread::spawn(move || {
            let (lock, cv) = &*worker_shared;
            loop {
                let key = {
                    let mut q = lock.lock().unwrap();
                    while q.pending.is_empty() && !q.closed {
                        q = cv.wait(q).unwrap();
                    }
                    if q.closed {
                        break;
                    }
                    q.pending.pop_front()
                };
                let Some((part, color)) = key else { continue };
                let frame = render(&part, color);
                if tx.send(((part, color), frame)).is_err() {
                    break;
                }
            }
        });
        Previews { worker: Some(Worker { shared, results: rx }), ..Default::default() }
    }

    #[test]
    fn unasked_requests_are_dropped() {
        let count = Arc::new(AtomicUsize::new(0));
        let c2 = count.clone();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let g2 = gate.clone();

        let mut p = with_custom_worker(move |_part, _color| {
            // Pause on the first render until frame 2 has pruned the queue.
            let (lock, cv) = &*g2;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cv.wait(open).unwrap();
            }
            c2.fetch_add(1, Ordering::SeqCst);
            Some(bm::Frame { width: 2, height: 2, rgba: vec![255; 16] })
        });
        let ctx = Context::default();

        // Frame 1 asks for 50 parts.
        p.frame_begin(&ctx);
        for i in 0..50 {
            let _ = p.get(&ctx, &format!("p{i}.dat"), 4);
        }
        p.frame_end();

        // Give worker time to pop the first item and block on `gate`.
        std::thread::sleep(Duration::from_millis(20));

        // Frame 2 asks for only 2 parts — the other ~47 still queued must be dropped.
        p.frame_begin(&ctx);
        let _ = p.get(&ctx, "p48.dat", 4);
        let _ = p.get(&ctx, "p49.dat", 4);
        p.frame_end();

        // Release the gate and wait for the 2 wanted parts to finish.
        {
            let (lock, cv) = &*gate;
            *lock.lock().unwrap() = true;
            cv.notify_all();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            p.frame_begin(&ctx);
            let r1 = matches!(p.get(&ctx, "p48.dat", 4), Preview::Ready(_));
            let r2 = matches!(p.get(&ctx, "p49.dat", 4), Preview::Ready(_));
            p.frame_end();
            if r1 && r2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }

        // At most 2 wanted + 1 in-flight from frame 1 ever rendered.
        let rendered = count.load(Ordering::SeqCst);
        assert!(rendered <= 3, "expected at most 3 renders, got {rendered}");
    }

    #[test]
    fn missing_part_is_missing_not_pending_forever() {
        let mut p = with_custom_worker(|_, _| None);
        let ctx = Context::default();
        p.frame_begin(&ctx);
        assert!(matches!(p.get(&ctx, "missing.dat", 4), Preview::Pending));
        p.frame_end();

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut saw_missing = false;
        while Instant::now() < deadline {
            p.frame_begin(&ctx);
            if matches!(p.get(&ctx, "missing.dat", 4), Preview::Missing) {
                saw_missing = true;
                p.frame_end();
                break;
            }
            p.frame_end();
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(saw_missing, "unknown part stayed Pending forever");
    }
}
