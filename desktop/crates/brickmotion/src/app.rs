use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::chrome;
use crate::commands::{Ctx, run, tabs};
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

/// A file dialog a test asked for instead of opening a panel (see `dialogs_off`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DialogRequest {
    /// "open" or "save_as".
    pub kind: &'static str,
    pub suggested: Option<String>,
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
    /// A document was opened or made (an empty launch has none).
    pub has_document: bool,
    /// A text field had keyboard focus last frame.
    pub text_focus: bool,
    /// The command palette is showing.
    pub palette_open: bool,
    /// Tests: file dialogs are recorded here instead of shown.
    pub dialog_requests: Vec<DialogRequest>,
    dialogs: bool,
    seen_version: u64,
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
            has_document: false,
            text_focus: false,
            palette_open: false,
            dialog_requests: Vec::new(),
            dialogs: true,
            seen_version: 0,
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

    /// What commands are enabled from, now.
    pub fn ctx(&self) -> Ctx {
        let s = self.doc.session();
        Ctx {
            has_document: self.has_document,
            pieces: s.piece_count(),
            selected: s.selection().len(),
            can_undo: s.can_undo(),
            can_redo: s.can_redo(),
            undo_name: s.undo_name(),
            redo_name: s.redo_name(),
            text_focus: self.text_focus,
        }
    }

    /// Does what command `id` does; `commands::run` has already checked it is enabled.
    pub(crate) fn execute(&mut self, id: &str) -> bool {
        let s = self.doc.session_mut();
        match id {
            "file.open" | "model.import" => self.open_dialog(),
            "file.new" => self.new_document(),
            "file.save" | "file.save_as" => self.save_as(),
            "edit.undo" => {
                let c = s.undo();
                self.edited(c);
            }
            "edit.redo" => {
                let c = s.redo();
                self.edited(c);
            }
            "edit.delete" => {
                let sel = s.selection();
                let c = s.remove(&sel);
                self.edited(c);
            }
            "edit.select_all" => s.select_all(),
            "edit.select_none" => s.select_none(),
            "edit.hide" => {
                let sel = s.selection();
                s.hide(&sel);
                s.select_none();
            }
            "edit.show_all" => s.show_all(),
            "view.fit" | "view.home" => self.viewport.queue(ViewOp::Fit),
            "view.frame_selection" => self.viewport.queue(ViewOp::FrameSelection),
            "view.palette" => self.palette_open = true,
            _ => return false,
        }
        true
    }

    /// After an edit: a refusal becomes a notice.
    fn edited(&mut self, c: bm::Changed) {
        if let Some(why) = c.refused {
            self.notices.push(Notice::Warning { title: "Couldn't edit".into(), detail: why });
        }
    }

    /// An untitled, empty project.
    pub fn new_document(&mut self) {
        let mut s = bm::Session::new();
        match s.new_blank() {
            Ok(_) => {
                self.doc = bm::Document::new(s);
                self.viewport.reset();
                self.has_document = true;
            }
            Err(e) => self.notices.push(Notice::open_failed(&e)),
        }
    }

    fn save_as(&mut self) {
        if !self.dialogs {
            self.dialog_requests.push(DialogRequest { kind: "save_as", suggested: None });
        }
    }

    /// Tests: file dialogs are recorded in `dialog_requests` instead of shown.
    #[doc(hidden)]
    pub fn dialogs_off(&mut self) {
        self.dialogs = false;
    }

    fn open_dialog(&mut self) {
        if !self.dialogs {
            self.dialog_requests.push(DialogRequest { kind: "open", suggested: None });
            return;
        }
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
                self.has_document = true;
                self.notices.extend(Notice::from_warnings(&info.warnings));
            }
            Some(Err(e)) => self.notices.push(Notice::open_failed(&e)),
            None => {}
        }
    }

    fn run_requested(&mut self) {
        for id in std::mem::take(&mut self.requested) {
            run(self, id);
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
        self.text_focus = ui.ctx().egui_wants_keyboard_input();
        crate::shortcuts::handle(self, ui.ctx());
        chrome::titlebar::show(ui, self);
        chrome::ribbon::show(ui, self);
        if self.workspace == Workspace::Animate {
            chrome::timeline::show(ui, self);
        }
        chrome::central(ui, self);
        self.run_requested();
        if self.doc.session().version() != self.seen_version {
            // An edit, undo or redo: the engine's viewport catches up by itself, it only needs a frame.
            self.seen_version = self.doc.session().version();
            ui.ctx().request_repaint();
        }
    }
}
