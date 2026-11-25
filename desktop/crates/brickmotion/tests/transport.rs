// Transport, planner status, keyboard shortcuts and playback frame time.
use std::time::{Duration, Instant};

use brickmotion::{BrickMotionApp, Workspace, run};
use egui::accesskit::Role;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");
const CAR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/8880-1.mpd");

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

fn key(h: &mut Harness<'static, BrickMotionApp>, key: egui::Key, modifiers: egui::Modifiers) {
    for pressed in [true, false] {
        h.event(egui::Event::Key { key, physical_key: None, pressed, repeat: false, modifiers });
    }
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

#[test]
fn space_plans_then_plays() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    assert!(!h.state().transport.ready());
    key(&mut h, egui::Key::Space, egui::Modifiers::NONE);
    h.run_steps(2);
    assert!(
        h.state().transport.busy() || h.state().transport.state.waiting_to_play || h.state().transport.ready(),
        "Space must start planning"
    );
    plan_ready(&mut h, Duration::from_secs(60));
    // Ensure playing after ready (if Space already started playback once ready, pause then play cleanly).
    if h.state().transport.state.playing {
        key(&mut h, egui::Key::Space, egui::Modifiers::NONE);
        h.run_steps(2);
        assert!(!h.state().transport.state.playing);
    }
    assert!(run(h.state_mut(), "transport.start"));
    h.run_steps(2);
    let t0 = h.state().transport.time();
    key(&mut h, egui::Key::Space, egui::Modifiers::NONE);
    h.run_steps(2);
    assert!(h.state().transport.state.playing, "Space starts playback");
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(250) {
        h.step();
        std::thread::sleep(Duration::from_millis(16));
    }
    let t1 = h.state().transport.time();
    key(&mut h, egui::Key::Space, egui::Modifiers::NONE);
    h.run_steps(2);
    assert!(!h.state().transport.state.playing, "Space pauses playback");
    assert!(t1 > t0, "playback time did not advance: t0={t0}, t1={t1}");
}

#[test]
fn home_end_seek() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    assert!(run(h.state_mut(), "video.plan_build"));
    plan_ready(&mut h, Duration::from_secs(60));
    let dur = h.state().transport.duration();
    let frame = 1.0 / h.state().transport.fps().max(1.0);
    key(&mut h, egui::Key::Home, egui::Modifiers::NONE);
    h.run_steps(2);
    assert!(h.state().transport.time().abs() <= frame + 1e-6);
    key(&mut h, egui::Key::End, egui::Modifiers::NONE);
    h.run_steps(2);
    assert!((h.state().transport.time() - dur).abs() <= frame + 1e-6);
}

#[test]
fn next_step_moves_to_the_next_run_start() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    assert!(run(h.state_mut(), "video.plan_build"));
    plan_ready(&mut h, Duration::from_secs(60));
    let start0 = h.state().transport.lanes.as_ref().unwrap().runs[0].start;
    {
        let app = h.state_mut();
        if let Some(vp) = app.doc.viewport() {
            app.transport.seek(vp, start0);
        }
    }
    h.run_steps(2);
    assert_eq!(h.state().workspace, Workspace::Build);
    // In Build workspace, ⇧→ must NOT seek.
    key(&mut h, egui::Key::ArrowRight, egui::Modifiers::SHIFT);
    h.run_steps(2);
    assert!((h.state().transport.time() - start0).abs() < 0.05, "⇧→ sought in Build workspace");

    // In Animate workspace, ⇧→ jumps to the next run's start.
    h.state_mut().set_workspace(Workspace::Animate);
    h.run_steps(2);
    let expected = h.state().transport.lanes.as_ref().unwrap().runs[1].start;
    let frame = 1.0 / h.state().transport.fps().max(1.0);
    key(&mut h, egui::Key::ArrowRight, egui::Modifiers::SHIFT);
    h.run_steps(2);
    let got = h.state().transport.time();
    assert!((got - expected).abs() <= frame + 1e-6, "got {got}, expected {expected}");
}

#[test]
fn edit_while_playing_marks_stale_and_never_mixes_versions() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    assert!(run(h.state_mut(), "video.plan_build"));
    plan_ready(&mut h, Duration::from_secs(60));
    let old_ver = h.state().transport.version.unwrap();
    let old_lanes_ptr = std::rc::Rc::as_ptr(h.state().transport.lanes.as_ref().unwrap());

    assert!(run(h.state_mut(), "transport.start"));
    assert!(run(h.state_mut(), "transport.play"));
    h.run_steps(2);
    assert!(h.state().transport.state.playing);

    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "edit.nudge_right"));
    h.step();

    // Immediately after the edit, the state is stale or not Ready, while cached version & lanes
    // remain consistently on the old version until the new Ready plan arrives.
    {
        let tr = &h.state().transport;
        assert!(tr.state.stale || !tr.ready(), "expected stale or planning after edit");
        assert_eq!(tr.version, Some(old_ver));
        assert_eq!(std::rc::Rc::as_ptr(tr.lanes.as_ref().unwrap()), old_lanes_ptr);
    }

    // Replan settles on the new version with fresh lanes matching `state.version`.
    plan_ready(&mut h, Duration::from_secs(60));
    let tr = &h.state().transport;
    assert_ne!(tr.version, Some(old_ver));
    assert_eq!(tr.version, Some(tr.state.version));
    assert!(tr.lanes.is_some());
}

#[test]
fn document_switch_resets_transport() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    assert!(run(h.state_mut(), "video.plan_build"));
    plan_ready(&mut h, Duration::from_secs(60));
    h.state_mut().transport.focused_step = Some(0);
    assert!(h.state().transport.version.is_some());

    h.state_mut().open(CAR.into());
    h.state_mut().wait_loaded();
    h.run_steps(2);
    assert_eq!(h.state().transport.version, None);
    assert!(h.state().transport.lanes.is_none());
    assert_eq!(h.state().transport.focused_step, None);
}

#[test]
fn play_cancels_placement() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().begin_placement(bm::library::PartMatch {
        name: "3001.dat".into(),
        description: "Brick 2 x 4".into(),
        category: "Brick".into(),
    });
    assert!(h.state().edit.placement.is_some());
    assert!(run(h.state_mut(), "transport.play"));
    assert!(h.state().edit.placement.is_none());
}

#[test]
fn auto_plan_pref_is_sent() {
    if !bm::metal_available() {
        return;
    }
    let mut h = Harness::builder()
        .with_size([1440.0, 900.0])
        .build_eframe(|cc| {
            let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
            app.prefs.auto_plan = false;
            app.wait_loaded();
            app.dialogs_off();
            app
        });
    h.state_mut().set_workspace(Workspace::Animate);
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(2) {
        h.step();
        assert!(!h.state().transport.busy() && !h.state().transport.ready(), "auto_plan=false still planned");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(run(h.state_mut(), "video.plan_build"));
    plan_ready(&mut h, Duration::from_secs(60));
    assert!(h.state().transport.ready());
}

#[test]
fn choosing_a_step_shows_the_callout() {
    let mut h = heli_harness();
    assert!(h.query_by_label("Play Step").is_none(), "callout hidden before choosing a step");
    h.state_mut().browser_tab = 1; // Steps tab
    h.run_steps(2);
    h.get_by_role_and_label(Role::TreeItem, "Step 1").click();
    h.run_steps(2);
    assert_eq!(h.state().transport.focused_step, Some(0));
    assert!(h.query_by_label("Play Step").is_some());
    assert!(h.query_by_label("Play to End").is_some());
    assert!(h.query_by_label("Step Appearance").is_some());
    assert!(h.query_by_label("Show All").is_some());
}

#[test]
fn next_step_arranges_the_next() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().browser_tab = 1;
    h.run_steps(2);
    h.get_by_role_and_label(Role::TreeItem, "Step 1").click();
    h.run_steps(3);
    assert_eq!(h.state().transport.focused_step, Some(0));
    let before = h.render().unwrap();

    h.get_by_role_and_label(Role::Button, "Next Step").click();
    h.run_steps(4);
    assert_eq!(h.state().transport.focused_step, Some(1));
    assert_eq!(h.state().edit.step, Some(1));
    assert_eq!(h.state().transport.step_preview, Some(bm::playback::AssemblyPreview::Assembled));
    let after = h.render().unwrap();
    assert_ne!(before.as_raw(), after.as_raw(), "arranging next step changed nothing in viewport");
}

#[test]
fn play_step_plans_then_plays_that_step() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    assert!(!h.state().transport.ready());
    h.state_mut().browser_tab = 1;
    h.run_steps(2);
    h.get_by_role_and_label(Role::TreeItem, "Step 2").click();
    h.run_steps(2);
    assert_eq!(h.state().transport.focused_step, Some(1));

    h.get_by_role_and_label(Role::Button, "Play Step").click();
    h.run_steps(2);
    plan_ready(&mut h, Duration::from_secs(60));
    h.run_steps(2);
    let step2 = h
        .state()
        .transport
        .lanes
        .as_ref()
        .unwrap()
        .steps
        .iter()
        .find(|s| s.step == 1)
        .cloned()
        .expect("step 2 lane clip");
    let t = h.state().transport.time();
    assert!(
        t + 0.05 >= step2.start && t <= step2.end + 0.5,
        "playhead {t} not inside step 2 [{}, {}]",
        step2.start,
        step2.end
    );
    assert!(
        h.state().transport.state.playing || !h.state().transport.state.at_rest,
        "Play Step must start playing step 2"
    );
}

#[test]
fn close_returns_to_rest() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    h.state_mut().browser_tab = 1;
    h.run_steps(2);
    h.get_by_role_and_label(Role::TreeItem, "Step 1").click();
    h.run_steps(2);
    let before = h.render().unwrap();
    assert!(run(h.state_mut(), "step.appearance_exploded"));
    h.run_steps(4);
    let exploded = h.render().unwrap();
    assert_ne!(before.as_raw(), exploded.as_raw(), "exploding step 1 changed nothing");

    h.get_by_role_and_label(Role::Button, "Close Step Callout").click();
    h.run_steps(4);
    assert_eq!(h.state().transport.focused_step, None);
    assert_eq!(h.state().transport.step_preview, None);
    assert!(h.state().transport.state.at_rest, "closing callout returns to rest");
    assert!(h.query_by_label("Play Step").is_none());
    let restored = h.render().unwrap();
    assert_ne!(exploded.as_raw(), restored.as_raw(), "closing callout did not return viewport to rest");
}

#[test]
#[ignore]
fn playback_frame_time() {
    let Some(big) = std::env::var_os("BM_BIG_MODEL") else { return };
    if !bm::metal_available() {
        return;
    }
    let mut h = Harness::builder()
        .with_size([1440.0, 900.0])
        .with_pixels_per_point(2.0) // 2880×1800 pixels
        .build_eframe(move |cc| {
            let mut app = BrickMotionApp::new_for_test_cc(cc, Some(big.into()));
            app.wait_loaded();
            app.dialogs_off();
            app
        });
    h.run_steps(3);
    let plan_t0 = Instant::now();
    // Standard Preview plans all 9,090 Titanic pieces in seconds (native flight collision checking
    // takes minutes on 10294-1) while rendering the exact same 9,090-piece playback frames.
    assert!(run(h.state_mut(), "video.standard_preview"));
    plan_ready(&mut h, Duration::from_secs(120));
    eprintln!(
        "10294-1 planned (standard_preview) in {:?}: {} flights, duration={:.1}s",
        plan_t0.elapsed(),
        h.state().transport.flights().len(),
        h.state().transport.duration()
    );
    assert!(run(h.state_mut(), "transport.start"));
    assert!(run(h.state_mut(), "transport.play"));
    let mut times = Vec::new();
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(3) {
        let f0 = Instant::now();
        h.step();
        times.push(f0.elapsed());
    }
    times.sort();
    let median = times[times.len() / 2];
    let p95 = times[(times.len() * 95) / 100];
    eprintln!(
        "playback_frame_time (2880x1800): {} frames in 3s, median={median:?}, p95={p95:?}",
        times.len()
    );
    assert!(median < Duration::from_millis(33), "median playback frame {median:?} >= 33 ms");
}
