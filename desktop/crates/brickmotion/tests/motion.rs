// Flight bake on a worker, flight keys from the Parts lane, the flight path overlay and Check Motion.
use std::time::{Duration, Instant};

use brickmotion::transport::Clock;
use brickmotion::{BrickMotionApp, Notice, Workspace, run};
use egui::{Pos2, vec2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

/// Piece 32 is a loose part (0–31 form a submodel) with a planned flight.
const PIECE: u32 = 32;

/// The helicopter in Animate with a ready Build plan.
fn planned() -> Harness<'static, BrickMotionApp> {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
        app.wait_loaded();
        app.dialogs_off();
        app
    });
    h.run_steps(3);
    h.state_mut().set_workspace(Workspace::Animate);
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        h.step();
        let ver = h.state().session().version();
        let tr = &h.state().transport;
        if tr.ready() && tr.version == Some(ver) && !tr.state.stale {
            break;
        }
        assert!(Instant::now() < deadline, "plan never became ready");
        std::thread::sleep(Duration::from_millis(10));
    }
    h.run_steps(3);
    h
}

/// The shortest timeline keeps the flight-path dots clear of the view bar above it.
fn path_room(h: &mut Harness<'static, BrickMotionApp>) {
    h.state_mut().timeline.height = 180.0;
    h.run_steps(2);
}

fn select(h: &mut Harness<'static, BrickMotionApp>, pieces: &[u32]) {
    h.state_mut().doc.session().select(pieces, bm::SelectMode::Replace);
    h.run_steps(2);
}

fn set_clock(h: &mut Harness<'static, BrickMotionApp>, clock: Clock) {
    let app = h.state_mut();
    let vp = app.doc.viewport().expect("viewport");
    app.transport.set_clock(vp, clock);
    h.run_steps(3);
}

fn wait_idle(h: &mut Harness<'static, BrickMotionApp>) {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        h.step();
        if !h.state().bake.busy() && !h.state().audit.busy() {
            break;
        }
        assert!(Instant::now() < deadline, "the worker never finished");
        std::thread::sleep(Duration::from_millis(10));
    }
    h.run_steps(2);
}

fn baked(h: &Harness<'static, BrickMotionApp>, piece: u32) -> bool {
    h.state().session().key_objects().iter().any(|o| o.piece == piece && !o.submodel && o.baked)
}

fn object_keys(h: &Harness<'static, BrickMotionApp>, piece: u32) -> Vec<bm::keys::Keyframe> {
    h.state().session().key_objects().into_iter().find(|o| o.piece == piece && !o.submodel).map(|o| o.keys).unwrap_or_default()
}

fn bake(h: &mut Harness<'static, BrickMotionApp>, piece: u32) {
    select(h, &[piece]);
    assert!(run(h.state_mut(), "video.bake_flight"));
    wait_idle(h);
    assert!(baked(h, piece), "piece {piece} baked");
}

fn last_warning(h: &Harness<'static, BrickMotionApp>) -> String {
    match h.state().notices().last() {
        Some(Notice::Warning { detail, .. }) => detail.clone(),
        other => panic!("no warning: {other:?}"),
    }
}

fn press(h: &mut Harness<'static, BrickMotionApp>, pos: Pos2, button: egui::PointerButton, pressed: bool) {
    h.event(egui::Event::PointerButton { pos, button, pressed, modifiers: egui::Modifiers::NONE });
    h.step();
}

fn edit_something(h: &mut Harness<'static, BrickMotionApp>) {
    let k = [bm::keys::Keyframe::new(bm::keys::KeyChannel::PositionX, 5, 1.0)];
    assert!(h.state_mut().doc.session().set_keys(33, &k, false, false).refused.is_none());
}

#[test]
fn bake_selected_flights() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    bake(&mut h, PIECE);
    let note = h.state().flights.note.clone().expect("a bake note");
    assert!(note.starts_with("Baked 1 flight into ") && note.ends_with(" editable keys."), "{note}");
    assert!(!object_keys(&h, PIECE).is_empty());
}

#[test]
fn rebake_asks_first() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    bake(&mut h, PIECE);
    let before = object_keys(&h, PIECE);
    let depth = h.state().session().undo_depth();
    assert!(run(h.state_mut(), "video.bake_flight"));
    h.run_steps(2);
    assert!(h.state().flights.confirm.is_some(), "a confirm is up");
    assert!(h.query_by_label("Replace Existing Keyframes?").is_some());
    h.get_by_label("Cancel").click();
    h.run_steps(2);
    wait_idle(&mut h);
    assert!(h.state().flights.confirm.is_none());
    assert_eq!(object_keys(&h, PIECE), before);
    assert_eq!(h.state().session().undo_depth(), depth);
}

#[test]
fn bake_result_after_edit_is_dropped() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    select(&mut h, &[PIECE]);
    assert!(run(h.state_mut(), "video.bake_flight"));
    // An edit lands before the worker's result is taken.
    edit_something(&mut h);
    let depth = h.state().session().undo_depth();
    wait_idle(&mut h);
    assert!(!baked(&h, PIECE), "the stale bake was dropped");
    assert_eq!(h.state().session().undo_depth(), depth);
}

#[test]
fn edit_flight_as_keys_opens_keyframes() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    let dur = h.state().transport.duration();
    let clip = h.state().timeline.parts_lane.clips.iter().find(|c| c.piece == PIECE).expect("a clip for the piece").clone();
    h.state_mut().timeline.view.zoom_by(32.0, clip.start, dur);
    h.state_mut().timeline.view.reveal(clip.start, dur, true);
    h.run_steps(3);
    let parts = h.state().timeline.last_parts_rect.expect("parts rect");
    let view = h.state().timeline.view;
    let clip = h.state().timeline.parts_lane.clips.iter().find(|c| c.piece == PIECE).unwrap().clone();
    let at = clip.rect_in(parts, view.lead_inset, view.offset).center();

    h.event(egui::Event::PointerMoved(at));
    h.step();
    press(&mut h, at, egui::PointerButton::Secondary, true);
    press(&mut h, at, egui::PointerButton::Secondary, false);
    h.run_steps(2);
    h.get_by_label("Edit Flight as Keys").click();
    h.run_steps(2);
    wait_idle(&mut h);

    assert_eq!(h.state().transport.clock(), Clock::Keyframes);
    assert_eq!(h.state().session().selection(), vec![PIECE]);
    let scene = h.state().session().key_scene();
    let want = bm::keys::flight_keys_start(scene, clip.start);
    let fps = f64::from(scene.fps);
    let want = (want * fps).round() / fps;
    assert!((h.state().transport.time() - want).abs() < 1e-6, "time {} want {want}", h.state().transport.time());
}

#[test]
fn path_point_drag_is_one_undo_step() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    path_room(&mut h);
    bake(&mut h, PIECE);
    set_clock(&mut h, Clock::Keyframes);
    select(&mut h, &[PIECE]);
    h.run_steps(2);
    let dots = h.state().flights.dots.clone();
    assert!(dots.len() >= 2, "path dots {dots:?}");
    let (lo, hi) = (dots.iter().map(|d| d.0).min().unwrap(), dots.iter().map(|d| d.0).max().unwrap());
    let &(frame, at) = dots.iter().find(|(f, p)| *f != lo && *f != hi && open_view(&h, *p)).expect("a middle dot in view");
    let before = object_keys(&h, PIECE);
    let depth = h.state().session().undo_depth();

    h.event(egui::Event::PointerMoved(at));
    h.step();
    press(&mut h, at, egui::PointerButton::Primary, true);
    for i in 1..=6 {
        h.event(egui::Event::PointerMoved(at + vec2(30.0 * i as f32 / 6.0, 0.0)));
        h.step();
    }
    press(&mut h, at + vec2(30.0, 0.0), egui::PointerButton::Primary, false);
    h.run_steps(2);

    assert_eq!(h.state().session().undo_depth(), depth + 1, "one undo step");
    assert_ne!(object_keys(&h, PIECE), before, "the key at frame {frame} moved");
    assert_eq!(h.state().session().selection(), vec![PIECE], "the selection stays");
}

#[test]
fn motion_check_after_edit_says_changed() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    bake(&mut h, PIECE);
    set_clock(&mut h, Clock::Keyframes);
    select(&mut h, &[PIECE]);
    let node = h.get_by_label("Check Motion");
    node.scroll_to_me();
    h.run_steps(40);
    let at = h.get_by_label("Check Motion").rect().center();
    h.event(egui::Event::PointerMoved(at));
    h.step();
    press(&mut h, at, egui::PointerButton::Primary, true);
    press(&mut h, at, egui::PointerButton::Primary, false);
    assert!(h.state().audit.busy(), "the check started");
    edit_something(&mut h);
    wait_idle(&mut h);
    let check = h.state().flights.check.as_ref().expect("a result");
    assert_eq!(check.text, "The animation changed while it was being checked.");
    assert!(check.warning);
}

#[test]
fn use_edited_flight_in_build() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    // Piece 33 has no baked flight, so it has no route to send.
    brickmotion::flights::use_edited_flight(h.state_mut(), 33);
    h.run_steps(2);
    assert_eq!(last_warning(&h), "Use two visible poses with movement and no scale change to send this flight to Build.");
    assert_eq!(h.state().transport.clock(), Clock::Build);
}

fn path_open(h: &mut Harness<'static, BrickMotionApp>) {
    bake(h, PIECE);
    set_clock(h, Clock::Keyframes);
    select(h, &[PIECE]);
    h.run_steps(2);
}

/// Two clicks 20 ms apart (kittest's clock stands still unless set).
fn double_click(h: &mut Harness<'static, BrickMotionApp>, at: Pos2) {
    h.event(egui::Event::PointerMoved(at));
    h.step();
    let mut t = h.ctx.input(|i| i.time);
    for _ in 0..2 {
        for pressed in [true, false] {
            t += 0.02;
            h.input_mut().time = Some(t);
            press(h, at, egui::PointerButton::Primary, pressed);
        }
    }
}

/// A point in the open view, not under a floating panel.
fn open_view(h: &Harness<'static, BrickMotionApp>, p: Pos2) -> bool {
    h.ctx.layer_id_at(p) == Some(egui::LayerId::background())
}

fn click(h: &mut Harness<'static, BrickMotionApp>, at: Pos2) {
    h.event(egui::Event::PointerMoved(at));
    h.step();
    press(h, at, egui::PointerButton::Primary, true);
    press(h, at, egui::PointerButton::Primary, false);
}

#[test]
fn picked_path_point_deletes() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    path_room(&mut h);
    path_open(&mut h);
    let dots = h.state().flights.dots.clone();
    let (lo, hi) = (dots.iter().map(|d| d.0).min().unwrap(), dots.iter().map(|d| d.0).max().unwrap());
    let &(frame, at) = dots.iter().find(|(f, p)| *f != lo && *f != hi && open_view(&h, *p)).expect("a middle dot in view");
    click(&mut h, at);
    h.run_steps(2);
    assert_eq!(h.state().flights.picked(), Some((PIECE, frame)));
    let depth = h.state().session().undo_depth();
    for pressed in [true, false] {
        h.event(egui::Event::Key { key: egui::Key::Backspace, physical_key: None, pressed, repeat: false, modifiers: egui::Modifiers::NONE });
    }
    h.run_steps(3);
    assert_eq!(h.state().session().undo_depth(), depth + 1);
    assert_eq!(h.state().flights.dots.len(), dots.len() - 1);
    assert_eq!(h.state().session().selection(), vec![PIECE], "the selection stays");
}

#[test]
fn double_click_line_adds_point() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    path_room(&mut h);
    path_open(&mut h);
    // A bake keys every flight frame, so free a frame first: delete a middle dot clear of its
    // neighbours, then double-click the line where it was.
    let dots = h.state().flights.dots.clone();
    let (lo, hi) = (dots.iter().map(|d| d.0).min().unwrap(), dots.iter().map(|d| d.0).max().unwrap());
    let clear = |p: Pos2, frame: i32| dots.iter().filter(|d| d.0 != frame).all(|d| d.1.distance(p) > 12.0);
    let &(frame, at) = dots
        .iter()
        .find(|(f, p)| *f != lo && *f != hi && open_view(&h, *p) && clear(*p, *f))
        .expect("a middle dot clear of the others");
    click(&mut h, at);
    h.run_steps(2);
    for pressed in [true, false] {
        h.event(egui::Event::Key { key: egui::Key::Backspace, physical_key: None, pressed, repeat: false, modifiers: egui::Modifiers::NONE });
    }
    h.run_steps(3);
    assert_eq!(h.state().flights.dots.len(), dots.len() - 1, "the dot went");
    let (_, line_at) = *h.state().flights.samples.iter().flatten().find(|(f, _)| *f == frame).expect("the line still runs there");
    let depth = h.state().session().undo_depth();
    double_click(&mut h, line_at);
    h.run_steps(3);
    assert_eq!(h.state().session().undo_depth(), depth + 1, "one point added");
    assert_eq!(h.state().flights.dots.len(), dots.len());
    assert!(h.state().flights.dots.iter().any(|d| d.0 == frame), "back at frame {frame}");
    assert_eq!(h.state().session().selection(), vec![PIECE], "the selection stays");
}

#[test]
fn check_motion_reports_and_shows_contacts() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    path_open(&mut h);
    brickmotion::flights::check_motion(h.state_mut());
    wait_idle(&mut h);
    let check = h.state().flights.check.clone().expect("a result");
    assert!(check.text.starts_with("No crossings found in ") || check.text.contains(" across "), "{}", check.text);
    assert!(check.text.ends_with('.'));
    if let Some(c) = check.contacts.first() {
        brickmotion::flights::show_contact(h.state_mut(), c);
        h.run_steps(2);
        let mut sel = h.state().session().selection();
        sel.sort_unstable();
        let mut want = vec![c.a, c.b];
        want.sort_unstable();
        assert_eq!(sel, want);
        let scene = h.state().session().key_scene();
        assert_eq!(h.state().transport.key_frame(&scene), c.first_frame);
    }
}

// ---- Task 11: Build Motion panel ----

use bm::motion::{MotionFields, MotionScope, effective_motion, flight_phases};
use brickmotion::chrome::motion_panel::{self, MotionTarget};
use egui_kittest::kittest::NodeT;

/// The helicopter in Animate, no plan needed.
fn animate() -> Harness<'static, BrickMotionApp> {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
        app.wait_loaded();
        app.dialogs_off();
        app.prefs.auto_plan = false;
        app
    });
    h.run_steps(3);
    h.state_mut().set_workspace(Workspace::Animate);
    h.run_steps(2);
    h
}

fn open_motion(h: &mut Harness<'static, BrickMotionApp>, scope: MotionScope, pieces: &[u32]) {
    motion_panel::open(h.state_mut(), MotionTarget { scope, step: 0, pieces: pieces.to_vec() });
    h.run_steps(3);
}

fn own(h: &Harness<'static, BrickMotionApp>, scope: MotionScope, pieces: &[u32]) -> MotionFields {
    h.state().session().motion_fields(scope, 0, pieces)
}

/// Scrolls a panel widget into view and returns its centre.
fn reveal(h: &mut Harness<'static, BrickMotionApp>, role: egui::accesskit::Role, label: &str) -> egui::Rect {
    h.get_by_role_and_label(role, label).scroll_to_me();
    h.run_steps(40);
    h.get_by_role_and_label(role, label).rect()
}

fn tap(h: &mut Harness<'static, BrickMotionApp>, at: Pos2) {
    click(h, at);
    h.run_steps(2);
}

#[test]
fn motion_slider_commits_once() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate();
    open_motion(&mut h, MotionScope::Project, &[]);
    let r = reveal(&mut h, egui::accesskit::Role::Slider, "Duration");
    let commits = h.state().motion.commits;
    let depth = h.state().session().undo_depth();
    let from = egui::pos2(r.left() + 10.0, r.center().y);
    h.event(egui::Event::PointerMoved(from));
    h.step();
    press(&mut h, from, egui::PointerButton::Primary, true);
    for i in 1..=10 {
        h.event(egui::Event::PointerMoved(from + vec2(r.width() * 0.6 * i as f32 / 10.0, 0.0)));
        h.step();
    }
    assert_eq!(h.state().motion.commits, commits, "nothing commits while dragging");
    press(&mut h, from + vec2(r.width() * 0.6, 0.0), egui::PointerButton::Primary, false);
    h.run_steps(2);
    assert_eq!(h.state().motion.commits, commits + 1, "one set_motion_fields call");
    assert_eq!(h.state().session().undo_depth(), depth + 1, "one undo step");
    assert!(own(&h, MotionScope::Project, &[]).time > 1.0);
}

#[test]
fn inherited_values_show() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate();
    let project = MotionFields { landing: 0.4, ..MotionFields::default() };
    assert!(h.state_mut().doc.session().set_motion_fields(MotionScope::Project, 0, &[], project).refused.is_none());
    open_motion(&mut h, MotionScope::Parts, &[PIECE]);
    reveal(&mut h, egui::accesskit::Role::Button, "Landing value");
    let shown = h.get_by_role_and_label(egui::accesskit::Role::Button, "Landing value").accesskit_node().value();
    assert_eq!(shown.as_deref(), Some("Inherit · 40%"));
    assert_eq!(own(&h, MotionScope::Parts, &[PIECE]).landing, -1.0, "its own field stays unset");
}

#[test]
fn reset_to_inherited() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate();
    let parts = MotionFields { landing: 0.3, ..MotionFields::default() };
    assert!(h.state_mut().doc.session().set_motion_fields(MotionScope::Parts, 0, &[PIECE], parts).refused.is_none());
    open_motion(&mut h, MotionScope::Parts, &[PIECE]);
    let shown = h.get_by_role_and_label(egui::accesskit::Role::Button, "Landing value").accesskit_node().value();
    assert_eq!(shown.as_deref(), Some("30%"));
    let depth = h.state().session().undo_depth();
    let r = reveal(&mut h, egui::accesskit::Role::Button, "Reset landing");
    tap(&mut h, r.center());
    assert_eq!(own(&h, MotionScope::Parts, &[PIECE]).landing, -1.0);
    assert_eq!(h.state().session().undo_depth(), depth + 1);
}

#[test]
fn flight_timing_bar_matches_phases() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate();
    let project = MotionFields { time: 1.0, landing: 0.3, hover: 0.2, ease: 0 };
    assert!(h.state_mut().doc.session().set_motion_fields(MotionScope::Project, 0, &[], project).refused.is_none());
    open_motion(&mut h, MotionScope::Project, &[]);
    let p = flight_phases(effective_motion(h.state().session(), MotionScope::Project, 0, project));
    let pct = |v: f64| format!("{}%", (v * 100.0).round() as i64);
    let want = format!("Travel {}, hover {}, landing {}", pct(p.travel), pct(p.hover), pct(p.landing));
    assert_eq!(want, "Travel 50%, hover 20%, landing 30%");
    let shown = h.get_by_label("Flight timing").accesskit_node().value();
    assert_eq!(shown.as_deref(), Some(want.as_str()));
}

#[test]
fn preset_sets_all_fields() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate();
    open_motion(&mut h, MotionScope::Project, &[]);
    let depth = h.state().session().undo_depth();
    let r = reveal(&mut h, egui::accesskit::Role::Button, "Precise Seating");
    tap(&mut h, r.center());
    assert_eq!(own(&h, MotionScope::Project, &[]), MotionFields { time: 1.4, landing: 0.45, hover: 0.12, ease: 2 });
    assert_eq!(h.state().session().undo_depth(), depth + 1, "one undo step");
    let r = reveal(&mut h, egui::accesskit::Role::Button, "Reset All");
    tap(&mut h, r.center());
    assert_eq!(own(&h, MotionScope::Project, &[]), MotionFields::default());
}

#[test]
fn clip_menu_opens_part_motion() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    let dur = h.state().transport.duration();
    let clip = h.state().timeline.parts_lane.clips.iter().find(|c| c.piece == PIECE).expect("a clip").clone();
    h.state_mut().timeline.view.zoom_by(32.0, clip.start, dur);
    h.state_mut().timeline.view.reveal(clip.start, dur, true);
    h.run_steps(3);
    let parts = h.state().timeline.last_parts_rect.expect("parts rect");
    let view = h.state().timeline.view;
    let clip = h.state().timeline.parts_lane.clips.iter().find(|c| c.piece == PIECE).unwrap().clone();
    let at = clip.rect_in(parts, view.lead_inset, view.offset).center();
    h.event(egui::Event::PointerMoved(at));
    h.step();
    press(&mut h, at, egui::PointerButton::Secondary, true);
    press(&mut h, at, egui::PointerButton::Secondary, false);
    h.run_steps(2);
    h.get_by_label("Motion…").click();
    h.run_steps(3);
    let target = h.state().motion.target.clone().expect("the panel opened");
    assert_eq!(target.scope, MotionScope::Parts);
    assert_eq!(target.pieces, vec![PIECE]);
    assert_eq!(target.step, clip.step as usize);
    assert!(h.query_by_label("Build Motion panel").is_some());
}

#[test]
fn step_menu_opens_step_motion() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    let at = h.query_all_by_label("Step 2").next().expect("Step 2 run").rect().center();
    h.event(egui::Event::PointerMoved(at));
    h.step();
    press(&mut h, at, egui::PointerButton::Secondary, true);
    press(&mut h, at, egui::PointerButton::Secondary, false);
    h.run_steps(2);
    h.get_by_label("Step Motion…").click();
    h.run_steps(3);
    let target = h.state().motion.target.clone().expect("the panel opened");
    assert_eq!((target.scope, target.step), (MotionScope::Step, 1));
}

// ---- Final review fixes ----

#[test]
fn build_workspace_leaves_the_keyframes_clock() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate();
    h.state_mut().keys.auto_key = true;
    set_clock(&mut h, Clock::Keyframes);
    assert!(h.state().viewport.auto_key.is_some(), "Auto Key on in Animate");
    h.state_mut().set_workspace(Workspace::Build);
    h.run_steps(3);
    assert_eq!(h.state().transport.clock(), Clock::Build);
    assert!(h.state().viewport.auto_key.is_none(), "a drag in Build moves parts and writes no keys");
}

#[test]
fn camera_key_selection_clears_on_clock_switch() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    {
        let app = h.state_mut();
        let vp = app.doc.viewport().expect("viewport");
        app.transport.seek(vp, 2.0);
    }
    h.run_steps(2);
    assert!(run(h.state_mut(), "video.camera_key"));
    h.run_steps(3);
    assert!(h.state().camera_selection.is_some(), "the new Build key is selected");
    set_clock(&mut h, Clock::Keyframes);
    assert_eq!(h.state().camera_selection, None, "a Build key is not a Keyframes time");
}

#[test]
fn dope_sheet_pick_takes_delete_from_path_point() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    path_room(&mut h);
    path_open(&mut h);
    let dots = h.state().flights.dots.clone();
    let (lo, hi) = (dots.iter().map(|d| d.0).min().unwrap(), dots.iter().map(|d| d.0).max().unwrap());
    let &(frame, at) = dots.iter().find(|(f, p)| *f != lo && *f != hi && open_view(&h, *p)).expect("a middle dot in view");
    click(&mut h, at);
    h.run_steps(2);
    assert_eq!(h.state().flights.picked(), Some((PIECE, frame)));
    // Now pick a different key in the dope sheet (baked keys sit a frame apart, so aim well clear).
    let target = dots
        .iter()
        .map(|d| d.0)
        .filter(|f| (*f - frame).abs() > 3)
        .find_map(|f| h.query_by_label(&format!("Position X key at frame {f}")).map(|n| n.rect().center()))
        .expect("a dope-sheet key on screen");
    click(&mut h, target);
    h.run_steps(2);
    let picks: Vec<_> = h.state().keys.picks.iter().copied().collect();
    assert_eq!(picks.len(), 1, "one dope-sheet key picked: {picks:?}");
    let other = picks[0];
    assert_ne!(other.1, frame);
    let dots_before = h.state().flights.dots.len();
    for pressed in [true, false] {
        h.event(egui::Event::Key { key: egui::Key::Backspace, physical_key: None, pressed, repeat: false, modifiers: egui::Modifiers::NONE });
    }
    h.run_steps(3);
    let keys = object_keys(&h, PIECE);
    assert!(!keys.iter().any(|k| k.channel == other.0 && k.frame == other.1), "the dope-sheet key went");
    assert!(keys.iter().any(|k| k.channel == bm::keys::KeyChannel::PositionX && k.frame == frame), "the path point stayed");
    assert!(h.state().flights.dots.len() <= dots_before);
}

#[test]
fn build_motion_from_ribbon_uses_the_parts_step() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate();
    let (step, piece) = {
        let s = h.state().session();
        (1..s.steps().len())
            .find_map(|st| s.step_items(st).into_iter().find(|i| !i.submodel && !i.pieces.is_empty()).map(|i| (st, i.pieces[0])))
            .expect("a loose part after step 1")
    };
    h.state_mut().edit.step = Some(0);
    select(&mut h, &[piece]);
    assert!(run(h.state_mut(), "motion.build"));
    h.run_steps(3);
    let t = h.state().motion.target.clone().expect("open");
    assert_eq!(t.scope, MotionScope::Parts);
    assert_eq!(t.step, step, "the step that holds the part, not the chosen step");
}

#[test]
fn build_motion_closes_when_its_parts_go() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate();
    select(&mut h, &[33]);
    assert!(run(h.state_mut(), "motion.build"));
    h.run_steps(3);
    assert!(h.state().motion.target.is_some());
    assert!(h.state_mut().doc.session().remove(&[33]).refused.is_none());
    h.run_steps(3);
    assert!(h.state().motion.target.is_none(), "piece indices moved; the panel would edit other parts");
}

#[test]
fn contact_click_keeps_the_keys_panel() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    path_open(&mut h);
    assert!(h.query_by_label("Keys panel").is_some());
    let first = h.state().session().key_scene().first;
    let contact = bm::motion::MotionContact { a: PIECE, b: 33, first_frame: first, last_frame: first, part: "a".into(), blocker: "b".into() };
    h.state_mut().flights.check = Some(brickmotion::flights::CheckResult {
        text: "1 crossing.".into(),
        warning: true,
        contacts: vec![contact.clone()],
        key: brickmotion::flights::doc_key(h.state()),
    });
    brickmotion::flights::show_contact(h.state_mut(), &contact);
    h.run_steps(3);
    let mut sel = h.state().session().selection();
    sel.sort_unstable();
    assert_eq!(sel, vec![PIECE, 33], "both parts shown");
    assert!(h.query_by_label("Keys panel").is_some(), "the checked object's panel stays open");
}

#[test]
fn stale_bake_confirm_is_dropped() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    bake(&mut h, PIECE);
    assert!(run(h.state_mut(), "video.bake_flight"));
    h.run_steps(2);
    assert!(h.state().flights.confirm.is_some(), "confirm modal open");
    // Document changes while confirm dialog is up.
    edit_something(&mut h);
    let depth = h.state().session().undo_depth();
    h.get_by_label("Replace Keys").click();
    h.run_steps(2);
    wait_idle(&mut h);
    assert_eq!(h.state().session().undo_depth(), depth, "stale bake must not apply");
    assert!(h.state().flights.note.as_deref().is_some_and(|n| n.contains("changed")));
}
