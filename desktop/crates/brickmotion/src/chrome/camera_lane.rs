//! A Camera track: one clock's camera keys as gold diamonds and the move between each pair as a
//! soft clip naming its preset (m5-rulings.md). Mirrors `CameraTrackLane.swift`: click a key to go
//! there and show it, drag it along the lane, and use the lane, key and move menus.
use bm::camera::{CameraClock, CameraKey, ClockInfo};
use egui::{Align2, FontId, Rect, Sense, Stroke, StrokeKind, Ui, WidgetInfo, pos2, vec2};

use super::timeline::TimelineDrag;
use crate::BrickMotionApp;
use crate::transport::Clock;


/// What the Camera panel shows: a key, or the move leaving a key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CameraPick {
    Key(String),
    Move(String),
}

impl CameraPick {
    pub fn id(&self) -> &str {
        match self {
            CameraPick::Key(id) | CameraPick::Move(id) => id,
        }
    }
}

/// Auto-Direct's six styles: id, label, hint (Swift's `CameraDirectorStyle`).
pub const STYLES: [(&str, &str, &str); 6] = [
    ("reference", "Speed Build", "High over the base, lowering as it grows, quick swoops to the side being built, then a hard cut to a low front view"),
    ("showcase", "Showcase Orbit", "Lowers to the front, circles slowly round the back while it is built, then cuts to a low front view"),
    ("turntable", "Turntable", "A still frame on the whole model, turning faster as it is built, then a whip to the front and a hold"),
    ("calm", "Calm", "Slow glides on a long lens, no swings, an arc onto the front"),
    ("energetic", "Energetic", "Lots of whip pans and swoops with strong motion blur"),
    ("overhead", "Overhead", "Looks down from above the whole time"),
];

/// What a key looks at: id and label (Swift's `CameraAim`).
pub const AIMS: [(&str, &str); 4] =
    [("point", "Fixed view"), ("model", "Whole model"), ("build", "What is being built"), ("piece", "The landing piece")];

pub fn aim_label(target: &str) -> &'static str {
    AIMS.iter().find(|(id, _)| *id == target).map_or("Fixed view", |(_, l)| l)
}

/// The Camera track of the clock the timeline shows.
pub fn camera_clock(clock: Clock) -> CameraClock {
    match clock {
        Clock::Build => CameraClock::Build,
        Clock::Keyframes => CameraClock::Timeline,
    }
}

/// The clock as a Camera track reads it.
pub fn clock_info(app: &BrickMotionApp, clock: CameraClock) -> ClockInfo {
    let tr = &app.transport;
    bm::camera::clock_info(clock, app.doc.session(), tr.fps(), tr.build_duration(), tr.ready())
}

pub fn preset_label(id: &str) -> String {
    bm::camera::camera_presets().into_iter().find(|p| p.id == id).map_or_else(|| "Smooth glide".into(), |p| p.label)
}

/// Follow Camera: the viewport plays the track.
pub fn set_director(app: &mut BrickMotionApp, on: bool) {
    app.director = on;
    if let Some(vp) = app.doc.viewport() {
        vp.set_director_preview(on);
    }
}

/// A key filming the view at the playhead (the key already there takes the view). A new key turns
/// Follow Camera on; the key is selected.
pub fn add_key_from_view(app: &mut BrickMotionApp) {
    let clock = camera_clock(app.transport.clock());
    let info = clock_info(app, clock);
    let now = app.transport.time();
    let (session, Some(vp)) = app.doc.parts() else { return };
    let (c, id, added) = bm::camera::add_camera_key_from_view(session, vp, clock, now, info);
    let ok = c.refused.is_none() && !id.is_empty();
    app.edited(c);
    if !ok {
        return;
    }
    if added {
        set_director(app, true);
    }
    app.camera_selection = Some((clock, CameraPick::Key(id)));
    app.flights.picked = None;
}

/// Writes the clock's track in `style`, keeping hand-made keys; Follow Camera turns on.
pub fn auto_direct(app: &mut BrickMotionApp, clock: CameraClock, style: &str) {
    let (session, Some(vp)) = app.doc.parts() else { return };
    let c = bm::camera::auto_direct(session, vp, clock, style);
    let ok = c.refused.is_none();
    app.edited(c);
    if ok {
        app.camera_selection = None;
        set_director(app, true);
    }
}

pub fn can_auto_direct(app: &BrickMotionApp, clock: CameraClock) -> bool {
    bm::camera::can_auto_direct(clock, app.doc.session(), app.transport.ready())
}

/// Why Auto-Direct is off (m5-rulings.md).
pub fn auto_direct_reason(app: &BrickMotionApp, clock: CameraClock) -> &'static str {
    if clock == CameraClock::Timeline && !app.doc.session().key_scene().build_linked {
        "Auto-Direct follows the build. Switch to the Build clock, or turn on Follow build in the key scene."
    } else {
        "Auto-Direct needs a build plan. Plan the build first."
    }
}

/// Drops a selection whose key is gone, and Follow Camera with the document it was for.
pub fn sync(app: &mut BrickMotionApp) {
    // A key on the other clock is not a time on this one.
    if app.camera_selection.as_ref().is_some_and(|(c, _)| *c != camera_clock(app.transport.clock())) {
        app.camera_selection = None;
    }
    let s = app.doc.session();
    let now = (s.generation(), s.version());
    if app.camera_synced == Some(now) {
        return;
    }
    if app.camera_synced.is_some_and(|(g, _)| g != now.0) {
        app.camera_selection = None;
        app.director = false;
    }
    app.camera_synced = Some(now);
    if let Some((clock, pick)) = &app.camera_selection
        && !s.camera_keys(*clock).iter().any(|k| k.id == pick.id())
    {
        app.camera_selection = None;
    }
}

/// Moves the playhead to `seconds` on the clock the timeline shows.
pub fn seek(app: &mut BrickMotionApp, seconds: f64) {
    if let Some(vp) = app.doc.viewport() {
        app.transport.seek(vp, seconds);
    }
}

/// Draws one clock's Camera track in `r` (a timeline lane `dur` seconds long).
pub fn show(ui: &mut Ui, app: &mut BrickMotionApp, r: Rect, dur: f64, clock: Clock) {
    let t = app.theme;
    let cam = camera_clock(clock);
    app.timeline.last_camera_rect = Some(r);
    let keys = app.doc.session().camera_keys(cam);

    let lane = ui.interact(r, ui.scope_id().with(("cam-lane", cam)), Sense::click());
    lane.widget_info(|| WidgetInfo::labeled(egui::Role::Group, true, "Camera lane"));
    lane.context_menu(|ui| lane_menu(ui, app, cam));
    if keys.is_empty() {
        let noun = if cam == CameraClock::Build { "Build" } else { "timeline" };
        ui.painter().text(
            pos2(r.left() + 12.0, r.center().y),
            Align2::LEFT_CENTER,
            format!("Add a camera key to film the {noun} from your own views, or Auto-Direct it"),
            FontId::proportional(11.5),
            t.text3,
        );
    }
    if dur <= 0.0 {
        return;
    }
    let view = app.timeline.view;
    let dragged = match &app.timeline.drag {
        Some(TimelineDrag::CameraKey { clock: c, id, seconds, .. }) if *c == cam => Some((id.clone(), *seconds)),
        _ => None,
    };
    let at = |k: &CameraKey| match &dragged {
        Some((id, s)) if *id == k.id => *s,
        _ => k.seconds,
    };
    let x = |s: f64| r.left() + view.screen_x(s, dur) as f32;
    let painter = ui.painter_at(r);

    // Moves: a clip between each pair of keys.
    for pair in keys.windows(2) {
        let (from, to) = (&pair[0], &pair[1]);
        let (a, b) = (x(at(from)) + 8.0, x(at(to)) - 8.0);
        if b - a <= 4.0 || b < r.left() || a > r.right() {
            continue;
        }
        let clip = Rect::from_min_max(pos2(a, r.top() + 5.0), pos2(b, r.bottom() - 5.0));
        let selected = app.camera_selection == Some((cam, CameraPick::Move(from.id.clone())));
        let label = preset_label(&from.preset);
        painter.rect(
            clip,
            6.0,
            if selected { crate::theme::Theme::alpha(t.camera_key, 62) } else { t.bg3 },
            if selected { Stroke::new(1.0, t.camera_key) } else { Stroke::new(0.5, t.border2) },
            StrokeKind::Inside,
        );
        if clip.width() > 64.0 {
            painter.with_clip_rect(clip.shrink2(vec2(6.0, 0.0))).text(
                pos2(clip.left() + 8.0, clip.center().y),
                Align2::LEFT_CENTER,
                &label,
                FontId::proportional(11.0),
                if selected { t.text1 } else { t.text2 },
            );
        }
        let resp = ui.interact(clip, ui.scope_id().with(("cam-move", cam, &from.id)), Sense::click());
        resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, selected, format!("Camera move, {label}")));
        let resp = resp.on_hover_text(format!("{label} · Click to edit the move"));
        if resp.clicked() {
            app.camera_selection = Some((cam, CameraPick::Move(from.id.clone())));
            app.flights.picked = None;
        }
        resp.context_menu(|ui| preset_picker(ui, app, cam, &from.id, &from.preset));
    }

    // Keys: diamonds on top.
    for k in &keys {
        let kx = x(at(k));
        if kx < r.left() - 8.0 || kx > r.right() + 8.0 {
            continue;
        }
        let c = pos2(kx, r.center().y);
        let selected = app.camera_selection == Some((cam, CameraPick::Key(k.id.clone())));
        let size = 5.0;
        let pts = vec![c + vec2(0.0, -size), c + vec2(size, 0.0), c + vec2(0.0, size), c + vec2(-size, 0.0)];
        if selected {
            let ring: Vec<_> = pts.iter().map(|p| c + (*p - c) * 1.7).collect();
            painter.add(egui::Shape::convex_polygon(ring, t.accent, Stroke::NONE));
            let gap: Vec<_> = pts.iter().map(|p| c + (*p - c) * 1.35).collect();
            painter.add(egui::Shape::convex_polygon(gap, t.bg1, Stroke::NONE));
        }
        let fill = if k.user { t.camera_key } else { t.camera_key.gamma_multiply(0.6) };
        painter.add(egui::Shape::convex_polygon(pts, fill, Stroke::NONE));

        let hit = Rect::from_center_size(c, vec2(18.0, r.height()));
        let resp = ui.interact(hit, ui.scope_id().with(("cam-key", cam, &k.id)), Sense::click_and_drag());
        let when = crate::chrome::timeline::format_timecode(k.seconds, app.transport.clock_fps());
        resp.widget_info(|| WidgetInfo::selected(egui::Role::Button, true, selected, format!("Camera key at {when}")));
        let auto = if k.user { "" } else { " · automatic" };
        let resp = resp.on_hover_text(format!("Camera key at {when}{auto} · {} · Drag to move", aim_label(&k.target)));
        if resp.clicked() {
            app.camera_selection = Some((cam, CameraPick::Key(k.id.clone())));
            app.flights.picked = None;
            seek(app, k.seconds);
        }
        if resp.drag_started() {
            app.camera_selection = Some((cam, CameraPick::Key(k.id.clone())));
            app.flights.picked = None;
            let start_x = ui.input(|i| i.pointer.press_origin()).map_or(kx, |p| p.x);
            app.timeline.drag =
                Some(TimelineDrag::CameraKey { clock: cam, id: k.id.clone(), start_x, original: k.seconds, seconds: k.seconds });
        }
        resp.context_menu(|ui| key_menu(ui, app, cam, k));
    }
}

/// Moves a dragged key once, on release, and goes to where it landed.
pub fn commit_drag(app: &mut BrickMotionApp, clock: CameraClock, id: &str, original: f64, seconds: f64) {
    if (seconds - original).abs() <= 1e-6 {
        return;
    }
    let info = clock_info(app, clock);
    let c = app.doc.session().move_camera_key(clock, id, seconds, info.fps, info.duration);
    let ok = c.refused.is_none();
    app.edited(c);
    if ok {
        seek(app, seconds);
    }
}

/// The lane's menu (and the Camera head's): add a key, Auto-Direct, Follow Camera, Clear.
pub fn lane_menu(ui: &mut Ui, app: &mut BrickMotionApp, clock: CameraClock) {
    let ready = clock_info(app, clock).ready;
    if ui.add_enabled(ready, egui::Button::new("Add Camera Key from View")).clicked() {
        add_key_from_view(app);
        ui.close();
    }
    let can = can_auto_direct(app, clock);
    let reason = auto_direct_reason(app, clock);
    ui.add_enabled_ui(can, |ui| {
        ui.menu_button("Auto-Direct", |ui| director_menu(ui, app, clock)).response.on_disabled_hover_text(reason);
    });
    let mut follow = app.director;
    if ui.checkbox(&mut follow, "Follow Camera").changed() {
        set_director(app, follow);
        ui.close();
    }
    ui.separator();
    let any = !app.doc.session().camera_keys(clock).is_empty();
    if ui.add_enabled(any, egui::Button::new("Clear Camera Track")).clicked() {
        let c = app.doc.session().clear_camera_track(clock);
        if c.refused.is_none() && app.camera_selection.as_ref().is_some_and(|(k, _)| *k == clock) {
            app.camera_selection = None;
        }
        app.edited(c);
        ui.close();
    }
}

/// Auto-Direct's styles, the current one checked.
pub fn director_menu(ui: &mut Ui, app: &mut BrickMotionApp, clock: CameraClock) {
    let current = app.doc.session().camera_director_style(clock);
    for (id, label, hint) in STYLES {
        if ui.radio(current == id, label).on_hover_text(hint).clicked() {
            auto_direct(app, clock, id);
            ui.close();
        }
    }
}

/// A key's menu: go to it, film the view, Look At, Delete.
fn key_menu(ui: &mut Ui, app: &mut BrickMotionApp, clock: CameraClock, key: &CameraKey) {
    if ui.button("Go to Key").clicked() {
        seek(app, key.seconds);
        ui.close();
    }
    if ui.button("Update Key from View").on_hover_text("This key films the viewport's view as it is now").clicked() {
        update_key_from_view(app, clock, &key.id);
        ui.close();
    }
    ui.menu_button("Look At", |ui| {
        for (id, label) in AIMS {
            if ui.radio(key.target == id, label).clicked() {
                aim_key(app, clock, key, id);
                ui.close();
            }
        }
    });
    ui.separator();
    if ui.button("Delete Key").clicked() {
        delete_key(app, clock, &key.id);
        ui.close();
    }
}

/// The key films the viewport's view as it is now.
pub fn update_key_from_view(app: &mut BrickMotionApp, clock: CameraClock, id: &str) {
    if let Some(vp) = app.doc.viewport() {
        let view = vp.capture_scene_camera();
        let c = app.doc.session().set_camera_key_view(clock, id, &view);
        app.edited(c);
    }
}

/// Look At: what the key looks at.
pub fn aim_key(app: &mut BrickMotionApp, clock: CameraClock, key: &CameraKey, target: &str) {
    if let (session, Some(vp)) = app.doc.parts() {
        let c = bm::camera::aim_camera_key(session, vp, clock, key, target);
        app.edited(c);
    }
}

/// Removes a key; a selection on it goes with it.
pub fn delete_key(app: &mut BrickMotionApp, clock: CameraClock, id: &str) {
    let c = app.doc.session().remove_camera_key(clock, id);
    if c.refused.is_none() && app.camera_selection.as_ref().is_some_and(|(k, p)| *k == clock && p.id() == id) {
        app.camera_selection = None;
    }
    app.edited(c);
}

/// The move's menu: the nineteen presets; a slide moves about as far as the camera is now.
pub fn preset_picker(ui: &mut Ui, app: &mut BrickMotionApp, clock: CameraClock, from: &str, current: &str) {
    egui::ScrollArea::vertical().max_height(360.0).show(ui, |ui| {
        for p in bm::camera::camera_presets() {
            if ui.radio(p.id == current, &p.label).on_hover_text(&p.hint).clicked() {
                choose_preset(app, clock, from, &p.id);
                ui.close();
            }
        }
    });
}

pub fn choose_preset(app: &mut BrickMotionApp, clock: CameraClock, from: &str, preset: &str) {
    let distance = app.doc.viewport().map_or(200.0, |vp| {
        let v = vp.capture_scene_camera();
        let d = [v.position.x - v.target.x, v.position.y - v.target.y, v.position.z - v.target.z];
        (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
    });
    let c = app.doc.session().choose_camera_preset(clock, from, preset, distance);
    app.edited(c);
}
