//! Planned flights baked into editable keys, flight keys opened from the Parts lane, edited
//! flights sent back to Build, and Check Motion (`AnimationWorkspace.runBake` / `editFlight` /
//! `checkMotion`, `KeyframeTracks.bake` / `useEditedFlight`). The slow halves run on the `bm-anim`
//! worker; a result made from an older document is dropped.
use bm::keys::{FlightPath, flight_keys_start};
use bm::motion::{BakeResult, FlightBake, MotionContact, MotionReport};
use egui::Pos2;

use crate::BrickMotionApp;
use crate::notices::Notice;
use crate::transport::Clock;
use crate::viewport::ViewOp;
use crate::workers::Stale;

/// The document a job was made from: (generation, version).
pub type DocKey = (u64, u64);

pub fn doc_key(app: &BrickMotionApp) -> DocKey {
    let s = app.doc.session();
    (s.generation(), s.version())
}

/// What to do once a bake lands.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Then {
    /// Open the piece's new keys on the Keyframes clock (Edit Flight as Keys).
    OpenKeys { piece: u32, start: f64 },
}

/// A prepared bake coming back from the worker.
pub struct Baked {
    bake: FlightBake,
    result: BakeResult,
    detach: bool,
    then: Option<Then>,
}

/// A bake waiting for "Replace Existing Keyframes?".
pub struct PendingBake {
    bake: FlightBake,
    pub detach: bool,
    /// The document the bake was captured from (checked before applying).
    key: DocKey,
}

#[derive(Clone, Debug)]
pub struct CheckResult {
    pub text: String,
    pub warning: bool,
    pub contacts: Vec<MotionContact>,
    /// The document the contacts were found in.
    pub key: DocKey,
}

/// A flight-path dot being dragged.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PathDrag {
    pub piece: u32,
    pub frame: i32,
    /// The key's position at the frame, in studs.
    pub origin: bm::Vec3,
    /// The dot's point on the path.
    pub through: bm::Vec3,
    /// Where the press was, from the view's top left.
    pub start: (f64, f64),
    /// A step is open (later moves continue it).
    pub moved: bool,
}

#[derive(Default)]
pub struct Flights {
    /// "Baked 1 flight into N editable keys."
    pub note: Option<String>,
    pub confirm: Option<PendingBake>,
    pub check: Option<CheckResult>,
    /// The path drawn for (piece, version).
    pub(crate) path: Option<(u32, u64, Option<FlightPath>)>,
    /// The path's dots on screen this frame: (frame, point).
    pub dots: Vec<(i32, Pos2)>,
    /// The path's line on screen: (frame, point), with breaks where it leaves the view.
    pub samples: Vec<Vec<(i32, Pos2)>>,
    /// The dot ⌫ deletes: (piece, frame).
    pub(crate) picked: Option<(u32, i32)>,
    pub(crate) drag: Option<PathDrag>,
    /// A press on the line is held (the viewport does not see it).
    pub(crate) line_press: bool,
    /// Cached local piece set for `(generation, version)` so UI panels don't scan steps every frame.
    local_cache: Option<(DocKey, std::collections::HashSet<u32>)>,
}

impl Flights {
    /// The dot ⌫ deletes: (piece, frame).
    pub fn picked(&self) -> Option<(u32, i32)> {
        self.picked
    }

    pub fn reset(&mut self) {
        *self = Flights::default();
    }
}

fn refuse(app: &mut BrickMotionApp, why: impl Into<String>) {
    crate::notices::push(&mut app.notices, Notice::Warning { title: "Couldn't edit".into(), detail: why.into() });
}

/// Thousands grouped as Swift's `formatted()` shows them.
pub fn grouped(n: i32) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

/// The pieces a bake takes: the chosen key objects' members, or the selection.
fn chosen_pieces(app: &BrickMotionApp) -> Vec<u32> {
    let mut pieces: Vec<u32> =
        app.keys.active.iter().filter_map(|id| app.keys.object(*id)).flat_map(|o| o.members.iter().copied()).collect();
    if pieces.is_empty() {
        pieces = app.doc.session().selection();
    }
    pieces.sort_unstable();
    pieces.dedup();
    pieces
}

/// Bake Flights to Keys (`detach`: and detach the Build motion). Asks first when keys go.
pub fn bake(app: &mut BrickMotionApp, detach: bool) {
    if app.bake.busy() {
        return;
    }
    let pieces = chosen_pieces(app);
    let key = doc_key(app);
    let Some(vp) = app.doc.viewport() else { return };
    let Some(bake) = vp.capture_flight_bake(&pieces, detach) else {
        refuse(app, "Generate a Build plan before baking flights.");
        return;
    };
    if bake.replaces_keys() {
        app.flights.confirm = Some(PendingBake { bake, detach, key });
    } else {
        run_bake(app, bake, detach, None, key);
    }
}

/// The answer to "Replace Existing Keyframes?".
pub fn answer_confirm(app: &mut BrickMotionApp, replace: bool) {
    if let Some(p) = app.flights.confirm.take()
        && replace
    {
        if p.key != doc_key(app) {
            app.flights.note = Some("The animation changed while flights were being baked. Bake again to use it.".into());
            return;
        }
        run_bake(app, p.bake, p.detach, None, p.key);
    }
}

fn run_bake(app: &mut BrickMotionApp, mut bake: FlightBake, detach: bool, then: Option<Then>, key: DocKey) {
    app.flights.note = None;
    app.bake.start(key, move || {
        let result = bake.prepare();
        Baked { bake, result, detach, then }
    });
}

/// Edit Flight as Keys from the Parts lane: open the keys a flight already has, or bake it first.
pub fn edit_flight(app: &mut BrickMotionApp, piece: u32, start: f64) {
    if app.doc.session().has_editable_flight_keys(piece) {
        open_keys(app, piece, start);
        return;
    }
    if app.bake.busy() {
        return;
    }
    let key = doc_key(app);
    let Some(vp) = app.doc.viewport() else { return };
    let Some(bake) = vp.capture_flight_bake(&[piece], false) else {
        refuse(app, "This part has no playable flight to open as keys.");
        return;
    };
    if bake.replaces_keys() {
        refuse(app, "This flight already has keys. Open Keyframes to review them before rebaking.");
        return;
    }
    run_bake(app, bake, false, Some(Then::OpenKeys { piece, start }), key);
}

fn open_keys(app: &mut BrickMotionApp, piece: u32, start: f64) {
    app.doc.session().select(&[piece], bm::SelectMode::Replace);
    let scene = app.doc.session().key_scene();
    if let Some(vp) = app.doc.viewport() {
        app.transport.set_clock(vp, Clock::Keyframes);
        app.transport.seek_scene(vp, flight_keys_start(scene, start));
    }
}

/// Use Edited Flight in Build: the keyed flight becomes the piece's Build route, then Build replans.
pub fn use_edited_flight(app: &mut BrickMotionApp, piece: u32) {
    let Some(vp) = app.doc.viewport() else { return };
    let route = vp.edited_flight_route(piece);
    if route.is_empty() {
        refuse(app, "Use two visible poses with movement and no scale change to send this flight to Build.");
        return;
    }
    let c = app.doc.session().use_flight_in_build(piece, &route);
    let ok = c.refused.is_none();
    app.edited(c);
    if ok && let Some(vp) = app.doc.viewport() {
        app.transport.set_clock(vp, Clock::Build);
        app.transport.plan(vp);
    }
}

/// Return Flight to Planner: drops the baked keys so Build plans the flight again.
pub fn return_to_planner(app: &mut BrickMotionApp, piece: u32) {
    let c = app.doc.session().return_flight_to_planner(piece);
    app.edited(c);
}

/// A piece of the open model itself (not inside a submodel), cached per document version.
pub fn is_local(app: &mut BrickMotionApp, piece: u32) -> bool {
    let key = doc_key(app);
    let stale = app.flights.local_cache.as_ref().is_none_or(|(k, _)| *k != key);
    if stale {
        let s = app.doc.session();
        let set: std::collections::HashSet<u32> = (0..s.steps().len())
            .flat_map(|st| s.step_items(st))
            .filter(|i| !i.submodel)
            .flat_map(|i| i.pieces)
            .collect();
        app.flights.local_cache = Some((key, set));
    }
    app.flights.local_cache.as_ref().is_some_and(|(_, set)| set.contains(&piece))
}

/// Check Motion on the selected piece's keyed motion.
pub fn check_motion(app: &mut BrickMotionApp) {
    if app.audit.busy() {
        return;
    }
    let piece = app.doc.session().selection().first().copied().or_else(|| app.keys.target().map(|id| id.0));
    let Some(piece) = piece else { return };
    let Some(vp) = app.doc.viewport() else { return };
    let Some(mut audit) = vp.audit_motion(piece) else { return };
    app.flights.check = None;
    let key = doc_key(app);
    app.audit.start(key, move || audit.check());
}

fn check_text(r: &MotionReport) -> (String, bool) {
    if let Some(e) = &r.error {
        return (e.clone(), true);
    }
    let frames = format!("{} sampled frames", grouped(r.tested_frames));
    let label = if r.intervals == 1 { "1 contact".to_owned() } else { format!("{} contacts", grouped(r.intervals)) };
    let title = if r.intervals == 0 { format!("No crossings found in {frames}.") } else { format!("{label} across {frames}.") };
    let shown = r.contacts.len() as i32;
    let text = if r.intervals > shown { format!("{title} Showing the first {shown}.") } else { title };
    (text, r.intervals > 0)
}

/// A contact clicked: seek to it, select both pieces and frame them.
pub fn show_contact(app: &mut BrickMotionApp, contact: &MotionContact) {
    let Some(check) = &app.flights.check else { return };
    if check.key != doc_key(app) {
        app.flights.check = Some(CheckResult {
            text: "The animation changed. Run Check Motion to update these results.".into(),
            warning: true,
            contacts: Vec::new(),
            key: check.key,
        });
        return;
    }
    let scene = app.doc.session().key_scene();
    if let Some(vp) = app.doc.viewport() {
        app.transport.seek_scene(vp, f64::from(contact.first_frame - scene.first) / f64::from(scene.fps.max(1)));
    }
    app.doc.session().select(&[contact.a, contact.b], bm::SelectMode::Replace);
    // Both parts show selected; the Keys panel stays on the object that was checked.
    let selection = app.doc.session().selection();
    app.keys.keep_chosen(selection);
    app.viewport.queue(ViewOp::FrameSelection);
}

/// Takes the workers' results; once per frame, before the chrome.
pub fn poll(app: &mut BrickMotionApp, ctx: &egui::Context) {
    let key = doc_key(app);
    match app.bake.poll(&key) {
        Some(Ok(mut b)) => {
            if let Some(e) = b.result.error.take() {
                refuse(app, e);
            } else {
                let c = app.doc.session().apply_flight_bake(&mut b.bake);
                let ok = c.refused.is_none();
                app.edited(c);
                if ok {
                    let flights =
                        if b.result.flights == 1 { "1 flight".to_owned() } else { format!("{} flights", grouped(b.result.flights)) };
                    let summary = format!("Baked {flights} into {} editable keys.", grouped(b.result.keys));
                    app.flights.note = Some(if b.detach { format!("{summary} Build motion detached.") } else { summary });
                    if let Some(Then::OpenKeys { piece, start }) = b.then {
                        open_keys(app, piece, start);
                    }
                }
            }
        }
        Some(Err(Stale)) => {
            app.flights.note = Some("The animation changed while flights were being baked. Bake again to use it.".into());
        }
        None => {}
    }
    match app.audit.poll(&key) {
        Some(Ok(report)) => {
            let (text, warning) = check_text(&report);
            app.flights.check = Some(CheckResult { text, warning, contacts: report.contacts, key });
        }
        Some(Err(Stale)) => {
            app.flights.check = Some(CheckResult {
                text: "The animation changed while it was being checked.".into(),
                warning: true,
                contacts: Vec::new(),
                key,
            });
        }
        None => {}
    }
    if app.bake.busy() || app.audit.busy() {
        ctx.request_repaint_after(std::time::Duration::from_millis(30));
    }
}

/// "Replace Existing Keyframes?" before a bake replaces keys.
pub fn show_confirm(ui: &mut egui::Ui, app: &mut BrickMotionApp) {
    let Some(pending) = &app.flights.confirm else { return };
    let t = app.theme;
    let detach = pending.detach;
    let mut answer = None;
    let modal = egui::Modal::new(egui::Id::unique("replace-keyframes")).show(ui.ctx(), |ui| {
        ui.set_width(360.0);
        ui.label(egui::RichText::new("Replace Existing Keyframes?").strong().size(14.0).color(t.text1));
        ui.add_space(4.0);
        ui.label(
            egui::RichText::new(
                "Baking replaces existing keys on the affected parts with the current Build motion. You can undo the bake as one edit.",
            )
            .color(t.text2),
        );
        ui.add_space(12.0);
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let label = if detach { "Replace Keys and Detach" } else { "Replace Keys" };
            let replace = egui::Button::new(egui::RichText::new(label).color(t.on_accent)).fill(t.accent);
            if ui.add(replace).clicked() {
                answer = Some(true);
            }
            if ui.button("Cancel").clicked() {
                answer = Some(false);
            }
        });
    });
    if modal.should_close() && answer.is_none() {
        answer = Some(false);
    }
    if let Some(a) = answer {
        answer_confirm(app, a);
        ui.ctx().request_repaint();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(tested: i32, intervals: i32, shown: usize) -> MotionReport {
        let c = MotionContact { a: 1, b: 2, first_frame: 3, last_frame: 4, part: "a".into(), blocker: "b".into() };
        MotionReport { tested_frames: tested, stride: 1, intervals, contacts: vec![c; shown], error: None }
    }

    #[test]
    fn check_wording() {
        assert_eq!(check_text(&report(1200, 0, 0)), ("No crossings found in 1,200 sampled frames.".into(), false));
        assert_eq!(check_text(&report(48, 1, 1)), ("1 contact across 48 sampled frames.".into(), true));
        assert_eq!(check_text(&report(48, 30, 20)), ("30 contacts across 48 sampled frames. Showing the first 20.".into(), true));
    }

    #[test]
    fn grouping() {
        assert_eq!(grouped(7), "7");
        assert_eq!(grouped(1234), "1,234");
        assert_eq!(grouped(1234567), "1,234,567");
    }
}
