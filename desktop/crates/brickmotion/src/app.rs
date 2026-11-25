use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::autosave::Autosaver;
use crate::chrome;
use crate::commands::{Ctx, run, tabs};
use crate::document::{DocState, PROJECT_EXTENSION, save_to, with_project_extension};
use crate::support::{Prefs, Recents, Support};
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

/// Something that would close or replace the current document, held while the person is asked
/// whether to save it.
pub enum Pending {
    Open(PathBuf),
    New,
    Quit,
    /// A load that finished after the document was edited.
    Adopt(Box<(PathBuf, bm::Document, bm::OpenInfo)>),
}

/// The answer to "Save changes?".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    Save,
    DontSave,
    Cancel,
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
    /// The file behind the document.
    pub state: DocState,
    pub support: Support,
    pub prefs: Prefs,
    pub recents: Recents,
    /// Waiting for an answer to "Save changes?".
    pub confirm: Option<Pending>,
    /// The person agreed to replace the document at this version; a load arriving while it is
    /// unchanged takes its place without asking again.
    replace_ok: Option<u64>,
    /// Quit was confirmed: the next frame closes the window.
    quitting: bool,
    autosaver: Autosaver,
    /// The last autosave failure shown, so a repeating one warns once.
    autosave_error: Option<String>,
}

impl BrickMotionApp {
    pub fn new(cc: &eframe::CreationContext, path: Option<PathBuf>) -> Self {
        Self::new_with_support(cc, path, Support::user())
    }

    /// As `new`, with the support folder given (tests use a temp folder).
    pub fn new_with_support(cc: &eframe::CreationContext, path: Option<PathBuf>, support: Support) -> Self {
        egui_extras::install_image_loaders(&cc.egui_ctx);
        apply(&cc.egui_ctx, &Theme::DARK);
        Self::with_path(path, support)
    }

    fn with_path(path: Option<PathBuf>, support: Support) -> Self {
        let theme = Theme::DARK;
        let prefs = Prefs::load(&support);
        let recents = Recents::load(&support);
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
            state: DocState::default(),
            support,
            prefs,
            recents,
            confirm: None,
            replace_ok: None,
            quitting: false,
            autosaver: Autosaver::default(),
            autosave_error: None,
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

    /// The saved project's name, else the opened file's, else "Untitled".
    pub fn title(&self) -> String {
        if let Some(p) = self.state.save_path() {
            return p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        }
        if self.state.path.is_none() {
            return "Untitled".into();
        }
        let t = self.doc.session().title();
        if t.is_empty() { "Untitled".into() } else { t }
    }

    fn dirty(&self) -> bool {
        self.has_document && self.doc.session().dirty()
    }

    /// Does `next` now, or first asks to save an edited document.
    pub fn request(&mut self, next: Pending) {
        if self.dirty() {
            self.confirm = Some(next);
        } else {
            self.perform(next);
        }
    }

    fn perform(&mut self, next: Pending) {
        match next {
            Pending::Open(p) => self.loader.start_warm(p, self.viewport.warm()),
            Pending::New => self.new_document_now(),
            Pending::Quit => self.quitting = true,
            Pending::Adopt(loaded) => {
                let (path, doc, info) = *loaded;
                self.adopt(path, doc, info);
            }
        }
    }

    /// The person's answer to "Save changes?".
    pub fn answer_confirm(&mut self, a: Answer) {
        let Some(next) = self.confirm.take() else { return };
        match a {
            Answer::Cancel => {}
            Answer::DontSave => {
                self.replace_ok = Some(self.doc.session().version());
                self.perform(next);
            }
            Answer::Save => {
                self.save();
                if self.doc.session().dirty() {
                    // The save failed or was cancelled: keep asking.
                    self.confirm = Some(next);
                } else {
                    self.replace_ok = Some(self.doc.session().version());
                    self.perform(next);
                }
            }
        }
    }

    /// Takes a loaded document as the current one.
    fn adopt(&mut self, path: PathBuf, doc: bm::Document, info: bm::OpenInfo) {
        // The old document (and its renderer) goes; the widget sets the new one up.
        self.doc = doc;
        self.viewport.reset();
        self.has_document = true;
        self.replace_ok = None;
        self.state = DocState { imported: self.doc.session().imported(), path: Some(path.clone()) };
        self.notices.extend(Notice::from_warnings(&info.warnings));
        self.remember(path);
    }

    /// Puts a file at the top of Open Recent.
    fn remember(&mut self, path: PathBuf) {
        self.recents.add(path);
        let _ = self.recents.save(&self.support);
    }

    /// Saves in place, or asks where when the document has no project file yet.
    pub fn save(&mut self) {
        let Some(path) = self.state.save_path().map(Path::to_path_buf) else {
            self.save_as();
            return;
        };
        self.write(path);
    }

    /// Saves to `path` (given the project extension) and makes it the document's file.
    pub fn save_as_path(&mut self, path: PathBuf) {
        self.write(with_project_extension(path));
    }

    fn write(&mut self, path: PathBuf) {
        match save_to(self.doc.session_mut(), &path) {
            Ok(()) => {
                self.state = DocState { path: Some(path.clone()), imported: false };
                self.remember(path);
            }
            Err(e) => {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                self.notices.push(Notice::Error { title: format!("Couldn't save {name}"), detail: e });
            }
        }
    }

    /// Autosaves when due (see `autosave`). A failure is a warning, once per distinct message.
    pub fn autosave(&mut self, now: std::time::Instant) {
        if !self.has_document {
            return;
        }
        let r = self.autosaver.tick(now, chrono::Local::now(), self.doc.session_mut(), &self.state, &self.prefs, &self.support);
        match r {
            Some(Ok(_)) => self.autosave_error = None,
            Some(Err(e)) if self.autosave_error.as_ref() != Some(&e) => {
                self.notices.push(Notice::Warning { title: "Couldn't autosave".into(), detail: e.clone() });
                self.autosave_error = Some(e);
            }
            _ => {}
        }
    }

    /// The name Save As suggests.
    fn suggested_name(&self) -> String {
        format!("{}.{PROJECT_EXTENSION}", self.title())
    }

    pub fn piece_count(&self) -> usize {
        self.doc.session().piece_count()
    }

    /// Starts opening `path` in the background, after asking to save an edited document; the
    /// current document stays until the new one arrives.
    pub fn open(&mut self, path: PathBuf) {
        self.request(Pending::Open(path));
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
            "file.save" => self.save(),
            "file.save_as" => self.save_as(),
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

    /// An untitled, empty project, after asking to save an edited one.
    pub fn new_document(&mut self) {
        self.request(Pending::New);
    }

    fn new_document_now(&mut self) {
        let mut s = bm::Session::new();
        match s.new_blank() {
            Ok(_) => {
                self.doc = bm::Document::new(s);
                self.viewport.reset();
                self.has_document = true;
                self.state = DocState::default();
            }
            Err(e) => self.notices.push(Notice::open_failed(&e)),
        }
    }

    /// Asks where to save, suggesting `<title>.brickmotion` beside the document's file.
    pub fn save_as(&mut self) {
        let suggested = self.suggested_name();
        if !self.dialogs {
            self.dialog_requests.push(DialogRequest { kind: "save_as", suggested: Some(suggested) });
            return;
        }
        let mut dialog = rfd::FileDialog::new().add_filter("BrickMotion project", &[PROJECT_EXTENSION]).set_file_name(&suggested);
        if let Some(dir) = self.state.path.as_deref().and_then(Path::parent) {
            dialog = dialog.set_directory(dir);
        }
        if let Some(p) = dialog.save_file() {
            self.save_as_path(p);
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
        let path = self.loader.loading().map(Path::to_path_buf);
        match self.loader.poll() {
            Some(Ok((doc, info))) => {
                let path = path.expect("a finished load had a path");
                let agreed = self.replace_ok == Some(self.doc.session().version());
                if self.dirty() && !agreed {
                    // Edited while it loaded: ask before the edits go.
                    self.confirm = Some(Pending::Adopt(Box::new((path, doc, info))));
                } else {
                    self.adopt(path, doc, info);
                }
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

    /// As `new`, with its own temp support folder: tests never touch the person's preferences.
    #[doc(hidden)]
    pub fn new_for_test_cc(cc: &eframe::CreationContext, path: Option<PathBuf>) -> Self {
        Self::new_with_support(cc, path, test_support())
    }

    /// A window-less app with its own temp support folder.
    #[doc(hidden)]
    pub fn new_for_test(path: Option<PathBuf>) -> Self {
        Self::with_path(path, test_support())
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

impl BrickMotionApp {
    /// Closing the window with unsaved changes asks first.
    fn guard_close(&mut self, ctx: &egui::Context) {
        if self.quitting {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            return;
        }
        if ctx.input(|i| i.viewport().close_requested()) && self.dirty() {
            ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
            if self.confirm.is_none() {
                self.confirm = Some(Pending::Quit);
            }
        }
    }
}

/// A fresh support folder under the temp folder, one per test app.
fn test_support() -> Support {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    Support::at(std::env::temp_dir().join(format!("bm-test-support-{}-{n}", std::process::id())))
}

impl eframe::App for BrickMotionApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.poll_loader();
        if self.loader.loading().is_some() {
            ui.ctx().request_repaint_after(Duration::from_millis(50));
        }
        self.guard_close(ui.ctx());
        self.text_focus = ui.ctx().egui_wants_keyboard_input();
        crate::shortcuts::handle(self, ui.ctx());
        chrome::titlebar::show(ui, self);
        chrome::ribbon::show(ui, self);
        if self.workspace == Workspace::Animate {
            chrome::timeline::show(ui, self);
        }
        chrome::central(ui, self);
        chrome::confirm::show(ui, self);
        self.run_requested();
        self.autosave(std::time::Instant::now());
        if self.dirty() {
            // An idle window still autosaves.
            ui.ctx().request_repaint_after(Duration::from_secs(self.prefs.autosave_seconds.max(1)));
        }
        if self.doc.session().version() != self.seen_version {
            // An edit, undo or redo: the engine's viewport catches up by itself, it only needs a frame.
            self.seen_version = self.doc.session().version();
            ui.ctx().request_repaint();
        }
    }
}
