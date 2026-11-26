//! The Keys track on the Keyframes clock (m5-rulings.md, `KeyframeTracks.swift`,
//! `KeyframeGroupTracks.swift`): one row per keyed object with a thin span from its first to last
//! key and a dot per keyed frame (larger when more than three channels are keyed there). Click a row
//! to choose its object (⌘/⇧ adds); the chosen object opens its channel lanes (the dope sheet).
//! Row dots pick frames; dragging them moves every key at those frames, once, on release.
use std::collections::HashSet;
use std::rc::Rc;

use bm::keys::{KeyChannel, KeyObject, KeyRowPick};
use egui::{Align2, Color32, FontId, Rect, Sense, Stroke, Ui, WidgetInfo, pos2, vec2};

use super::timeline::TimelineDrag;
use crate::BrickMotionApp;

pub const ROW_H: f32 = 26.0;
/// Rows drawn for a filter that matches many objects.
const MAX_ROWS: usize = 200;
const DOT: Color32 = Color32::from_rgb(0x4f, 0x8c, 0xff);
const PICKED: Color32 = Color32::from_rgb(0xff, 0x9f, 0x43);

/// An object of the Keys track: a piece, or a submodel keyed as one.
pub type ObjectId = (u32, bool);

/// What the Keys track shows and what is picked in it.
#[derive(Default)]
pub struct KeysView {
    pub objects: Rc<Vec<KeyObject>>,
    pub for_version: Option<(u64, u64)>,
    /// The chosen objects; one chosen object opens its dope sheet and the Keys panel.
    pub active: HashSet<ObjectId>,
    /// Picked keys of the chosen object: channel and frame.
    pub picks: HashSet<(KeyChannel, i32)>,
    /// Picked frames on object rows.
    pub row_picks: HashSet<(u32, bool, i32)>,
    pub property: KeyChannel,
    pub auto_key: bool,
    /// Picking a frame on one row picks it on every listed row (Group).
    pub group_rows: bool,
    pub filter: String,
    /// A box select in the dope sheet: where it started.
    pub box_from: Option<egui::Pos2>,
    builds: usize,
    selection_seen: Vec<u32>,
}

impl KeysView {
    /// How many times the objects were read (a big model must not rebuild them every frame).
    pub fn builds(&self) -> usize {
        self.builds
    }

    pub fn reset(&mut self) {
        let (auto_key, group_rows) = (self.auto_key, self.group_rows);
        *self = Self { auto_key, group_rows, ..Self::default() };
    }

    /// The one chosen object, if exactly one is chosen.
    pub fn target(&self) -> Option<ObjectId> {
        (self.active.len() == 1).then(|| *self.active.iter().next().unwrap())
    }

    pub fn object(&self, id: ObjectId) -> Option<&KeyObject> {
        self.objects.iter().find(|o| (o.piece, o.submodel) == id)
    }

    /// The rows the track lists: keyed or chosen objects, or every object the filter matches.
    pub fn rows(&self) -> Vec<&KeyObject> {
        let f = self.filter.trim().to_lowercase();
        self.objects
            .iter()
            .filter(|o| {
                if f.is_empty() {
                    o.keyed || self.active.contains(&(o.piece, o.submodel))
                } else {
                    o.name.to_lowercase().contains(&f)
                }
            })
            .take(MAX_ROWS)
            .collect()
    }

    /// Re-reads the objects when the document changed, and follows the viewport's selection.
    pub fn sync(&mut self, session: &bm::Session) {
        let now = (session.generation(), session.version());
        if self.for_version != Some(now) {
            if self.for_version.is_some_and(|(g, _)| g != now.0) {
                self.reset();
            }
            let mut objects = session.key_objects();
            name_pieces(session, &mut objects, &self.active);
            self.objects = Rc::new(objects);
            self.for_version = Some(now);
            self.builds += 1;
            let known: HashSet<ObjectId> = self.objects.iter().map(|o| (o.piece, o.submodel)).collect();
            self.active.retain(|id| known.contains(id));
            let target = self.target().and_then(|id| self.object(id)).map(|o| o.keys.clone()).unwrap_or_default();
            self.picks.retain(|(c, f)| target.iter().any(|k| k.channel == *c && k.frame == *f));
            let objects = Rc::clone(&self.objects);
            self.row_picks.retain(|(p, s, f)| {
                objects.iter().any(|o| o.piece == *p && o.submodel == *s && o.markers.iter().any(|m| m.frame == *f))
            });
        }
        let selection = session.selection();
        if selection != self.selection_seen {
            self.follow_selection(&selection);
            self.selection_seen = selection;
        }
    }

    /// Swift's `syncObjects`: whole submodels first, then single pieces, then submodels touched.
    fn follow_selection(&mut self, pieces: &[u32]) {
        let chosen: HashSet<u32> = self.active.iter().filter_map(|id| self.object(*id)).flat_map(|o| o.members.iter().copied()).collect();
        let wanted: HashSet<u32> = pieces.iter().copied().collect();
        if chosen == wanted {
            return;
        }
        let mut remaining = wanted;
        let mut next = HashSet::new();
        for o in self.objects.iter().filter(|o| o.submodel && o.members.len() > 1) {
            if o.members.iter().all(|m| remaining.contains(m)) {
                next.insert((o.piece, true));
                for m in &o.members {
                    remaining.remove(m);
                }
            }
        }
        for o in self.objects.iter().filter(|o| !o.submodel) {
            if remaining.remove(&o.piece) {
                next.insert((o.piece, false));
            }
        }
        for o in self.objects.iter().filter(|o| o.submodel) {
            if o.members.iter().any(|m| remaining.contains(m)) {
                next.insert((o.piece, true));
            }
        }
        if next != self.active {
            self.picks.clear();
        }
        self.active = next;
        self.name_new_rows();
    }

    /// A chosen piece with no keys is read again next frame so its row gets its part's name.
    fn name_new_rows(&mut self) {
        if self.active.iter().any(|id| !id.1 && self.object(*id).is_some_and(|o| !o.keyed)) {
            self.for_version = None;
        }
    }

    /// Chooses an object (⌘/⇧ adds or removes it) and selects its pieces in the viewport.
    pub fn choose(&mut self, session: &bm::Session, id: ObjectId, extend: bool) {
        if extend {
            if !self.active.remove(&id) {
                self.active.insert(id);
            }
        } else {
            self.active = HashSet::from([id]);
        }
        self.picks.clear();
        self.name_new_rows();
        let pieces: Vec<u32> = self.active.iter().filter_map(|id| self.object(*id)).flat_map(|o| o.members.iter().copied()).collect();
        session.select(&pieces, bm::SelectMode::Replace);
        self.selection_seen = session.selection();
    }

    /// Key frames of the chosen objects (or of every object when none is chosen).
    pub fn frames_for_travel(&self) -> Vec<KeyObject> {
        if self.active.is_empty() {
            return self.objects.iter().filter(|o| o.keyed).cloned().collect();
        }
        self.objects.iter().filter(|o| self.active.contains(&(o.piece, o.submodel))).cloned().collect()
    }
}

/// The key scene's frames on a lane: frame ↔ x.
#[derive(Clone, Copy)]
pub struct FrameScale {
    pub lane: Rect,
    pub first: i32,
    pub fps: f64,
    pub dur: f64,
}

impl FrameScale {
    pub fn new(app: &BrickMotionApp, lane: Rect) -> Self {
        let scene = app.transport.key_scene;
        Self { lane, first: scene.first, fps: f64::from(scene.fps.max(1)), dur: app.transport.duration() }
    }

    pub fn x(&self, view: &bm::timeline::TimelineView, frame: f64) -> f32 {
        self.lane.left() + view.screen_x((frame - f64::from(self.first)) / self.fps, self.dur) as f32
    }

    /// Frames per logical pixel.
    pub fn frames_per_px(&self, view: &bm::timeline::TimelineView) -> f64 {
        self.dur * self.fps / view.logical_width().max(1.0)
    }
}

/// The Keys head's count note.
pub fn count_note(app: &BrickMotionApp) -> String {
    match app.keys.objects.iter().filter(|o| o.keyed).count() {
        0 => String::new(),
        1 => "1 object".into(),
        n => format!("{n} objects"),
    }
}

/// One object row: its head (name, click to choose) and its lane (span and dots).
pub fn row(ui: &mut Ui, app: &mut BrickMotionApp, hr: Rect, lr: Rect, object: &KeyObject) {
    let t = app.theme;
    let id = (object.piece, object.submodel);
    let chosen = app.keys.active.contains(&id);
    let head = ui.interact(hr, ui.scope_id().with(("key-obj", id)), Sense::click());
    head.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, chosen, format!("{} object", object.name)));
    if chosen {
        ui.painter().rect_filled(hr, 0.0, t.accent_bg());
    } else if head.hovered() {
        ui.painter().rect_filled(hr, 0.0, Color32::from_white_alpha(8));
    }
    let name = ui.painter().layout_no_wrap(object.name.clone(), FontId::proportional(12.0), if chosen { t.text1 } else { t.text2 });
    let clip = Rect::from_min_max(pos2(hr.left() + 34.0, hr.top()), pos2(hr.right() - 8.0, hr.bottom()));
    ui.painter().with_clip_rect(clip).galley(pos2(clip.left(), hr.center().y - name.size().y / 2.0), name, t.text2);
    if head.clicked() {
        let extend = ui.input(|i| i.modifiers.command || i.modifiers.shift);
        app.keys.choose(app.doc.session(), id, extend);
    }

    let scale = FrameScale::new(app, lr);
    let view = app.timeline.view;
    let drag_offset = match &app.timeline.drag {
        Some(TimelineDrag::KeyRows { picks, offset, .. }) => Some((picks.clone(), *offset)),
        _ => None,
    };
    let shift = |f: i32| -> i32 {
        match &drag_offset {
            Some((picks, off)) if picks.contains(&(object.piece, object.submodel, f)) => f + off,
            _ => f,
        }
    };
    let y = lr.center().y;
    if let (Some(a), Some(b)) = (object.markers.first(), object.markers.last()) {
        let (xa, xb) = (scale.x(&view, f64::from(shift(a.frame))), scale.x(&view, f64::from(shift(b.frame))));
        ui.painter().line_segment([pos2(xa.min(xb), y), pos2(xa.max(xb), y)], Stroke::new(2.0, Color32::from_rgba_unmultiplied(0x4f, 0x8c, 0xff, 70)));
    }
    let lo = lr.left() - 18.0;
    let hi = lr.right() + 18.0;
    for m in &object.markers {
        let x = scale.x(&view, f64::from(shift(m.frame)));
        if x < lo || x > hi {
            continue;
        }
        let picked = app.keys.row_picks.contains(&(object.piece, object.submodel, m.frame));
        let r = if m.channels > 3 { 4.5 } else { 3.2 };
        let hit = Rect::from_center_size(pos2(x, y), vec2(12.0, ROW_H));
        let resp = ui.interact(hit, ui.scope_id().with(("key-dot", id, m.frame)), Sense::click_and_drag());
        resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, picked, format!("{}, frame {}", object.name, m.frame)));
        let fill = if picked { PICKED } else { DOT };
        ui.painter().circle_filled(pos2(x, y), r, fill);
        if resp.hovered() {
            ui.painter().circle_stroke(pos2(x, y), r + 2.0, Stroke::new(1.0, t.text2));
        }
        let pick = (object.piece, object.submodel, m.frame);
        if resp.clicked() {
            let extend = ui.input(|i| i.modifiers.command || i.modifiers.shift);
            pick_row(app, pick, extend);
            seek_frame(app, m.frame);
        }
        if resp.drag_started() {
            if !app.keys.row_picks.contains(&pick) {
                pick_row(app, pick, false);
            }
            let start_x = ui.input(|i| i.pointer.press_origin()).map_or(x, |p| p.x);
            app.timeline.drag = Some(TimelineDrag::KeyRows { picks: app.keys.row_picks.iter().copied().collect(), start_x, offset: 0 });
        }
        resp.context_menu(|ui| row_menu(ui, app, pick));
    }
}

/// Picks a frame on a row; grouped rows pick it on every listed row that has it.
fn pick_row(app: &mut BrickMotionApp, pick: (u32, bool, i32), extend: bool) {
    let mut set: HashSet<(u32, bool, i32)> = HashSet::from([pick]);
    if app.keys.group_rows {
        for o in app.keys.rows() {
            if o.markers.iter().any(|m| m.frame == pick.2) {
                set.insert((o.piece, o.submodel, pick.2));
            }
        }
    }
    if extend {
        if app.keys.row_picks.contains(&pick) {
            app.keys.row_picks.retain(|p| !set.contains(p));
        } else {
            app.keys.row_picks.extend(set);
        }
    } else {
        app.keys.row_picks = set;
    }
}

fn row_menu(ui: &mut Ui, app: &mut BrickMotionApp, pick: (u32, bool, i32)) {
    let picks: Vec<(u32, bool, i32)> =
        if app.keys.row_picks.contains(&pick) { app.keys.row_picks.iter().copied().collect() } else { vec![pick] };
    let frame = app.transport.key_frame(&app.transport.key_scene);
    if ui.add_enabled(frame != pick.2, egui::Button::new("Move to Playhead")).clicked() {
        commit_rows(app, &picks, frame - pick.2);
        ui.close();
    }
    ui.separator();
    let label = if picks.len() == 1 { "Delete Keys at Frame" } else { "Delete Keys at Selected Frames" };
    if ui.button(label).clicked() {
        delete_rows(app, &picks);
        ui.close();
    }
}

fn native(picks: &[(u32, bool, i32)]) -> Vec<KeyRowPick> {
    picks.iter().map(|&(piece, submodel, frame)| KeyRowPick { piece, frame, submodel }).collect()
}

/// How far row picks may move and stay in the scene.
pub fn row_limits(app: &BrickMotionApp, picks: &[(u32, bool, i32)]) -> (i32, i32) {
    let (Some(lo), Some(hi)) = (picks.iter().map(|p| p.2).min(), picks.iter().map(|p| p.2).max()) else { return (0, 0) };
    bm::keys::key_offset_limits(app.transport.key_scene, lo, hi)
}

/// Moves every key at the picked frames by `offset` (clamped to the scene), as one change.
pub fn commit_rows(app: &mut BrickMotionApp, picks: &[(u32, bool, i32)], offset: i32) {
    let offset = bm::keys::clamp_offset(row_limits(app, picks), offset);
    if offset == 0 {
        return;
    }
    let c = app.doc.session().move_key_rows(&native(picks), offset);
    let ok = c.refused.is_none();
    app.edited(c);
    if ok {
        app.keys.row_picks = picks.iter().map(|&(p, s, f)| (p, s, f + offset)).collect();
        if let Some(anchor) = picks.iter().map(|p| p.2).min() {
            seek_frame(app, anchor + offset);
        }
    }
}

pub fn delete_rows(app: &mut BrickMotionApp, picks: &[(u32, bool, i32)]) {
    let c = app.doc.session().remove_key_rows(&native(picks));
    if c.refused.is_none() {
        for p in picks {
            app.keys.row_picks.remove(p);
        }
    }
    app.edited(c);
}

/// Moves the Keyframes playhead to a scene frame.
pub fn seek_frame(app: &mut BrickMotionApp, frame: i32) {
    let scene = app.transport.key_scene;
    let s = f64::from(frame - scene.first) / f64::from(scene.fps.max(1));
    if let Some(vp) = app.doc.viewport() {
        app.transport.seek_scene(vp, s);
    }
}

/// ⌫ / Delete remove picked keys before the registry's Delete sees the key.
pub fn delete_key(app: &mut BrickMotionApp, ctx: &egui::Context) {
    if app.text_focus || app.transport.clock() != crate::transport::Clock::Keyframes {
        return;
    }
    if app.keys.picks.is_empty() && app.keys.row_picks.is_empty() {
        return;
    }
    let pressed = ctx.input_mut(|i| {
        i.consume_key(egui::Modifiers::NONE, egui::Key::Delete) || i.consume_key(egui::Modifiers::NONE, egui::Key::Backspace)
    });
    if !pressed {
        return;
    }
    if !app.keys.picks.is_empty() {
        super::dope_sheet::delete_picks(app);
    } else {
        let picks: Vec<_> = app.keys.row_picks.iter().copied().collect();
        delete_rows(app, &picks);
    }
}

/// A lane hint when the track lists no rows.
pub fn empty_hint(ui: &Ui, app: &BrickMotionApp, lr: Rect) {
    ui.painter().text(
        pos2(lr.left() + 12.0, lr.center().y),
        Align2::LEFT_CENTER,
        "Select a part to key it",
        FontId::proportional(11.5),
        app.theme.text3,
    );
}

/// Names loose pieces by their part's description ("Gear 24 Tooth"), as Swift does, for the rows
/// the track lists; a model with no keys reads nothing.
fn name_pieces(session: &bm::Session, objects: &mut [KeyObject], active: &HashSet<ObjectId>) {
    let wanted: HashSet<u32> = objects
        .iter()
        .filter(|o| !o.submodel && (o.keyed || active.contains(&(o.piece, false))))
        .map(|o| o.piece)
        .collect();
    if wanted.is_empty() {
        return;
    }
    let mut names = std::collections::HashMap::new();
    for step in 0..session.steps().len() {
        for item in session.step_items(step) {
            if item.submodel || item.description.is_empty() {
                continue;
            }
            for p in item.pieces.iter().filter(|p| wanted.contains(p)) {
                names.insert(*p, item.description.split_whitespace().collect::<Vec<_>>().join(" "));
            }
        }
        if names.len() == wanted.len() {
            break;
        }
    }
    for o in objects.iter_mut().filter(|o| !o.submodel) {
        if let Some(n) = names.remove(&o.piece) {
            o.name = n;
        }
    }
}
