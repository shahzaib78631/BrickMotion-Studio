// Submodel commands: Make Submodel, Extract, Make Unique, New Submodel, Remove from Group.
use std::path::{Path, PathBuf};

use brickmotion::commands::{enabled, find};
use brickmotion::{BrickMotionApp, run};
use egui_kittest::Harness;

fn three_bricks() -> Harness<'static, BrickMotionApp> {
    let dir = std::env::temp_dir().join(format!("bm-submodels-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path: PathBuf = dir.join("three.ldr");
    std::fs::write(
        &path,
        "0 Three\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 4 80 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 4 160 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n",
    )
    .unwrap();
    let p = path.clone();
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(move |cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(Path::new(&p).to_path_buf()));
        app.wait_loaded();
        app.dialogs_off();
        app.prefs.auto_plan = false;
        app
    });
    h.run_steps(3);
    h
}

#[test]
fn make_submodel_needs_two_pieces_and_extract_undoes_it() {
    let mut h = three_bricks();
    let make = find("model.make_submodel").unwrap();
    h.state_mut().session().select(&[0], bm::SelectMode::Replace);
    assert!(!enabled(make, &h.state().ctx()));
    h.state_mut().session().select(&[0, 1], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.make_submodel"));
    h.run_steps(2);
    assert_eq!(h.state().session().undo_name(), "Make Submodel");
    assert_eq!(h.state().session().free_submodel_name("Submodel"), "Submodel 2");

    // The new use stays selected: Extract puts its bricks back in the model.
    assert!(run(h.state_mut(), "model.extract"));
    h.run_steps(2);
    assert_eq!(h.state().session().undo_name(), "Extract Submodel");
    assert_eq!(h.state().session().piece_count(), 3);
}

#[test]
fn new_submodel_and_make_unique() {
    let mut h = three_bricks();
    assert!(run(h.state_mut(), "model.new_submodel"));
    assert_eq!(h.state().session().free_submodel_name("Submodel"), "Submodel 2");
    h.state_mut().session().select(&[1, 2], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.make_submodel"));
    assert_eq!(h.state().session().free_submodel_name("Submodel 2"), "Submodel 2 2");
    let sel = h.state().session().selection();
    assert_eq!(h.state().session().duplicate(&[sel[0]], bm::Vec3::new(0.0, 0.0, 200.0)).refused, None);
    h.state_mut().session().select(&[sel[0]], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.make_unique"));
    assert!(h.state().notices().is_empty(), "{:?}", h.state().notices().last().map(|n| n.detail()));
}

#[test]
fn remove_from_group_clears_the_mark() {
    let mut h = three_bricks();
    assert_eq!(h.state().session().set_group(&[0, 1], "Wheels").refused, None);
    h.state_mut().session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.ungroup"));
    assert!(h.state().session().groups_of(&[0]).is_empty());
    assert_eq!(h.state().session().groups_of(&[1]), vec!["Wheels".to_owned()]);
}
