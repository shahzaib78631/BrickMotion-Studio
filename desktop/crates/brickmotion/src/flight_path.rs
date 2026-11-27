//! A baked flight drawn through the air on the Keyframes clock (`EditorOverlays.updateFlightPath`,
//! `ViewportView.beginPathEdit`): a 2-px accent line with an 8-px dot per key and an 11-px dot in
//! the playhead colour at the playhead. Drag a dot to reshape the flight (one undo step), double-click the line to add a
//! point there, and ⌫ deletes the picked dot (never the first or the last).
use egui::{Align2, FontId, Pos2, Rect, Stroke, Ui, pos2, vec2};

use crate::BrickMotionApp;
use crate::flights::PathDrag;
use crate::transport::Clock;

const DOT_HIT: f32 = 8.0;
const LINE_HIT: f32 = 5.0;
pub const HINT: &str = "Drag a point to reshape · double-click the line to add one · ⌫ deletes";

/// The one selected piece whose flight path shows, if any.
fn piece(app: &BrickMotionApp) -> Option<u32> {
    if !app.has_document
        || app.edit.placement.is_some()
        || app.transport.clock() != Clock::Keyframes
        || app.transport.state.playing
    {
        return None;
    }
    match app.doc.session().selection().as_slice() {
        [p] => Some(*p),
        _ => None,
    }
}

fn seek_frame(app: &mut BrickMotionApp, frame: i32) {
    let scene = app.doc.session().key_scene();
    if let Some(vp) = app.doc.viewport() {
        app.transport.seek_scene(vp, f64::from(frame - scene.first) / f64::from(scene.fps.max(1)));
    }
}

fn nearest_dot(app: &BrickMotionApp, p: Pos2) -> Option<i32> {
    app.flights
        .dots
        .iter()
        .map(|(f, d)| (*f, d.distance(p)))
        .filter(|(_, d)| *d <= DOT_HIT)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(f, _)| f)
}

/// The frame where the line runs under `p`, within a few points of it.
fn line_frame(app: &BrickMotionApp, p: Pos2) -> Option<i32> {
    let mut best: Option<(i32, f32)> = None;
    for run in &app.flights.samples {
        for w in run.windows(2) {
            let ((fa, a), (fb, b)) = (w[0], w[1]);
            let d = b - a;
            let len = d.length_sq();
            let t = if len > 0.0 { ((p - a).dot(d) / len).clamp(0.0, 1.0) } else { 0.0 };
            let dist = p.distance(a + d * t);
            if dist <= LINE_HIT && best.is_none_or(|(_, b)| dist < b) {
                best = Some((if t < 0.5 { fa } else { fb }, dist));
            }
        }
    }
    best.map(|(f, _)| f)
}

/// Takes the primary button for the path: a press on a dot starts its drag, a press on the line is
/// held (a double-click adds a point). True while the path owns the pointer, so the viewport does
/// not pick, orbit or start a gizmo drag. Runs before the viewport, with last frame's dots.
pub fn handle_pointer(ui: &Ui, app: &mut BrickMotionApp) -> bool {
    let (Some(rect), Some(piece)) = (app.viewport.last_rect, piece(app)) else {
        if app.flights.drag.take().is_some() {
            app.doc.session().end_gesture();
        }
        app.flights.line_press = false;
        return false;
    };
    let (pressed, down, released, pos, double) = ui.input(|i| {
        (
            i.pointer.primary_pressed(),
            i.pointer.primary_down(),
            i.pointer.primary_released(),
            i.pointer.latest_pos(),
            i.pointer.button_double_clicked(egui::PointerButton::Primary),
        )
    });
    let local = |p: Pos2| (f64::from(p.x - rect.left()), f64::from(p.y - rect.top()));

    if let Some(mut d) = app.flights.drag {
        if down {
            if let Some(p) = pos
                && let Some(vp) = app.doc.viewport()
            {
                let (x, y) = local(p);
                if (x, y) != d.start || d.moved {
                    let m = vp.drag_facing_view(d.through, d.start.0, d.start.1, x, y);
                    // LDU to the keys' studs (y and z flip: the web's axes).
                    let at = bm::Vec3::new(d.origin.x + m.x / 20.0, d.origin.y - m.y / 20.0, d.origin.z - m.z / 20.0);
                    // The press closed any open step; every move continues this one (as Swift does).
                    let c = app.doc.session().set_flight_path_point(d.piece, d.frame, at, true);
                    d.moved = d.moved || c.refused.is_none();
                    app.edited(c);
                }
            }
            app.flights.drag = Some(d);
        } else {
            app.doc.session().end_gesture();
            app.flights.drag = None;
        }
        return true;
    }

    if app.flights.line_press {
        if released || !down {
            app.flights.line_press = false;
            if double
                && let Some(p) = pos
                && let Some(frame) = line_frame(app, p)
            {
                let c = app.doc.session().add_flight_path_point(piece, frame);
                if c.refused.is_some() {
                    crate::viewport::beep();
                } else {
                    seek_frame(app, frame);
                    app.flights.picked = Some((piece, frame));
                }
            }
        }
        return true;
    }

    let Some(p) = pos.filter(|p| rect.contains(*p)) else { return false };
    if !pressed || ui.ctx().layer_id_at(p) != Some(ui.layer_id()) {
        return false;
    }
    if let Some(frame) = nearest_dot(app, p) {
        let s = app.doc.session();
        s.end_gesture();
        let f = f64::from(frame);
        use bm::keys::KeyChannel as C;
        let origin = bm::Vec3::new(
            s.key_value(piece, C::PositionX, f, false),
            s.key_value(piece, C::PositionY, f, false),
            s.key_value(piece, C::PositionZ, f, false),
        );
        let through = app
            .flights
            .path
            .as_ref()
            .and_then(|(_, _, path)| path.as_ref())
            .and_then(|path| path.keys.iter().find(|k| k.frame == frame))
            .map_or(origin, |k| k.at);
        seek_frame(app, frame);
        app.flights.picked = Some((piece, frame));
        app.flights.drag = Some(PathDrag { piece, frame, origin, through, start: local(p), moved: false });
        return true;
    }
    if line_frame(app, p).is_some() {
        // A click on the line belongs to the path: the selection stays.
        app.flights.line_press = true;
        return true;
    }
    app.flights.picked = None;
    false
}

/// ⌫ or Delete on a picked dot; before the Keys track's own ⌫ and the shortcuts.
pub fn delete_key(app: &mut BrickMotionApp, ctx: &egui::Context) {
    let Some((piece, frame)) = app.flights.picked else { return };
    if self::piece(app) != Some(piece) {
        app.flights.picked = None;
        return;
    }
    if app.text_focus {
        return;
    }
    let hit = ctx.input_mut(|i| {
        i.consume_key(egui::Modifiers::NONE, egui::Key::Backspace) || i.consume_key(egui::Modifiers::NONE, egui::Key::Delete)
    });
    if !hit {
        return;
    }
    let c = app.doc.session().delete_flight_path_point(piece, frame);
    if c.refused.is_some() {
        crate::viewport::beep();
    } else {
        app.edited(c);
    }
    app.flights.picked = None;
}

/// Draws the path over the viewport; after the viewport, in its rectangle.
pub fn show(ui: &Ui, app: &mut BrickMotionApp) {
    app.flights.dots.clear();
    app.flights.samples.clear();
    let (Some(rect), Some(piece)) = (app.viewport.last_rect, piece(app)) else { return };
    let version = app.doc.session().version();
    if !matches!(app.flights.path, Some((p, v, _)) if p == piece && v == version) {
        let path = app.doc.viewport().and_then(|vp| vp.flight_path(piece));
        app.flights.path = Some((piece, version, path));
    }
    let Some((_, _, Some(path))) = &app.flights.path else { return };
    if path.keys.is_empty() && path.line.is_empty() {
        return;
    }
    let path = path.clone();
    let Some(vp) = app.doc.viewport() else { return };
    let cam = vp.camera();
    let view = bm::Vec2::new(f64::from(rect.width()), f64::from(rect.height()));
    let project = |at: bm::Vec3| -> Option<Pos2> {
        bm::gizmo::project(&cam, view, at)
            .filter(|p| p.x.is_finite() && p.y.is_finite())
            .map(|p| pos2(rect.left() + p.x as f32, rect.top() + p.y as f32))
    };

    let t = app.theme;
    let painter = ui.painter_at(rect);
    let mut run: Vec<(i32, Pos2)> = Vec::new();
    for s in &path.line {
        match project(s.at) {
            Some(p) => run.push((s.frame, p)),
            None if !run.is_empty() => app.flights.samples.push(std::mem::take(&mut run)),
            None => {}
        }
    }
    if !run.is_empty() {
        app.flights.samples.push(run);
    }
    for r in &app.flights.samples {
        let pts: Vec<Pos2> = r.iter().map(|(_, p)| *p).collect();
        painter.add(egui::Shape::line(pts, Stroke::new(2.0, t.accent)));
    }

    let playhead = app.transport.key_frame(&app.doc.session().key_scene());
    let bounds = rect.expand(8.0);
    let mut playhead_pos: Option<Pos2> = None;
    for k in &path.keys {
        let Some(p) = project(k.at).filter(|p| bounds.contains(*p)) else { continue };
        app.flights.dots.push((k.frame, p));
        let picked = app.flights.picked == Some((piece, k.frame));
        if k.frame == playhead {
            playhead_pos = Some(p);
        } else {
            painter.circle(p, 4.0, t.knob, Stroke::new(1.5, t.accent));
        }
        if picked {
            painter.circle_stroke(p, 8.0, Stroke::new(1.2, t.accent));
        }
    }
    // Show the playhead dot even between key frames by sampling the flight line.
    if playhead_pos.is_none() {
        playhead_pos = path
            .line
            .iter()
            .find(|s| s.frame == playhead)
            .and_then(|s| project(s.at))
            .or_else(|| {
                let w = path.line.windows(2).find(|w| w[0].frame <= playhead && playhead <= w[1].frame)?;
                let span = (w[1].frame - w[0].frame).max(1) as f64;
                let frac = (playhead - w[0].frame) as f64 / span;
                let at = bm::Vec3::new(
                    w[0].at.x + (w[1].at.x - w[0].at.x) * frac,
                    w[0].at.y + (w[1].at.y - w[0].at.y) * frac,
                    w[0].at.z + (w[1].at.z - w[0].at.z) * frac,
                );
                project(at)
            })
            .filter(|p| bounds.contains(*p));
    }
    if let Some(p) = playhead_pos {
        painter.circle(p, 5.5, t.playhead, Stroke::new(1.5, t.knob));
    }

    // The hint sits low in the view, above the floating view bar (and above the floating timeline in Animate).
    let tl_clearance = if app.workspace == crate::Workspace::Animate {
        app.timeline.height + 16.0
    } else {
        0.0
    };
    let at = pos2(rect.center().x, rect.bottom() - tl_clearance - 66.0);
    let galley = painter.layout_no_wrap(HINT.to_owned(), FontId::proportional(11.5), t.text2);
    let bg = Rect::from_center_size(at, galley.size() + vec2(22.0, 12.0));
    painter.rect(bg, 8.0, t.float_fill(), Stroke::new(1.0, t.border2), egui::StrokeKind::Inside);
    painter.text(at, Align2::CENTER_CENTER, HINT, FontId::proportional(11.5), t.text2);
}
