// Submodel commands: Make Submodel, Extract, Make Unique, New Submodel, Remove from Group.
use std::path::{Path, PathBuf};

use brickmotion::commands::{enabled, find};
use brickmotion::{BrickMotionApp, run};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

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
    h.state_mut().finish_naming(true);
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
    h.state_mut().finish_naming(true);
    assert_eq!(h.state().session().free_submodel_name("Submodel"), "Submodel 2");
    h.state_mut().session().select(&[1, 2], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.make_submodel"));
    h.state_mut().finish_naming(true);
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

#[test]
fn make_submodel_asks_for_a_name_first() {
    use brickmotion::chrome::naming::NameFor;
    let mut h = three_bricks();
    h.state_mut().session().select(&[0, 1], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.make_submodel"));
    let n = h.state().naming.clone().expect("the naming sheet is open");
    assert_eq!((n.kind, n.text.as_str()), (NameFor::MakeSubmodel, "Submodel"));
    assert_eq!(h.state().session().undo_name(), "", "nothing is made until the name is confirmed");
    h.run_steps(2);

    // Cancel leaves the model alone.
    h.state_mut().finish_naming(false);
    assert!(h.state().naming.is_none());
    assert_eq!(h.state().session().free_submodel_name("Submodel"), "Submodel");

    // A typed name is used.
    assert!(run(h.state_mut(), "model.make_submodel"));
    h.state_mut().naming.as_mut().unwrap().text = "  Rotor ".into();
    h.state_mut().finish_naming(true);
    assert_eq!(h.state().session().undo_name(), "Make Submodel");
    assert_eq!(h.state().session().free_submodel_name("Rotor"), "Rotor 2");
}

#[test]
fn an_empty_name_is_not_accepted() {
    let mut h = three_bricks();
    assert!(run(h.state_mut(), "model.new_submodel"));
    h.state_mut().naming.as_mut().unwrap().text = "   ".into();
    h.state_mut().finish_naming(true);
    assert!(h.state().naming.is_some(), "the sheet stays open");
    assert_eq!(h.state().session().free_submodel_name("Submodel"), "Submodel");
}

#[test]
fn group_names_the_selection() {
    let mut h = three_bricks();
    h.state_mut().session().select(&[0, 2], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.group"));
    assert_eq!(h.state().naming.as_ref().unwrap().text, "Group");
    h.state_mut().naming.as_mut().unwrap().text = "Wheels".into();
    h.state_mut().finish_naming(true);
    assert_eq!(h.state().session().groups_of(&[2]), vec!["Wheels".to_owned()]);
    assert!(h.state().session().groups_of(&[1]).is_empty());

    // The next group's name is free; a grouped selection starts from its own name.
    h.state_mut().session().select(&[1], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.group"));
    h.state_mut().naming.as_mut().unwrap().text = "Group".into();
    h.state_mut().finish_naming(true);
    h.state_mut().session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.group"));
    assert_eq!(h.state().naming.as_ref().unwrap().text, "Wheels");
    h.state_mut().finish_naming(false);
    h.state_mut().session().select(&[], bm::SelectMode::Replace);
    assert!(!run(h.state_mut(), "model.group"));
}

#[test]
fn naming_sheet_draws_and_return_confirms() {
    let mut h = three_bricks();
    h.state_mut().session().select(&[0, 1], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.make_submodel"));
    h.run_steps(3);
    assert!(h.query_all_by_label("Make Submodel").count() >= 2, "title and button");
    h.get_by_label("2 pieces become one submodel, used here once.");
    h.key_press(egui::Key::Enter);
    h.run_steps(3);
    assert!(h.state().naming.is_none());
    assert_eq!(h.state().session().undo_name(), "Make Submodel");
}

#[test]
fn keyboard_shortcuts_sheet_lists_commands() {
    let mut h = three_bricks();
    assert!(run(h.state_mut(), "help.shortcuts"));
    h.run_steps(3);
    h.get_by_label("Keyboard Shortcuts");
    assert!(h.query_all_by_label("Make Submodel").count() >= 1);
    h.get_by_label("⌥⌘G");
    h.key_press(egui::Key::Escape);
    h.run_steps(3);
    assert!(!h.state().shortcuts_open);
}
