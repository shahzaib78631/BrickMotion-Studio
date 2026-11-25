// The locked layout, driven through the accessibility tree.
use brickmotion::{BrickMotionApp, Workspace, registry};
use egui::accesskit::Role;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

fn harness() -> Harness<'static, BrickMotionApp> {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| BrickMotionApp::new(cc, None));
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
    assert!(registry().iter().filter(|c| !c.enabled).all(|c| c.tip.ends_with(" — coming soon")));
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
