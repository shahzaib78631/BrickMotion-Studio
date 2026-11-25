// Viewport move and rotate gizmos: drawing, hit-testing, single-undo drag, orbit passthrough.
use bm::gizmo::Handle;
use brickmotion::{BrickMotionApp, Tool, run};
use egui::{Event, Modifiers, PointerButton, Pos2, pos2};
use egui_kittest::Harness;

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

fn to_screen(rect: egui::Rect, v: bm::Vec2) -> Pos2 {
    pos2(rect.left() + v.x as f32, rect.top() + v.y as f32)
}

#[test]
fn move_tool_shows_a_gizmo() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.move"));
    h.run_steps(2);
    assert_eq!(h.state().gizmo_lines(), 3);
}

#[test]
fn select_tool_has_no_gizmo() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    assert_eq!(h.state().edit.tool, Tool::Select);
    h.run_steps(2);
    assert_eq!(h.state().gizmo_lines(), 0);
}

#[test]
fn gizmo_drag_is_one_undo_step() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.move"));
    h.run_steps(2);

    let rect = h.state().viewport_rect().expect("viewport rect");
    let (a, b, _) = h.state().gizmo_line(0).expect("line 0");
    let start = to_screen(rect, b);
    let dir = (to_screen(rect, b) - to_screen(rect, a)).normalized();
    let before = h.state().session().copy(&[0]);

    h.event(Event::PointerMoved(start));
    h.event(Event::PointerButton { pos: start, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
    h.step();
    for k in 1..=6 {
        let p = start + dir * (k as f32 * 20.0);
        h.event(Event::PointerMoved(p));
        h.step();
    }
    let end = start + dir * 120.0;
    h.event(Event::PointerButton { pos: end, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
    h.run_steps(2);

    let after = h.state().session().copy(&[0]);
    assert_ne!(before, after, "piece 0 should have moved along the gizmo axis");
    assert!(h.state().session().can_undo());
    assert!(run(h.state_mut(), "edit.undo"));
    assert!(!h.state().session().can_undo(), "entire gizmo drag must be one undo step");
    assert_eq!(h.state().session().copy(&[0]), before);
}

#[test]
fn rotate_drag_is_one_undo_step() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.rotate_tool"));
    h.run_steps(2);

    let rect = h.state().viewport_rect().expect("viewport rect");
    let ring = h.state().gizmo_ring(Handle::Y).expect("Y rotate ring");
    assert!(ring.len() >= 8);
    let before = h.state().session().copy(&[0]);

    let start = to_screen(rect, ring[0]);
    h.event(Event::PointerMoved(start));
    h.event(Event::PointerButton { pos: start, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
    h.step();
    let steps = 6;
    let target_idx = ring.len() / 3;
    for k in 1..=steps {
        let idx = (target_idx * k) / steps;
        h.event(Event::PointerMoved(to_screen(rect, ring[idx])));
        h.step();
    }
    let end = to_screen(rect, ring[target_idx]);
    h.event(Event::PointerButton { pos: end, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
    h.run_steps(2);

    let after = h.state().session().copy(&[0]);
    assert_ne!(before, after, "piece 0 should have rotated on the Y ring");
    assert!(h.state().session().can_undo());
    assert!(run(h.state_mut(), "edit.undo"));
    assert!(!h.state().session().can_undo(), "entire rotate drag must be one undo step");
    assert_eq!(h.state().session().copy(&[0]), before);
}

#[test]
fn press_off_the_gizmo_orbits() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.move"));
    h.run_steps(2);

    let v0 = h.state().session().version();
    let cam0 = h.state_mut().doc.viewport().unwrap().camera();
    let empty = pos2(450.0, 260.0);
    h.event(Event::PointerMoved(empty));
    h.event(Event::PointerButton { pos: empty, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
    h.step();
    for k in 1..=4 {
        h.event(Event::PointerMoved(empty + egui::vec2(k as f32 * 25.0, k as f32 * 10.0)));
        h.step();
    }
    h.event(Event::PointerButton {
        pos: empty + egui::vec2(100.0, 40.0),
        button: PointerButton::Primary,
        pressed: false,
        modifiers: Modifiers::NONE,
    });
    h.run_steps(2);

    let cam1 = h.state_mut().doc.viewport().unwrap().camera();
    assert_eq!(h.state().session().version(), v0, "model must not edit when dragging empty space");
    assert_ne!(cam0.yaw, cam1.yaw, "camera should orbit instead");
}
