// The Camera track on both clocks: keys from the view, drag, Auto-Direct, Follow Camera.
use std::time::{Duration, Instant};

use bm::camera::CameraClock;
use bm::keys::KeyScene;
use brickmotion::chrome::camera_lane::CameraPick;
use brickmotion::transport::Clock;
use brickmotion::{BrickMotionApp, Workspace, run};
use egui::{Pos2, pos2};
use egui_kittest::Harness;
use egui_kittest::kittest::{NodeT, Queryable};

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

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

fn seek(h: &mut Harness<'static, BrickMotionApp>, seconds: f64) {
    let app = h.state_mut();
    let vp = app.doc.viewport().expect("viewport");
    app.transport.seek(vp, seconds);
    h.run_steps(2);
}

fn keys(h: &Harness<'static, BrickMotionApp>, clock: CameraClock) -> Vec<bm::camera::CameraKey> {
    h.state().session().camera_keys(clock)
}

fn key_pos(h: &Harness<'static, BrickMotionApp>, seconds: f64) -> Pos2 {
    let lane = h.state().timeline.last_camera_rect.expect("camera lane drawn");
    let dur = h.state().transport.duration();
    pos2(lane.left() + h.state().timeline.view.screen_x(seconds, dur) as f32, lane.center().y)
}

fn press(h: &mut Harness<'static, BrickMotionApp>, pos: Pos2, button: egui::PointerButton, pressed: bool) {
    h.event(egui::Event::PointerButton { pos, button, pressed, modifiers: egui::Modifiers::NONE });
    h.step();
}

fn right_click(h: &mut Harness<'static, BrickMotionApp>, pos: Pos2) {
    h.event(egui::Event::PointerMoved(pos));
    h.step();
    press(h, pos, egui::PointerButton::Secondary, true);
    press(h, pos, egui::PointerButton::Secondary, false);
    h.run_steps(2);
}

#[test]
fn add_key_from_view_selects_it() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    seek(&mut h, 2.0);
    assert!(run(h.state_mut(), "video.camera_key"));
    h.run_steps(3);
    let k = keys(&h, CameraClock::Build);
    assert_eq!(k.len(), 1);
    assert_eq!(h.state().camera_selection, Some((CameraClock::Build, CameraPick::Key(k[0].id.clone()))));
    assert!(h.state().director, "a first key turns Follow Camera on");
}

#[test]
fn key_drag_moves_once() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    seek(&mut h, 2.0);
    run(h.state_mut(), "video.camera_key");
    h.run_steps(3);
    let before = keys(&h, CameraClock::Build)[0].clone();
    let start = key_pos(&h, before.seconds);
    let end = start + egui::vec2(60.0, 0.0);
    let dur = h.state().transport.duration();
    let fps = h.state().transport.fps();
    let lane = h.state().timeline.last_camera_rect.unwrap();
    let dropped = h.state().timeline.view.time_at((end.x - lane.left()) as f64, dur);

    h.event(egui::Event::PointerMoved(start));
    h.step();
    press(&mut h, start, egui::PointerButton::Primary, true);
    for i in 1..=6 {
        h.event(egui::Event::PointerMoved(start + egui::vec2(10.0 * i as f32, 0.0)));
        h.step();
    }
    assert_eq!(keys(&h, CameraClock::Build)[0].seconds, before.seconds, "nothing lands while dragging");
    press(&mut h, end, egui::PointerButton::Primary, false);
    h.run_steps(3);

    let after = keys(&h, CameraClock::Build)[0].seconds;
    assert!((after - dropped).abs() <= 0.5 / fps + 1e-9, "dropped {dropped}, key at {after}");
    assert!(((after * fps) - (after * fps).round()).abs() < 1e-6, "key sits on a frame");
    run(h.state_mut(), "edit.undo");
    h.run_steps(2);
    assert!((keys(&h, CameraClock::Build)[0].seconds - before.seconds).abs() < 1e-9, "one undo step");
}

#[test]
fn auto_direct_from_lane_menu() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    let lane = h.state().timeline.last_camera_rect.expect("camera lane");
    right_click(&mut h, lane.center());
    h.get_by_label("Auto-Direct").hover();
    h.run_steps(3);
    h.get_by_label("Showcase Orbit").click();
    h.run_steps(3);
    assert!(!keys(&h, CameraClock::Build).is_empty());
    assert_eq!(h.state().session().camera_director_style(CameraClock::Build), "showcase");

    let lane = h.state().timeline.last_camera_rect.unwrap();
    // Keys and moves fill the lane now: the Camera head has the same menu.
    right_click(&mut h, pos2(lane.left() - 100.0, lane.center().y));
    h.get_by_label("Auto-Direct").hover();
    h.run_steps(3);
    let node = h.get_by_label("Showcase Orbit");
    assert_eq!(node.accesskit_node().toggled(), Some(egui::accesskit::Toggled::True), "current style checked");
}

#[test]
fn camera_selection_clears_when_key_goes() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    seek(&mut h, 2.0);
    run(h.state_mut(), "video.camera_key");
    h.run_steps(3);
    let k = keys(&h, CameraClock::Build)[0].clone();
    let at = key_pos(&h, k.seconds);
    right_click(&mut h, at);
    h.get_by_label("Delete Key").click();
    h.run_steps(3);
    assert!(keys(&h, CameraClock::Build).is_empty());
    assert_eq!(h.state().camera_selection, None);

    run(h.state_mut(), "edit.undo");
    h.run_steps(3);
    assert_eq!(keys(&h, CameraClock::Build).len(), 1);
    h.state_mut().camera_selection = Some((CameraClock::Build, CameraPick::Key(k.id.clone())));
    run(h.state_mut(), "edit.undo");
    h.run_steps(3);
    assert!(keys(&h, CameraClock::Build).is_empty());
    assert_eq!(h.state().camera_selection, None, "undoing the key away clears the selection");
}

#[test]
fn timeline_clock_has_its_own_track() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    h.state_mut().doc.session().set_key_scene(KeyScene { fps: 24, first: 1, last: 49, ..KeyScene::default() });
    h.run_steps(2);
    {
        let app = h.state_mut();
        let vp = app.doc.viewport().expect("viewport");
        app.transport.set_clock(vp, Clock::Keyframes);
    }
    h.run_steps(2);
    assert!(run(h.state_mut(), "video.camera_key"));
    h.run_steps(3);
    assert_eq!(keys(&h, CameraClock::Timeline).len(), 1);
    assert!(keys(&h, CameraClock::Build).is_empty());
}
