// Library tab: common parts, search, category filtering, Add Part focus, virtualised preview budget.
use std::time::{Duration, Instant};

use brickmotion::chrome::library::short_name;
use brickmotion::{BrickMotionApp, Tool, run};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

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

#[test]
fn library_shows_common_parts() {
    let mut h = heli_harness();
    h.get_by_label("Library").click();
    h.run_steps(2);
    assert!(h.query_by_label("Common").is_some());
    let common = bm::library::common_parts();
    assert!(!common.is_empty());
    let first = short_name(&common[0].name);
    assert!(h.query_by_label(first).is_some(), "expected tile for {first}");
}

#[test]
fn search_shows_results() {
    let mut h = heli_harness();
    h.get_by_label("Library").click();
    h.run_steps(2);
    h.get_by_label("Filter models and parts").click();
    h.get_by_label("Filter models and parts").type_text("3001");
    h.run_steps(2);
    assert_eq!(h.state().library.results().first().map(|p| p.name.as_str()), Some("3001.dat"));
    assert!(h.query_by_label("3001").is_some());
}

#[test]
fn category_filters() {
    let mut h = heli_harness();
    h.get_by_label("Library").click();
    h.state_mut().library.category = "Brick".into();
    h.run_steps(2);
    let results = h.state().library.results();
    assert!(!results.is_empty());
    assert!(results.iter().all(|p| p.category == "Brick"));
}

#[test]
fn add_part_opens_library_search() {
    let mut h = heli_harness();
    assert!(run(h.state_mut(), "model.add_part"));
    h.run_steps(2);
    assert_eq!(h.state().browser_tab, 3);
    assert!(h.state().text_focus, "filter should have focus after model.add_part");
}

#[test]
fn library_requests_only_visible_previews() {
    let mut h = heli_harness();
    h.state_mut().browser_tab = 3;
    h.state_mut().library.category = "Brick".into();
    h.run_steps(2);
    let total = h.state().library.results().len();
    assert!(total > 40, "expected many Brick parts, got {total}");
    let asked = h.state().previews.requested_this_frame();
    // 380-pt viewport holds ~5 rows of 4 tiles (20 tiles) + 1 buffer row = 24 tiles max.
    assert!(asked > 0 && asked <= 28, "expected only visible tiles to request previews, asked {asked} of {total}");
}

#[test]
#[ignore = "release frame-time check; run with --release -- --ignored"]
fn library_scroll_stays_under_16ms_in_release() {
    let mut h = heli_harness();
    h.state_mut().browser_tab = 3;
    h.state_mut().library.category = "Brick".into();
    h.run_steps(2);
    let mut slowest = Duration::ZERO;
    for _ in 0..10 {
        h.event(egui::Event::PointerMoved(egui::pos2(150.0, 340.0)));
        h.event(egui::Event::MouseWheel {
            unit: egui::MouseWheelUnit::Point,
            delta: egui::vec2(0.0, -240.0),
            phase: egui::TouchPhase::Move,
            modifiers: egui::Modifiers::NONE,
            source: egui::MouseWheelSource::Wheel,
        });
        let t0 = Instant::now();
        h.step();
        let _ = t0.elapsed();
        slowest = slowest.max(h.state().library.last_show);
    }
    eprintln!("library scroll slowest layout: {slowest:?}");
    assert!(slowest < Duration::from_millis(16), "library scroll too slow: {slowest:?}");
}

#[test]
fn typing_in_library_search_does_not_edit() {
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.add_part"));
    h.run_steps(2);
    let v = h.state().session().version();
    h.get_by_label("Filter models and parts").type_text("pmceqr");
    h.run_steps(2);
    assert_eq!(h.state().session().version(), v);
    assert_eq!(h.state().edit.tool, Tool::Select);
}

#[test]
fn replace_swaps_the_part_and_keeps_colour() {
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    let orig = h.state().session().snapshot().described[0].clone();
    let target = if orig.part == "3001.dat" { "3003" } else { "3001" };
    let target_dat = format!("{target}.dat");

    assert!(run(h.state_mut(), "model.replace"));
    h.run_steps(2);
    assert!(h.state().replace.open);
    h.get_by_label("Replace part search").type_text(target);
    h.run_steps(2);
    h.get_by_label(target).click();
    h.run_steps(1);
    // Click the modal's primary Replace button (ribbon also has a "Replace" button, so pick the last).
    let replace_buttons: Vec<_> = h.query_all_by_label("Replace").collect();
    replace_buttons.last().expect("Replace button").click();
    h.run_steps(2);

    assert!(!h.state().replace.open);
    let after = h.state().session().snapshot().described[0].clone();
    assert_eq!(after.part, target_dat);
    assert_eq!(after.color, orig.color);
    assert!(run(h.state_mut(), "edit.undo"));
    assert_eq!(h.state().session().snapshot().described[0].part, orig.part);
}

#[test]
fn replace_needs_a_selection() {
    let mut h = heli_harness();
    assert!(!run(h.state_mut(), "model.replace"));
    assert!(!h.state().replace.open);
}

#[test]
fn cancel_changes_nothing() {
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    let v = h.state().session().version();
    assert!(run(h.state_mut(), "model.replace"));
    h.run_steps(2);
    h.get_by_label("Replace part search").type_text("3001");
    h.run_steps(2);
    h.get_by_label("Cancel").click();
    h.run_steps(2);
    assert!(!h.state().replace.open);
    assert_eq!(h.state().session().version(), v);
}
