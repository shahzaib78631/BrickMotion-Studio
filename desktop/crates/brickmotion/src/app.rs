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

/// What a cached snapshot was made for: (generation, version, selection).
type SnapKey = (u64, u64, Vec<u32>);

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
    /// What Properties shows, and the (generation, version, selection) it was made for.
    snap: Option<(SnapKey, std::rc::Rc<bm::Snapshot>)>,
    /// The library's colours, read once.
    colors: Option<std::rc::Rc<Vec<bm::ColorInfo>>>,
    /// The Browser's model tree.
    pub tree: chrome::tree::Tree,
    /// The command palette.
    pub palette: crate::palette::Palette,
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
    /// The person agreed to replace this document as it stood; a load arriving while it is
    /// unchanged takes its place without asking again.
    replace_ok: Option<ReplaceOk>,
    /// Quit was confirmed: the next frame closes the window.
    quitting: bool,
    /// The window was closed while "Save changes?" was up for something else: quit once answered.
    quit_after: bool,
    autosaver: Autosaver,
    /// The native menu bar, once installed (never in tests).
    pub menubar: Option<crate::menubar::MenuBar>,
    /// What the menu bar was last updated for.
    menu_shown: Option<MenuKey>,
    /// The last autosave failure shown, so a repeating one warns once.
    autosave_error: Option<String>,
    /// The autosave writing on its own thread, if one is.
    autosaving: Option<std::sync::mpsc::Receiver<crate::autosave::AutosaveDone>>,
    /// The command-line file, opened on the first frame (see `start_startup`).
    startup: Option<PathBuf>,
    /// Editing state: active tool, axes, collision, colour and chosen step.
    pub edit: crate::edit::EditState,
    /// Recent/frequent parts and recent colours in history.toml.
    pub history: crate::history::History,
    /// Colour swatches popover state.
    pub swatches: chrome::swatches::Swatches,
    /// Off-thread part preview renderer and texture cache.
    pub previews: crate::previews::Previews,
    /// In-memory clipboard used when dialogs are off (headless tests).
    pub(crate) clipboard: String,
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
        let history = crate::history::History::load(&support);
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
            palette: Default::default(),
            tree: Default::default(),
            snap: None,
            colors: None,
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
            quit_after: false,
            menu_shown: None,
            autosaver: Autosaver::default(),
            menubar: None,
            autosave_error: None,
            autosaving: None,
            startup: None,
            edit: crate::edit::EditState::default(),
            history,
            swatches: chrome::swatches::Swatches::default(),
            previews: crate::previews::Previews::default(),
            clipboard: String::new(),
        };
        // Opened once the first frame knows the view's size, so the worker can draw it warm.
        app.startup = path.map(|p| std::path::absolute(&p).unwrap_or(p));
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
        // The window was closed while this was asked: once the edits are dealt with, quit.
        let next = if std::mem::take(&mut self.quit_after) && a != Answer::Cancel { Pending::Quit } else { next };
        match a {
            Answer::Cancel => {}
            Answer::DontSave => {
                self.replace_ok = Some(ReplaceOk::of(self.doc.session()));
                self.perform(next);
            }
            Answer::Save => {
                self.save();
                if self.doc.session().dirty() {
                    // The save failed or was cancelled: keep asking.
                    self.confirm = Some(next);
                } else {
                    self.replace_ok = Some(ReplaceOk::of(self.doc.session()));
                    self.perform(next);
                }
            }
        }
    }

    /// Takes a loaded document as the current one.
    fn adopt(&mut self, path: PathBuf, doc: bm::Document, info: bm::OpenInfo) {
        // The old document (and its renderer) goes, off this thread; the widget sets the new one up.
        crate::loader::retire(std::mem::replace(&mut self.doc, doc));
        self.viewport.reset();
        self.has_document = true;
        self.replace_ok = None;
        self.state = DocState { imported: self.doc.session().imported(), path: Some(path.clone()) };
        if let Some(n) = Notice::from_warnings(&info.warnings) {
            crate::notices::push(&mut self.notices, n);
        }
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
        let path = std::path::absolute(&path).unwrap_or(path);
        self.write(with_project_extension(path));
    }

    fn write(&mut self, path: PathBuf) {
        // An autosave still writing older bytes must land first, not over this save.
        self.wait_autosaved();
        match save_to(self.doc.session(), &path) {
            Ok(()) => {
                self.state = DocState { path: Some(path.clone()), imported: false };
                self.remember(path);
            }
            Err(e) => {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                crate::notices::push(&mut self.notices, Notice::Error { title: format!("Couldn't save {name}"), detail: e });
            }
        }
    }

    /// Autosaves when due (see `autosave`). A failure is a warning, once per distinct message.
    pub fn autosave(&mut self, now: std::time::Instant) {
        if !self.has_document {
            return;
        }
        if let Some(rx) = &self.autosaving {
            match rx.try_recv() {
                Ok(done) => self.autosaved(done),
                Err(std::sync::mpsc::TryRecvError::Empty) => return, // one at a time
                Err(std::sync::mpsc::TryRecvError::Disconnected) => self.autosaving = None,
            }
        }
        let Some(job) = self.autosaver.tick(now, chrono::Local::now(), self.doc.session(), &self.state, &self.prefs, &self.support) else {
            return;
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let spawned = std::thread::Builder::new().name("bm-autosave".into()).spawn(move || {
            let _ = tx.send(job.run());
        });
        match spawned {
            Ok(_) => self.autosaving = Some(rx),
            Err(e) => self.autosaved(crate::autosave::AutosaveDone::failed(format!("could not start writing: {e}"))),
        }
    }

    /// Takes a finished autosave: marks the document saved if it still matches, warns once on failure.
    fn autosaved(&mut self, done: crate::autosave::AutosaveDone) {
        self.autosaving = None;
        done.finish(self.doc.session());
        match done.result {
            Ok(_) => self.autosave_error = None,
            Err(e) if self.autosave_error.as_ref() != Some(&e) => {
                crate::notices::push(&mut self.notices, Notice::Warning { title: "Couldn't autosave".into(), detail: e.clone() });
                self.autosave_error = Some(e);
            }
            Err(_) => {}
        }
    }

    /// Blocks until the autosave in flight (if any) has finished and been taken.
    #[doc(hidden)]
    pub fn wait_autosaved(&mut self) {
        if let Some(done) = self.autosaving.take().and_then(|rx| rx.recv().ok()) {
            self.autosaved(done);
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
        // Recents and Save As keep the path, so it must not depend on the working folder.
        let path = std::path::absolute(&path).unwrap_or(path);
        self.request(Pending::Open(path));
    }

    /// The file being opened, if any.
    pub fn opening(&self) -> Option<&Path> {
        self.loader.loading().or(self.startup.as_deref())
    }

    /// Starts the command-line open, once the view's size is known (or right away when asked).
    fn start_startup(&mut self) {
        if let Some(p) = self.startup.take() {
            self.loader.start_warm(p, self.viewport.warm());
        }
    }

    /// Whether the latest open knew the view's size.
    #[doc(hidden)]
    pub fn opened_warm(&self) -> bool {
        self.loader.started_warm()
    }

    /// The panes' view of the document, made again only when the document, its version or the
    /// selection changes.
    pub fn snapshot(&mut self) -> std::rc::Rc<bm::Snapshot> {
        let s = self.doc.session();
        let key = (s.generation(), s.version(), s.selection());
        match &self.snap {
            Some((k, snap)) if *k == key => snap.clone(),
            _ => {
                let snap = std::rc::Rc::new(s.snapshot());
                self.snap = Some((key, snap.clone()));
                snap
            }
        }
    }

    /// The library's colours.
    pub fn colors(&mut self) -> std::rc::Rc<Vec<bm::ColorInfo>> {
        if self.colors.as_ref().is_none_or(|c| c.is_empty()) {
            self.colors = Some(std::rc::Rc::new(self.doc.session().colors()));
        }
        self.colors.clone().unwrap_or_default()
    }

    /// What commands are enabled from, now.
    pub fn ctx(&self) -> Ctx {
        let s = self.doc.session();
        Ctx {
            has_document: self.has_document,
            pieces: s.piece_count(),
            selected: s.selection_len(),
            can_undo: s.can_undo(),
            can_redo: s.can_redo(),
            undo_name: s.undo_name(),
            redo_name: s.redo_name(),
            text_focus: self.text_focus,
            local_axes: self.edit.local_axes,
            collision: self.edit.collision,
            tool: self.edit.tool,
        }
    }

    /// Everything the menu bar's titles, enabled states and Open Recent depend on.
    #[doc(hidden)]
    pub fn menu_key(&self) -> MenuKey {
        let s = self.doc.session();
        MenuKey {
            generation: s.generation(),
            version: s.version(),
            selected: s.selection_len(),
            text_focus: self.text_focus,
            has_document: self.has_document,
            recents: self.recents.0.clone(),
        }
    }

    /// Does what command `id` does; `commands::run` has already checked it is enabled.
    pub(crate) fn execute(&mut self, id: &str) -> bool {
        let s = self.doc.session();
        match id {
            "file.open" | "model.import" => self.open_dialog(),
            "file.new" => self.new_document(),
            "app.quit" => self.request(Pending::Quit),
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
                self.snap = None;
            }
            "edit.show_all" => {
                s.show_all();
                self.snap = None;
            }
            "view.fit" | "view.home" => self.viewport.queue(ViewOp::Fit),
            "view.frame_selection" => self.viewport.queue(ViewOp::FrameSelection),
            "view.palette" => self.palette.show_palette(),
            "tool.select" => self.edit.tool = crate::edit::Tool::Select,
            "model.move" => self.edit.tool = crate::edit::Tool::Move,
            "model.rotate_tool" => self.edit.tool = crate::edit::Tool::Rotate,
            "model.rotate" => crate::edit::turn(self, true),
            "model.rotate_back" => crate::edit::turn(self, false),
            "model.recolour" => self.swatches.open(chrome::swatches::Target::Selection),
            "edit.clone" => crate::edit::clone(self),
            "model.duplicate" => crate::edit::duplicate(self),
            "edit.raise" => crate::edit::raise(self, self.edit.alt_held),
            "edit.lower" => crate::edit::lower(self, self.edit.alt_held),
            "edit.nudge_left" => crate::edit::nudge_along(self, bm::Arrow::Left),
            "edit.nudge_right" => crate::edit::nudge_along(self, bm::Arrow::Right),
            "edit.nudge_up" => crate::edit::nudge_along(self, bm::Arrow::Up),
            "edit.nudge_down" => crate::edit::nudge_along(self, bm::Arrow::Down),
            "edit.copy" => crate::edit::copy(self),
            "edit.cut" => crate::edit::cut(self),
            "edit.paste" => crate::edit::paste(self),
            "view.local_axes" => self.edit.local_axes = !self.edit.local_axes,
            "edit.collision" => self.edit.collision = !self.edit.collision,
            _ => return false,
        }
        true
    }

    /// After an edit: a refusal becomes a notice.
    pub(crate) fn edited(&mut self, c: bm::Changed) {
        if let Some(why) = c.refused {
            crate::notices::push(&mut self.notices, Notice::Warning { title: "Couldn't edit".into(), detail: why });
        }
    }

    pub(crate) fn dialogs_enabled(&self) -> bool {
        self.dialogs
    }

    /// An untitled, empty project, after asking to save an edited one.
    pub fn new_document(&mut self) {
        self.request(Pending::New);
    }

    fn new_document_now(&mut self) {
        let mut s = bm::Session::new();
        match s.new_blank() {
            Ok(_) => {
                crate::loader::retire(std::mem::replace(&mut self.doc, bm::Document::new(s)));
                self.viewport.reset();
                self.has_document = true;
                self.state = DocState::default();
            }
            Err(e) => crate::notices::push(&mut self.notices, Notice::open_failed(&e)),
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

    /// Puts the menu bar up. The window's app only: tests must not change the process's menus.
    pub fn install_menu(&mut self, ctx: &egui::Context) {
        self.menubar = Some(crate::menubar::MenuBar::install(ctx));
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
                let agreed = self.replace_ok.is_some_and(|ok| ok.covers(self.doc.session()));
                if self.dirty() && !agreed {
                    // Edited while it loaded: ask before the edits go.
                    self.confirm = Some(Pending::Adopt(Box::new((path, doc, info))));
                } else {
                    self.adopt(path, doc, info);
                }
            }
            Some(Err(e)) => crate::notices::push(&mut self.notices, Notice::open_failed(&e)),
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
        self.start_startup();
        while self.loader.loading().is_some() {
            self.poll_loader();
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[doc(hidden)]
    pub fn session(&self) -> &bm::Session {
        self.doc.session()
    }

    /// Whether the app is closing.
    #[doc(hidden)]
    pub fn quitting(&self) -> bool {
        self.quitting
    }

    #[doc(hidden)]
    pub fn notices(&self) -> &[Notice] {
        &self.notices
    }

    #[doc(hidden)]
    pub fn gizmo_lines(&self) -> usize {
        self.viewport.gizmo.as_ref().map(|g| g.lines.len()).unwrap_or(0)
    }

    #[doc(hidden)]
    pub fn gizmo_line(&self, i: usize) -> Option<(bm::Vec2, bm::Vec2, bm::gizmo::Handle)> {
        self.viewport.gizmo.as_ref()?.lines.get(i).copied()
    }

    #[doc(hidden)]
    pub fn gizmo_ring(&self, handle: bm::gizmo::Handle) -> Option<Vec<bm::Vec2>> {
        self.viewport
            .gizmo
            .as_ref()?
            .rings
            .iter()
            .find(|(_, h)| *h == handle)
            .map(|(pts, _)| pts.clone())
    }

    #[doc(hidden)]
    pub fn viewport_rect(&self) -> Option<egui::Rect> {
        self.viewport.last_rect
    }
}

impl BrickMotionApp {
    /// Closing the window with unsaved changes asks first.
    fn guard_close(&mut self, ctx: &egui::Context) {
        if self.quitting {
            self.wait_autosaved(); // its backup is the newest copy of an edited document
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            return;
        }
        if ctx.input(|i| i.viewport().close_requested()) && self.dirty() {
            ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
            match self.confirm {
                None => self.confirm = Some(Pending::Quit),
                Some(Pending::Quit) => {}
                // Already asking about something else: the same answer then quits.
                Some(_) => self.quit_after = true,
            }
        }
    }
}

/// See [`BrickMotionApp::menu_key`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuKey {
    generation: u64,
    version: u64,
    selected: usize,
    text_focus: bool,
    has_document: bool,
    recents: Vec<PathBuf>,
}

/// Which document, at which version, the person agreed to replace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReplaceOk {
    generation: u64,
    version: u64,
}

impl ReplaceOk {
    pub fn of(s: &bm::Session) -> ReplaceOk {
        ReplaceOk { generation: s.generation(), version: s.version() }
    }

    /// True while `s` is that same document, unchanged.
    pub fn covers(&self, s: &bm::Session) -> bool {
        *self == ReplaceOk::of(s)
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
        self.previews.frame_begin(ui.ctx());
        self.poll_loader();
        if self.loader.loading().is_some() {
            ui.ctx().request_repaint_after(Duration::from_millis(50));
        }
        self.guard_close(ui.ctx());
        crate::menubar::poll(self);
        self.text_focus = ui.ctx().egui_wants_keyboard_input();
        crate::shortcuts::handle(self, ui.ctx());
        chrome::titlebar::show(ui, self);
        chrome::ribbon::show(ui, self);
        if self.workspace == Workspace::Animate {
            chrome::timeline::show(ui, self);
        }
        chrome::central(ui, self);
        self.start_startup();
        crate::palette::show(ui, self);
        chrome::swatches::show(ui, self);
        chrome::confirm::show(ui, self);
        self.run_requested();
        self.previews.frame_end();
        self.autosave(std::time::Instant::now());
        if self.autosaving.is_some() {
            ui.ctx().request_repaint_after(Duration::from_millis(50)); // to take its result
        }
        if self.quitting {
            ui.ctx().request_repaint();
        }
        if self.menubar.is_some() {
            // Titles and enabled states follow only these; most frames change none of them.
            let key = self.menu_key();
            if self.menu_shown.as_ref() != Some(&key) {
                let ctx = self.ctx();
                if let Some(m) = self.menubar.as_mut() {
                    m.sync(&ctx, &self.recents);
                }
                self.menu_shown = Some(key);
            }
        }
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
