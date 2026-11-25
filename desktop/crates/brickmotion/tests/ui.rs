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
fn disabled_commands_say_so() {
    use brickmotion::commands::When;
    assert!(registry().iter().filter(|c| c.when == When::Soon).all(|c| c.tip.ends_with(" — coming soon")));
    assert!(registry().iter().filter(|c| c.when != When::Soon).all(|c| !c.tip.ends_with(" — coming soon")));
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

/// Writes desktop/docs/m1-build.png and m1-animate.png when BM_SCREENSHOTS is set.
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
