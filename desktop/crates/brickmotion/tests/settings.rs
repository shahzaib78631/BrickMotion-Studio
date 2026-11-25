// Build Settings, Build Staging, and waiting-part floor drag tests.
use std::time::{Duration, Instant};

use bm::settings::{BuildOrder, BuildSettings};
use brickmotion::{BrickMotionApp, Workspace, run};
use egui::{Event, Key, Modifiers, PointerButton, pos2};
use egui::accesskit::Role;
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

fn plan_ready(h: &mut Harness<'static, BrickMotionApp>, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        h.step();
        let ver = h.state().session().version();
        let tr = &h.state().transport;
        if tr.ready() && tr.version == Some(ver) && !tr.state.stale {
            return;
        }
        assert!(Instant::now() < deadline, "plan never became ready (state={:?})", tr.state);
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn drag_slider(h: &mut Harness<'static, BrickMotionApp>, label: &str, from_frac: f32, to_frac: f32) {
    let rect = h.get_by_role_and_label(Role::Slider, label).rect();
    let p0 = pos2(rect.left() + rect.width() * from_frac, rect.center().y);
    let p1 = pos2(rect.left() + rect.width() * ((from_frac + to_frac) * 0.5), rect.center().y);
    let p2 = pos2(rect.left() + rect.width() * to_frac, rect.center().y);
    h.event(Event::PointerMoved(p0));
    h.event(Event::PointerButton { pos: p0, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
    h.step();
    h.event(Event::PointerMoved(p1));
    h.step();
    h.event(Event::PointerMoved(p2));
    h.step();
    h.event(Event::PointerButton { pos: p2, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
    h.run_steps(2);
}

#[test]
fn pacing_slider_drag_is_one_undo_and_one_plan() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    assert!(run(h.state_mut(), "video.plan_build"));
    plan_ready(&mut h, Duration::from_secs(60));
    assert!(run(h.state_mut(), "model.build_settings"));
    h.run_steps(2);

    let before_undo = h.state().session().undo_depth();
    let before_ver = h.state().session().version();
    let before_gap = h.state().session().build_settings().gap;
    let rect = h.get_by_role_and_label(Role::Slider, "Gap between parts").rect();
    let p0 = pos2(rect.left() + rect.width() * 0.1, rect.center().y);
    let p1 = pos2(rect.left() + rect.width() * 0.5, rect.center().y);
    let p2 = pos2(rect.left() + rect.width() * 0.75, rect.center().y);

    // Mid-drag: must NOT push an undo step or change session version.
    h.event(Event::PointerMoved(p0));
    h.event(Event::PointerButton { pos: p0, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
    h.step();
    h.event(Event::PointerMoved(p1));
    h.step();
    assert_eq!(h.state().session().undo_depth(), before_undo, "mid-drag must not push undo");
    assert_eq!(h.state().session().version(), before_ver, "mid-drag must not commit");

    // Release commits ONCE.
    h.event(Event::PointerMoved(p2));
    h.step();
    h.event(Event::PointerButton { pos: p2, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
    h.run_steps(2);
    assert_eq!(h.state().session().undo_depth(), before_undo + 1, "drag must be one undo step");
    let after_gap = h.state().session().build_settings().gap;
    assert!((after_gap - before_gap).abs() > 0.2, "gap did not change: {before_gap} -> {after_gap}");

    // Observe whether pacing change enters CheckingFlights (for m4-rulings.md verification).
    let mut saw_checking = false;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        h.step();
        let tr = &h.state().transport;
        if tr.state.stage == bm::playback::PlanStage::CheckingFlights {
            saw_checking = true;
        }
        if tr.ready() && tr.version == Some(h.state().session().version()) && !tr.state.stale {
            break;
        }
        assert!(Instant::now() < deadline, "plan never settled after pacing edit");
        std::thread::sleep(Duration::from_millis(5));
    }
    eprintln!("pacing_slider_drag: saw_checking_flights={saw_checking}");
    assert!(h.state().transport.ready());
}

#[test]
fn segmented_order_change_replans() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    assert!(run(h.state_mut(), "video.plan_build"));
    plan_ready(&mut h, Duration::from_secs(60));
    let old_ver = h.state().transport.version.unwrap();

    assert!(run(h.state_mut(), "model.build_settings"));
    h.run_steps(2);
    assert_eq!(h.state().session().build_settings().order, BuildOrder::TakeApart);
    h.get_by_role_and_label(Role::RadioButton, "Bottom Up").click();
    h.run_steps(2);
    assert_eq!(h.state().session().build_settings().order, BuildOrder::BottomUp);
    plan_ready(&mut h, Duration::from_secs(60));
    assert_ne!(h.state().transport.version, Some(old_ver));
}

#[test]
fn restore_defaults_is_one_step() {
    let mut h = heli_harness();
    let custom = BuildSettings {
        gap: 0.8,
        step_pause: 1.5,
        order: BuildOrder::BottomUp,
        ..BuildSettings::default()
    };
    h.state_mut().doc.session().set_build_settings(&custom);
    assert!(run(h.state_mut(), "model.build_settings"));
    h.run_steps(2);

    let before = h.state().session().undo_depth();
    h.get_by_role_and_label(Role::Button, "Restore Defaults").click();
    h.run_steps(2);
    assert_eq!(h.state().session().undo_depth(), before + 1);
    let after = h.state().session().build_settings();
    assert_eq!(after.order, BuildOrder::TakeApart);
    assert!((after.gap - BuildSettings::default().gap).abs() < 1e-6);
    assert!((after.step_pause - BuildSettings::default().step_pause).abs() < 1e-6);
}

#[test]
fn staging_apply_is_one_undo_and_previews_from_zero() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().set_workspace(Workspace::Animate);
    plan_ready(&mut h, Duration::from_secs(60));
    // Seek away from 0 so we can prove Apply previews from 0.0.
    assert!(run(h.state_mut(), "transport.end"));
    h.run_steps(2);
    assert!(h.state().transport.time() > 0.5);

    assert!(run(h.state_mut(), "video.staging"));
    h.run_steps(2);
    let before = h.state().session().undo_depth();
    let before_layout = h.state().session().staging_settings().layout;

    // Pick Grid tile + drag Turn slider: draft only, zero commits yet.
    h.get_by_role_and_label(Role::RadioButton, "Grid").click();
    h.run_steps(2);
    drag_slider(&mut h, "Turn", 0.5, 0.75);
    assert_eq!(h.state().session().undo_depth(), before, "editing draft must not commit");
    assert_eq!(h.state().session().staging_settings().layout, before_layout);
    assert!(h.query_by_label("Edited").is_some());

    // Apply commits ONCE and seeks to 0 once the replan lands.
    h.get_by_role_and_label(Role::Button, "Apply").click();
    h.run_steps(2);
    assert_eq!(h.state().session().undo_depth(), before + 1, "Apply must be one undo step");
    assert_eq!(h.state().session().staging_settings().layout, "grid");
    plan_ready(&mut h, Duration::from_secs(60));
    h.run_steps(2);
    assert!(
        h.state().transport.time().abs() <= 0.1,
        "Apply must preview staging from 0.0, got {}",
        h.state().transport.time()
    );
}

#[test]
fn staging_reset_discards_draft() {
    let mut h = heli_harness();
    assert!(run(h.state_mut(), "video.staging"));
    h.run_steps(2);
    let before = h.state().session().undo_depth();
    let saved_layout = h.state().session().staging_settings().layout;

    h.get_by_role_and_label(Role::RadioButton, "Fan").click();
    h.run_steps(2);
    assert_eq!(h.state().staging.draft.layout, "fan");
    assert!(h.query_by_label("Edited").is_some());

    h.get_by_role_and_label(Role::Button, "Revert").click();
    h.run_steps(2);
    assert_eq!(h.state().staging.draft.layout, saved_layout);
    assert_eq!(h.state().session().undo_depth(), before);
    assert!(h.query_by_label("Edited").is_none());
}

#[test]
fn straighten_puts_back() {
    let mut h = heli_harness();
    // Pick a piece whose waiting turn succeeds (not refused as part of a shared submodel).
    let piece = (0..h.state().piece_count() as u32)
        .find(|&p| {
            let c = h.state_mut().doc.session().turn_waiting_part(p, 90.0);
            c.refused.is_none() && h.state().session().moved_waiting_parts() > 0
        })
        .expect("expected at least one turnable waiting part");
    let _ = piece;
    assert_eq!(h.state().session().moved_waiting_parts(), 1);
    assert!(run(h.state_mut(), "video.straighten"));
    assert_eq!(h.state().session().moved_waiting_parts(), 0);
}

#[test]
fn waiting_drag_is_one_undo_step() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    assert!(run(h.state_mut(), "video.plan_build"));
    plan_ready(&mut h, Duration::from_secs(60));
    assert!(run(h.state_mut(), "transport.start"));
    h.run_steps(4);

    // Find a screen point on the viewport that hits a draggable waiting part.
    let rect = h.state().viewport_rect().expect("viewport rect");
    let mut hit_pt = None;
    'scan: for gy in 1..20 {
        for gx in 1..24 {
            let x = rect.width() * (gx as f32 / 25.0);
            let y = rect.height() * (gy as f32 / 21.0);
            let can = h
                .state_mut()
                .doc
                .viewport()
                .and_then(|vp| vp.pick(x as f64, y as f64).filter(|&p| vp.can_move_waiting_part(p)));
            if can.is_some() {
                hit_pt = Some(pos2(rect.left() + x, rect.top() + y));
                break 'scan;
            }
        }
    }
    let start = hit_pt.expect("expected at least one waiting part on floor at t=0");
    let mid = pos2(start.x + 25.0, start.y + 10.0);
    let end = pos2(start.x + 55.0, start.y + 20.0);

    let before = h.state().session().undo_depth();
    h.event(Event::PointerMoved(start));
    h.event(Event::PointerButton { pos: start, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
    h.step();
    h.event(Event::PointerMoved(mid));
    h.step();
    assert_eq!(h.state().session().undo_depth(), before, "mid-drag must not push undo");
    h.event(Event::PointerMoved(end));
    h.step();
    h.event(Event::PointerButton { pos: end, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
    h.run_steps(2);
    assert_eq!(h.state().session().undo_depth(), before + 1, "waiting drag must commit in one undo step");
    assert!(h.state().session().moved_waiting_parts() >= 1);
}

#[test]
fn typing_in_a_settings_field_does_not_edit() {
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.build_settings"));
    h.run_steps(2);

    // Double-click the "Gap between parts" value to open inline text editing.
    let val_rect = h.get_by_label("Gap between parts value").rect();
    let p = val_rect.center();
    let mut t = h.ctx.input(|i| i.time) + 0.02;
    for _ in 0..2 {
        h.input_mut().time = Some(t);
        h.event(Event::PointerMoved(p));
        h.event(Event::PointerButton { pos: p, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
        h.step();
        t += 0.02;
        h.input_mut().time = Some(t);
        h.event(Event::PointerButton { pos: p, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
        h.step();
        t += 0.02;
    }
    h.input_mut().time = Some(t);
    h.step();
    assert!(
        h.query_by_role_and_label(Role::TextInput, "Gap between parts value").is_some(),
        "expected inline editor"
    );

    // Pressing R (model.rotate) or F (view.fit) while typing must NOT run those commands!
    let before_undo = h.state().session().undo_depth();
    let before_ops = h.state().viewport.queued_total;
    for k in [Key::R, Key::F] {
        h.event(Event::Key { key: k, physical_key: None, pressed: true, repeat: false, modifiers: Modifiers::NONE });
        h.event(Event::Key { key: k, physical_key: None, pressed: false, repeat: false, modifiers: Modifiers::NONE });
        h.step();
    }
    assert_eq!(h.state().session().undo_depth(), before_undo, "R rotated selection while typing in settings");
    assert_eq!(h.state().viewport.queued_total, before_ops, "F fitted view while typing in settings");
}
