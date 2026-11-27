//! Pictures of whole models for Home's sample cards. Each is drawn once on a worker thread at the
//! card's size and colour, saved as a PNG under Application Support, and read from there after.
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, TryRecvError, channel};

use egui::{ColorImage, Context, TextureHandle, TextureOptions};
use image::RgbaImage;

use crate::support::Support;

/// What a card can show for a model now.
pub enum Thumb {
    Ready(TextureHandle),
    /// Being drawn; ask again next frame.
    Pending,
    /// The model can't be opened or drawn.
    Missing,
}

type Key = (PathBuf, [u8; 3]);

/// Bumped when the framing changes, so old cached pictures are drawn again.
const FRAMING: u32 = 3;

/// Thumbnail pixel size: a card is about 160 × 80 points, drawn at 2×.
pub const SIZE: (u32, u32) = (320, 160);

#[derive(Default)]
pub struct Thumbnails {
    ready: HashMap<Key, TextureHandle>,
    failed: HashSet<Key>,
    queue: VecDeque<Key>,
    running: Option<(Key, Receiver<Option<RgbaImage>>)>,
}

/// Where the picture of `model` on a `bg` card is kept; None when the model can't be read.
/// The name follows the file's path, its last change and the colour, so an edit redraws it.
pub fn cache_file(support: &Support, model: &Path, bg: [u8; 3]) -> Option<PathBuf> {
    let modified = std::fs::metadata(model).and_then(|m| m.modified()).ok()?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    model.hash(&mut h);
    modified.hash(&mut h);
    bg.hash(&mut h);
    SIZE.hash(&mut h);
    FRAMING.hash(&mut h);
    Some(support.dir.join("Thumbnails").join(format!("{:016x}.png", h.finish())))
}

/// Draws `model` fitted into a `size` picture on a `bg` background; None without Metal or when
/// the model doesn't open.
pub fn render(model: &Path, size: (u32, u32), bg: [u8; 3]) -> Option<RgbaImage> {
    let (session, _) = crate::loader::open_model(model).ok()?;
    let mut doc = bm::Document::new(session);
    let vp = doc.viewport()?;
    vp.set_background([f64::from(bg[0]) / 255.0, f64::from(bg[1]) / 255.0, f64::from(bg[2]) / 255.0]);
    vp.resize(size.0, size.1, 2.0);
    vp.fit_all();
    // Fit All leaves room for editing; a card wants the model to fill it.
    vp.zoom_toward(1.4, f64::from(size.0) / 4.0, f64::from(size.1) / 4.0);
    for _ in 0..30 {
        if !vp.draw() {
            break;
        }
    }
    let mut frame = bm::Frame::default();
    vp.read_frame(&mut frame);
    let img = RgbaImage::from_raw(frame.width, frame.height, frame.rgba)?;
    // Opaque: the background fills every pixel the model leaves.
    Some(image::imageops::resize(&img, size.0, size.1, image::imageops::FilterType::Triangle))
        .filter(|i| i.width() > 0)
        .map(|mut i| {
            i.pixels_mut().for_each(|p| p.0[3] = 255);
            i
        })
}

fn texture(ctx: &Context, key: &Key, img: &RgbaImage) -> TextureHandle {
    let color = ColorImage::from_rgba_unmultiplied([img.width() as usize, img.height() as usize], img.as_raw());
    ctx.load_texture(format!("thumb:{}", key.0.display()), color, TextureOptions::LINEAR)
}

impl Thumbnails {
    /// The picture of `model` on a `bg` card, starting its drawing if needed.
    pub fn get(&mut self, ctx: &Context, support: &Support, model: &Path, bg: [u8; 3]) -> Thumb {
        self.poll(ctx, support);
        let key = (model.to_path_buf(), bg);
        if let Some(t) = self.ready.get(&key) {
            return Thumb::Ready(t.clone());
        }
        if self.failed.contains(&key) {
            return Thumb::Missing;
        }
        let Some(file) = cache_file(support, model, bg) else {
            self.failed.insert(key);
            return Thumb::Missing;
        };
        if let Ok(img) = image::open(&file).map(|i| i.to_rgba8()) {
            let t = texture(ctx, &key, &img);
            self.ready.insert(key, t.clone());
            return Thumb::Ready(t);
        }
        if self.running.as_ref().map(|r| &r.0) != Some(&key) && !self.queue.contains(&key) {
            self.queue.push_back(key);
        }
        self.start_next(ctx);
        Thumb::Pending
    }

    /// How many pictures on a `bg` card are ready to show.
    pub fn ready_count(&self, bg: [u8; 3]) -> usize {
        self.ready.keys().filter(|k| k.1 == bg).count()
    }

    fn start_next(&mut self, ctx: &Context) {
        if self.running.is_some() {
            return;
        }
        let Some(key) = self.queue.pop_front() else { return };
        let (tx, rx) = channel();
        let (model, bg) = key.clone();
        let wake = ctx.clone();
        let spawned = std::thread::Builder::new().name("bm-thumbnail".into()).spawn(move || {
            let _ = tx.send(render(&model, SIZE, bg));
            wake.request_repaint();
        });
        match spawned {
            Ok(_) => self.running = Some((key, rx)),
            Err(_) => {
                self.failed.insert(key);
            }
        }
    }

    fn poll(&mut self, ctx: &Context, support: &Support) {
        let Some((key, rx)) = self.running.as_ref() else { return };
        let got = match rx.try_recv() {
            Ok(img) => img,
            Err(TryRecvError::Empty) => return,
            Err(TryRecvError::Disconnected) => None,
        };
        let key = key.clone();
        self.running = None;
        match got {
            Some(img) => {
                if let Some(file) = cache_file(support, &key.0, key.1) {
                    let _ = std::fs::create_dir_all(file.parent().unwrap_or(Path::new(".")));
                    let _ = img.save(&file);
                }
                let t = texture(ctx, &key, &img);
                self.ready.insert(key, t);
            }
            None => {
                self.failed.insert(key);
            }
        }
        self.start_next(ctx);
    }
}
