// P3: the Scale tool (S) — square handles per axis, a centre disc for even scaling, one undo step.
use bm::gizmo::Handle;
use brickmotion::gizmo::scale_factor;
use brickmotion::{BrickMotionApp, Tool, run};
use egui::{Event, Modifiers, PointerButton, Pos2, pos2};
use egui_kittest::Harness;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn heli() -> Harness<'static, BrickMotionApp> {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
        app.wait_loaded();
        app.dialogs_off();
        app.prefs.auto_plan = false;
        app
    });
    h.run_steps(3);
    h
}

fn to_screen(rect: egui::Rect, v: bm::Vec2) -> Pos2 {
    pos2(rect.left() + v.x as f32, rect.top() + v.y as f32)
}

fn v(x: f64, y: f64) -> bm::Vec2 {
    bm::Vec2::new(x, y)
}

#[test]
fn factor_follows_the_handle_and_clamps() {
    let (o, tip) = (v(0.0, 0.0), v(100.0, 0.0));
    assert!((scale_factor(o, tip, Handle::X, tip, v(200.0, 0.0), false) - 2.0).abs() < 1e-9, "one axis length further doubles");
    assert!((scale_factor(o, tip, Handle::X, tip, v(150.0, 40.0), false) - 1.5).abs() < 1e-9, "only the part along the axis counts");
    assert_eq!(scale_factor(o, tip, Handle::X, tip, v(-500.0, 0.0), false), 0.05, "never below 0.05×");
    assert_eq!(scale_factor(o, tip, Handle::X, tip, v(5000.0, 0.0), false), 20.0, "never above 20×");
    assert_eq!(scale_factor(o, tip, Handle::X, tip, v(161.0, 0.0), true), 1.5, "⇧ snaps to 0.25×");
    // The centre disc: right or up grows, left or down shrinks.
    assert!(scale_factor(o, tip, Handle::View, o, v(60.0, 0.0), false) > 1.0);
    assert!(scale_factor(o, tip, Handle::View, o, v(0.0, 60.0), false) < 1.0);
}

#[test]
fn s_picks_the_scale_tool() {
    let mut h = heli();
    assert!(run(h.state_mut(), "model.scale_tool"));
    assert_eq!(h.state().edit.tool, Tool::Scale);
    assert!(run(h.state_mut(), "model.scale_tool"));
    assert_eq!(h.state().edit.tool, Tool::Select, "a second press puts it away");
    let c = brickmotion::commands::find("model.scale_tool").unwrap();
    assert_eq!(c.keys, Some("S"));
}

#[test]
fn dragging_a_handle_stretches_the_selection_in_one_undo_step() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.scale_tool"));
    h.run_steps(2);
    assert_eq!(h.state().gizmo_lines(), 3, "one stalk per axis");
    let rect = h.state().viewport_rect().unwrap();

    // Hits: the tip square is the axis, the middle is the disc.
    let (o, tip, handle) = h.state().gizmo_line(1).unwrap();
    let shape_hit = |p: bm::Vec2| h.state().scale_gizmo_hit(p);
    assert_eq!(shape_hit(tip), handle);
    assert_eq!(shape_hit(o), Handle::View);

    let before = h.state().session().pose_of(0);
    let start = to_screen(rect, tip);
    let dir = to_screen(rect, tip) - to_screen(rect, o);
    h.event(Event::PointerMoved(start));
    h.event(Event::PointerButton { pos: start, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
    h.step();
    for k in 1..=4 {
        h.event(Event::PointerMoved(start + dir * (k as f32 * 0.125)));
        h.step();
    }
    assert!(h.state().scale_readout().is_some_and(|s| s.contains('×')), "a chip shows the factor while dragging");
    let end = start + dir * 0.5;
    h.event(Event::PointerButton { pos: end, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
    h.run_steps(2);
    assert!(h.state().scale_readout().is_none());

    let after = h.state().session().pose_of(0);
    assert_ne!(before.rotation, after.rotation, "the piece was stretched");
    assert!(run(h.state_mut(), "edit.undo"));
    assert!(!h.state().session().can_undo(), "the whole drag is one undo step");
    assert_eq!(h.state().session().pose_of(0), before);
}

/// Writes screenshots of the P3 screens to $P3_SHOTS (ignored; run by hand).
#[test]
#[ignore]
fn p3_screenshots() {
    let out = std::path::PathBuf::from(std::env::var("P3_SHOTS").unwrap_or_else(|_| "/tmp".into()));
    for theme in ["dark", "light"] {
        let mut h = Harness::builder().with_size([1440.0, 900.0]).wgpu().build_eframe(|cc| {
            let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
            app.wait_loaded();
            app.dialogs_off();
            app.prefs.auto_plan = false;
            app
        });
        h.run_steps(3);
        let ctx = h.ctx.clone();
        h.state_mut().set_theme(&ctx, theme);
        h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
        brickmotion::chrome::transform::set(h.state_mut(), brickmotion::chrome::transform::Field::Rotation(1), 90.0);
        brickmotion::chrome::transform::set(h.state_mut(), brickmotion::chrome::transform::Field::Scale(1), 1.5);
        h.run_steps(6);
        h.render().unwrap().save(out.join(format!("p3-transform-{theme}.png"))).unwrap();

        assert!(run(h.state_mut(), "model.scale_tool"));
        h.run_steps(3);
        let rect = h.state().viewport_rect().unwrap();
        let (o, tip, _) = h.state().gizmo_line(1).unwrap();
        let start = to_screen(rect, tip);
        let dir = to_screen(rect, tip) - to_screen(rect, o);
        h.event(Event::PointerMoved(start));
        h.event(Event::PointerButton { pos: start, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
        h.step();
        for k in 1..=4 {
            h.event(Event::PointerMoved(start + dir * (k as f32 * 0.1)));
            h.step();
        }
        h.run_steps(2);
        h.render().unwrap().save(out.join(format!("p3-scale-{theme}.png"))).unwrap();
        h.event(Event::PointerButton { pos: start + dir * 0.4, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
        h.run_steps(2);

        // Marquee, mid-drag.
        assert!(run(h.state_mut(), "model.scale_tool"));
        h.run_steps(2);
        let c = rect.center();
        let a = c + egui::vec2(-360.0, -260.0);
        h.event(Event::PointerMoved(a));
        h.event(Event::PointerButton { pos: a, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
        h.step();
        for k in 1..=4 {
            h.event(Event::PointerMoved(a + egui::vec2(60.0, 40.0) * k as f32));
            h.step();
        }
        h.run_steps(2);
        h.render().unwrap().save(out.join(format!("p3-marquee-{theme}.png"))).unwrap();
    }
}
