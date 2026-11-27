// Regression tests for the desktop UX & parity fixes (A1–A9 and B1–B4).
use std::time::{Duration, Instant};

use bm::motion::{Inspection, JointRow};
use brickmotion::chrome::joints;
use brickmotion::edit::Tool;
use brickmotion::transport::Clock;
use brickmotion::viewport::DragMode;
use brickmotion::{BrickMotionApp, Workspace, run};
use egui::{Event, Modifiers, PointerButton, Pos2, pos2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn build_heli() -> Harness<'static, BrickMotionApp> {
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

fn animate_heli() -> Harness<'static, BrickMotionApp> {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
        app.wait_loaded();
        app.dialogs_off();
        app.set_workspace(Workspace::Animate);
        app
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        h.step();
        let ver = h.state().session().version();
        let tr = &h.state().transport;
        if tr.ready() && tr.version == Some(ver) && !tr.state.stale {
            break;
        }
        assert!(Instant::now() < deadline, "plan never settled");
        std::thread::sleep(Duration::from_millis(10));
    }
    h.run_steps(3);
    h
}

fn click_at(h: &mut Harness<'static, BrickMotionApp>, pos: Pos2) {
    h.event(Event::PointerMoved(pos));
    h.step();
    h.event(Event::PointerButton { pos, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
    h.step();
    h.event(Event::PointerButton { pos, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
    h.run_steps(2);
}

#[test]
fn browser_header_controls_and_generous_steps_height() {
    let mut h = build_heli();
    // Switch to Steps tab in the Browser (the ribbon also has a "Steps" tab).
    let steps_tabs: Vec<_> = h.query_all_by_label("Steps").collect();
    assert!(!steps_tabs.is_empty());
    // Browser Steps tab is below the ribbon (larger y).
    let browser_steps = steps_tabs.into_iter().max_by(|a, b| a.rect().top().total_cmp(&b.rect().top())).unwrap();
    let tab_pos = browser_steps.rect().center();
    click_at(&mut h, tab_pos);
    h.run_steps(2);
    let step1 = h.get_by_label("Step 1").rect();
    let step6 = h.get_by_label("Step 6").rect();
    assert!(
        step6.bottom() - step1.top() > 120.0,
        "steps list should span generously, got {}..{}",
        step1.top(),
        step6.bottom()
    );

    // Collapse button folds Browser body; clicking again expands it.
    assert!(!h.state().browser.collapsed);
    h.get_by_label("Collapse Browser").click();
    h.run_steps(3);
    assert!(h.state().browser.collapsed);
    assert!(h.query_by_label("Step 1").is_none());
    h.get_by_label("Expand Browser").click();
    h.run_steps(3);
    assert!(!h.state().browser.collapsed);
    assert!(h.query_by_label("Step 1").is_some());

    // Resizing state persists cleanly.
    h.state_mut().browser.width = 340.0;
    h.run_steps(2);
    assert!((h.state().browser.width - 340.0).abs() < 1.0);
}

#[test]
fn look_then_build_settings_shows_build_settings() {
    let mut h = build_heli();
    // Open Look first.
    run(h.state_mut(), "model.look");
    h.run_steps(3);
    assert!(h.state().look.open);
    // Now click Build Settings: Build Settings MUST be displayed (Look steps aside).
    run(h.state_mut(), "model.build_settings");
    h.run_steps(3);
    assert!(h.state().properties_page.is_settings());
    assert!(!h.state().look.open);
    assert!(h.query_by_label("Back to Properties").is_some());
}

#[test]
fn timeline_floats_over_full_height_viewport() {
    if !bm::metal_available() {
        return;
    }
    let mut h = build_heli();
    let build_rect = h.state().viewport.last_rect().expect("build viewport rect");
    h.state_mut().set_workspace(Workspace::Animate);
    h.run_steps(3);
    let anim_rect = h.state().viewport.last_rect().expect("animate viewport rect");
    assert!(
        (anim_rect.height() - build_rect.height()).abs() < 2.0,
        "timeline must float over the viewport instead of shrinking it: build={}, animate={}",
        build_rect.height(),
        anim_rect.height()
    );
}

#[test]
fn navigator_presets_and_drag_orbit() {
    if !bm::metal_available() {
        return;
    }
    let mut h = build_heli();
    let before = h.state_mut().doc.viewport().unwrap().camera();
    // Clicking Left View (a negative axis bubble) snaps camera.
    h.get_by_label("Left View").click();
    h.run_steps(3);
    let after_left = h.state_mut().doc.viewport().unwrap().camera();
    assert!((after_left.yaw - before.yaw).abs() > 0.05 || (after_left.pitch - before.pitch).abs() > 0.05);

    // Dragging the Axis Navigator orb orbits the camera live.
    let orb = h.get_by_label("Axis Navigator").rect().center();
    h.event(Event::PointerMoved(orb));
    h.step();
    h.event(Event::PointerButton { pos: orb, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
    h.step();
    h.event(Event::PointerMoved(pos2(orb.x + 36.0, orb.y - 18.0)));
    h.step();
    h.event(Event::PointerButton { pos: pos2(orb.x + 36.0, orb.y - 18.0), button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
    h.run_steps(2);
    let after_drag = h.state_mut().doc.viewport().unwrap().camera();
    assert!((after_drag.yaw - after_left.yaw).abs() > 0.05);
}

#[test]
fn properties_hide_and_reopen_pill() {
    let mut h = build_heli();
    assert!(!h.state().properties.hidden);
    h.get_by_label("Hide Properties").click();
    h.run_steps(3);
    assert!(h.state().properties.hidden);
    // Reopen pill restores Properties.
    h.get_by_label("Show Properties").click();
    h.run_steps(3);
    assert!(!h.state().properties.hidden);
}

#[test]
fn viewbar_reclick_unselects_tools_and_nav_modes() {
    let mut h = build_heli();
    assert_eq!(h.state().edit.tool, Tool::Select);
    h.get_by_label("Move Tool").click();
    h.run_steps(2);
    assert_eq!(h.state().edit.tool, Tool::Move);
    // Re-clicking active Move Tool returns to Select.
    h.get_by_label("Move Tool").click();
    h.run_steps(2);
    assert_eq!(h.state().edit.tool, Tool::Select);

    // Nav modes toggle on and off on re-click.
    assert_eq!(h.state().viewport.nav_mode, None);
    h.get_by_label("Orbit").click();
    h.run_steps(2);
    assert_eq!(h.state().viewport.nav_mode, Some(DragMode::Orbit));
    h.get_by_label("Orbit").click();
    h.run_steps(2);
    assert_eq!(h.state().viewport.nav_mode, None);
}

#[test]
fn smart_joints_info_flip_and_extended_rotation() {
    if !bm::metal_available() {
        return;
    }
    let mut h = build_heli();
    assert!(!h.state().edit.smart_joints);
    run(h.state_mut(), "edit.smart_joints");
    h.run_steps(1);
    assert!(h.state().edit.smart_joints);
    run(h.state_mut(), "edit.smart_joints");
    h.run_steps(1);
    assert!(!h.state().edit.smart_joints);
    run(h.state_mut(), "edit.smart_joints");
    h.run_steps(1);
    assert!(h.state().edit.smart_joints);

    // Inspect helicopter joints and verify JointInfo works on a real free turning joint.
    let mut insp = Inspection::capture(h.state().session()).expect("inspection");
    let report = insp.joints(&[], true, false);
    let turning: Vec<JointRow> = report.joints.into_iter().filter(|j| j.kind.turns()).collect();
    assert!(!turning.is_empty(), "helicopter should have turning joints");

    let (j, info) = turning
        .into_iter()
        .find_map(|cand| {
            let info = insp.joint_info(cand.a, cand.b, true);
            info.error.is_none().then_some((cand, info))
        })
        .expect("helicopter should have at least one free turning joint");
    assert!(!info.pieces.is_empty(), "joint_info should return articulated branch");
    assert!(info.min_deg <= 0.0 && info.max_deg >= 0.0);

    // Open in UI and verify flip_side swaps fixed and moving.
    joints::open(h.state_mut(), (j.a, j.b));
    h.run_steps(2);
    assert_eq!(h.state().joints.open, Some((j.a, j.b)));
    joints::flip_side(h.state_mut());
    h.run_steps(2);
    assert_eq!(h.state().joints.open, Some((j.b, j.a)));
}

#[test]
fn submodel_focus_and_exit_breadcrumb() {
    let mut h = build_heli();
    assert!(h.state().session().focus_path().is_empty());
    // Helicopter has a submodel in its outline (!r.def.is_empty()).
    let rows = h.state().session().outline();
    let sub = rows.iter().find(|r| !r.def.is_empty()).expect("helicopter should have a submodel");
    let path = vec![sub.def.clone()];
    h.state_mut().focus_submodel(&path);
    h.run_steps(3);
    assert_eq!(h.state().session().focus_path(), path);
    assert!(h.query_by_label("Exit Submodel").is_some());

    // Clicking Exit Submodel returns to main model.
    h.get_by_label("Exit Submodel").click();
    h.run_steps(3);
    assert!(h.state().session().focus_path().is_empty());
}

#[test]
fn animate_parts_lane_double_click_opens_flight_path() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_heli();
    let dur = h.state().transport.duration();
    let step1_start = h.state().transport.lanes.as_ref().unwrap().runs[1].start;
    h.state_mut().timeline.view.zoom_by(32.0, step1_start, dur);
    h.state_mut().timeline.view.reveal(step1_start, dur, true);
    h.run_steps(3);

    let parts_r = h.state().timeline.last_parts_rect.expect("parts lane rect");
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
        .expect("visible local part clip")
        .clone();
    let center = clip.rect_in(parts_r, view.lead_inset, view.offset).center();

    // Double-clicking the clip opens the Flight Path editor on the Keyframes clock.
    h.event(Event::PointerMoved(center));
    h.step();
    let mut t = h.ctx.input(|i| i.time);
    for _ in 0..2 {
        t += 0.02;
        h.input_mut().time = Some(t);
        h.event(Event::PointerButton { pos: center, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
        h.step();
        t += 0.02;
        h.input_mut().time = Some(t);
        h.event(Event::PointerButton { pos: center, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
        h.step();
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    while h.state().transport.clock() != Clock::Keyframes {
        h.step();
        assert!(Instant::now() < deadline, "double-click did not switch to Keyframes flight path editor (notices={:?})", h.state().notices());
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(h.state().transport.clock(), Clock::Keyframes);
    assert_eq!(h.state().keys.target(), Some((clip.piece, false)));
}

#[test]
fn animate_waiting_piece_click_selects_instead_of_swallowing() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_heli();
    // Seek to start (t = 0) so pieces are waiting on the staging floor.
    run(h.state_mut(), "playback.start");
    h.run_steps(3);
    let vp_rect = h.state().viewport.last_rect().expect("viewport rect");
    let mut picked = false;
    'scan: for gy in 3..=9 {
        for gx in 3..=9 {
            let lx = vp_rect.width() * (gx as f32 / 12.0);
            let ly = vp_rect.height() * (gy as f32 / 12.0);
            let hit = h.state_mut().doc.viewport().unwrap().pick(lx as f64, ly as f64);
            if let Some(piece) = hit {
                let want = h.state().session().use_pieces(piece);
                let scr = pos2(vp_rect.left() + lx, vp_rect.top() + ly);
                click_at(&mut h, scr);
                assert_eq!(h.state().session().selection(), want, "clicking waiting piece should select it");
                picked = true;
                break 'scan;
            }
        }
    }
    assert!(picked, "expected to find at least one visible piece on the floor at t=0");
}

#[test]
fn submodel_selected_as_whole_in_main_and_by_piece_inside_or_with_alt() {
    if !bm::metal_available() {
        return;
    }
    let mut h = build_heli();
    // Pieces 0..32 form `helicopter - underside` submodel in the main model.
    let sub_group = h.state().session().use_pieces(0);
    assert!(sub_group.len() > 1, "submodel piece 0 should expand to its whole submodel in main model");

    // Frame the submodel in Bottom View so its bricks sit right at the viewport centre, then clear selection.
    h.state_mut().doc.session().select(&sub_group, bm::SelectMode::Replace);
    run(h.state_mut(), "view.frame_selection");
    h.run_steps(4);
    h.get_by_label("Bottom View").click();
    h.run_steps(4);
    h.state_mut().doc.session().select(&[], bm::SelectMode::Replace);
    h.run_steps(2);
    let vp_rect = h.state().viewport.last_rect().expect("viewport rect");
    let mut sub_hit: Option<(Pos2, u32)> = None;
    'find_sub: for gy in 3..=17 {
        for gx in 3..=17 {
            let lx = vp_rect.width() * (gx as f32 / 20.0);
            let ly = vp_rect.height() * (gy as f32 / 20.0);
            if let Some(p) = h.state_mut().doc.viewport().unwrap().pick(lx as f64, ly as f64)
                && h.state().session().use_pieces(p).len() > 1
            {
                sub_hit = Some((pos2(vp_rect.left() + lx, vp_rect.top() + ly), p));
                break 'find_sub;
            }
        }
    }
    let (pos, piece) = sub_hit.expect("expected to pick a framed submodel piece");
    let whole = h.state().session().use_pieces(piece);
    assert!(whole.len() > 1);

    // 1. Plain click in main model selects the whole submodel.
    click_at(&mut h, pos);
    assert_eq!(h.state().session().selection(), whole, "plain click should select the entire submodel");

    // 2. Option/Alt-click in main model selects the individual piece inside the submodel.
    h.event(Event::PointerMoved(pos));
    h.step();
    h.event(Event::PointerButton { pos, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::ALT });
    h.step();
    h.event(Event::PointerButton { pos, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::ALT });
    h.run_steps(2);
    assert_eq!(h.state().session().selection(), vec![piece], "Option/Alt-click should select single piece");

    // 3. Inside the submodel itself, plain click selects individual pieces.
    let rows = h.state().session().outline();
    let sub = rows.iter().find(|r| !r.def.is_empty()).expect("submodel");
    h.state_mut().focus_submodel(std::slice::from_ref(&sub.def));
    h.run_steps(4);
    assert_eq!(h.state().session().use_pieces(0), vec![0], "inside submodel, use_pieces returns single piece");
}

#[test]
fn axis_navigator_stays_fixed_when_build_settings_opens() {
    let mut h = build_heli();
    let nav_before = h.get_by_label("Axis Navigator").rect();
    run(h.state_mut(), "model.build_settings");
    h.run_steps(3);
    let nav_after = h.get_by_label("Axis Navigator").rect();
    assert!(
        (nav_before.left() - nav_after.left()).abs() < 1.0 && (nav_before.top() - nav_after.top()).abs() < 1.0,
        "Axis Navigator must not jump when Build Settings opens: before={nav_before:?}, after={nav_after:?}"
    );
    // Unified panel header is used on Build Settings too (Move + Back + Collapse + Close).
    assert!(h.query_by_label("Move Build Settings").is_some());
    assert!(h.query_by_label("Back to Properties").is_some());
    assert!(h.query_by_label("Collapse Properties").is_some());
}

#[test]
fn browser_find_button_toggles_filter_bar() {
    let mut h = build_heli();
    assert!(h.state().browser.show_filter);
    assert!(h.query_by_label("Filter models and parts").is_some());
    // Clicking magnifying glass hides the filter bar visibly.
    h.get_by_label("Find in Browser").click();
    h.run_steps(3);
    assert!(!h.state().browser.show_filter);
    assert!(h.query_by_label("Filter models and parts").is_none());
    // Clicking again re-opens and focuses it.
    h.get_by_label("Find in Browser").click();
    h.run_steps(3);
    assert!(h.state().browser.show_filter);
    assert!(h.query_by_label("Filter models and parts").is_some());
}

#[test]
fn duplicate_mix_command_removed_from_audio_ribbon() {
    let mut h = build_heli();
    h.state_mut().set_workspace(Workspace::Animate);
    h.run_steps(3);
    assert!(h.query_by_label("Mix").is_none());
    h.get_by_label("Sound").click();
    h.run_steps(3);
    assert!(h.query_by_label("Snap Sound").is_some());
    assert!(h.query_by_label("Mix").is_none());
}

#[test]
fn parts_lane_shows_labeled_pills_when_spaced_out() {
    if !bm::metal_available() {
        return;
    }
    let mut h = animate_heli();
    let dur = h.state().transport.duration();
    let step1_start = h.state().transport.lanes.as_ref().unwrap().runs[1].start;
    // Moderate zoom (~12x) where consecutive parts have generous room (~55px pitch).
    h.state_mut().timeline.view.zoom_by(12.0, step1_start, dur);
    h.state_mut().timeline.view.reveal(step1_start, dur, true);
    h.run_steps(3);
    assert!(
        h.state().timeline.parts_lane.zoomed_in,
        "parts lane should switch to labeled pills when parts have ample spacing"
    );
}


/// In Animate the view bar sits just above the timeline card and the selection chip stays clear
/// of the Browser panel.
#[test]
fn animate_view_bar_and_chip_sit_above_the_timeline() {
    let mut h = build_heli();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    h.state_mut().set_workspace(Workspace::Animate);
    h.run_steps(6);
    let bar = h.get_by_label("Fit All").rect();
    let snaps = h.get_by_label("Snaps").rect();
    let models = h.get_by_label("Models").rect();
    let chip = h.get_by_label_contains("selected").rect();
    eprintln!("bar {bar:?} snaps {snaps:?} models {models:?} chip {chip:?}");
    let timeline_top = snaps.top() - 120.0;
    assert!(bar.bottom() > timeline_top - 80.0, "view bar floats too high: {bar:?}");
    assert!(bar.bottom() < snaps.top(), "view bar overlaps the timeline: {bar:?}");
    assert!(!chip.intersects(models), "selection chip covers the Browser tabs: {chip:?}");
}

/// Every ribbon tab has at least one tool: none says "Nothing on this tab yet".
#[test]
fn every_ribbon_tab_has_tools() {
    for w in [Workspace::Build, Workspace::Animate] {
        for &tab in brickmotion::commands::tabs(w) {
            let n = brickmotion::commands::registry().iter().filter(|c| c.workspace == w && c.tab == tab).count();
            assert!(n > 0, "{w:?} › {tab} has no tools");
        }
    }
    let mut h = build_heli();
    for tab in ["Parts", "Steps", "View"] {
        h.state_mut().ribbon_tab = tab;
        h.run_steps(2);
        assert!(h.query_by_label("Nothing on this tab yet").is_none(), "{tab} is empty");
    }
}

/// View › Top turns the camera to the top preset; Orthographic toggles the projection.
#[test]
fn view_presets_and_orthographic_run() {
    let mut h = build_heli();
    assert!(run(h.state_mut(), "view.top"));
    h.run_steps(2);
    let cam = h.state_mut().doc.viewport().unwrap().camera();
    assert!(cam.pitch.abs() > 1.4, "not looking down: pitch {}", cam.pitch);
    assert!(!cam.orthographic);
    assert!(run(h.state_mut(), "view.orthographic"));
    h.run_steps(2);
    assert!(h.state_mut().doc.viewport().unwrap().camera().orthographic);
    assert_eq!(brickmotion::commands::title(brickmotion::commands::find("view.orthographic").unwrap(), &h.state().ctx()), "Orthographic");
    assert!(run(h.state_mut(), "view.orthographic"));
    h.run_steps(2);
    assert!(!h.state_mut().doc.viewport().unwrap().camera().orthographic);
}

/// Nothing unbuilt ships: no "coming soon" command, tip or dead title-bar button.
#[test]
fn no_coming_soon_placeholders() {
    for c in brickmotion::commands::registry() {
        assert!(!c.tip.to_lowercase().contains("coming soon"), "{} still says coming soon", c.id);
    }
    assert!(brickmotion::commands::find("model.submodel").is_none(), "model.submodel is registered but not built");
    // Settings is built now (BrickMotion › Settings…, ⌘,): it must open a real window.
    let mut app = BrickMotionApp::new_for_test(None);
    assert!(run(&mut app, "app.settings"));
    assert!(app.settings.open, "Settings… opens the Settings window");
    let h = build_heli();
    assert!(h.query_by_label("Preferences").is_none(), "disabled Preferences button");
    assert!(h.query_by_label("Help").is_none(), "disabled Help button");
}
