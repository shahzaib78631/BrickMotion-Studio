// Steps tab, step menu/commands, step editor single-undo typing, Parts tab, and big-model perf.
use std::time::{Duration, Instant};

use bm::library::PartMatch;
use bm::placement::PlacementState;
use brickmotion::{BrickMotionApp, run};
use egui::{Event, Modifiers, PointerButton, Pos2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const CAR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/8880-1.mpd");
const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn harness_for(path: &str) -> Harness<'static, BrickMotionApp> {
    let p = path.to_owned();
    let mut h = Harness::builder()
        .with_size([1440.0, 900.0])
        .build_eframe(move |cc| {
            let mut app = BrickMotionApp::new_for_test_cc(cc, Some(p.into()));
            app.wait_loaded();
            app.dialogs_off();
            app
        });
    h.run_steps(3);
    h
}

#[test]
fn steps_tab_lists_steps() {
    let mut h = harness_for(CAR);
    h.get_by_role_and_label(egui::accesskit::Role::Tab, "Steps").click();
    h.run_steps(2);
    assert!(h.state().session().steps().len() >= 2);
    assert!(h.query_by_label("Step 1").is_some());
    assert!(h.query_by_label("Step 2").is_some());
}

#[test]
fn clicking_a_step_selects_its_pieces() {
    let mut h = harness_for(CAR);
    h.get_by_role_and_label(egui::accesskit::Role::Tab, "Steps").click();
    h.run_steps(2);
    h.get_by_label("Step 1").click();
    h.run_steps(2);
    assert_eq!(h.state().edit.step, Some(0));
    let mut sel = h.state().session().selection();
    let mut expected = h.state().session().pieces_of_step(0);
    sel.sort();
    expected.sort();
    assert_eq!(sel, expected);
}

#[test]
fn insert_after_adds_a_step_and_undo_removes_it() {
    let mut h = harness_for(CAR);
    let n = h.state().session().steps().len();
    h.state_mut().edit.step = Some(0);
    assert!(run(h.state_mut(), "step.insert_after"));
    assert_eq!(h.state().session().steps().len(), n + 1);
    assert!(run(h.state_mut(), "edit.undo"));
    assert_eq!(h.state().session().steps().len(), n);
}

#[test]
fn gather_selection_moves_pieces_to_the_chosen_step() {
    let mut h = harness_for(CAR);
    let item1 = h.state().session().step_items(1)[0].pieces.clone();
    let before = h.state().session().pieces_of_step(0).len();
    h.state_mut().doc.session().select(&item1, bm::SelectMode::Replace);
    h.state_mut().edit.step = Some(0);
    assert!(run(h.state_mut(), "model.to_step"));
    assert_eq!(h.state().session().pieces_of_step(0).len(), before + item1.len());
}

#[test]
fn step_title_typing_is_one_undo_step() {
    let mut h = harness_for(CAR);
    let orig = h.state().session().steps()[0].title.clone();
    h.state_mut().edit.step = Some(0);
    assert!(run(h.state_mut(), "step.edit"));
    h.run_steps(2);
    h.get_by_label("Step title").type_text("Wheels");
    h.run_steps(2);
    h.get_by_label("Done").click();
    h.run_steps(2);
    assert!(h.state().steps.editor.is_none());
    assert_eq!(h.state().session().steps()[0].title, "Wheels");
    assert!(run(h.state_mut(), "edit.undo"));
    assert!(!h.state().session().can_undo(), "typing a step title must be one undo step");
    assert_eq!(h.state().session().steps()[0].title, orig);
}

#[test]
fn typing_in_step_title_does_not_edit() {
    let mut h = harness_for(CAR);
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    let piece_before = h.state().session().copy(&[0]);
    h.state_mut().edit.step = Some(0);
    assert!(run(h.state_mut(), "step.edit"));
    h.run_steps(2);
    h.get_by_label("Step title").type_text("eqrc");
    h.run_steps(2);
    h.get_by_label("Done").click();
    h.run_steps(2);
    assert_eq!(h.state().session().steps()[0].title, "eqrc");
    assert_eq!(h.state().session().copy(&[0]), piece_before, "typing eqrc in step title must not move/clone/turn piece 0");
}

#[test]
fn parts_tab_counts_parts() {
    let mut h = harness_for(HELI);
    h.get_by_role_and_label(egui::accesskit::Role::Tab, "Parts").click();
    h.run_steps(2);
    let total: usize = h.state().parts.rows().iter().map(|r| r.pieces.len()).sum();
    assert_eq!(total, h.state().piece_count());
    let first = h.state().parts.rows()[0].clone();
    let short = if first.submodel {
        first.name.clone()
    } else {
        brickmotion::chrome::library::short_name(&first.name).to_owned()
    };
    let label = format!("{} ({})", short, first.pieces.len());
    h.get_by_label(&label).click();
    h.run_steps(2);
    assert_eq!(h.state().session().selection().len(), first.pieces.len());
}

fn click(h: &mut Harness<'static, BrickMotionApp>, pos: Pos2) {
    h.event(Event::PointerMoved(pos));
    for pressed in [true, false] {
        h.event(Event::PointerButton { pos, button: PointerButton::Primary, pressed, modifiers: Modifiers::NONE });
    }
}

#[test]
fn new_parts_go_into_the_chosen_step() {
    if !bm::metal_available() {
        return;
    }
    let mut h = harness_for(CAR);
    h.state_mut().edit.step = Some(0);
    let before = h.state().session().pieces_of_step(0).len();
    let centre = h.state().viewport_rect().unwrap().center();
    let brick = PartMatch { name: "3001.dat".into(), description: "Brick 2 x 4".into(), category: "Brick".into() };
    h.state_mut().begin_placement(brick);

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut target = centre;
    h.event(Event::PointerMoved(target));
    let mut settled = false;
    while Instant::now() < deadline {
        h.step();
        if let Some(p) = &h.state().edit.placement
            && !matches!(p.state, PlacementState::Inactive | PlacementState::Preparing)
        {
            if p.state.is_placeable() {
                settled = true;
                break;
            }
            target = centre + egui::vec2(180.0, 120.0);
            h.event(Event::PointerMoved(target));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(settled, "placement never reached a placeable state");
    click(&mut h, target);
    h.run_steps(4);
    assert_eq!(h.state().session().pieces_of_step(0).len(), before + 1);
}

#[test]
#[ignore = "big model layout check; run with BM_BIG_MODEL=<abs path> --release -- --ignored"]
fn big_model_steps_and_parts_layout() {
    let Some(big) = std::env::var_os("BM_BIG_MODEL") else {
        panic!("set BM_BIG_MODEL to an absolute model path");
    };
    let mut h = Harness::builder()
        .with_size([1440.0, 900.0])
        .build_eframe(move |cc| {
            let mut app = BrickMotionApp::new_for_test_cc(cc, Some(big.into()));
            app.wait_loaded();
            app.dialogs_off();
            app
        });
    assert!(h.state().piece_count() > 1000, "big model did not open");
    h.state_mut().browser_tab = 1;
    h.run_steps(3);
    let mut slowest_steps = Duration::ZERO;
    for _ in 0..5 {
        h.step();
        slowest_steps = slowest_steps.max(h.state().steps.last_show);
    }
    h.state_mut().browser_tab = 2;
    h.run_steps(3);
    let mut slowest_parts = Duration::ZERO;
    for _ in 0..5 {
        h.step();
        slowest_parts = slowest_parts.max(h.state().parts.last_show);
    }
    eprintln!("big model steps={slowest_steps:?}, parts={slowest_parts:?}");
    assert!(slowest_steps < Duration::from_millis(16), "steps layout too slow: {slowest_steps:?}");
    assert!(slowest_parts < Duration::from_millis(16), "parts layout too slow: {slowest_parts:?}");
}

#[test]
fn chosen_step_survives_undo_of_its_insert() {
    let mut h = harness_for(CAR);
    let n = h.state().session().steps().len();
    h.state_mut().edit.step = Some(n - 1);
    assert!(run(h.state_mut(), "step.insert_after"));
    assert_eq!(h.state().edit.step, Some(n));
    assert!(run(h.state_mut(), "edit.undo"));
    h.run_steps(2);
    let chosen = h.state().edit.step;
    let count = h.state().session().steps().len();
    assert!(chosen.is_none_or(|i| i < count), "edit.step = {chosen:?} but only {count} steps");
}

#[test]
fn step_editor_closes_when_its_step_goes() {
    let mut h = harness_for(CAR);
    let n = h.state().session().steps().len();
    h.state_mut().edit.step = Some(n - 1);
    assert!(run(h.state_mut(), "step.edit"));
    h.run_steps(2);
    assert!(h.state().steps.editor.is_some());
    // Delete the edited step from the menu path while its editor is open.
    assert!(run(h.state_mut(), "step.delete"));
    h.run_steps(2);
    assert!(h.state().steps.editor.is_none(), "editor still open on a deleted step");
    assert_eq!(h.state().session().steps().len(), n - 1);
    assert!(run(h.state_mut(), "edit.undo"));
    assert_eq!(h.state().session().steps().len(), n);
}
