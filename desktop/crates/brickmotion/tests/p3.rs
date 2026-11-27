// P3 depth: Select Same, the Models tree row menu (Rename, Delete, Import Into).
use std::path::PathBuf;

use brickmotion::{BrickMotionApp, run};
use egui_kittest::Harness;

fn write(name: &str, text: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bm-p3-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, text).unwrap();
    path
}

/// Red 2×4, blue 2×4, red 2×2.
fn mixed() -> Harness<'static, BrickMotionApp> {
    let path = write(
        "mixed.ldr",
        "0 Mixed\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 1 80 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 4 160 0 0 1 0 0 0 1 0 0 0 1 3003.dat\n",
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

fn sorted(mut v: Vec<u32>) -> Vec<u32> {
    v.sort_unstable();
    v
}

#[test]
fn select_same_part_and_same_colour() {
    let mut h = mixed();
    h.state().session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "edit.select_same_part"));
    assert_eq!(sorted(h.state().session().selection()), vec![0, 1], "both 2×4s, any colour");
    h.state().session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "edit.select_same_colour"));
    assert_eq!(sorted(h.state().session().selection()), vec![0, 2], "both red pieces, any shape");
}

#[test]
fn rename_delete_and_import_into_a_submodel() {
    let mut h = mixed();
    // An unused submodel: New Submodel names one.
    assert!(run(h.state_mut(), "model.new_submodel"));
    let name = h.state().naming.as_ref().unwrap().text.clone();
    h.state_mut().finish_naming(true);
    h.run_steps(2);

    // Rename through the naming sheet the row menu opens.
    h.state_mut().naming = Some(brickmotion::chrome::naming::Naming::new(
        brickmotion::chrome::naming::NameFor::Rename(name.clone()),
        "Wheels".into(),
        Vec::new(),
    ));
    h.state_mut().finish_naming(true);
    h.run_steps(2);
    let rows = h.state().session().outline();
    assert!(rows.iter().any(|r| r.def == "Wheels"), "renamed");
    assert!(!rows.iter().any(|r| r.def == name), "old name gone");

    // Import a model into it: its parts land in that submodel, not the open model.
    let before = h.state().session().piece_count();
    let extra = write("extra.ldr", "0 Extra\n1 14 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n");
    h.state_mut().import_model_file(&extra, "Wheels");
    h.run_steps(2);
    let wheels = h.state().session().outline().into_iter().find(|r| r.def == "Wheels").unwrap();
    assert!(wheels.pieces >= 1, "the imported part is inside Wheels");
    assert_eq!(h.state().session().piece_count(), before, "Wheels is unused, so the open model is unchanged");

    // Delete works on an unused submodel.
    let c = h.state().session().delete_submodel("Wheels");
    assert!(c.refused.is_none());
    assert!(!h.state().session().outline().iter().any(|r| r.def == "Wheels"));
}

#[test]
fn import_into_asks_for_a_file() {
    let mut h = mixed();
    h.state_mut().import_model_dialog(String::new());
    let req = h.state().dialog_requests.last().unwrap();
    assert_eq!(req.kind, "import_into");
}

#[test]
fn home_import_parts_list_starts_a_project_first() {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, None);
        app.dialogs_off();
        app
    });
    h.run_steps(3);
    use egui::accesskit::Role;
    use egui_kittest::kittest::Queryable;
    h.get_by_role_and_label(Role::Button, "Import Parts List…").click();
    h.run_steps(3);
    assert!(h.state().has_document, "a new project to fill");
    assert_eq!(h.state().dialog_requests.last().map(|r| r.kind), Some("inventory"));
}

#[test]
fn tree_row_menu_offers_rename_and_greys_out_delete_while_used() {
    use egui::accesskit::Role;
    use egui_kittest::kittest::Queryable;
    const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
        app.wait_loaded();
        app.dialogs_off();
        app.prefs.auto_plan = false;
        app
    });
    h.run_steps(4);
    let at = h.get_by_label("helicopter - underside 1.ldr").rect().center();
    let at = egui::pos2(at.x, at.y);
    let right_click = |h: &mut Harness<'static, BrickMotionApp>| {
        h.event(egui::Event::PointerMoved(at));
        for pressed in [true, false] {
            h.event(egui::Event::PointerButton { pos: at, button: egui::PointerButton::Secondary, pressed, modifiers: Default::default() });
        }
        h.run_steps(3);
    };
    right_click(&mut h);
    for item in ["Open", "Play Its Build", "Lay Out Its Parts", "Rename…", "Import Model Into…", "Export"] {
        assert!(h.query_all_by_label(item).count() >= 1, "{item}");
    }
    // Clicking the greyed-out Delete does nothing: the submodel is still used.
    h.get_by_role_and_label(Role::Button, "Delete Submodel").click();
    h.run_steps(2);
    assert!(h.state().session().outline().iter().any(|r| r.def == "helicopter - underside 1.ldr"));
    assert_eq!(h.state().session().undo_name(), "", "nothing was edited");
    right_click(&mut h);
    h.get_by_label("Rename…").click();
    h.run_steps(3);
    let naming = h.state().naming.as_ref().expect("rename sheet open");
    assert_eq!(naming.text, "helicopter - underside 1.ldr");
}

/// Presses at `from`, drags to `to` in four moves, releases; `button` and `mods` held throughout.
fn drag(h: &mut Harness<'static, BrickMotionApp>, from: egui::Pos2, to: egui::Pos2, button: egui::PointerButton, mods: egui::Modifiers) {
    h.event(egui::Event::PointerMoved(from));
    h.event(egui::Event::PointerButton { pos: from, button, pressed: true, modifiers: mods });
    h.step();
    for k in 1..=4 {
        h.event(egui::Event::PointerMoved(from + (to - from) * (k as f32 / 4.0)));
        h.step();
    }
    h.event(egui::Event::PointerButton { pos: to, button, pressed: false, modifiers: mods });
    h.run_steps(2);
}

/// The viewport's centre, with the model zoomed out so it sits well inside a ±150 pt box.
fn zoomed_out(h: &mut Harness<'static, BrickMotionApp>) -> Option<egui::Pos2> {
    if !bm::metal_available() {
        return None;
    }
    let r = h.state().viewport.last_rect()?;
    let c = r.center();
    h.state_mut().doc.viewport().unwrap().zoom_toward(0.12, (c.x - r.left()) as f64, (c.y - r.top()) as f64);
    h.run_steps(2);
    Some(c)
}

#[test]
fn dragging_empty_space_marquees_without_orbiting() {
    let mut h = mixed();
    let Some(c) = zoomed_out(&mut h) else { return };
    h.state().session().select(&[], bm::SelectMode::Replace);
    let cam0 = h.state_mut().doc.viewport().unwrap().camera();
    drag(&mut h, c + egui::vec2(-150.0, -150.0), c + egui::vec2(150.0, 150.0), egui::PointerButton::Primary, Default::default());
    assert_eq!(sorted(h.state().session().selection()), vec![0, 1, 2], "every piece inside the box");
    assert_eq!(h.state_mut().doc.viewport().unwrap().camera(), cam0, "the camera stays put");

    // ⇧ adds to the selection; a box around nothing replaces it with nothing only without ⇧.
    h.state().session().select(&[0], bm::SelectMode::Replace);
    drag(&mut h, c + egui::vec2(-150.0, -150.0), c + egui::vec2(-120.0, -120.0), egui::PointerButton::Primary, egui::Modifiers::SHIFT);
    assert_eq!(h.state().session().selection(), vec![0], "⇧ with an empty box keeps the selection");
    drag(&mut h, c + egui::vec2(-150.0, -150.0), c + egui::vec2(-120.0, -120.0), egui::PointerButton::Primary, Default::default());
    assert!(h.state().session().selection().is_empty(), "an empty box clears it");

    // A click on empty space (no drag) still clears the selection.
    h.state().session().select(&[1], bm::SelectMode::Replace);
    let at = c + egui::vec2(-150.0, -150.0);
    h.event(egui::Event::PointerMoved(at));
    for pressed in [true, false] {
        h.event(egui::Event::PointerButton { pos: at, button: egui::PointerButton::Primary, pressed, modifiers: Default::default() });
    }
    h.run_steps(2);
    assert!(h.state().session().selection().is_empty());
}

#[test]
fn right_drag_orbits() {
    let mut h = mixed();
    let Some(c) = zoomed_out(&mut h) else { return };
    let cam0 = h.state_mut().doc.viewport().unwrap().camera();
    drag(&mut h, c + egui::vec2(-150.0, -150.0), c + egui::vec2(-50.0, -110.0), egui::PointerButton::Secondary, Default::default());
    let cam1 = h.state_mut().doc.viewport().unwrap().camera();
    assert_ne!(cam0.yaw, cam1.yaw, "right-drag turns the view");
    assert_eq!(cam0.target, cam1.target, "and does not pan");
}

/// A 2×4 at the origin and a 2×2 off to the side, unconnected.
fn apart() -> Harness<'static, BrickMotionApp> {
    let path = write("apart.ldr", "0 Apart\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 1 200 0 120 1 0 0 0 1 0 0 0 1 3003.dat\n");
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

fn settle(h: &mut Harness<'static, BrickMotionApp>) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while h.state().fit_together_busy() {
        assert!(std::time::Instant::now() < deadline, "Fit Together never finished");
        std::thread::sleep(std::time::Duration::from_millis(10));
        h.run_steps(1);
    }
    h.run_steps(2);
}

#[test]
fn fit_together_seats_the_second_piece_on_the_first_in_one_undo_step() {
    let mut h = apart();
    h.state().session().select(&[0], bm::SelectMode::Replace);
    assert!(!run(h.state_mut(), "model.fit_together"), "needs two pieces");
    h.state().session().select(&[0, 1], bm::SelectMode::Replace);
    let depth = h.state().session().undo_depth();
    let before = h.state().session().pose_of(1);
    assert!(run(h.state_mut(), "model.fit_together"));
    settle(&mut h);
    let after = h.state().session().pose_of(1);
    assert_ne!(after.position, before.position, "the 2×2 moved onto the 2×4");
    assert_eq!(h.state().session().pose_of(0).position, bm::Vec3::ZERO, "the first piece stays");
    assert!((after.position.y.abs() - 24.0).abs() < 1e-6, "one brick above or below: {:?}", after.position);
    assert_eq!(h.state().session().undo_depth(), depth + 1);
    assert!(h.state().last_refusal.is_none());
}

#[test]
fn tree_row_menu_plays_and_lays_out_a_submodel() {
    const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
        app.wait_loaded();
        app.dialogs_off();
        app.prefs.auto_plan = false;
        app
    });
    h.run_steps(4);
    let path = vec!["helicopter - underside 1.ldr".to_owned()];
    h.state_mut().play_submodel_build(&path);
    h.run_steps(2);
    assert_eq!(h.state().session().focus_path(), path, "opened it");
    assert_eq!(h.state().workspace, brickmotion::Workspace::Animate);
    h.state_mut().lay_out_submodel(&path);
    h.run_steps(2);
    assert_eq!(h.state().transport.step_preview, Some(bm::playback::AssemblyPreview::LaidOut));
    if let Some(c) = h.state_mut().doc.camera() {
        assert!(c.orthographic, "seen flat from the top");
        assert!(c.pitch > 1.5);
    }
}
