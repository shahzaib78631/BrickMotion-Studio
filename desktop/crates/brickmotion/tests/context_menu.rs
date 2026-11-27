// The viewport's right-click menus: rows for a piece and for empty space, and what they do.
use std::path::{Path, PathBuf};

use brickmotion::BrickMotionApp;
use brickmotion::chrome::context_menu::{Action, Row, apply, rows};
use brickmotion::viewport::ContextTarget;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

fn three_bricks() -> Harness<'static, BrickMotionApp> {
    let dir = std::env::temp_dir().join(format!("bm-context-{}-{:?}", std::process::id(), std::thread::current().id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path: PathBuf = dir.join("three.ldr");
    std::fs::write(
        &path,
        "0 Three\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 4 80 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 1 160 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n",
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

/// Every item label, submenus included, with whether it is enabled.
fn items(rows: &[Row]) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    for r in rows {
        match r {
            Row::Item { label, enabled, .. } => out.push((label.clone(), *enabled)),
            Row::Sub { label, rows, .. } => {
                out.push((label.clone(), true));
                out.extend(items(rows));
            }
            _ => {}
        }
    }
    out
}

fn has(rows: &[Row], label: &str) -> Option<bool> {
    items(rows).into_iter().find(|(l, _)| l == label).map(|(_, on)| on)
}

fn action(rows: &[Row], label: &str) -> Action {
    fn find(rows: &[Row], label: &str) -> Option<Action> {
        rows.iter().find_map(|r| match r {
            Row::Item { label: l, action, .. } if l == label => Some(action.clone()),
            Row::Sub { rows, .. } => find(rows, label),
            _ => None,
        })
    }
    find(rows, label).unwrap_or_else(|| panic!("no row {label}"))
}

#[test]
fn empty_space_menu() {
    let mut h = three_bricks();
    let r = rows(h.state_mut(), ContextTarget::Empty);
    for label in ["Paste", "Select All", "Show All", "Fit All", "View", "Front", "Bottom", "Orthographic", "Home View", "Add Part", "New Submodel"] {
        assert!(has(&r, label).is_some(), "{label}");
    }
    assert!(r.iter().any(|row| matches!(row, Row::Sub { label, rows, .. } if label == "View"
        && rows.iter().any(|x| matches!(x, Row::Item { label, checked: Some(false), .. } if label == "Orthographic")))));
}

#[test]
fn piece_menu_for_a_loose_brick() {
    let mut h = three_bricks();
    h.state_mut().session().select(&[2], bm::SelectMode::Replace);
    let r = rows(h.state_mut(), ContextTarget::Piece(2));
    let Row::Header { title, subtitle } = &r[0] else { panic!("header first: {:?}", r[0]) };
    assert!(title.contains("Brick"), "{title}");
    assert!(subtitle.starts_with("3001 · ") && subtitle.ends_with("Step 1"), "{subtitle}");
    assert_eq!(has(&r, "Make Submodel"), Some(false), "needs two pieces");
    assert_eq!(has(&r, "Extract"), None, "only for a submodel");
    assert_eq!(has(&r, "Open Submodel"), None);
    assert_eq!(has(&r, "Remove from Group"), None, "not in a group");
    assert_eq!(has(&r, "Delete"), Some(true));
    assert_eq!(has(&r, "Move to Step"), Some(true));
    assert_eq!(has(&r, "Step 1"), Some(false), "its own step");
    assert_eq!(action(&r, "Use This Colour for New Parts"), Action::UseColour(1));

    apply(h.state_mut(), Action::UseColour(1));
    assert_eq!(h.state().edit.colour, 1);
    apply(h.state_mut(), action(&r, "Delete"));
    assert_eq!(h.state().session().piece_count(), 2);
}

#[test]
fn piece_menu_for_a_submodel_use() {
    let mut h = three_bricks();
    let s = h.state().session();
    assert_eq!(s.make_submodel(&[0, 1], "Rotor").refused, None);
    let sel = h.state().session().selection();
    assert_eq!(sel.len(), 2);
    let r = rows(h.state_mut(), ContextTarget::Piece(sel[0]));
    assert_eq!(has(&r, "Extract"), Some(true));
    assert_eq!(has(&r, "Make Unique"), Some(true));
    let Action::OpenSubmodel(path) = action(&r, "Open Submodel") else { panic!() };
    assert_eq!(path.last().map(String::as_str), Some("Rotor"));
    apply(h.state_mut(), Action::OpenSubmodel(path));
    assert_eq!(h.state().session().focused(), "Rotor");
}

#[test]
fn move_to_model_and_group_rows() {
    let mut h = three_bricks();
    let s = h.state().session();
    assert_eq!(s.new_submodel("Spare").refused, None);
    assert_eq!(s.make_submodel(&[0], "Pod").refused.map(|_| ()), Some(()), "one piece is refused");
    assert_eq!(s.make_submodel(&[0, 1], "Pod").refused, None);
    assert_eq!(s.set_group(&[2], "Wheels").refused, None);
    s.select(&[2], bm::SelectMode::Replace);
    let r = rows(h.state_mut(), ContextTarget::Piece(2));
    assert_eq!(action(&r, "Pod"), Action::MoveToModel("Pod".into()));
    assert_eq!(has(&r, "Spare"), None, "only submodels this model uses");
    assert_eq!(has(&r, "Remove from Group"), Some(true));
    h.state().session().select(&[], bm::SelectMode::Replace);
    apply(h.state_mut(), action(&r, "Same Group · Wheels"));
    assert_eq!(h.state().session().selection(), vec![2]);

    let pieces = h.state().session().piece_count();
    apply(h.state_mut(), Action::MoveToModel("Pod".into()));
    assert!(h.state().notices().is_empty(), "{:?}", h.state().notices().last().map(|n| n.detail()));
    assert_eq!(h.state().session().undo_name(), "Move Piece to Pod");
    assert_eq!(h.state().session().piece_count(), pieces);
}

fn press(h: &mut Harness<'static, BrickMotionApp>, pos: egui::Pos2, pressed: bool) {
    h.event(egui::Event::PointerButton { pos, button: egui::PointerButton::Secondary, pressed, modifiers: egui::Modifiers::NONE });
    h.step();
}

#[test]
fn right_click_opens_the_piece_menu() {
    if !bm::metal_available() {
        return;
    }
    let mut h = three_bricks();
    assert!(brickmotion::run(h.state_mut(), "view.fit"));
    h.run_steps(6);
    let rect = h.state().viewport.last_rect().expect("viewport drawn");
    // Find a point on a brick, scanning a band through the middle of the view.
    let hit = (0..80).find_map(|i| {
        let at = egui::pos2(rect.left() + rect.width() * (0.2 + 0.6 * i as f32 / 80.0), rect.center().y);
        let vp = h.state_mut().doc.viewport()?;
        vp.pick((at.x - rect.left()) as f64, (at.y - rect.top()) as f64).map(|p| (at, p))
    });
    let (at, piece) = hit.expect("a brick under the middle of the view");
    h.state().session().select(&[], bm::SelectMode::Replace);
    h.event(egui::Event::PointerMoved(at));
    h.step();
    press(&mut h, at, true);
    press(&mut h, at, false);
    h.run_steps(3);
    assert_eq!(h.state().viewport.context_target, Some(ContextTarget::Piece(piece)));
    assert!(h.state().session().selection().contains(&piece), "the clicked piece is selected");
    h.get_by_label("Use This Colour for New Parts");
    h.get_by_label("Move to Step").hover();
    h.run_steps(4);
    h.get_by_label("Step 1");
}

#[test]
fn right_click_on_empty_space_opens_the_view_menu() {
    if !bm::metal_available() {
        return;
    }
    let mut h = three_bricks();
    h.run_steps(4);
    let rect = h.state().viewport.last_rect().expect("viewport drawn");
    let at = egui::pos2(rect.left() + 300.0, rect.bottom() - 60.0);
    assert_eq!(h.state_mut().doc.viewport().unwrap().pick((at.x - rect.left()) as f64, (at.y - rect.top()) as f64), None);
    h.event(egui::Event::PointerMoved(at));
    h.step();
    press(&mut h, at, true);
    press(&mut h, at, false);
    h.run_steps(3);
    assert_eq!(h.state().viewport.context_target, Some(ContextTarget::Empty));
    h.get_by_label("New Submodel").click();
    h.run_steps(3);
    assert!(h.state().naming.is_some(), "New Submodel asks for a name");
}

#[test]
fn escape_closes_the_menu_and_keeps_the_selection() {
    if !bm::metal_available() {
        return;
    }
    let mut h = three_bricks();
    h.run_steps(4);
    let rect = h.state().viewport.last_rect().expect("viewport drawn");
    let at = egui::pos2(rect.left() + 300.0, rect.bottom() - 60.0);
    h.state().session().select(&[1], bm::SelectMode::Replace);
    h.event(egui::Event::PointerMoved(at));
    h.step();
    press(&mut h, at, true);
    press(&mut h, at, false);
    h.run_steps(3);
    h.get_by_label("New Submodel");
    h.key_press(egui::Key::Escape);
    h.run_steps(3);
    assert!(h.query_by_label("New Submodel").is_none(), "Esc closes the menu");
    assert_eq!(h.state().session().selection(), vec![1], "Esc went to the menu, not Select None");
    // The next right-click opens a menu straight away.
    press(&mut h, at, true);
    press(&mut h, at, false);
    h.run_steps(3);
    h.get_by_label("New Submodel");
}
