// Live part placement: snapping preview, click to commit, Esc cancel, R turn, stale guard, HUD.
use std::time::{Duration, Instant};

use bm::library::PartMatch;
use bm::placement::PlacementState;
use brickmotion::{BrickMotionApp, run};
use egui::{Event, Key, Modifiers, PointerButton, Pos2};
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

fn brick_3001() -> PartMatch {
    PartMatch { name: "3001.dat".into(), description: "Brick 2 x 4".into(), category: "Brick".into() }
}

fn key(h: &mut Harness<'static, BrickMotionApp>, key: Key, modifiers: Modifiers) {
    for pressed in [true, false] {
        h.event(Event::Key { key, physical_key: None, pressed, repeat: false, modifiers });
    }
}

fn click(h: &mut Harness<'static, BrickMotionApp>, pos: Pos2) {
    h.event(Event::PointerMoved(pos));
    for pressed in [true, false] {
        h.event(Event::PointerButton { pos, button: PointerButton::Primary, pressed, modifiers: Modifiers::NONE });
    }
}

fn wait_settle(h: &mut Harness<'static, BrickMotionApp>, at: Pos2) -> PlacementState {
    h.event(Event::PointerMoved(at));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        h.step();
        if let Some(p) = &h.state().edit.placement
            && !matches!(p.state, PlacementState::Inactive | PlacementState::Preparing)
        {
            return p.state;
        }
        assert!(Instant::now() < deadline, "placement preview never settled");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn click_places_one_piece() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    let n = h.state().piece_count();
    let centre = h.state().viewport_rect().unwrap().center();
    h.state_mut().begin_placement(brick_3001());
    let state = wait_settle(&mut h, centre);
    assert!(matches!(state, PlacementState::Free | PlacementState::Snapped | PlacementState::Blocked));

    // If blocked at the exact centre, step slightly toward empty floor space so it is placeable.
    let target = if state.is_placeable() {
        centre
    } else {
        let off = centre + egui::vec2(180.0, 120.0);
        let s2 = wait_settle(&mut h, off);
        assert!(s2.is_placeable(), "expected placeable state off-centre, got {s2:?}");
        off
    };

    click(&mut h, target);
    h.run_steps(4);
    assert_eq!(h.state().piece_count(), n + 1);
    assert!(h.state().edit.placement.is_none());
    assert_eq!(h.state().history.recent_parts().first().map(|p| p.name.as_str()), Some("3001.dat"));
    assert!(run(h.state_mut(), "edit.undo"));
    assert_eq!(h.state().piece_count(), n);
}

#[test]
fn escape_cancels() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    let n = h.state().piece_count();
    h.state_mut().begin_placement(brick_3001());
    h.run_steps(2);
    assert!(h.state().edit.placement.is_some());
    key(&mut h, Key::Escape, Modifiers::NONE);
    h.run_steps(2);
    assert!(h.state().edit.placement.is_none());
    assert_eq!(h.state().piece_count(), n);
}

#[test]
fn r_turns_the_preview_not_the_selection() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    let before = h.state().session().copy(&[0]);
    h.state_mut().begin_placement(brick_3001());
    h.run_steps(2);
    key(&mut h, Key::R, Modifiers::NONE);
    h.run_steps(2);
    assert_eq!(h.state().edit.placement.as_ref().unwrap().turns(), 1);
    assert_eq!(h.state().session().copy(&[0]), before, "R during placement must not rotate the selection");
}

#[test]
fn placement_cancels_when_the_model_changes() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    let n = h.state().piece_count();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    let centre = h.state().viewport_rect().unwrap().center();
    h.state_mut().begin_placement(brick_3001());
    let _ = wait_settle(&mut h, centre);

    assert!(run(h.state_mut(), "edit.delete"));
    h.run_steps(2);
    assert!(h.state().edit.placement.is_none(), "live placement must cancel when model changes");
    click(&mut h, centre);
    h.run_steps(3);
    assert_eq!(h.state().piece_count(), n - 1, "clicking after cancel must not commit a stale pose");
}

#[test]
fn hud_follows_the_state() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    let centre = h.state().viewport_rect().unwrap().center();
    h.state_mut().begin_placement(brick_3001());
    let _ = wait_settle(&mut h, centre);
    h.run_steps(2);
    let status = h.state().edit.placement.as_ref().unwrap().status_text();
    assert!(h.query_by_label("3001").is_some(), "HUD shows part name");
    assert!(h.query_by_label(&status).is_some(), "HUD shows current status '{status}'");
}

#[test]
fn new_part_uses_the_chosen_colour() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().edit.colour = 4;
    let centre = h.state().viewport_rect().unwrap().center();
    h.state_mut().begin_placement(brick_3001());
    let state = wait_settle(&mut h, centre);
    let target = if state.is_placeable() {
        centre
    } else {
        let off = centre + egui::vec2(180.0, 120.0);
        let _ = wait_settle(&mut h, off);
        off
    };
    click(&mut h, target);
    h.run_steps(4);
    let snap = h.state().session().snapshot();
    assert!(!snap.described.is_empty(), "newly placed piece is selected");
    assert_eq!(snap.described[0].color, 4);
}
