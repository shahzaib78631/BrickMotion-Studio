// Keyboard and menu edits: nudge, raise/lower, turn, clone, duplicate, clipboard, refusals.
use brickmotion::{BrickMotionApp, Notice, Tool, run};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn heli_app() -> BrickMotionApp {
    let mut app = BrickMotionApp::new_for_test(Some(HELI.into()));
    app.wait_loaded();
    app.dialogs_off();
    assert!(app.piece_count() > 100);
    app
}

fn heli_harness() -> Harness<'static, BrickMotionApp> {
    let mut h = Harness::builder()
        .with_size([1440.0, 900.0])
        .build_eframe(|cc| {
            let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
            app.wait_loaded();
            app.dialogs_off();
            app
        });
    h.run_steps(3);
    h
}

fn key(h: &mut Harness<'static, BrickMotionApp>, key: egui::Key, modifiers: egui::Modifiers) {
    for pressed in [true, false] {
        h.event(egui::Event::Key { key, physical_key: None, pressed, repeat: false, modifiers });
    }
}

/// Parses the y coordinate (4th whitespace field, 0-based index 3) from an LDraw type-1 line.
fn piece_y(s: &bm::Session, piece: u32) -> f64 {
    let line = s.copy(&[piece]);
    line.split_whitespace().nth(3).expect("ldraw y field").parse::<f64>().expect("f64 y")
}

#[test]
fn nudge_moves_one_stud_and_is_one_undo() {
    let mut app = heli_app();
    app.doc.session().select(&[0], bm::SelectMode::Replace);
    let before = app.doc.session().copy(&[0]);
    assert!(run(&mut app, "edit.nudge_right"));
    assert!(app.doc.session().can_undo());
    assert!(!app.doc.session().undo_name().is_empty());
    assert_ne!(app.doc.session().copy(&[0]), before);
    assert!(run(&mut app, "edit.undo"));
    assert!(!app.doc.session().can_undo());
    assert_eq!(app.doc.session().copy(&[0]), before);
}

#[test]
fn raise_moves_up_one_plate_and_alt_moves_one_brick() {
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    h.run_steps(1);
    let y0 = piece_y(h.state().session(), 0);
    assert!(run(h.state_mut(), "edit.raise"));
    let y1 = piece_y(h.state().session(), 0);
    assert!((y0 - y1 - bm::PLATE).abs() < 1e-4, "expected 8 less: y0={y0}, y1={y1}");

    // With ⌥ held via keyboard event, raises one brick (24 LDU).
    key(&mut h, egui::Key::E, egui::Modifiers::ALT);
    h.run_steps(2);
    let y2 = piece_y(h.state().session(), 0);
    assert!((y1 - y2 - bm::BRICK).abs() < 1e-4, "expected 24 less: y1={y1}, y2={y2}");
}

#[test]
fn turn_needs_a_selection() {
    let mut app = heli_app();
    assert!(!run(&mut app, "model.rotate"));
    assert!(!run(&mut app, "model.rotate_back"));
}

#[test]
fn clone_adds_one_piece_in_place() {
    let mut app = heli_app();
    let n = app.piece_count();
    app.doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(run(&mut app, "edit.clone"));
    assert_eq!(app.piece_count(), n + 1);
    let sel = app.doc.session().selection();
    assert_eq!(sel.len(), 1);
    assert_ne!(sel[0], 0);
}

#[test]
#[ignore = "uses the macOS pasteboard; run with BM_CLIPBOARD=1"]
fn copy_paste_through_clipboard() {
    if std::env::var_os("BM_CLIPBOARD").is_none() {
        return;
    }
    let mut app = BrickMotionApp::new_for_test(Some(HELI.into()));
    app.wait_loaded();
    let n = app.piece_count();
    app.doc.session().select(&[0, 1], bm::SelectMode::Replace);
    assert!(run(&mut app, "edit.copy"));
    assert!(run(&mut app, "edit.paste"));
    assert_eq!(app.piece_count(), n + 2);
}

#[test]
fn refused_edit_shows_reason_and_changes_nothing() {
    let mut app = heli_app();
    app.doc.session().select(&[0], bm::SelectMode::Replace);
    let v = app.doc.session().version();
    let notices_before = app.notices().len();
    // Paste with empty clipboard is refused by bmffi with a reason.
    brickmotion::edit::selection_edit(&mut app, |s, _| s.paste("", bm::Vec3::ZERO));
    assert_eq!(app.doc.session().version(), v);
    assert_eq!(app.notices().len(), notices_before + 1);
    match app.notices().last().unwrap() {
        Notice::Warning { detail, .. } => assert!(!detail.is_empty()),
        other => panic!("expected warning notice, got {other:?}"),
    }
}

#[test]
fn typing_does_not_edit() {
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    h.run_steps(1);
    let v = h.state().session().version();
    h.get_by_label("Filter models and parts").click();
    h.run_steps(2);
    h.get_by_label("Filter models and parts").type_text("pmceqrvlk");
    key(&mut h, egui::Key::ArrowLeft, egui::Modifiers::NONE);
    h.run_steps(2);
    assert_eq!(h.state().session().version(), v);
    assert_eq!(h.state().edit.tool, Tool::Select);
    assert_eq!(h.state().filter, "pmceqrvlk");
}

#[test]
fn recolour_selection_from_swatches() {
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    let orig = h.state().session().snapshot().described[0].color;
    let target_label = if orig == 4 { "Blue (1)" } else { "Red (4)" };
    let target_code = if orig == 4 { 1 } else { 4 };
    assert!(run(h.state_mut(), "model.recolour"));
    h.run_steps(2);
    h.get_by_label(target_label).click();
    h.run_steps(2);
    assert_eq!(h.state().session().snapshot().described[0].color, target_code);
    assert_eq!(h.state().history.colours.first().copied(), Some(target_code));
    assert!(h.state().swatches.open.is_none());
    assert!(run(h.state_mut(), "edit.undo"));
    assert_eq!(h.state().session().snapshot().described[0].color, orig);
}

#[test]
fn swatch_search_by_code() {
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.recolour"));
    h.run_steps(2);
    h.get_by_label("Search colours").type_text("4");
    h.run_steps(2);
    assert!(h.query_by_label("Red (4)").is_some());
    assert!(h.query_by_label("Blue (1)").is_none());
}

#[test]
fn new_part_colour_set_from_swatches() {
    let mut h = heli_harness();
    let v = h.state().session().version();
    h.state_mut().swatches.open(brickmotion::chrome::swatches::Target::NewParts);
    h.run_steps(2);
    h.get_by_label("Red (4)").click();
    h.run_steps(2);
    assert_eq!(h.state().edit.colour, 4);
    assert_eq!(h.state().session().version(), v);
}

#[test]
fn typing_in_swatch_search_does_not_edit() {
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    let v = h.state().session().version();
    assert!(run(h.state_mut(), "model.recolour"));
    h.run_steps(2);
    h.get_by_label("Search colours").type_text("pmceqrvlk");
    h.run_steps(2);
    assert_eq!(h.state().session().version(), v);
    assert_eq!(h.state().edit.tool, Tool::Select);
}
