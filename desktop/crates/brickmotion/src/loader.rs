//! Opens documents on a worker thread so the window keeps drawing. The worker builds the whole
//! Document, renderer included (the slow part), and can draw it once at the view's size so the
//! first frame on the UI thread is quick.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};

pub type Loaded = Result<(bm::Document, bm::OpenInfo), bm::OpenError>;

/// The view a document will be shown in, so the worker can draw it once first.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Warm {
    /// Pixels wide, pixels high, pixels per point.
    pub size: (u32, u32, f64),
    /// sRGB 0..1.
    pub background: [f64; 3],
}

/// File types BrickMotion opens; the engine would read anything as LDraw and find no pieces.
pub const OPEN_EXTENSIONS: [&str; 6] = ["brickmotion", "json", "ldr", "mpd", "dat", "io"];

/// Opens a model into a fresh session: refuses other file types, and an LDraw file with no
/// pieces (the engine reads anything as LDraw). An empty .brickmotion project is fine.
pub fn open_model(path: &Path) -> Result<(bm::Session, bm::OpenInfo), bm::OpenError> {
    let fail = |message: String| bm::OpenError { path: path.to_path_buf(), message };
    // Say plainly what is wrong with the path before the engine gives a vaguer reason.
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(fail("There is no file here any more.".into())),
        Err(e) => return Err(fail(format!("BrickMotion can't read this file ({}).", reason(&e)))),
        Ok(m) if m.is_dir() => return Err(fail("This is a folder, not a model file.".into())),
        Ok(_) => {}
    }
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !ext.as_deref().is_some_and(|e| OPEN_EXTENSIONS.contains(&e)) {
        return Err(bm::OpenError {
            path: path.to_path_buf(),
            message: "BrickMotion opens .brickmotion, .json, .ldr, .mpd, .dat and .io files.".into(),
        });
    }
    if let Err(e) = std::fs::File::open(path) {
        return Err(fail(format!("BrickMotion can't read this file ({}).", reason(&e))));
    }
    let mut s = bm::Session::new();
    let info = s.open(path)?;
    if s.piece_count() == 0 && ext.as_deref() != Some("brickmotion") {
        return Err(bm::OpenError { path: path.to_path_buf(), message: "No pieces were found in this file.".into() });
    }
    Ok((s, info))
}

/// An io error in a few plain words.
fn reason(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => "permission denied".into(),
        _ => e.to_string(),
    }
}

/// Opens `path` and builds its Document (drawn once at `warm`'s size), unless `cancel` is set
/// first: then nothing is built and the result is None. Runs on the worker.
pub fn build(path: &Path, warm: Option<Warm>, cancel: &AtomicBool) -> Option<Loaded> {
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    let (session, info) = match open_model(path) {
        Ok(opened) => opened,
        Err(e) => return Some(Err(e)),
    };
    // Building the renderer is the slow part; skip it for a load nobody wants any more.
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    let mut doc = bm::Document::new(session);
    if let (Some(w), Some(vp)) = (warm, doc.viewport()) {
        vp.set_background(w.background);
        vp.resize(w.size.0, w.size.1, w.size.2);
        vp.fit_all();
        vp.draw();
    }
    Some(Ok((doc, info)))
}

/// Drops a document the window no longer shows on a thread of its own: freeing a big model's
/// renderer takes long enough to stall a frame. None if no thread could start; the document is
/// then dropped here, with the unspawned thread's closure.
pub fn retire(doc: bm::Document) -> Option<std::thread::JoinHandle<()>> {
    std::thread::Builder::new().name("bm-retire".into()).spawn(move || drop(doc)).ok()
}

/// One load at a time: a newer request cancels an older pending one, whose result is dropped.
#[derive(Default)]
pub struct Loader {
    current: Option<(PathBuf, Receiver<Loaded>)>,
    cancel: Arc<AtomicBool>,
    warm: bool,
}

impl Loader {
    /// Opens `path` into a fresh document on its own thread.
    pub fn start(&mut self, path: PathBuf) {
        self.start_warm(path, None);
    }

    /// As `start`, and draws the document once at `warm`'s size before handing it over.
    pub fn start_warm(&mut self, path: PathBuf, warm: Option<Warm>) {
        self.cancel.store(true, Ordering::Relaxed);
        self.cancel = Arc::new(AtomicBool::new(false));
        self.warm = warm.is_some();
        let (tx, rx) = mpsc::channel();
        let p = path.clone();
        let cancel = Arc::clone(&self.cancel);
        let spawned = std::thread::Builder::new().name("bm-open".into()).spawn(move || {
            if let Some(loaded) = build(&p, warm, &cancel) {
                let _ = tx.send(loaded); // the receiver is gone when a newer request replaced this one
            }
        });
        if let Err(e) = spawned {
            let (tx, rx) = mpsc::channel();
            let _ = tx.send(Err(bm::OpenError { path: path.clone(), message: format!("could not start opening: {e}") }));
            self.current = Some((path, rx));
            return;
        }
        self.current = Some((path, rx));
    }

    /// The finished load, if any. Never blocks.
    pub fn poll(&mut self) -> Option<Loaded> {
        let (path, rx) = self.current.as_ref()?;
        let r = match rx.try_recv() {
            Ok(r) => r,
            Err(TryRecvError::Empty) => return None,
            Err(TryRecvError::Disconnected) => {
                Err(bm::OpenError { path: path.clone(), message: "the engine stopped while opening the file".into() })
            }
        };
        self.current = None;
        Some(r)
    }

    /// The current load's cancel flag (set once a newer request replaces it).
    #[doc(hidden)]
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    /// Whether the latest load knew the view's size.
    pub fn started_warm(&self) -> bool {
        self.warm
    }

    /// The file being opened.
    pub fn loading(&self) -> Option<&Path> {
        self.current.as_ref().map(|(p, _)| p.as_path())
    }
}
