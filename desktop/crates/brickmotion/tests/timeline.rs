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

// ---- Task 7: Parts lane tests ----

fn zoom_in_parts(h: &mut Harness<'static, BrickMotionApp>) {
    let dur = h.state().transport.duration();
    h.state_mut().timeline.view.zoom_by(32.0, 2.0, dur);
    h.state_mut().timeline.view.reveal(2.0, dur, true);
    h.run_steps(3);
    assert!(h.state().timeline.parts_lane.zoomed_in, "expected zoomed-in clips");
}

#[test]
fn lane_clips_match_flights() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    zoom_in_parts(&mut h);
    let flights_len = h.state().transport.flights().len();
    let lane = &h.state().timeline.parts_lane;
    assert_eq!(lane.clips.len(), flights_len);
    // No two clips in the same row may overlap.
    let mut by_row: std::collections::HashMap<u32, Vec<(f32, f32)>> = std::collections::HashMap::new();
    for c in &lane.clips {
        by_row.entry(c.row).or_default().push((c.x, c.x + c.width));
    }
    for (row, mut spans) in by_row {
        spans.sort_by(|a, b| a.0.total_cmp(&b.0));
        for w in spans.windows(2) {
            assert!(w[0].1 <= w[1].0 + 1e-3, "row {row} overlaps: {:?} vs {:?}", w[0], w[1]);
        }
    }
}

#[test]
fn visible_range_keeps_long_clips_that_start_off_screen() {
    use brickmotion::chrome::parts_lane::{Clip, PartsLane};
    let clip = |flight: usize, x: f32, width: f32| Clip {
        flight,
        piece: flight as u32,
        step: 0,
        color: 16,
        start: 0.0,
        end: 1.0,
        x,
        width,
        row: flight as u32,
        seat_x: x + width,
    };
    // A 4000-px clip from x = 0, then short clips far to the right (sorted by x).
    let mut lane = PartsLane::default();
    lane.set_clips(vec![clip(0, 0.0, 4000.0), clip(1, 3000.0, 60.0), clip(2, 5000.0, 60.0)], true, 3);
    let view = bm::timeline::TimelineView { zoom: 64.0, offset: 3012.0, viewport_width: 800.0, ..Default::default() };
    // Visible content is [3000, 3800]: clip 0 (0..4000) and clip 1 overlap it, clip 2 does not.
    let vis = lane.visible_range(&view);
    assert!(vis.contains(&0), "the long clip under the view was culled: {vis:?}");
    assert!(vis.contains(&1));
    assert!(!vis.contains(&2));
}

#[test]
fn clip_click_selects_and_seeks() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    zoom_in_parts(&mut h);
    let parts_r = h.state().timeline.last_parts_rect.expect("parts rect");
    let view = h.state().timeline.view;
    let vis = h.state().timeline.parts_lane.visible_range(&view);
    let clip = h.state().timeline.parts_lane.clips[vis.start + 1].clone();
    let center = clip.rect_in(parts_r, view.lead_inset, view.offset).center();
    h.event(egui::Event::PointerMoved(center));
    h.step();
    h.event(egui::Event::PointerButton {
        pos: center,
        button: egui::PointerButton::Primary,
        pressed: true,
        modifiers: egui::Modifiers::NONE,
    });
    h.step();
    h.event(egui::Event::PointerButton {
        pos: center,
        button: egui::PointerButton::Primary,
        pressed: false,
        modifiers: egui::Modifiers::NONE,
    });
    h.run_steps(2);
    assert_eq!(h.state().session().selection(), vec![clip.piece]);
    let frame = 1.0 / h.state().transport.fps().max(1.0);
    assert!((h.state().transport.time() - clip.end).abs() <= frame + 0.05);
}

#[test]
fn arrival_drag_moves_the_piece_once() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    let dur = h.state().transport.duration();
    // Zoom so steps 0 and 1 are both visible as clips.
    let step1_start = h.state().transport.lanes.as_ref().unwrap().runs[1].start;
    h.state_mut().timeline.view.zoom_by(18.0, step1_start, dur);
    h.state_mut().timeline.view.reveal(step1_start, dur, true);
    h.run_steps(3);
    assert!(h.state().timeline.parts_lane.zoomed_in);

    let parts_r = h.state().timeline.last_parts_rect.expect("parts rect");
    let view = h.state().timeline.view;
    // Find a visible clip in step 1 and drag it into step 0's time range.
    let clip = h
        .state()
        .timeline
        .parts_lane
        .clips
        .iter()
        .find(|c| {
            c.step == 1 && {
                let cr = c.rect_in(parts_r, view.lead_inset, view.offset);
                cr.left() >= parts_r.left() + 4.0 && cr.right() <= parts_r.right() - 4.0
            }
        })
        .expect("visible step 1 clip")
        .clone();
    let from = clip.rect_in(parts_r, view.lead_inset, view.offset).center();
    let target_t = (step1_start - 1.5).max(1.0);
    let to_x = (parts_r.left() + view.screen_x(target_t, dur) as f32).clamp(parts_r.left() + 8.0, parts_r.right() - 8.0);
    let to = egui::pos2(to_x, parts_r.center().y);

    let depth_before = h.state().session().undo_depth();
    drag(&mut h, from, to, 6);
    assert_eq!(h.state().session().undo_depth(), depth_before + 1, "arrival drag must be one undo step");
}

#[test]
fn arrival_drag_released_outside_commits_nothing() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    zoom_in_parts(&mut h);
    let parts_r = h.state().timeline.last_parts_rect.expect("parts rect");
    let view = h.state().timeline.view;
    let vis = h.state().timeline.parts_lane.visible_range(&view);
    let clip = h.state().timeline.parts_lane.clips[vis.start + 1].clone();
    let from = clip.rect_in(parts_r, view.lead_inset, view.offset).center();
    let outside = egui::pos2(-50.0, -50.0);
    let depth_before = h.state().session().undo_depth();
    drag(&mut h, from, outside, 5);
    assert_eq!(h.state().session().undo_depth(), depth_before, "releasing outside must commit nothing");
    assert!(h.state().timeline.drag.is_none());
}

#[test]
fn alt_drag_forces_order() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    let dur = h.state().transport.duration();
    let step1_start = h.state().transport.lanes.as_ref().unwrap().runs[1].start;
    h.state_mut().timeline.view.zoom_by(18.0, step1_start, dur);
    h.state_mut().timeline.view.reveal(step1_start, dur, true);
    h.run_steps(3);
    assert!(h.state().timeline.parts_lane.zoomed_in);

    let parts_r = h.state().timeline.last_parts_rect.expect("parts rect");
    let view = h.state().timeline.view;
    let local_step1: std::collections::HashSet<u32> = h
        .state()
        .session()
        .step_items(1)
        .into_iter()
        .filter(|it| !it.submodel)
        .flat_map(|it| it.pieces)
        .collect();
    let clip = h
        .state()
        .timeline
        .parts_lane
        .clips
        .iter()
        .find(|c| {
            c.step == 1
                && local_step1.contains(&c.piece)
                && {
                    let cr = c.rect_in(parts_r, view.lead_inset, view.offset);
                    cr.left() >= parts_r.left() + 4.0 && cr.right() <= parts_r.right() - 4.0
                }
        })
        .expect("visible local step 1 clip")
        .clone();
    let from = clip.rect_in(parts_r, view.lead_inset, view.offset).center();
    let target_t = (step1_start - 1.5).max(1.0);
    let to_x = (parts_r.left() + view.screen_x(target_t, dur) as f32).clamp(parts_r.left() + 8.0, parts_r.right() - 8.0);
    let to = egui::pos2(to_x, parts_r.center().y);
    let alt = egui::Modifiers::ALT;

    h.event(egui::Event::PointerMoved(from));
    h.step();
    h.event(egui::Event::PointerButton {
        pos: from,
        button: egui::PointerButton::Primary,
        pressed: true,
        modifiers: alt,
    });
    h.step();
    for i in 1..=6 {
        let f = i as f32 / 6.0;
        let p = egui::pos2(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f);
        h.event(egui::Event::PointerMoved(p));
        h.step();
    }
    h.event(egui::Event::PointerButton {
        pos: to,
        button: egui::PointerButton::Primary,
        pressed: false,
        modifiers: alt,
    });
    h.run_steps(2);
    assert_eq!(h.state().session().undo_name(), "Move and Pin Arrival");
    assert!(!h.state().session().arrival_pins().is_empty());
}

#[test]
fn pin_from_menu_round_trips() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    let dur = h.state().transport.duration();
    let step1_start = h.state().transport.lanes.as_ref().unwrap().runs[1].start;
    h.state_mut().timeline.view.zoom_by(32.0, step1_start, dur);
    h.state_mut().timeline.view.reveal(step1_start, dur, true);
    h.run_steps(3);
    assert!(h.state().timeline.parts_lane.zoomed_in);

    let parts_r = h.state().timeline.last_parts_rect.expect("parts rect");
    let view = h.state().timeline.view;
    let vis = h.state().timeline.parts_lane.visible_range(&view);
    let local_step1: std::collections::HashSet<u32> = h
        .state()
        .session()
        .step_items(1)
        .into_iter()
        .filter(|it| !it.submodel)
        .flat_map(|it| it.pieces)
        .collect();
    let clip = h.state().timeline.parts_lane.clips[vis]
        .iter()
        .find(|c| {
            c.step == 1
                && local_step1.contains(&c.piece)
                && {
                    let cr = c.rect_in(parts_r, view.lead_inset, view.offset);
                    cr.left() >= parts_r.left() + 4.0 && cr.right() <= parts_r.right() - 4.0
                }
        })
        .expect("visible local step 1 clip")
        .clone();
    let center = clip.rect_in(parts_r, view.lead_inset, view.offset).center();
    assert!(!h.state().session().arrival_pins().contains(&clip.piece));

    // Right-click the clip and choose "Pin This Arrival".
    h.event(egui::Event::PointerMoved(center));
    h.step();
    h.event(egui::Event::PointerButton {
        pos: center,
        button: egui::PointerButton::Secondary,
        pressed: true,
        modifiers: egui::Modifiers::NONE,
    });
    h.step();
    h.event(egui::Event::PointerButton {
        pos: center,
        button: egui::PointerButton::Secondary,
        pressed: false,
        modifiers: egui::Modifiers::NONE,
    });
    h.run_steps(2);
    h.get_by_label("Pin This Arrival").click();
    h.run_steps(2);
    assert!(h.state().session().arrival_pins().contains(&clip.piece));

    // Right-click again and choose "Release Arrival Pins".
    h.event(egui::Event::PointerMoved(center));
    h.step();
    h.event(egui::Event::PointerButton {
        pos: center,
        button: egui::PointerButton::Secondary,
        pressed: true,
        modifiers: egui::Modifiers::NONE,
    });
    h.step();
    h.event(egui::Event::PointerButton {
        pos: center,
        button: egui::PointerButton::Secondary,
        pressed: false,
        modifiers: egui::Modifiers::NONE,
    });
    h.run_steps(2);
    h.get_by_label("Release Arrival Pins").click();
    h.run_steps(2);
    assert!(!h.state().session().arrival_pins().contains(&clip.piece));
}

#[test]
fn library_drop_inserts_before_target() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    zoom_in_parts(&mut h);
    h.state_mut().browser_tab = 3; // Library tab
    h.run_steps(3);

    let tile_center = h.get_by_label("3001").rect().center();
    let parts_r = h.state().timeline.last_parts_rect.expect("parts rect");
    let view = h.state().timeline.view;
    let vis = h.state().timeline.parts_lane.visible_range(&view);
    let target_clip = h.state().timeline.parts_lane.clips[vis.start + 1].clone();
    let drop_at = target_clip.rect_in(parts_r, view.lead_inset, view.offset).left_center();

    // Compute what arrival_target predicts for `drop_at`.
    let dur = h.state().transport.duration();
    let time = view.time_at((drop_at.x - parts_r.left()) as f64, dur);
    let expected = h
        .state()
        .transport
        .lanes
        .as_ref()
        .unwrap()
        .arrival_target(
            h.state().transport.timeline.as_ref().unwrap(),
            Some(h.state().session()),
            time,
            &[],
        )
        .expect("arrival target");

    // Drag the 3001 tile from Library onto the Parts lane and release.
    drag(&mut h, tile_center, drop_at, 6);
    assert!(h.state().edit.placement.is_some(), "drop onto Parts lane must start placement");

    // Move pointer into viewport center, wait for placeable preview, click to commit.
    let vp_center = h.state().viewport_rect().unwrap().center();
    h.event(egui::Event::PointerMoved(vp_center));
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        h.step();
        if let Some(p) = &h.state().edit.placement
            && p.state.is_placeable()
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    h.event(egui::Event::PointerButton {
        pos: vp_center,
        button: egui::PointerButton::Primary,
        pressed: true,
        modifiers: egui::Modifiers::NONE,
    });
    h.step();
    h.event(egui::Event::PointerButton {
        pos: vp_center,
        button: egui::PointerButton::Primary,
        pressed: false,
        modifiers: egui::Modifiers::NONE,
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && h.state().edit.placement.is_some() {
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(h.state().edit.placement.is_none(), "placement should have committed");
    let items = h.state().session().step_items(expected.step as usize);
    assert_eq!(items[expected.before].name, "3001.dat");
}

#[test]
#[ignore]
fn big_model_parts_lane() {
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
    h.step();
    let fit_layout = h.state().timeline.parts_lane.last_layout_time;
    let mut fit_slowest = Duration::ZERO;
    for _ in 0..8 {
        h.step();
        fit_slowest = fit_slowest.max(h.state().timeline.parts_lane.last_show_time);
    }

    let dur = h.state().transport.duration();
    h.state_mut().timeline.view.zoom_by(64.0, dur * 0.5, dur);
    h.step();
    let z64_layout = h.state().timeline.parts_lane.last_layout_time;
    let z64_visited = h.state().timeline.parts_lane.last_visited;
    let total = h.state().timeline.parts_lane.clips.len();
    let mut z64_slowest = Duration::ZERO;
    for _ in 0..8 {
        h.step();
        z64_slowest = z64_slowest.max(h.state().timeline.parts_lane.last_show_time);
    }
    eprintln!(
        "big_model_parts_lane (10294-1, {total} flights): fit_layout={fit_layout:?}, fit_show={fit_slowest:?}, z64_layout={z64_layout:?}, z64_show={z64_slowest:?}, z64_visited={z64_visited}"
    );
    assert!(fit_layout < Duration::from_millis(50), "fit layout {fit_layout:?} >= 50 ms");
    assert!(z64_layout < Duration::from_millis(50), "z64 layout {z64_layout:?} >= 50 ms");
    assert!(fit_slowest < Duration::from_millis(16), "fit frame {fit_slowest:?} >= 16 ms");
    assert!(z64_slowest < Duration::from_millis(16), "z64 frame {z64_slowest:?} >= 16 ms");
    assert!(z64_visited < total / 10, "z64 visited {z64_visited} out of {total}");
}

#[test]
fn dot_menu_stays_open_when_the_pointer_leaves_the_dot() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    assert!(!h.state().timeline.parts_lane.zoomed_in, "fit zoom shows dots");
    let parts_r = h.state().timeline.last_parts_rect.expect("parts rect");
    let view = h.state().timeline.view;
    let vis = h.state().timeline.parts_lane.visible_range(&view);
    let clip = h.state().timeline.parts_lane.clips[vis]
        .iter()
        .find(|c| {
            let p = c.dot_center_in(parts_r, view.lead_inset, view.offset);
            p.x > parts_r.left() + 20.0 && p.x < parts_r.right() - 20.0
        })
        .expect("a dot inside the lane")
        .clone();
    let center = clip.dot_center_in(parts_r, view.lead_inset, view.offset);
    h.event(egui::Event::PointerMoved(center));
    h.step();
    for pressed in [true, false] {
        h.event(egui::Event::PointerButton {
            pos: center,
            button: egui::PointerButton::Secondary,
            pressed,
            modifiers: egui::Modifiers::NONE,
        });
        h.step();
    }
    h.run_steps(2);
    assert!(h.query_by_label("Frame in View").is_some(), "menu opened");
    // Move toward the menu, away from the dot (and out of the 7-px hit range).
    h.event(egui::Event::PointerMoved(egui::pos2(center.x + 40.0, center.y - 40.0)));
    h.run_steps(3);
    assert!(h.query_by_label("Frame in View").is_some(), "menu closed when the pointer left the dot");
}

#[test]
fn playhead_flag_shows_timecode() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    {
        let app = h.state_mut();
        let vp = app.doc.viewport().expect("viewport");
        app.transport.seek(vp, 1.5);
    }
    h.run_steps(3);
    let flag = h.get_by_label("Playhead 0:01.5");
    let ruler = h.get_by_label("Timeline Ruler").rect();
    assert!(flag.rect().top() < ruler.center().y, "the flag sits in the ruler");
}

#[test]
fn clip_hover_shows_name_chip() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_harness();
    zoom_in_parts(&mut h);
    let parts_r = h.state().timeline.last_parts_rect.expect("parts rect");
    let view = h.state().timeline.view;
    let vis = h.state().timeline.parts_lane.visible_range(&view);
    let clip = h.state().timeline.parts_lane.clips[vis.start + 1].clone();
    let name = clip.part_name(h.state().transport.timeline.as_ref().expect("timeline")).to_owned();
    let center = clip.rect_in(parts_r, view.lead_inset, view.offset).center();
    h.event(egui::Event::PointerMoved(center));
    h.run_steps(3);
    assert!(h.query_by_label(&format!("Part name {name}")).is_some(), "hover chip names {name}");
}
