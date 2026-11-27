// P3: Properties › Transform — exact position, rotation and scale with scrub fields.
use std::path::PathBuf;

use brickmotion::BrickMotionApp;
use brickmotion::chrome::transform::{self, Field};
use egui_kittest::Harness;

fn write(name: &str, text: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bm-transform-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, text).unwrap();
    path
}

/// Three bricks along X at 0, 80 and 160 LDU (0, 4 and 8 studs).
fn row_of_three() -> Harness<'static, BrickMotionApp> {
    let path = write(
        "row.ldr",
        "0 Row\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 1 80 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 4 160 0 0 1 0 0 0 1 0 0 0 1 3003.dat\n",
    );
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(move |cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(path.clone()));
        app.wait_loaded();
        app.dialogs_off();
        app.prefs.auto_plan = false;
        app
    });
    h.run_steps(3);
    h
}

fn select(h: &Harness<'static, BrickMotionApp>, pieces: &[u32]) {
    h.state().session().select(pieces, bm::SelectMode::Replace);
}

fn near(a: Option<f64>, b: f64) -> bool {
    a.is_some_and(|a| (a - b).abs() < 1e-6)
}

#[test]
fn one_piece_reads_in_studs_plates_and_degrees() {
    let h = row_of_three();
    select(&h, &[1]);
    let r = transform::readout(h.state().session(), &[1]);
    assert!(near(r.position[0], 4.0) && near(r.position[1], 0.0) && near(r.position[2], 0.0), "{r:?}");
    assert!(r.rotation.iter().all(|&a| near(a, 0.0)), "{r:?}");
    assert!(r.scale.is_none(), "an unscaled piece has no Scale row");
}

#[test]
fn fields_that_differ_show_a_dash_and_move_every_piece_the_same() {
    let mut h = row_of_three();
    select(&h, &[0, 1, 2]);
    let r = transform::readout(h.state().session(), &[0, 1, 2]);
    assert_eq!(r.position[0], None, "X differs");
    assert!(near(r.position[1], 0.0) && near(r.position[2], 0.0));

    transform::nudge(h.state_mut(), Field::Position(0), 2.0, false);
    let xs: Vec<f64> = (0..3).map(|p| h.state().session().pose_of(p).position.x).collect();
    assert_eq!(xs, vec![40.0, 120.0, 200.0], "each moved 2 studs");

    // Typing into a field that differs moves every piece by the same amount, measured on the first.
    transform::set(h.state_mut(), Field::Position(0), 0.0);
    let xs: Vec<f64> = (0..3).map(|p| h.state().session().pose_of(p).position.x).collect();
    assert_eq!(xs, vec![0.0, 80.0, 160.0]);
}

#[test]
fn y_is_plates_and_up_is_positive() {
    let mut h = row_of_three();
    select(&h, &[1]);
    transform::set(h.state_mut(), Field::Position(1), 3.0);
    assert_eq!(h.state().session().pose_of(1).position.y, -24.0, "three plates up is −24 LDU");
    assert!(near(transform::readout(h.state().session(), &[1]).position[1], 3.0));
}

#[test]
fn typing_a_rotation_turns_the_piece_in_place() {
    let mut h = row_of_three();
    select(&h, &[1]);
    transform::set(h.state_mut(), Field::Rotation(1), 90.0);
    let r = transform::readout(h.state().session(), &[1]);
    assert!(near(r.rotation[1], 90.0), "{r:?}");
    assert!(near(r.rotation[0], 0.0) && near(r.rotation[2], 0.0), "{r:?}");
    assert!(near(r.position[0], 4.0), "turns about its own origin: {r:?}");
    transform::set(h.state_mut(), Field::Rotation(0), 30.0);
    let r = transform::readout(h.state().session(), &[1]);
    assert!(near(r.rotation[0], 30.0) && near(r.rotation[1], 90.0), "the other angles hold: {r:?}");
    transform::set(h.state_mut(), Field::Rotation(2), -45.0);
    let r = transform::readout(h.state().session(), &[1]);
    assert!(near(r.rotation[0], 30.0) && near(r.rotation[1], 90.0) && near(r.rotation[2], -45.0), "{r:?}");
}

#[test]
fn a_scrub_drag_is_one_undo_step() {
    let mut h = row_of_three();
    select(&h, &[1]);
    let depth = h.state().session().undo_depth();
    for _ in 0..3 {
        transform::nudge(h.state_mut(), Field::Position(2), 1.0, true);
    }
    h.state().session().end_gesture();
    assert_eq!(h.state().session().pose_of(1).position.z, 60.0);
    assert_eq!(h.state().session().undo_depth(), depth + 1);
    h.state().session().undo();
    assert_eq!(h.state().session().pose_of(1).position.z, 0.0);
}

#[test]
fn a_scaled_piece_shows_scale_and_reset_clears_rotation_and_scale() {
    let mut h = row_of_three();
    select(&h, &[1]);
    transform::set(h.state_mut(), Field::Rotation(1), 90.0);
    transform::set(h.state_mut(), Field::Scale(0), 1.5);
    let r = transform::readout(h.state().session(), &[1]);
    let s = r.scale.expect("scaled");
    assert!(near(s[0], 1.5) && near(s[1], 1.0) && near(s[2], 1.0), "{s:?}");
    assert!(near(r.rotation[1], 90.0), "scale leaves rotation: {r:?}");

    transform::reset(h.state_mut());
    let r = transform::readout(h.state().session(), &[1]);
    assert!(r.rotation.iter().all(|&a| near(a, 0.0)), "{r:?}");
    assert!(r.scale.is_none(), "{r:?}");
    assert!(near(r.position[0], 4.0), "position kept: {r:?}");
}

#[test]
fn properties_shows_the_transform_section() {
    use egui_kittest::kittest::Queryable;
    let mut h = row_of_three();
    select(&h, &[1]);
    h.run_steps(3);
    assert!(h.query_by_label("Position in studs · Y in plates").is_some());
    assert!(h.query_by_label("Reset").is_some());
    assert!(h.query_by_label("Position").is_some());
    assert!(h.query_by_label("Rotation").is_some());
}

#[test]
fn dragging_a_field_sideways_scrubs_and_clicking_types() {
    use egui::accesskit::Role;
    use egui_kittest::kittest::Queryable;
    let mut h = row_of_three();
    select(&h, &[1]);
    h.run_steps(3);
    let depth = h.state().session().undo_depth();
    let at = h.get_by_role_and_label(Role::SpinButton, "Position Z").rect().center();
    let start = egui::pos2(at.x, at.y);
    h.event(egui::Event::PointerMoved(start));
    h.event(egui::Event::PointerButton { pos: start, button: egui::PointerButton::Primary, pressed: true, modifiers: Default::default() });
    h.run_steps(1);
    for dx in [10.0, 20.0, 30.0] {
        h.event(egui::Event::PointerMoved(egui::pos2(start.x + dx, start.y)));
        h.run_steps(1);
    }
    h.event(egui::Event::PointerButton { pos: egui::pos2(start.x + 30.0, start.y), button: egui::PointerButton::Primary, pressed: false, modifiers: Default::default() });
    h.run_steps(2);
    let z = h.state().session().pose_of(1).position.z;
    assert!((40.0..=80.0).contains(&z), "30 px is a few studs: {z}");
    assert_eq!(z % bm::STUD, 0.0, "whole studs");
    assert_eq!(h.state().session().undo_depth(), depth + 1, "one undo step");

    h.get_by_role_and_label(Role::SpinButton, "Position X").click();
    h.run_steps(2);
    h.event(egui::Event::Text("−2.5".into()));
    h.event(egui::Event::Key { key: egui::Key::Enter, physical_key: None, pressed: true, repeat: false, modifiers: Default::default() });
    h.run_steps(3);
    assert_eq!(h.state().session().pose_of(1).position.x, -50.0, "typed −2.5 studs over the selected number");
}

#[test]
fn a_mirrored_piece_reads_as_unturned_and_unscaled() {
    let path = write("mirror.ldr", "0 Mirror\n1 4 40 0 0 -1 0 0 0 1 0 0 0 1 3001.dat\n");
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(move |cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(path.clone()));
        app.wait_loaded();
        app.dialogs_off();
        app
    });
    h.run_steps(3);
    select(&h, &[0]);
    let r = transform::readout(h.state().session(), &[0]);
    assert!(r.rotation.iter().all(|&a| near(a, 0.0)), "{r:?}");
    assert!(r.scale.is_none(), "{r:?}");
    assert!(!transform::can_reset(h.state().session(), &[0]));
    transform::set(h.state_mut(), Field::Rotation(1), 90.0);
    assert!(near(transform::readout(h.state().session(), &[0]).rotation[1], 90.0));
    transform::reset(h.state_mut());
    let r = transform::readout(h.state().session(), &[0]);
    assert!(r.rotation.iter().all(|&a| near(a, 0.0)), "{r:?}");
    assert!(h.state().session().pose_of(0).rotation.m[0] < 0.0, "reset keeps the mirror");
}

#[test]
fn reset_is_one_named_undo_step_for_every_piece_and_change() {
    let mut h = row_of_three();
    select(&h, &[0, 1]);
    transform::set(h.state_mut(), Field::Rotation(1), 90.0);
    transform::set(h.state_mut(), Field::Scale(0), 1.5);
    let depth = h.state().session().undo_depth();
    transform::reset(h.state_mut());
    assert_eq!(h.state().session().undo_depth(), depth + 1, "turned and stretched pieces reset in one step");
    assert_eq!(h.state().session().undo_name(), "Reset 2 Transforms");
    assert!(!transform::can_reset(h.state().session(), &[0, 1]));
    select(&h, &[1]);
    transform::set(h.state_mut(), Field::Rotation(1), 45.0);
    transform::reset(h.state_mut());
    assert_eq!(h.state().session().undo_name(), "Reset Transform");
}

#[test]
fn keys_typed_into_a_field_do_not_edit_the_model() {
    use egui::accesskit::Role;
    use egui_kittest::kittest::Queryable;
    let mut h = row_of_three();
    select(&h, &[1]);
    h.run_steps(3);
    let count = h.state().session().piece_count();
    h.get_by_role_and_label(Role::SpinButton, "Position X").click();
    h.run_steps(2);
    for key in [egui::Key::Backspace, egui::Key::Delete, egui::Key::Escape] {
        h.event(egui::Event::Key { key, physical_key: None, pressed: true, repeat: false, modifiers: Default::default() });
        h.run_steps(2);
    }
    assert_eq!(h.state().session().piece_count(), count, "Backspace and Delete stayed in the field");
    assert_eq!(h.state().session().selection(), vec![1], "Esc closed the field, not the selection");
    assert_eq!(h.state().session().pose_of(1).position.x, 80.0, "Esc cancels");
}
