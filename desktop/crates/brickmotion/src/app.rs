use std::path::PathBuf;

use crate::chrome;
use crate::commands::tabs;
use crate::theme::{Theme, apply};

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
    /// Models, Steps, Parts or Library.
    pub browser_tab: usize,
    pub filter: String,
    pub curves: bool,
    /// Command ids the chrome asked for this frame; run after the frame is laid out.
    pub requested: Vec<&'static str>,
    /// A file given on the command line, opened once the window is up.
    pub pending_open: Option<PathBuf>,
}

impl BrickMotionApp {
    pub fn new(cc: &eframe::CreationContext, path: Option<PathBuf>) -> Self {
        egui_extras::install_image_loaders(&cc.egui_ctx);
        let theme = Theme::DARK;
        apply(&cc.egui_ctx, &theme);
        BrickMotionApp {
            workspace: Workspace::Build,
            ribbon_tab: tabs(Workspace::Build)[0],
            theme,
            doc: bm::Document::new(bm::Session::new()),
            browser_tab: 0,
            filter: String::new(),
            curves: false,
            requested: Vec::new(),
            pending_open: path,
        }
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

    fn run_requested(&mut self) {
        // view.fit and view.home get their handlers with the viewport, file.open with the loader.
        self.requested.clear();
    }
}

impl eframe::App for BrickMotionApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        chrome::titlebar::show(ui, self);
        chrome::ribbon::show(ui, self);
        if self.workspace == Workspace::Animate {
            chrome::timeline::show(ui, self);
        }
        chrome::central(ui, self);
        self.run_requested();
    }
}
