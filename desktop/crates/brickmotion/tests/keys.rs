// The Keyframes clock beside the Build clock.
use std::time::{Duration, Instant};

use bm::keys::KeyScene;
use brickmotion::transport::Clock;
use brickmotion::{BrickMotionApp, Workspace};
use egui_kittest::Harness;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn heli_harness() -> Harness<'static, BrickMotionApp> {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
        app.wait_loaded();
        app.dialogs_off();
        app.prefs.auto_plan = false;
        app.apply_viewport_prefs();
        app
    });
    h.run_steps(3);
    h
}

fn unlinked_scene() -> KeyScene {
    KeyScene { fps: 24, first: 1, last: 49, build_linked: false, ..KeyScene::default() }
}

fn set_clock(h: &mut Harness<'static, BrickMotionApp>, clock: Clock) {
    let app = h.state_mut();
    let vp = app.doc.viewport().expect("viewport");
    app.transport.set_clock(vp, clock);
    h.run_steps(2);
}

fn seek_scene(h: &mut Harness<'static, BrickMotionApp>, seconds: f64) {
    let app = h.state_mut();
    let vp = app.doc.viewport().expect("viewport");
    app.transport.seek_scene(vp, seconds);
    h.run_steps(2);
}

fn key_frame(h: &Harness<'static, BrickMotionApp>) -> i32 {
    let scene = h.state().session().key_scene();
    h.state().transport.key_frame(&scene)
}

fn plan_ready(h: &mut Harness<'static, BrickMotionApp>, timeout: Duration) {
    {
        let app = h.state_mut();
        let vp = app.doc.viewport().expect("viewport");
        app.transport.plan(vp);
    }
    let deadline = Instant::now() + timeout;
    loop {
        h.step();
        if h.state().transport.ready() {
            return;
        }
        assert!(Instant::now() < deadline, "plan never became ready");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn keyframes_clock_needs_no_plan() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().set_workspace(Workspace::Animate);
    h.state_mut().doc.session().set_key_scene(unlinked_scene());
    h.run_steps(2);
    set_clock(&mut h, Clock::Keyframes);
    assert_eq!(h.state().transport.clock(), Clock::Keyframes);
    assert!(!h.state().transport.ready(), "auto-plan is off");
    assert!((h.state().transport.duration() - 2.0).abs() < 1e-9, "duration {}", h.state().transport.duration());
    assert!((brickmotion::transport::Transport::scene_length(&unlinked_scene()) - 2.0).abs() < 1e-9);

    seek_scene(&mut h, 1.0);
    assert_eq!(key_frame(&h), 25);

    h.state_mut().doc.session().set_key_scene(KeyScene { build_linked: true, ..unlinked_scene() });
    h.run_steps(3);
    assert_eq!(h.state().transport.duration(), 0.0, "a linked scene shows no time before a plan");
    assert_eq!(h.state().transport.time(), 0.0);
}

#[test]
fn clock_switch_stops_playback() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().set_workspace(Workspace::Animate);
    h.state_mut().doc.session().set_key_scene(unlinked_scene());
    plan_ready(&mut h, Duration::from_secs(60));
    {
        let app = h.state_mut();
        let vp = app.doc.viewport().expect("viewport");
        app.transport.seek(vp, 1.0);
        app.transport.toggle(vp);
    }
    h.run_steps(2);
    assert!(h.state().transport.state.playing, "Build clock plays");

    set_clock(&mut h, Clock::Keyframes);
    assert!(!h.state().transport.state.playing, "switching clocks stops playback");
    assert_eq!(h.state().transport.time(), 0.0);
    assert_eq!(key_frame(&h), 1);

    set_clock(&mut h, Clock::Build);
    assert!(!h.state().transport.state.playing);
    assert_eq!(h.state().transport.clock(), Clock::Build);
}

#[test]
fn clock_survives_replan() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().set_workspace(Workspace::Animate);
    h.state_mut().doc.session().set_key_scene(unlinked_scene());
    h.run_steps(2);
    set_clock(&mut h, Clock::Keyframes);
    seek_scene(&mut h, 1.0);
    assert_eq!(key_frame(&h), 25);

    plan_ready(&mut h, Duration::from_secs(60));
    h.run_steps(3);
    assert_eq!(h.state().transport.clock(), Clock::Keyframes);
    assert_eq!(key_frame(&h), 25, "a plan becoming Ready must not move the Keyframes playhead");
}

#[test]
fn document_switch_resets_to_build() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().set_workspace(Workspace::Animate);
    h.state_mut().doc.session().set_key_scene(unlinked_scene());
    h.run_steps(2);
    set_clock(&mut h, Clock::Keyframes);
    h.state_mut().transport.reset();
    assert_eq!(h.state().transport.clock(), Clock::Build);
}

#[test]
fn header_switch_picks_the_clock() {
    use egui_kittest::kittest::Queryable;
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().set_workspace(Workspace::Animate);
    h.state_mut().doc.session().set_key_scene(unlinked_scene());
    h.run_steps(3);
    h.get_by_label("Keyframes clock").click();
    h.run_steps(3);
    assert_eq!(h.state().transport.clock(), Clock::Keyframes);
    assert!((h.state().transport.duration() - 2.0).abs() < 1e-9);
    // The Build track and its lanes are hidden on the Keyframes clock.
    assert!(h.query_by_label("Build track").is_none(), "Build track hidden on Keyframes");
    h.get_by_label("Build clock").click();
    h.run_steps(3);
    assert_eq!(h.state().transport.clock(), Clock::Build);
}

#[test]
fn shift_arrows_go_to_keys_on_keyframes() {
    use bm::keys::{KeyChannel, Keyframe};
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().set_workspace(Workspace::Animate);
    {
        let s = h.state_mut().doc.session();
        s.set_key_scene(unlinked_scene());
        let keys = [Keyframe::new(KeyChannel::PositionX, 10, 0.0), Keyframe::new(KeyChannel::PositionX, 30, 5.0)];
        assert!(s.set_keys(0, &keys, false, false).refused.is_none());
    }
    h.run_steps(2);
    set_clock(&mut h, Clock::Keyframes);
    for (key, want) in [(egui::Key::ArrowRight, 10), (egui::Key::ArrowRight, 30), (egui::Key::ArrowLeft, 10)] {
        for pressed in [true, false] {
            h.event(egui::Event::Key { key, physical_key: None, pressed, repeat: false, modifiers: egui::Modifiers::SHIFT });
        }
        h.run_steps(2);
        assert_eq!(key_frame(&h), want);
    }
    // Home is Build-only: the Keyframes playhead stays.
    for pressed in [true, false] {
        h.event(egui::Event::Key { key: egui::Key::Home, physical_key: None, pressed, repeat: false, modifiers: egui::Modifiers::NONE });
    }
    h.run_steps(2);
    assert_eq!(key_frame(&h), 10);
}

// ---- Task 9: Keys track, dope sheet, Keys panel and Auto Key ----

use bm::keys::{Interpolation, KeyChannel, Keyframe};
use egui::{Pos2, pos2};
use egui_kittest::kittest::Queryable;

fn press(h: &mut Harness<'static, BrickMotionApp>, pos: Pos2, button: egui::PointerButton, pressed: bool, modifiers: egui::Modifiers) {
    h.event(egui::Event::PointerButton { pos, button, pressed, modifiers });
    h.step();
}

fn drag_x(h: &mut Harness<'static, BrickMotionApp>, from: Pos2, dx: f32, frames: usize) {
    h.event(egui::Event::PointerMoved(from));
    h.step();
    press(h, from, egui::PointerButton::Primary, true, egui::Modifiers::NONE);
    for i in 1..=frames {
        h.event(egui::Event::PointerMoved(from + egui::vec2(dx * i as f32 / frames as f32, 0.0)));
        h.step();
    }
    press(h, from + egui::vec2(dx, 0.0), egui::PointerButton::Primary, false, egui::Modifiers::NONE);
    h.run_steps(2);
}

fn click_at(h: &mut Harness<'static, BrickMotionApp>, at: Pos2, modifiers: egui::Modifiers) {
    h.event(egui::Event::PointerMoved(at));
    h.step();
    // Held keys reach egui as the frame's modifiers, as the window reports them.
    h.event(egui::Event::ModifiersChanged(modifiers));
    press(h, at, egui::PointerButton::Primary, true, modifiers);
    press(h, at, egui::PointerButton::Primary, false, modifiers);
    h.event(egui::Event::ModifiersChanged(egui::Modifiers::NONE));
    h.run_steps(2);
}

/// Pieces 32 and 33 are loose parts (0–31 form a submodel).
/// The helicopter on the Keyframes clock (fps 24, frames 1–49) with Keys open.
/// A piece and the keys it starts with: channel, frame, value.
type Keys<'a> = (u32, &'a [(KeyChannel, i32, f64)]);

fn keyed(keys: &[Keys<'_>]) -> Harness<'static, BrickMotionApp> {
    let mut h = heli_harness();
    h.state_mut().set_workspace(Workspace::Animate);
    {
        let s = h.state_mut().doc.session();
        s.set_key_scene(unlinked_scene());
        for (piece, list) in keys {
            let k: Vec<Keyframe> = list.iter().map(|(c, f, v)| Keyframe::new(*c, *f, *v)).collect();
            assert!(s.set_keys(*piece, &k, false, false).refused.is_none());
        }
    }
    h.run_steps(2);
    set_clock(&mut h, Clock::Keyframes);
    h.run_steps(3);
    h
}

fn object_keys(h: &Harness<'static, BrickMotionApp>, piece: u32) -> Vec<Keyframe> {
    h.state().session().key_objects().into_iter().find(|o| o.piece == piece && !o.submodel).map(|o| o.keys).unwrap_or_default()
}

fn choose(h: &mut Harness<'static, BrickMotionApp>, piece: u32) {
    h.state_mut().doc.session().select(&[piece], bm::SelectMode::Replace);
    h.run_steps(3);
}

fn key_rect(h: &Harness<'static, BrickMotionApp>, channel: KeyChannel, frame: i32) -> egui::Rect {
    h.get_by_label(&format!("{} key at frame {frame}", channel.title())).rect()
}

/// Screen pixels per key-scene frame on the Keyframes clock.
fn px_per_frame(h: &Harness<'static, BrickMotionApp>) -> f32 {
    let a = key_rect(h, KeyChannel::PositionX, 10).center().x;
    let b = key_rect(h, KeyChannel::PositionX, 30).center().x;
    (b - a) / 20.0
}

#[test]
fn insert_key_at_playhead() {
    if !bm::metal_available() {
        return;
    }
    let mut h = keyed(&[]);
    seek_scene(&mut h, 0.5);
    choose(&mut h, 32);
    assert!(h.query_by_label("Keys panel").is_some(), "choosing an object opens the Keys panel");
    let field = h.get_by_role_and_label(egui::accesskit::Role::TextInput, "Position X value");
    field.focus();
    h.run_steps(1);
    h.get_by_role_and_label(egui::accesskit::Role::TextInput, "Position X value").type_text("2");
    h.key_press(egui::Key::Enter);
    h.run_steps(3);
    let frame = key_frame(&h);
    assert_eq!(frame, 13);
    let k = object_keys(&h, 32);
    assert!(k.iter().any(|k| k.channel == KeyChannel::PositionX && k.frame == frame && (k.value - 2.0).abs() < 1e-9), "{k:?}");
}

#[test]
fn key_selection_follows_retime() {
    if !bm::metal_available() {
        return;
    }
    let mut h = keyed(&[(32, &[(KeyChannel::PositionX, 10, 0.0), (KeyChannel::PositionX, 30, 5.0), (KeyChannel::PositionY, 10, 1.0)])]);
    choose(&mut h, 32);
    let a = key_rect(&h, KeyChannel::PositionX, 10).center();
    click_at(&mut h, a, egui::Modifiers::NONE);
    let b = key_rect(&h, KeyChannel::PositionY, 10).center();
    click_at(&mut h, b, egui::Modifiers::COMMAND);
    assert_eq!(h.state().keys.picks.len(), 2);
    let ppf = px_per_frame(&h);
    let depth = h.state().session().undo_depth();
    let from = key_rect(&h, KeyChannel::PositionX, 10).center();
    drag_x(&mut h, from, 5.0 * ppf, 6);
    let k = object_keys(&h, 32);
    assert!(k.iter().any(|k| k.channel == KeyChannel::PositionX && k.frame == 15));
    assert!(k.iter().any(|k| k.channel == KeyChannel::PositionY && k.frame == 15));
    assert!(k.iter().any(|k| k.channel == KeyChannel::PositionX && k.frame == 30), "an unpicked key stays");
    assert_eq!(h.state().session().undo_depth(), depth + 1, "one move_keys call");
    let picks = &h.state().keys.picks;
    assert!(picks.contains(&(KeyChannel::PositionX, 15)) && picks.contains(&(KeyChannel::PositionY, 15)), "{picks:?}");
}

#[test]
fn retime_drag_is_one_call() {
    if !bm::metal_available() {
        return;
    }
    let mut h = keyed(&[(32, &[(KeyChannel::PositionX, 10, 0.0), (KeyChannel::PositionX, 30, 5.0)])]);
    choose(&mut h, 32);
    let ppf = px_per_frame(&h);
    let depth = h.state().session().undo_depth();
    let from = key_rect(&h, KeyChannel::PositionX, 10).center();
    drag_x(&mut h, from, 12.0 * ppf, 12);
    assert_eq!(h.state().session().undo_depth(), depth + 1);
    assert!(object_keys(&h, 32).iter().any(|k| k.frame == 22));
}

#[test]
fn retime_clamps_to_scene() {
    if !bm::metal_available() {
        return;
    }
    let mut h = keyed(&[(32, &[(KeyChannel::PositionX, 10, 0.0), (KeyChannel::PositionX, 30, 5.0)])]);
    choose(&mut h, 32);
    let ppf = px_per_frame(&h);
    let from = key_rect(&h, KeyChannel::PositionX, 30).center();
    drag_x(&mut h, from, 40.0 * ppf, 8);
    let scene = h.state().session().key_scene();
    let (_, upper) = bm::keys::key_offset_limits(scene, 30, 30);
    assert!(object_keys(&h, 32).iter().any(|k| k.frame == 30 + upper), "{:?}", object_keys(&h, 32));
}

#[test]
fn interpolation_change() {
    if !bm::metal_available() {
        return;
    }
    let mut h = keyed(&[(32, &[(KeyChannel::PositionX, 10, 0.0), (KeyChannel::PositionX, 30, 5.0)])]);
    choose(&mut h, 32);
    let at = key_rect(&h, KeyChannel::PositionX, 10).center();
    h.event(egui::Event::PointerMoved(at));
    h.step();
    press(&mut h, at, egui::PointerButton::Secondary, true, egui::Modifiers::NONE);
    press(&mut h, at, egui::PointerButton::Secondary, false, egui::Modifiers::NONE);
    h.run_steps(2);
    h.get_by_role_and_label(egui::accesskit::Role::Button, "Linear").click();
    h.run_steps(3);
    let k = object_keys(&h, 32);
    assert_eq!(k.iter().find(|k| k.frame == 10).unwrap().interpolation, Interpolation::Linear);
    assert_eq!(k.iter().find(|k| k.frame == 30).unwrap().interpolation, Interpolation::Smooth);
}

#[test]
fn prev_next_key() {
    if !bm::metal_available() {
        return;
    }
    let mut h = keyed(&[(32, &[(KeyChannel::PositionX, 20, 0.0)]), (33, &[(KeyChannel::PositionX, 10, 0.0), (KeyChannel::PositionX, 40, 1.0)])]);
    choose(&mut h, 32);
    for pressed in [true, false] {
        h.event(egui::Event::Key { key: egui::Key::ArrowRight, physical_key: None, pressed, repeat: false, modifiers: egui::Modifiers::SHIFT });
    }
    h.run_steps(2);
    assert_eq!(key_frame(&h), 20, "the chosen object's keys only");
    for pressed in [true, false] {
        h.event(egui::Event::Key { key: egui::Key::ArrowRight, physical_key: None, pressed, repeat: false, modifiers: egui::Modifiers::SHIFT });
    }
    h.run_steps(2);
    assert_eq!(key_frame(&h), 20, "no later key on the chosen object");
}

#[test]
fn link_build_extends_scene() {
    if !bm::metal_available() {
        return;
    }
    let mut h = keyed(&[]);
    plan_ready(&mut h, Duration::from_secs(60));
    h.run_steps(3);
    choose(&mut h, 32);
    let build = h.state().transport.build_duration();
    assert!(build > 2.0);
    let node = h.get_by_role_and_label(egui::accesskit::Role::Switch, "Follow build");
    node.scroll_to_me();
    h.run_steps(40);
    let at = h.get_by_role_and_label(egui::accesskit::Role::Switch, "Follow build").rect().center();
    click_at(&mut h, at, egui::Modifiers::NONE);
    let scene = h.state().session().key_scene();
    assert!(scene.build_linked);
    assert_eq!(scene, bm::keys::linked_key_scene(unlinked_scene(), true, build));
    assert!(scene.last > 49, "the scene grows to hold the build");
}

#[test]
fn auto_key_drag_is_one_undo_step() {
    if !bm::metal_available() {
        return;
    }
    let mut h = keyed(&[]);
    seek_scene(&mut h, 0.5);
    choose(&mut h, 32);
    h.state_mut().keys.auto_key = true;
    assert!(brickmotion::run(h.state_mut(), "model.move"));
    h.run_steps(2);
    let before = h.state().session().copy(&[32]);
    let depth = h.state().session().undo_depth();
    let rect = h.state().viewport_rect().expect("viewport rect");
    let (a, b, _) = h.state().gizmo_line(0).expect("line 0");
    let to = |v: bm::Vec2| pos2(rect.left() + v.x as f32, rect.top() + v.y as f32);
    let start = to(b);
    let dir = (to(b) - to(a)).normalized();
    h.event(egui::Event::PointerMoved(start));
    press(&mut h, start, egui::PointerButton::Primary, true, egui::Modifiers::NONE);
    for k in 1..=8 {
        h.event(egui::Event::PointerMoved(start + dir * (k as f32 * 15.0)));
        h.step();
    }
    press(&mut h, start + dir * 120.0, egui::PointerButton::Primary, false, egui::Modifiers::NONE);
    h.run_steps(2);
    assert_eq!(h.state().session().undo_depth(), depth + 1, "one undo step");
    assert_eq!(h.state().session().copy(&[32]), before, "Auto Key keys the piece instead of moving it");
    let total = h.state().last_auto_key_change().expect("an Auto Key drag ran");
    let want = bm::keys::auto_key_values(bm::keys::GizmoTool::Move, bm::Vec3::ZERO, total, 13);
    let got = object_keys(&h, 32);
    for w in &want {
        assert!(got.iter().any(|k| k.channel == w.channel && k.frame == 13 && (k.value - w.value).abs() < 1e-6), "{w:?} in {got:?}");
    }
}

#[test]
fn group_rows_move_together() {
    if !bm::metal_available() {
        return;
    }
    let mut h = keyed(&[(32, &[(KeyChannel::PositionX, 10, 0.0)]), (33, &[(KeyChannel::PositionX, 10, 0.0)])]);
    assert!(brickmotion::run(h.state_mut(), "video.group"));
    assert!(h.state().keys.group_rows);
    h.run_steps(2);
    let a = h.get_by_label(&format!("{}, frame 10", h.state().keys.objects.iter().find(|o| o.piece == 32 && !o.submodel).unwrap().name)).rect();
    let b = h.get_by_label(&format!("{}, frame 10", h.state().keys.objects.iter().find(|o| o.piece == 33 && !o.submodel).unwrap().name)).rect();
    let _ = b;
    // Grouped rows: picking a frame on one row picks it on every row.
    click_at(&mut h, a.center(), egui::Modifiers::NONE);
    assert_eq!(h.state().keys.row_picks.len(), 2);
    let lane = h.state().timeline.last_lanes_rect.unwrap();
    let dur = h.state().transport.duration();
    let ppf = (h.state().timeline.view.screen_x(1.0 / 24.0, dur) - h.state().timeline.view.screen_x(0.0, dur)) as f32;
    let _ = lane;
    drag_x(&mut h, a.center(), 6.0 * ppf, 6);
    assert_eq!(object_keys(&h, 32)[0].frame, 16);
    assert_eq!(object_keys(&h, 33)[0].frame, 16);
}

#[test]
#[ignore]
fn big_model_keys_track() {
    let Ok(path) = std::env::var("BM_BIG_MODEL") else { return };
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(path.into()));
        app.wait_loaded();
        app.dialogs_off();
        app.prefs.auto_plan = false;
        app
    });
    h.run_steps(3);
    h.state_mut().set_workspace(Workspace::Animate);
    h.state_mut().doc.session().set_key_scene(unlinked_scene());
    set_clock(&mut h, Clock::Keyframes);
    h.run_steps(3);
    let builds = h.state().keys.builds();
    let mut worst = Duration::ZERO;
    for _ in 0..10 {
        let t0 = Instant::now();
        h.step();
        worst = worst.max(t0.elapsed());
    }
    assert_eq!(h.state().keys.builds(), builds, "objects built once");
    eprintln!("worst Keys frame {worst:?}");
    assert!(worst < Duration::from_millis(16), "frame {worst:?}");
}
