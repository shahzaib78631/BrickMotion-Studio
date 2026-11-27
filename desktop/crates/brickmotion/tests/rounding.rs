// Look › Bricks: the three display-rounding switches (smooth curves, rounded edges, soft stud
// bases) are on by default, change the project's look, and undo.
use brickmotion::{BrickMotionApp, run};
use egui::accesskit::Role;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn look_open() -> Harness<'static, BrickMotionApp> {
    // Tall enough that the whole Look panel is laid out without scrolling.
    let mut h = Harness::builder().with_size([1440.0, 2000.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
        app.wait_loaded();
        app.dialogs_off();
        app.prefs.auto_plan = false;
        app
    });
    h.run_steps(3);
    assert!(run(h.state_mut(), "model.look"));
    h.run_steps(3);
    h
}

#[test]
fn rounding_switches_are_on_and_each_turns_its_rounding_off() {
    let mut h = look_open();
    let look = h.state().session().render_look();
    assert!(look.smooth_curves && look.rounded_edges && look.soft_stud_roots);
    for label in ["Smooth curves", "Rounded edges", "Soft stud bases"] {
        h.get_by_role_and_label(Role::Switch, label).click();
        h.run_steps(3);
    }
    let look = h.state().session().render_look();
    assert!(!look.smooth_curves, "Smooth curves");
    assert!(!look.rounded_edges, "Rounded edges");
    assert!(!look.soft_stud_roots, "Soft stud bases");
    let depth = h.state().session().undo_depth();
    h.get_by_role_and_label(Role::Switch, "Smooth curves").click();
    h.run_steps(3);
    assert!(h.state().session().render_look().smooth_curves);
    assert_eq!(h.state().session().undo_depth(), depth + 1, "one undo step a switch");
}
