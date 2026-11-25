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
