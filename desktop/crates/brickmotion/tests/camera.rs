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

/// The panels scroll inside when taller than the view: bring the control in, then click it.
fn click_in_panel(h: &mut Harness<'static, BrickMotionApp>, label: &str) {
    h.get_by_label(label).scroll_to_me();
    // The scroll eases in, and a scroll area ignores clicks while it moves.
    h.run_steps(40);
    let at = h.get_by_label(label).rect().center();
    h.event(egui::Event::PointerMoved(at));
    h.step();
    press(h, at, egui::PointerButton::Primary, true);
    press(h, at, egui::PointerButton::Primary, false);
    h.run_steps(2);
}

fn drag_across(h: &mut Harness<'static, BrickMotionApp>, from: Pos2, to: Pos2, frames: usize) {
    h.event(egui::Event::PointerMoved(from));
    h.step();
    press(h, from, egui::PointerButton::Primary, true);
    for i in 1..=frames {
        let p = from + (to - from) * (i as f32 / frames as f32);
        h.event(egui::Event::PointerMoved(p));
        h.step();
    }
    press(h, to, egui::PointerButton::Primary, false);
    h.run_steps(2);
}

#[test]
fn camera_slider_drag_is_one_undo_step() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    seek(&mut h, 2.0);
    run(h.state_mut(), "video.camera_key");
    h.run_steps(3);
    let before = keys(&h, CameraClock::Build)[0].clone();
    let depth = h.state().session().undo_depth();
    let lens = h.get_by_role_and_label(egui::accesskit::Role::Slider, "Lens").rect();
    drag_across(&mut h, pos2(lens.left() + 20.0, lens.center().y), pos2(lens.right() - 30.0, lens.center().y), 10);
    let after = keys(&h, CameraClock::Build)[0].clone();
    assert!(after.lens_mm > before.lens_mm + 20.0, "lens {} → {}", before.lens_mm, after.lens_mm);
    assert_eq!(h.state().session().undo_depth(), depth + 1, "the whole drag is one undo step");
    run(h.state_mut(), "edit.undo");
    h.run_steps(2);
    assert!((keys(&h, CameraClock::Build)[0].lens_mm - before.lens_mm).abs() < 1e-9);
}

#[test]
fn move_curve_popup_commits() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    for at in [1.0, 5.0] {
        seek(&mut h, at);
        run(h.state_mut(), "video.camera_key");
        h.run_steps(3);
    }
    let from = keys(&h, CameraClock::Build)[0].id.clone();
    h.state_mut().camera_selection = Some((CameraClock::Build, CameraPick::Move(from)));
    h.run_steps(3);
    click_in_panel(&mut h, "Easing");
    h.get_by_label("Even Speed").click();
    h.run_steps(3);
    assert_eq!(h.state().session().camera_moves(CameraClock::Build)[0].curve, "linear");
}

#[test]
fn escape_closes_the_camera_key_panel() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    seek(&mut h, 2.0);
    run(h.state_mut(), "video.camera_key");
    h.run_steps(3);
    assert!(h.query_by_label("Camera Key panel").is_some(), "selecting a key opens its panel");
    h.key_press(egui::Key::Escape);
    h.run_steps(2);
    assert_eq!(h.state().camera_selection, None);
    assert!(h.query_by_label("Camera Key panel").is_none());
}

#[test]
fn scene_camera_save_and_recall() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    assert!(run(h.state_mut(), "video.scene_cameras"));
    h.run_steps(3);
    click_in_panel(&mut h, "Save View as Camera");
    h.run_steps(3);
    let cams = h.state().session().scene_cameras();
    assert_eq!(cams.cameras.len(), 1);
    assert_eq!(cams.cameras[0].name, "Camera 1");
    let id = cams.cameras[0].id.clone();
    let saved = h.state_mut().doc.viewport().unwrap().capture_scene_camera();

    let row = h.get_by_label("Camera 1").rect();
    right_click(&mut h, row.center());
    h.get_by_label("Rename…").click();
    h.run_steps(2);
    h.get_by_role_and_label(egui::accesskit::Role::TextInput, "Camera name").type_text("Hero");
    h.run_steps(1);
    h.key_press(egui::Key::Enter);
    h.run_steps(3);
    assert_eq!(h.state().session().scene_cameras().cameras[0].name, "Hero");

    h.state_mut().doc.viewport().unwrap().orbit(120.0, 40.0);
    h.run_steps(2);
    assert_ne!(h.state_mut().doc.viewport().unwrap().capture_scene_camera().position, saved.position);
    click_in_panel(&mut h, "Look Through Hero");
    h.run_steps(3);
    let now = h.state_mut().doc.viewport().unwrap().capture_scene_camera();
    assert!((now.position.x - saved.position.x).abs() < 1e-3 && (now.position.z - saved.position.z).abs() < 1e-3);
    assert!(!h.state().director, "recalling a camera stops Follow Camera");

    h.get_by_label("Hero").scroll_to_me();
    h.run_steps(40);
    let row = h.get_by_label("Hero").rect();
    right_click(&mut h, row.center());
    // The first saved camera is already the video's: hand video back to the automatic camera.
    h.get_by_label("Use Automatic Camera for Video").click();
    h.run_steps(3);
    let cams = h.state().session().scene_cameras();
    assert!(!(cams.use_for_video && cams.active_id == id), "automatic camera for video");
    let row = h.get_by_label("Hero").rect();
    right_click(&mut h, row.center());
    h.get_by_label("Make Default for Video").click();
    h.run_steps(3);
    let cams = h.state().session().scene_cameras();
    assert_eq!(cams.active_id, id);
    assert!(cams.use_for_video);
}

#[test]
fn export_camera_popup() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    run(h.state_mut(), "video.scene_cameras");
    h.run_steps(3);
    click_in_panel(&mut h, "Camera Track");
    h.run_steps(2);
    assert_eq!(h.state().session().export_camera(), "track");
    click_in_panel(&mut h, "Viewport");
    h.run_steps(2);
    assert_eq!(h.state().session().export_camera(), "buildView");
    click_in_panel(&mut h, "Scene Camera");
    h.run_steps(2);
    assert_eq!(h.state().session().export_camera(), "automatic");
}

/// A switch row is one 36-px row, not centred in whatever height is left in its panel.
#[test]
fn camera_panel_switch_row_stays_compact() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    assert!(run(h.state_mut(), "video.scene_cameras"));
    h.run_steps(4);
    // The ribbon has a Follow Camera button too; the panel's switch is the lower one.
    let lowest = |label: &str| h.query_all_by_label(label).map(|n| n.rect()).max_by(|a, b| a.top().total_cmp(&b.top())).expect(label);
    let style = lowest("Auto-Direct style");
    let follow = lowest("Follow Camera");
    assert!(follow.top() - style.bottom() < 30.0, "Follow Camera sits {} px below the row above", follow.top() - style.bottom());
}

/// The slider is one rounded row: label and value sit inside the bar you drag.
#[test]
fn slider_is_one_pill_with_the_value_inside() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    seek(&mut h, 2.0);
    run(h.state_mut(), "video.camera_key");
    h.run_steps(3);
    let lens = h.get_by_role_and_label(egui::accesskit::Role::Slider, "Lens").rect();
    let value = h.get_by_label("Lens value").rect();
    assert!((32.0..=44.0).contains(&lens.height()), "pill height {}", lens.height());
    assert!(lens.contains_rect(value), "value {value:?} inside the pill {lens:?}");
}

/// Double-clicking the value opens it for typing and leaves the value where it was.
#[test]
fn double_click_value_types_without_moving() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    seek(&mut h, 2.0);
    run(h.state_mut(), "video.camera_key");
    h.run_steps(3);
    let before = keys(&h, CameraClock::Build)[0].lens_mm;
    let depth = h.state().session().undo_depth();
    let at = h.get_by_label("Lens value").rect().center();
    h.event(egui::Event::PointerMoved(at));
    h.step();
    let mut t = h.ctx.input(|i| i.time);
    for _ in 0..2 {
        for pressed in [true, false] {
            t += 0.02;
            h.input_mut().time = Some(t);
            press(&mut h, at, egui::PointerButton::Primary, pressed);
        }
    }
    h.run_steps(2);
    assert!(h.query_by_role_and_label(egui::accesskit::Role::TextInput, "Lens value").is_some(), "typing opened");
    assert_eq!(h.state().session().undo_depth(), depth);
    assert!((keys(&h, CameraClock::Build)[0].lens_mm - before).abs() < 1e-9);
}

/// Pressing Esc mid-drag on a Camera Key slider reverts the value and keeps the panel open.
#[test]
fn escape_mid_slider_drag_reverts_without_closing_panel() {
    if !bm::metal_available() {
        return;
    }
    let mut h = planned();
    seek(&mut h, 2.0);
    run(h.state_mut(), "video.camera_key");
    h.run_steps(3);
    let before = keys(&h, CameraClock::Build)[0].lens_mm;
    let lens = h.get_by_role_and_label(egui::accesskit::Role::Slider, "Lens").rect();
    let start = pos2(lens.left() + 20.0, lens.center().y);
    let far = pos2(lens.right() - 25.0, lens.center().y);

    h.event(egui::Event::PointerMoved(start));
    h.step();
    press(&mut h, start, egui::PointerButton::Primary, true);
    h.event(egui::Event::PointerMoved(far));
    h.step();
    assert!((keys(&h, CameraClock::Build)[0].lens_mm - before).abs() > 10.0, "live drag moved lens");

    // Esc mid-drag reverts lens and leaves the Camera Key panel open.
    h.key_press(egui::Key::Escape);
    h.run_steps(2);
    press(&mut h, far, egui::PointerButton::Primary, false);
    h.run_steps(2);
    assert!(h.state().camera_selection.is_some(), "panel stays open on slider Esc");
    assert!((keys(&h, CameraClock::Build)[0].lens_mm - before).abs() < 1e-6, "lens reverted");

    // A second Esc closes the Camera Key panel.
    h.key_press(egui::Key::Escape);
    h.run_steps(2);
    assert_eq!(h.state().camera_selection, None);
}
