use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::chrome;
use crate::commands::tabs;
use crate::loader::{Loader, OPEN_EXTENSIONS};
use crate::notices::Notice;
use crate::theme::{Theme, apply};
use crate::viewport::{ViewOp, ViewportWidget};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Workspace {
    Build,
    Animate,
}

impl Workspace {
    pub fn name(self) -> &'static str {
        match self {
            Workspace::Build => "Build",
            Workspace::Animate => "Animate",
        }
    }

    pub fn other(self) -> Workspace {
        match self {
            Workspace::Build => Workspace::Animate,
            Workspace::Animate => Workspace::Build,
        }
    }
}

pub struct BrickMotionApp {
    pub workspace: Workspace,
    pub ribbon_tab: &'static str,
    pub theme: Theme,
    pub doc: bm::Document,
    pub viewport: ViewportWidget,
    pub loader: Loader,
    /// Shown bottom right, newest last, until dismissed.
    pub notices: Vec<Notice>,
    /// Models, Steps, Parts or Library.
    pub browser_tab: usize,
    pub filter: String,
    pub curves: bool,
    /// Command ids the chrome asked for this frame; run after the frame is laid out.
    pub requested: Vec<&'static str>,
}

impl BrickMotionApp {
    pub fn new(cc: &eframe::CreationContext, path: Option<PathBuf>) -> Self {
        egui_extras::install_image_loaders(&cc.egui_ctx);
        apply(&cc.egui_ctx, &Theme::DARK);
        Self::with_path(path)
    }

    fn with_path(path: Option<PathBuf>) -> Self {
        let theme = Theme::DARK;
        let mut app = BrickMotionApp {
            workspace: Workspace::Build,
            ribbon_tab: tabs(Workspace::Build)[0],
            theme,
            doc: bm::Document::new(bm::Session::new()),
            viewport: ViewportWidget::new(theme.bg1),
            loader: Loader::default(),
            notices: Vec::new(),
            browser_tab: 0,
            filter: String::new(),
            curves: false,
            requested: Vec::new(),
        };
        if let Some(p) = path {
            app.open(p);
        }
        app
    }

    pub fn set_workspace(&mut self, w: Workspace) {
        if self.workspace != w {
            self.workspace = w;
            self.ribbon_tab = tabs(w)[0];
        }
    }

    /// The document's title, or "Untitled" before one is open.
    pub fn title(&self) -> String {
        let t = self.doc.session().title();
        if t.is_empty() { "Untitled".into() } else { t }
    }

    pub fn piece_count(&self) -> usize {
        self.doc.session().piece_count()
    }

    /// Starts opening `path` in the background; the current document stays until it succeeds.
    pub fn open(&mut self, path: PathBuf) {
        self.loader.start_warm(path, self.viewport.warm());
    }

    /// The file being opened, if any.
    pub fn opening(&self) -> Option<&Path> {
        self.loader.loading()
    }

    fn open_dialog(&mut self) {
        let picked = rfd::FileDialog::new().add_filter("BrickMotion and LDraw models", &OPEN_EXTENSIONS).pick_file();
        if let Some(p) = picked {
            self.open(p);
        }
    }

    /// Takes a finished load: the new document on success, a notice either way it needs one.
    fn poll_loader(&mut self) {
        match self.loader.poll() {
            Some(Ok((doc, info))) => {
                // The old document (and its renderer) goes; the widget sets the new one up.
                self.doc = doc;
                self.viewport.reset();
                self.notices.extend(Notice::from_warnings(&info.warnings));
            }
            Some(Err(e)) => self.notices.push(Notice::open_failed(&e)),
            None => {}
        }
    }

    fn run_requested(&mut self) {
        for id in std::mem::take(&mut self.requested) {
            match id {
                "file.open" | "model.import" => self.open_dialog(),
                "view.fit" | "view.home" => self.viewport.queued.push(ViewOp::Fit),
                _ => {}
            }
        }
    }

    #[doc(hidden)]
    pub fn new_for_test(path: Option<PathBuf>) -> Self {
        Self::with_path(path)
    }

    /// Blocks until the pending open (if any) has finished and been taken.
    #[doc(hidden)]
    pub fn wait_loaded(&mut self) {
        while self.loader.loading().is_some() {
            self.poll_loader();
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[doc(hidden)]
    pub fn session(&self) -> &bm::Session {
        self.doc.session()
    }

    #[doc(hidden)]
    pub fn notices(&self) -> &[Notice] {
        &self.notices
    }
}

impl eframe::App for BrickMotionApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.poll_loader();
        if self.loader.loading().is_some() {
            ui.ctx().request_repaint_after(Duration::from_millis(50));
        }
        let open = egui::KeyboardShortcut::new(egui::Modifiers::COMMAND, egui::Key::O);
        if ui.input_mut(|i| i.consume_shortcut(&open)) {
            self.requested.push("file.open");
        }
        chrome::titlebar::show(ui, self);
        chrome::ribbon::show(ui, self);
        if self.workspace == Workspace::Animate {
            chrome::timeline::show(ui, self);
        }
        chrome::central(ui, self);
        self.run_requested();
    }
}
