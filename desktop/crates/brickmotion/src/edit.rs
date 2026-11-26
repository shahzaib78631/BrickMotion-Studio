//! Editing state (active tool, axes, collision, colour, step) and the keyboard/menu edits.
use crate::BrickMotionApp;
use crate::notices::Notice;

/// The active viewport tool.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tool {
    #[default]
    Select,
    Move,
    Rotate,
}

/// Editing state owned by the app and lent to the viewport and chrome each frame.
/// What a plain viewport click selects when a piece sits inside a submodel.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PickScope {
    /// Select the whole submodel instance in the focused model (individual pieces once inside
    /// that submodel, or when holding ⌥ Option). Matches web behaviour.
    #[default]
    Submodels,
    /// Always select the individual brick under the pointer (hold ⌥ Option for its submodel).
    Pieces,
}

#[derive(Debug)]
pub struct EditState {
    pub tool: Tool,
    pub pick_scope: PickScope,
    pub local_axes: bool,
    pub collision: bool,
    /// Smart Joints: engage articulated joint rotation rings & limits when a jointed piece is selected.
    pub smart_joints: bool,
    /// LDraw colour code for newly placed parts (default 71: Light Bluish Grey).
    pub colour: i32,
    /// Step chosen in the Steps tab (new parts go here, or into the last step when None).
    pub step: Option<usize>,
    /// Live library part placement or mouse piece drag following the pointer, when active.
    pub placement: Option<crate::placement::Placement>,
    /// True while an ⌥-modified shortcut (e.g. ⌥E / ⌥Q) is being dispatched.
    pub(crate) alt_held: bool,
}

impl Default for EditState {
    fn default() -> Self {
        Self {
            tool: Tool::Select,
            pick_scope: PickScope::Submodels,
            local_axes: false,
            collision: true,
            smart_joints: false,
            colour: 71,
            step: None,
            placement: None,
            alt_held: false,
        }
    }
}

/// Runs one engine edit against the current selection and surfaces any refusal as a notice.
pub fn selection_edit(app: &mut BrickMotionApp, f: impl FnOnce(&bm::Session, &[u32]) -> bm::Changed) {
    let sel = app.doc.session().selection();
    let changed = f(app.doc.session(), &sel);
    app.edited(changed);
}

pub fn nudge(app: &mut BrickMotionApp, delta: bm::Vec3) {
    selection_edit(app, |s, sel| s.translate(sel, delta, false));
}

pub fn nudge_along(app: &mut BrickMotionApp, arrow: bm::Arrow) {
    let cam = app.doc.viewport().map(|v| v.camera()).unwrap_or_default();
    let axis = bm::arrow_axis(&cam, arrow);
    nudge(app, bm::Vec3::new(axis.x * bm::STUD, 0.0, axis.z * bm::STUD));
}

pub fn raise(app: &mut BrickMotionApp, brick: bool) {
    let step = if brick { bm::BRICK } else { bm::PLATE };
    // −y is up in LDraw coordinates.
    nudge(app, bm::Vec3::new(0.0, -step, 0.0));
}

pub fn lower(app: &mut BrickMotionApp, brick: bool) {
    let step = if brick { bm::BRICK } else { bm::PLATE };
    nudge(app, bm::Vec3::new(0.0, step, 0.0));
}

/// Turns the selection 90° around +y through its centre (−y is up, so +90° is clockwise from above).
pub fn turn(app: &mut BrickMotionApp, clockwise: bool) {
    let pivot = app.doc.viewport().map(|v| v.selection_center()).unwrap_or_default();
    let deg = if clockwise { 90.0 } else { -90.0 };
    selection_edit(app, |s, sel| s.rotate(sel, bm::Vec3::new(0.0, 1.0, 0.0), deg, pivot, false));
}

pub fn clone(app: &mut BrickMotionApp) {
    selection_edit(app, |s, sel| s.duplicate(sel, bm::Vec3::ZERO));
}

pub fn duplicate(app: &mut BrickMotionApp) {
    selection_edit(app, |s, sel| s.duplicate(sel, bm::Vec3::new(bm::STUD, 0.0, 0.0)));
}

/// Copies the selection's LDraw text; false when nothing was copied.
pub fn copy(app: &mut BrickMotionApp) -> bool {
    let sel = app.doc.session().selection();
    let text = app.doc.session().copy(&sel);
    if text.is_empty() {
        return false;
    }
    let written = if !app.dialogs_enabled() {
        if app.clipboard_fails {
            Err("The clipboard could not be written.".to_owned())
        } else {
            app.clipboard = text;
            Ok(())
        }
    } else {
        arboard::Clipboard::new().and_then(|mut cb| cb.set_text(text)).map_err(|e| e.to_string())
    };
    match written {
        Ok(()) => true,
        Err(detail) => {
            crate::notices::push(&mut app.notices, Notice::Warning { title: "Couldn't copy".into(), detail });
            false
        }
    }
}

/// Removes the selection only once its copy is on the clipboard.
pub fn cut(app: &mut BrickMotionApp) {
    if copy(app) {
        selection_edit(app, |s, sel| s.remove(sel));
    }
}

pub fn paste(app: &mut BrickMotionApp) {
    let text = if !app.dialogs_enabled() {
        app.clipboard.clone()
    } else {
        match arboard::Clipboard::new().and_then(|mut cb| cb.get_text()) {
            Ok(t) => t,
            Err(e) => {
                crate::notices::push(
                    &mut app.notices,
                    Notice::Warning { title: "Couldn't paste".into(), detail: e.to_string() },
                );
                return;
            }
        }
    };
    let changed = app.doc.session().paste(&text, bm::Vec3::ZERO);
    app.edited(changed);
}
