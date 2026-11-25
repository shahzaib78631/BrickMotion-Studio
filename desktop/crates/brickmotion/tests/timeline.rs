// Live Build timeline tests: ruler scrub, zoom, double-click play, hold drag, sequence trim, failed state.
use std::time::{Duration, Instant};

use brickmotion::{BrickMotionApp, Workspace, run};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn animate_harness() -> Harness<'static, BrickMotionApp> {
    let mut h = Harness::builder()
        .with_size([1440.0, 900.0])
        .build_eframe(|cc| {
            let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
            app.wait_loaded();
            app.dialogs_off();
            app.set_workspace(Workspace::Animate);
            app
        });
    plan_ready(&mut h, Duration::from_secs(60));
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

fn drag(h: &mut Harness<'static, BrickMotionApp>, from: egui::Pos2, to: egui::Pos2, steps: usize) {
    h.event(egui::Event::PointerMoved(from));
    h.step();
    h.event(egui::Event::PointerButton {
        pos: from,
        button: egui::PointerButton::Primary,
        pressed: true,
        modifiers: egui::Modifiers::NONE,
    });
    h.step();
    for i in 1..=steps {
        let f = i as f32 / steps as f32;
        let p = egui::pos2(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f);
        h.event(egui::Event::PointerMoved(p));
        h.step();
    }
    h.event(egui::Event::PointerButton {
        pos: to,
        button: egui::PointerButton::Primary,
        pressed: false,
        modifiers: egui::Modifiers::NONE,
    });
    h.run_steps(2);
}

#[test]
fn ruler_click_seeks() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    let ruler = h.state().timeline.last_ruler_rect.expect("ruler rect");
    let view = h.state().timeline.view;
    let dur = h.state().transport.duration();
    let target_x = ruler.left() + view.screen_x(dur * 0.25, dur) as f32;
    let at = egui::pos2(target_x, ruler.center().y);
    h.event(egui::Event::PointerMoved(at));
    h.event(egui::Event::PointerButton {
        pos: at,
        button: egui::PointerButton::Primary,
        pressed: true,
        modifiers: egui::Modifiers::NONE,
    });
    h.step();
    h.event(egui::Event::PointerButton {
        pos: at,
        button: egui::PointerButton::Primary,
        pressed: false,
        modifiers: egui::Modifiers::NONE,
    });
    h.run_steps(2);
    let frame = 1.0 / h.state().transport.fps().max(1.0);
    let got = h.state().transport.time();
    assert!((got - dur * 0.25).abs() <= frame + 0.05, "got {got}, expected {}", dur * 0.25);
}

#[test]
fn scrub_release_outside_ends_scrub() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    let ruler = h.state().timeline.last_ruler_rect.expect("ruler rect");
    let start = ruler.center();
    h.event(egui::Event::PointerMoved(start));
    h.event(egui::Event::PointerButton {
        pos: start,
        button: egui::PointerButton::Primary,
        pressed: true,
        modifiers: egui::Modifiers::NONE,
    });
    h.step();
    assert!(h.state().timeline.scrubbing);
    // Move outside the window and release there.
    let outside = egui::pos2(-40.0, -40.0);
    h.event(egui::Event::PointerMoved(outside));
    h.step();
    h.event(egui::Event::PointerButton {
        pos: outside,
        button: egui::PointerButton::Primary,
        pressed: false,
        modifiers: egui::Modifiers::NONE,
    });
    h.run_steps(2);
    assert!(!h.state().timeline.scrubbing, "scrub must end on release outside window");
    assert!(!h.state().transport.state.playing);
}

#[test]
fn pinch_zoom_keeps_time_under_pointer() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    let lanes = h.state().timeline.last_lanes_rect.expect("lanes rect");
    let dur = h.state().transport.duration();
    let ptr = egui::pos2(lanes.left() + lanes.width() * 0.4, lanes.center().y);
    let local_x = (ptr.x - lanes.left()) as f64;
    let t_before = h.state().timeline.view.time_at(local_x, dur);
    h.event(egui::Event::PointerMoved(ptr));
    h.event(egui::Event::Zoom(4.0));
    h.run_steps(2);
    assert!(h.state().timeline.view.zoom > 3.5);
    let t_after = h.state().timeline.view.time_at(local_x, dur);
    assert!((t_after - t_before).abs() < 1e-6, "anchor drifted: before={t_before}, after={t_after}");
}

#[test]
fn step_run_double_click_plays_that_step() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    // Double-click "Step 1" in the Steps lane (long run so playback is still active across steps).
    let btn = h.query_all_by_label("Step 1").next().expect("Step 1 run");
    let rect = btn.rect();
    let at = rect.center();
    h.event(egui::Event::PointerMoved(at));
    h.step();
    let mut t = h.ctx.input(|i| i.time);
    for _ in 0..2 {
        t += 0.02;
        h.input_mut().time = Some(t);
        h.event(egui::Event::PointerButton {
            pos: at,
            button: egui::PointerButton::Primary,
            pressed: true,
            modifiers: egui::Modifiers::NONE,
        });
        h.step();
        t += 0.02;
        h.input_mut().time = Some(t);
        h.event(egui::Event::PointerButton {
            pos: at,
            button: egui::PointerButton::Primary,
            pressed: false,
            modifiers: egui::Modifiers::NONE,
        });
        h.step();
    }
    let st = h.state().transport.state;
    let cur_step = h.state().transport.current_step();
    assert!(
        st.playing || st.waiting_to_play,
        "not playing after dblclick at {at:?} (rect={rect:?}): state={st:?}, cur_step={cur_step:?}, focused={:?}",
        h.state().transport.focused_step
    );
    assert_eq!(cur_step, Some(0));
}

#[test]
fn hold_drag_is_one_undo_step() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    let dur = h.state().transport.duration();
    let lw = h.state().timeline.view.logical_width();
    // Find the first editable hold handle exposed in AccessKit.
    let node = h.get_by_label("Hold after Step 1");
    let from = node.rect().center();
    let before_pause = h.state().session().steps()[0].pause_after;
    let before_depth = h.state().session().undo_depth();
    let before_plan = h.state().transport.version.unwrap();

    // Drag right by enough pixels to add ~1.0 s.
    let dx = (1.0 / dur * lw) as f32;
    let to = egui::pos2(from.x + dx, from.y);
    drag(&mut h, from, to, 8);

    let after_pause = h.state().session().steps()[0].pause_after;
    assert!(after_pause > before_pause + 0.5, "pause did not grow: before={before_pause}, after={after_pause}");
    assert_eq!(h.state().session().undo_depth(), before_depth + 1, "hold drag must be one undo step");

    // Replan finishes with one new plan version.
    plan_ready(&mut h, Duration::from_secs(60));
    let new_plan = h.state().transport.version.unwrap();
    assert_ne!(new_plan, before_plan);

    // One undo restores original pause.
    assert!(run(h.state_mut(), "edit.undo"));
    h.run_steps(2);
    assert!((h.state().session().steps()[0].pause_after - before_pause).abs() < 1e-6);
}

#[test]
fn trim_intro_commits_once() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    let dur = h.state().transport.duration();
    let lw = h.state().timeline.view.logical_width();
    let before_intro = h.state().transport.build_start();
    let before_depth = h.state().session().undo_depth();

    let node = h.get_by_label("Trim Intro");
    let from = node.rect().center();
    let dx = (1.5 / dur * lw) as f32;
    let to = egui::pos2(from.x + dx, from.y);
    drag(&mut h, from, to, 6);

    assert_eq!(h.state().session().undo_depth(), before_depth + 1);
    plan_ready(&mut h, Duration::from_secs(60));
    let after_intro = h.state().transport.build_start();
    assert!(
        after_intro > before_intro + 0.8,
        "intro did not grow: before={before_intro}, after={after_intro}"
    );
}

#[test]
fn failed_plan_shows_try_again() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    h.state_mut().transport.forced_failure = Some("Piece 3710 has no clear path.".into());
    h.run_steps(2);
    assert!(h.query_by_label("The build could not be planned.").is_some());
    assert!(h.query_by_label("Piece 3710 has no clear path.").is_some());
    assert!(h.query_by_label("Try Again").is_some());
    assert!(h.query_by_label("Try Standard Preview").is_some());
}

#[test]
#[ignore]
fn big_model_timeline_frame() {
    let Some(big) = std::env::var_os("BM_BIG_MODEL") else { return };
    if !bm::metal_available() {
        return;
    }
    let mut h = Harness::builder()
        .with_size([1440.0, 900.0])
        .build_eframe(move |cc| {
            let mut app = BrickMotionApp::new_for_test_cc(cc, Some(big.into()));
            app.wait_loaded();
            app.dialogs_off();
            app.set_workspace(Workspace::Animate);
            app
        });
    assert!(run(h.state_mut(), "video.standard_preview"));
    plan_ready(&mut h, Duration::from_secs(120));
    h.run_steps(3);

    // Measure at Fit (zoom 1) and at zoom 64.
    let mut slowest = Duration::ZERO;
    for _ in 0..10 {
        h.step();
        slowest = slowest.max(h.state().timeline.last_frame_time);
    }
    let dur = h.state().transport.duration();
    h.state_mut().timeline.view.zoom_by(64.0, dur * 0.5, dur);
    for _ in 0..10 {
        h.step();
        slowest = slowest.max(h.state().timeline.last_frame_time);
    }
    eprintln!("big_model_timeline_frame (10294-1): slowest timeline frame = {slowest:?}");
    assert!(slowest < Duration::from_millis(16), "timeline frame {slowest:?} >= 16 ms");
}
