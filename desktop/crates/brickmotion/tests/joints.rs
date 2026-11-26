// Joint markers, the joint card (turn, detach, rigid body) and insertion direction.
use std::time::{Duration, Instant};

use bm::motion::{Inspection, JointRow};
use brickmotion::chrome::joints;
use brickmotion::{BrickMotionApp, Notice, Workspace, run};
use egui::Pos2;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn heli() -> Harness<'static, BrickMotionApp> {
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

/// Steps until the joint workers are idle and the report is for the document as it stands.
fn settle(h: &mut Harness<'static, BrickMotionApp>) {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        h.step();
        let j = &h.state().joints;
        if !j.busy() && j.current(h.state().session()) {
            break;
        }
        assert!(Instant::now() < deadline, "the joints never settled");
        std::thread::sleep(Duration::from_millis(10));
    }
    h.run_steps(2);
}

fn press(h: &mut Harness<'static, BrickMotionApp>, pos: Pos2, pressed: bool) {
    h.event(egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers: egui::Modifiers::NONE });
    h.step();
}

fn click_label(h: &mut Harness<'static, BrickMotionApp>, label: &str) {
    let at = h.get_by_label(label).rect().center();
    h.event(egui::Event::PointerMoved(at));
    h.step();
    press(h, at, true);
    press(h, at, false);
}

fn same(j: &JointRow, k: (u32, u32)) -> bool {
    (j.a, j.b) == k || (j.b, j.a) == k
}

fn angle_of(h: &Harness<'static, BrickMotionApp>, k: (u32, u32)) -> Option<f64> {
    let mut i = Inspection::capture(h.state().session())?;
    i.joints(&[], true, false).joints.iter().find(|j| same(j, k)).map(|j| j.angle)
}

/// Opens each turning joint in turn until one turns 15° (some are blocked), and returns it.
fn turned_joint(h: &mut Harness<'static, BrickMotionApp>) -> ((u32, u32), f64) {
    run(h.state_mut(), "view.joints");
    settle(h);
    let turning: Vec<JointRow> = h.state().joints.report.clone().expect("a report").into_iter().filter(|j| j.kind.turns()).collect();
    assert!(!turning.is_empty());
    for j in turning {
        let depth = h.state().session().undo_depth();
        joints::open(h.state_mut(), (j.a, j.b));
        h.run_steps(3);
        click_label(h, "Rotate right 15 degrees");
        settle(h);
        if h.state().session().undo_depth() == depth + 1 {
            return ((j.a, j.b), j.angle);
        }
        assert_eq!(h.state().session().undo_depth(), depth, "a refused turn changes nothing");
    }
    panic!("no joint was free to turn");
}

#[test]
fn joint_markers_toggle() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli();
    assert!(h.state().joints.markers.is_empty());
    assert!(run(h.state_mut(), "view.joints"));
    settle(&mut h);
    assert!(h.state().joints.show);
    assert!(!h.state().joints.markers.is_empty(), "markers drawn");
    assert!(run(h.state_mut(), "view.joints"));
    h.run_steps(3);
    assert!(h.state().joints.markers.is_empty());
}

#[test]
fn joint_card_turns_15() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli();
    let (k, before) = turned_joint(&mut h);
    let after = angle_of(&h, k).expect("still joined");
    let mut delta = (after - before).abs() % 360.0;
    if delta > 180.0 {
        delta = 360.0 - delta;
    }
    assert!((delta - 15.0).abs() < 1.0, "turned {delta}°");
    assert!(h.query_by_label("Joint panel").is_some(), "the Joint panel floats while a joint is open");
}

#[test]
fn joint_change_after_edit_is_dropped() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli();
    run(h.state_mut(), "view.joints");
    settle(&mut h);
    let j = h.state().joints.report.clone().unwrap().into_iter().find(|j| j.kind.turns()).expect("a turning joint");
    joints::open(h.state_mut(), (j.a, j.b));
    h.run_steps(3);
    joints::change(h.state_mut(), 15.0);
    assert!(h.state().joints.busy());
    // An edit lands before the worker's result is taken.
    h.state_mut().doc.session().select(&[33], bm::SelectMode::Replace);
    h.state_mut().doc.session().hide(&[33]);
    let k = [bm::keys::Keyframe::new(bm::keys::KeyChannel::PositionX, 5, 1.0)];
    assert!(h.state_mut().doc.session().set_keys(33, &k, false, false).refused.is_none());
    let depth = h.state().session().undo_depth();
    settle(&mut h);
    assert_eq!(h.state().session().undo_depth(), depth, "the stale change was dropped");
}

#[test]
fn detach_separates() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli();
    let (k, _) = turned_joint(&mut h);
    let depth = h.state().session().undo_depth();
    click_label(&mut h, "Detach");
    settle(&mut h);
    assert_eq!(h.state().session().undo_depth(), depth + 1, "one undo step");
    assert_ne!(h.state().session().undo_name(), "", "a named step");
    assert!(angle_of(&h, k).is_none(), "the parts no longer join");
}

#[test]
fn select_rigid_body() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli();
    run(h.state_mut(), "view.joints");
    settle(&mut h);
    let j = h.state().joints.report.clone().unwrap().into_iter().find(|j| j.kind.turns()).expect("a turning joint");
    joints::open(h.state_mut(), (j.a, j.b));
    h.run_steps(3);
    click_label(&mut h, "Select Rigid Body");
    settle(&mut h);
    let mut want = Inspection::capture(h.state().session()).unwrap().body(j.b);
    want.sort_unstable();
    let mut got = h.state().session().selection();
    got.sort_unstable();
    assert_eq!(got, want);
}

#[test]
fn joint_card_closes_when_joint_goes() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli();
    run(h.state_mut(), "view.joints");
    settle(&mut h);
    let j = h.state().joints.report.clone().unwrap().into_iter().find(|j| j.kind.turns()).expect("a turning joint");
    joints::open(h.state_mut(), (j.a, j.b));
    h.run_steps(3);
    assert!(h.query_by_label("Joint card").is_some());
    assert!(h.state_mut().doc.session().remove(&[j.b]).refused.is_none());
    settle(&mut h);
    assert_eq!(h.state().joints.open, None);
    assert!(h.query_by_label("Joint card").is_none());
}

#[test]
fn insertion_direction_from_camera() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli();
    h.state_mut().doc.session().select(&[33], bm::SelectMode::Replace);
    h.run_steps(2);
    assert!(run(h.state_mut(), "object.arrival_direction"));
    h.run_steps(2);
    let cam = h.state_mut().doc.viewport().unwrap().camera();
    let want = joints::nearest_axis(joints::camera_direction(&cam));
    let got = h.state().session().insertion_direction(33);
    assert!((got.x - want.x).abs() < 1e-9 && (got.y - want.y).abs() < 1e-9 && (got.z - want.z).abs() < 1e-9, "{got:?} want {want:?}");
    assert_eq!(want.x.abs() + want.y.abs() + want.z.abs(), 1.0, "an axis");
    assert!(!matches!(h.state().notices().last(), Some(Notice::Warning { .. })));
}

#[test]
fn inspector_arrives_from_above() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli();
    h.state_mut().doc.session().select(&[33], bm::SelectMode::Replace);
    h.run_steps(3);
    click_label(&mut h, "Insertion direction, Automatic");
    h.run_steps(2);
    click_label(&mut h, "From Above");
    h.run_steps(2);
    let got = h.state().session().insertion_direction(33);
    assert_eq!((got.x, got.y, got.z), (0.0, -1.0, 0.0));
    assert!(h.query_by_label("Insertion direction, From Above").is_some());
}
