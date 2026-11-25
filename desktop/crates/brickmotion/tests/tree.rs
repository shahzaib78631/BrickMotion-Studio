// The Browser's model tree: built from the engine's outline, rebuilt only on structural change,
// filtered, and selecting what a row holds.
use std::path::Path;

use brickmotion::BrickMotionApp;
use brickmotion::chrome::tree::Tree;
use egui::accesskit::Role;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");
const NESTED: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/8880-1.mpd");

fn session(p: &str) -> bm::Session {
    let mut s = bm::Session::new();
    s.open(Path::new(p)).unwrap();
    s
}

#[test]
fn tree_rebuilds_only_on_structure_change() {
    let mut s = session(HELI);
    let mut tree = Tree::default();
    tree.sync(&s);
    tree.sync(&s);
    assert_eq!(tree.rebuilds, 1);
    assert_eq!(s.remove(&[0]).refused, None);
    tree.sync(&s);
    assert_eq!(tree.rebuilds, 2);
    s.select(&[1], bm::SelectMode::Replace);
    tree.sync(&s);
    assert_eq!(tree.rebuilds, 2);
}

#[test]
fn filter_keeps_ancestors() {
    let s = session(NESTED);
    let rows = s.outline();
    let deep = rows.iter().position(|r| r.depth >= 2).expect("8880-1 nests submodels two deep");
    let parent = rows[deep].parent.unwrap();
    let mut tree = Tree::default();
    tree.sync(&s);
    let name = rows[deep].name.to_uppercase();
    let shown = tree.visible(&name);
    assert!(shown.contains(&deep), "the match");
    assert!(shown.contains(&parent), "its parent");
    assert!(shown.contains(&0), "the root");
    // Without a filter, a closed parent hides its children.
    assert!(!tree.visible("").contains(&deep));
}

#[test]
fn click_row_selects_its_pieces() {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
        app.wait_loaded();
        app
    });
    h.run_steps(3);
    let rows = h.state().session().outline();
    let n = h.state().piece_count();
    h.get_by_role_and_label(Role::TreeItem, &rows[0].name).click();
    h.run_steps(2);
    assert_eq!(h.state().session().selection().len(), n);
    // A submodel row selects just its pieces.
    if let Some(sub) = rows.iter().find(|r| r.depth == 1 && r.pieces > 0) {
        let want = h.state().session().pieces_of_row(&sub.id).len();
        h.get_all_by_role_and_label(Role::TreeItem, &sub.name).next().unwrap().click();
        h.run_steps(2);
        assert_eq!(h.state().session().selection().len(), want);
    }
}

/// With BM_BIG_MODEL=<path> (release): laying out the Models tab stays under 16 ms a frame,
/// scrolled through to the end. (The whole frame also draws the 3D view, which is timed apart.)
#[test]
fn big_model_tree_frame_time() {
    let Some(big) = std::env::var_os("BM_BIG_MODEL") else { return };
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(move |cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(big.clone().into()));
        app.wait_loaded();
        app
    });
    h.run_steps(3);
    // Open every row so the list is as long as it gets.
    h.state_mut().tree.open_all();
    // Everything selected: each row checks its pieces against the selection every frame.
    h.state_mut().doc.session_mut().select_all();
    h.run_steps(2);
    let rows = h.state().tree.len();
    assert!(rows > 0, "the model did not open: {:?}", h.state().notices());
    let mut slowest = std::time::Duration::ZERO;
    for _ in 0..40 {
        h.event(egui::Event::PointerMoved(egui::pos2(150.0, 300.0)));
        h.event(egui::Event::MouseWheel { unit: egui::MouseWheelUnit::Page, delta: egui::vec2(0.0, -5.0), modifiers: egui::Modifiers::NONE, phase: egui::TouchPhase::Move, source: egui::MouseWheelSource::Wheel });
        h.step();
        slowest = slowest.max(h.state().tree.last_show);
    }
    eprintln!("{rows} tree rows, slowest tree layout {slowest:?}");
    assert!(slowest < std::time::Duration::from_millis(16), "slowest tree layout {slowest:?}");
}

