// The locked layout, driven through the accessibility tree.
use brickmotion::{BrickMotionApp, Workspace, registry};
use egui::accesskit::Role;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

fn harness() -> Harness<'static, BrickMotionApp> {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| BrickMotionApp::new_for_test_cc(cc, None));
    h.run();
    h
}

#[test]
fn build_has_no_timeline() {
    let mut h = harness();
    assert!(h.query_by_label("Search commands").is_some());
    assert!(h.query_by_label("Snaps").is_none()); // timeline track
    h.get_by_role_and_label(Role::Button, "Animate").click();
    h.run();
    assert!(h.query_by_label("Snaps").is_some());
    assert!(h.query_by_label("Output").is_some()); // Animate ribbon tab
    // The timeline has a Build track too, so the switch is found by role.
    h.get_by_role_and_label(Role::Button, "Build").click();
    h.run();
    assert!(h.query_by_label("Snaps").is_none());
}

#[test]
fn workspace_button_mirrors_switch() {
    let mut h = harness();
    h.get_by_label("Workspace").click();
    h.run();
    assert_eq!(h.state().workspace, Workspace::Animate);
}

#[test]
fn ribbon_comes_from_registry() {
    let h = harness();
    for c in registry().iter().filter(|c| c.workspace == Workspace::Build && c.tab == "Model") {
        assert!(h.query_by_label(c.title).is_some(), "{}", c.title);
    }
}

#[test]
fn ribbon_tabs_switch_content() {
    let mut h = harness();
    h.get_by_role_and_label(Role::Button, "Animate").click();
    h.run();
    assert!(h.query_by_label("Plan Build").is_some());
    h.get_by_label("Output").click();
    h.run();
    assert!(h.query_by_label("Export Movie").is_some());
    assert!(h.query_by_label("Plan Build").is_none());
}

/// Writes desktop/docs/m1-build.png and m1-animate.png, and the milestone 2 pictures (model
/// tree, Properties for one piece, the palette), when BM_SCREENSHOTS is set.
#[test]
fn screenshots() {
    if std::env::var_os("BM_SCREENSHOTS").is_none() {
        return;
    }
    let docs = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs");
    let mut h = harness();
    h.run_steps(4);
    h.render().unwrap().save(format!("{docs}/m1-build.png")).unwrap();
    h.get_by_role_and_label(Role::Button, "Animate").click();
    h.run();
    h.run_steps(4);
    h.render().unwrap().save(format!("{docs}/m1-animate.png")).unwrap();

    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    h.run_steps(6);
    h.render().unwrap().save(format!("{docs}/m2-document.png")).unwrap();
    h.state_mut().palette.show_palette();
    h.run_steps(2);
    h.event(egui::Event::Text("sel".into()));
    h.run_steps(4);
    h.render().unwrap().save(format!("{docs}/m2-palette.png")).unwrap();

    // Milestone 3 screenshots: Move gizmo, Library with rendered previews, snapped placement + HUD, Steps + editor.
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(brickmotion::run(h.state_mut(), "model.move"));
    h.run_steps(6);
    h.render().unwrap().save(format!("{docs}/m3-gizmo.png")).unwrap();

    let mut h = heli_harness();
    h.state_mut().browser_tab = 3;
    let t0 = std::time::Instant::now();
    // Give the preview worker a moment so common-part tiles show crisp rendered bricks.
    while t0.elapsed() < std::time::Duration::from_secs(3) {
        h.step();
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    h.run_steps(4);
    h.render().unwrap().save(format!("{docs}/m3-library.png")).unwrap();

    if bm::metal_available() {
        let mut h = heli_harness();
        let centre = h.state().viewport_rect().unwrap().center();
        let brick = bm::library::PartMatch {
            name: "3001.dat".into(),
            description: "Brick 2 x 4".into(),
            category: "Brick".into(),
        };
        h.state_mut().edit.colour = 4;
        h.state_mut().begin_placement(brick);
        h.event(egui::Event::PointerMoved(centre));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            h.step();
            if let Some(p) = &h.state().edit.placement
                && !matches!(
                    p.state,
                    bm::placement::PlacementState::Inactive | bm::placement::PlacementState::Preparing
                )
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        h.run_steps(4);
        h.render().unwrap().save(format!("{docs}/m3-placing.png")).unwrap();
    }

    let car = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/8880-1.mpd");
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(move |cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(car.into()));
        app.wait_loaded();
        app
    });
    h.run_steps(4);
    h.state_mut().browser_tab = 1;
    h.state_mut().edit.step = Some(0);
    h.run_steps(2);
    assert!(brickmotion::run(h.state_mut(), "step.edit"));
    h.run_steps(4);
    h.render().unwrap().save(format!("{docs}/m3-steps.png")).unwrap();

    // Milestone 4 screenshots: Timeline + Parts lane, Planning state, Build Settings,
    // Build Staging, Snap Sound, and Step Callout.
    if bm::metal_available() {
        let wait_plan = |h: &mut Harness<'static, BrickMotionApp>| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            loop {
                h.step();
                let ver = h.state().session().version();
                let tr = &h.state().transport;
                if tr.ready() && tr.version == Some(ver) && !tr.state.stale {
                    break;
                }
                assert!(std::time::Instant::now() < deadline, "plan timed out in screenshots");
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        };

        // 1. m4-timeline.png: Animate workspace, helicopter planned, playhead mid-build, Parts lane zoomed in.
        let mut h = heli_harness();
        h.state_mut().set_workspace(Workspace::Animate);
        wait_plan(&mut h);
        let mid = h.state().transport.build_start()
            + (h.state().transport.build_end() - h.state().transport.build_start()) * 0.45;
        {
            let app = h.state_mut();
            if let Some(vp) = app.doc.viewport() {
                app.transport.seek(vp, mid);
            }
            app.timeline.view.zoom = 18.0;
        }
        // Step once so TimelineView knows viewport_width, then center on playhead so orange line & Parts clips show.
        h.run_steps(2);
        {
            let app = h.state_mut();
            let dur = app.transport.duration();
            app.timeline.view.reveal(mid, dur, true);
        }
        h.run_steps(6);
        h.render().unwrap().save(format!("{docs}/m4-timeline.png")).unwrap();

        // 2. m4-staging.png: Animate workspace at t=0 (waiting parts on floor) with Build Staging page.
        assert!(brickmotion::run(h.state_mut(), "transport.start"));
        h.state_mut().timeline.view.fit();
        assert!(brickmotion::run(h.state_mut(), "video.staging"));
        h.run_steps(6);
        h.render().unwrap().save(format!("{docs}/m4-staging.png")).unwrap();

        // 3. m4-sound.png: Animate workspace with Snap Sound page enabled and Brick sample waveform rendered.
        {
            let mut mix = h.state().session().snap_mix();
            mix.enabled = true;
            h.state_mut().doc.session().set_snap_mix(&mix);
        }
        assert!(brickmotion::run(h.state_mut(), "video.snap_sound"));
        h.run_steps(2);
        h.state_mut().play_snap_sample(bm::settings::SnapExample::Brick);
        let t0 = std::time::Instant::now();
        while h.state().sound.waveform(bm::settings::SnapExample::Brick).is_none()
            && t0.elapsed() < std::time::Duration::from_secs(10)
        {
            h.step();
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        h.run_steps(6);
        h.render().unwrap().save(format!("{docs}/m4-sound.png")).unwrap();

        // 4. m4-build-settings.png: Build workspace, assembled planned helicopter, Build Settings page open.
        {
            let app = h.state_mut();
            if let Some(vp) = app.doc.viewport() {
                app.transport.rest(vp);
            }
        }
        h.state_mut().set_workspace(Workspace::Build);
        assert!(brickmotion::run(h.state_mut(), "model.build_settings"));
        h.run_steps(6);
        h.render().unwrap().save(format!("{docs}/m4-build-settings.png")).unwrap();

        // 5. m4-callout.png: Build workspace, Steps tab, Step 4 Exploded with floating callout.
        let mut h = heli_harness();
        h.state_mut().browser_tab = 1;
        h.state_mut().edit.step = Some(3);
        h.state_mut().transport.focused_step = Some(3);
        h.run_steps(2);
        let step_pieces = h.state().session().pieces_of_step(3);
        h.state_mut().doc.session().select(&step_pieces, bm::SelectMode::Replace);
        assert!(brickmotion::run(h.state_mut(), "step.appearance_exploded"));
        h.run_steps(6);
        h.render().unwrap().save(format!("{docs}/m4-callout.png")).unwrap();

        // 6. m4-planning.png: Animate workspace on 8880-1.mpd actively planning (titlebar status + greyed timeline).
        let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(move |cc| {
            let mut app = BrickMotionApp::new_for_test_cc(cc, Some(car.into()));
            app.wait_loaded();
            app
        });
        h.run_steps(3);
        h.state_mut().set_workspace(Workspace::Animate);
        let t0 = std::time::Instant::now();
        while !h.state().transport.busy() && t0.elapsed() < std::time::Duration::from_secs(3) {
            h.step();
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        h.run_steps(3);
        h.render().unwrap().save(format!("{docs}/m4-planning.png")).unwrap();
    }
}

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn press(h: &mut Harness<'static, BrickMotionApp>, at: egui::Pos2, modifiers: egui::Modifiers) {
    for pressed in [true, false] {
        h.event(egui::Event::PointerButton { pos: at, button: egui::PointerButton::Primary, pressed, modifiers });
    }
}

#[test]
fn viewport_shows_model_and_picks() {
    let mut h = Harness::builder()
        .with_size([1440.0, 900.0])
        .build_eframe(|cc| BrickMotionApp::new_for_test_cc(cc, Some(HELI.into())));
    // The model opens on a worker; the window keeps drawing meanwhile.
    let t0 = std::time::Instant::now();
    while h.state().piece_count() < 100 {
        assert!(t0.elapsed() < std::time::Duration::from_secs(60), "the model never arrived");
        h.step();
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    h.run_steps(6);
    // Middle of the viewport (below the 38-px title bar and 104-px ribbon): a piece.
    let centre = egui::pos2(720.0, 142.0 + (900.0 - 142.0) / 2.0);
    h.event(egui::Event::PointerMoved(centre));
    press(&mut h, centre, egui::Modifiers::NONE);
    h.run_steps(3);
    assert_eq!(h.state().doc.session().selection().len(), 1);
    assert!(h.query_by_label("1 piece").is_some(), "selection chip");
    // A plain click on empty space clears it.
    let empty = egui::pos2(200.0, 800.0);
    h.event(egui::Event::PointerMoved(empty));
    press(&mut h, empty, egui::Modifiers::NONE);
    h.run_steps(3);
    assert!(h.state().doc.session().selection().is_empty());
    // The navigator's discs change the view.
    let before = h.render().unwrap();
    h.get_by_label("Top View").click();
    h.run_steps(4);
    assert_ne!(before.as_raw(), h.render().unwrap().as_raw(), "Top View changed nothing");
    if std::env::var_os("BM_SCREENSHOTS").is_some() {
        press(&mut h, centre, egui::Modifiers::NONE);
        h.run_steps(4);
        let docs = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs");
        h.render().unwrap().save(format!("{docs}/m1-viewport.png")).unwrap();
    }
}

/// With BM_BIG_MODEL=<path>: the window keeps drawing, with the Browser spinner, while it opens.
#[test]
fn large_model_keeps_window_responsive() {
    let Some(big) = std::env::var_os("BM_BIG_MODEL") else { return };
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| BrickMotionApp::new_for_test_cc(cc, None));
    h.run();
    let name = std::path::Path::new(&big).file_name().unwrap().to_string_lossy().into_owned();
    h.state_mut().open(big.into());
    let t0 = std::time::Instant::now();
    let (mut frames, mut slowest, mut saw_spinner) = (0, std::time::Duration::ZERO, false);
    while h.state().opening().is_some() {
        assert!(t0.elapsed() < std::time::Duration::from_secs(120), "never finished");
        let f0 = std::time::Instant::now();
        h.step();
        slowest = slowest.max(f0.elapsed());
        frames += 1;
        saw_spinner |= h.query_by_label(&format!("Opening {name}…")).is_some();
    }
    h.run_steps(2);
    eprintln!("{name}: {} pieces in {:?}, {frames} frames meanwhile, slowest {slowest:?}", h.state().piece_count(), t0.elapsed());
    assert!(saw_spinner, "no spinner while opening");
    assert!(frames > 3 && slowest < std::time::Duration::from_millis(100), "UI stalled: slowest frame {slowest:?}");
}

#[test]
fn empty_launch_invites_open() {
    let h = harness();
    assert!(h.query_by_label("Open a model to begin").is_some());
    assert!(h.query_by_label_contains("Metal").is_none());
}

fn heli_harness() -> Harness<'static, BrickMotionApp> {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
        app.wait_loaded();
        app
    });
    h.run_steps(3);
    h
}

#[test]
fn properties_show_project_when_nothing_selected() {
    let h = heli_harness();
    assert!(h.query_by_label("Project").is_some());
    assert!(h.query_by_label("Not saved").is_some());
    assert!(h.query_by_label("Edited").is_none());
}

#[test]
fn properties_show_one_piece() {
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    h.run_steps(2);
    let info = h.state().session().snapshot().described[0].clone();
    assert!(h.query_by_label("Piece").is_some());
    assert!(h.query_by_label(&info.description).is_some(), "{}", info.description);
    assert!(h.query_by_label(&info.part).is_some(), "{}", info.part);
    assert!(h.query_by_label(&info.color_name).is_some(), "{}", info.color_name);
}

#[test]
fn properties_show_many() {
    let mut h = heli_harness();
    h.state_mut().doc.session().select_all();
    h.run_steps(2);
    let n = h.state().piece_count();
    assert!(h.query_all_by_label(&format!("{n} pieces")).count() >= 3, "title bar, chip and Properties");
    assert!(h.query_all_by_label_contains(" × ").count() >= 2, "the parts list");
    assert!(h.query_by_label("Showing the first 200").is_some());
}

#[test]
fn properties_say_saved_after_save() {
    let mut h = heli_harness();
    h.state_mut().doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(brickmotion::run(h.state_mut(), "edit.delete"));
    h.run_steps(2);
    assert!(h.query_by_label("Edited").is_some());
    let out = std::env::temp_dir().join(format!("bm-ui-saved-{}.brickmotion", std::process::id()));
    h.state_mut().save_as_path(out);
    h.run_steps(2);
    assert!(h.query_by_label("Edited").is_none(), "still says Edited after saving");
    assert!(h.query_by_label("Saved").is_some());
}

#[test]
fn command_line_open_waits_for_the_view_size() {
    let mut h = Harness::builder()
        .with_size([1440.0, 900.0])
        .build_eframe(|cc| BrickMotionApp::new_for_test_cc(cc, Some(HELI.into())));
    let t0 = std::time::Instant::now();
    while h.state().piece_count() == 0 {
        assert!(t0.elapsed() < std::time::Duration::from_secs(60), "never opened");
        h.step();
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(h.state().opened_warm(), "the first open did not know the view size");
}

/// Writes the milestone 5 pictures to desktop/docs when BM_M5_SCREENSHOTS is set: the Keys panel
/// and dope sheet, the Camera Key panel, the Camera panel, Build Motion, a joint and a flight path.
#[test]
fn m5_screenshots() {
    use brickmotion::transport::Clock;
    use std::time::{Duration, Instant};
    if std::env::var_os("BM_M5_SCREENSHOTS").is_none() || !bm::metal_available() {
        return;
    }
    let docs = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs");
    let planned = || {
        let mut h = heli_harness();
        h.state_mut().set_workspace(Workspace::Animate);
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            h.step();
            let ver = h.state().session().version();
            let tr = &h.state().transport;
            if tr.ready() && tr.version == Some(ver) && !tr.state.stale {
                break;
            }
            assert!(Instant::now() < deadline, "plan timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
        h.run_steps(3);
        h
    };
    let idle = |h: &mut Harness<'static, BrickMotionApp>| {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            h.step();
            let a = h.state();
            if !a.bake.busy() && !a.audit.busy() && !a.joints.busy() {
                break;
            }
            assert!(Instant::now() < deadline, "workers never finished");
            std::thread::sleep(Duration::from_millis(10));
        }
        h.run_steps(4);
    };
    let clock = |h: &mut Harness<'static, BrickMotionApp>, c: Clock| {
        let app = h.state_mut();
        let vp = app.doc.viewport().expect("viewport");
        app.transport.set_clock(vp, c);
        h.run_steps(3);
    };
    let select = |h: &mut Harness<'static, BrickMotionApp>, p: &[u32]| {
        h.state_mut().doc.session().select(p, bm::SelectMode::Replace);
        h.run_steps(3);
    };
    let save = |h: &mut Harness<'static, BrickMotionApp>, name: &str| {
        h.run_steps(6);
        h.render().unwrap().save(format!("{docs}/{name}")).unwrap();
    };

    // Keys panel, dope sheet and the flight path of a baked part.
    let mut h = planned();
    select(&mut h, &[32]);
    assert!(brickmotion::run(h.state_mut(), "video.bake_flight"));
    idle(&mut h);
    clock(&mut h, Clock::Keyframes);
    h.state_mut().ribbon_tab = "Keyframes";
    select(&mut h, &[32]);
    save(&mut h, "m5-flight-path.png");
    assert!(brickmotion::run(h.state_mut(), "video.group"));
    save(&mut h, "m5-keyframes.png");

    // Camera Key panel on the camera lane, then the Camera panel.
    let mut h = planned();
    h.state_mut().ribbon_tab = "Camera";
    assert!(brickmotion::run(h.state_mut(), "video.camera_key"));
    save(&mut h, "m5-camera.png");
    h.state_mut().camera_selection = None;
    assert!(brickmotion::run(h.state_mut(), "video.scene_cameras"));
    save(&mut h, "m5-camera-page.png");

    // Build Motion for one part.
    let mut h = planned();
    select(&mut h, &[32]);
    assert!(brickmotion::run(h.state_mut(), "motion.build"));
    save(&mut h, "m5-motion.png");

    // A joint with its card and panel.
    let mut h = planned();
    assert!(brickmotion::run(h.state_mut(), "view.joints"));
    idle(&mut h);
    let j = h.state().joints.report.clone().unwrap().into_iter().filter(|j| j.kind.turns()).nth(3).unwrap();
    brickmotion::chrome::joints::open(h.state_mut(), (j.a, j.b));
    idle(&mut h);
    save(&mut h, "m5-joint.png");
}
