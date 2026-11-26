// The Look panel: scene, shading, detail switches and path samples, each one undo step.
use brickmotion::{BrickMotionApp, Workspace, run};
use egui::{Pos2, vec2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn app() -> Harness<'static, BrickMotionApp> {
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

fn open_look(h: &mut Harness<'static, BrickMotionApp>) {
    assert!(run(h.state_mut(), "view.look"));
    h.run_steps(3);
}

fn reveal(h: &mut Harness<'static, BrickMotionApp>, role: egui::accesskit::Role, label: &str) -> egui::Rect {
    h.get_by_role_and_label(role, label).scroll_to_me();
    h.run_steps(40);
    h.get_by_role_and_label(role, label).rect()
}

fn press(h: &mut Harness<'static, BrickMotionApp>, pos: Pos2, pressed: bool) {
    h.event(egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers: egui::Modifiers::NONE });
    h.step();
}

#[test]
fn look_command_opens_panel() {
    if !bm::metal_available() {
        return;
    }
    let mut h = app();
    assert!(h.query_by_label("Look panel").is_none());
    assert!(run(h.state_mut(), "model.look"));
    h.run_steps(3);
    assert!(h.query_by_label("Look panel").is_some(), "Model › Look opens the panel");
    assert!(run(h.state_mut(), "model.look"));
    h.run_steps(3);
    assert!(h.query_by_label("Look panel").is_none(), "a second click closes it");
    h.state_mut().set_workspace(Workspace::Animate);
    open_look(&mut h);
    assert!(h.query_by_label("Look panel").is_some(), "View › Look… opens the panel");
    assert!(h.query_by_label("Saved with the project and used by every video.").is_some());
}

#[test]
fn look_toggle_is_one_undo_step() {
    if !bm::metal_available() {
        return;
    }
    let mut h = app();
    open_look(&mut h);
    let depth = h.state().session().undo_depth();
    assert!(h.state().session().render_look().edges);
    let r = reveal(&mut h, egui::accesskit::Role::Switch, "Edge lines");
    press(&mut h, r.center(), true);
    press(&mut h, r.center(), false);
    h.run_steps(2);
    assert!(!h.state().session().render_look().edges);
    assert_eq!(h.state().session().undo_depth(), depth + 1);
}

#[test]
fn look_scene_tile_sets_scene() {
    if !bm::metal_available() {
        return;
    }
    let mut h = app();
    open_look(&mut h);
    let r = reveal(&mut h, egui::accesskit::Role::Button, "Slate blue");
    press(&mut h, r.center(), true);
    press(&mut h, r.center(), false);
    h.run_steps(2);
    assert_eq!(h.state().session().render_look().scene, "slate-blue");
    let r = reveal(&mut h, egui::accesskit::Role::Button, "Editor");
    press(&mut h, r.center(), true);
    press(&mut h, r.center(), false);
    h.run_steps(2);
    assert_eq!(h.state().session().render_look().scene, "");
}

#[test]
fn path_samples_commit_on_release() {
    if !bm::metal_available() {
        return;
    }
    let mut h = app();
    let mut look = h.state().session().render_look();
    look.shading = bm::export::Shading::PathTraced;
    assert!(h.state_mut().doc.session().set_render_look(&look).refused.is_none());
    open_look(&mut h);
    let r = reveal(&mut h, egui::accesskit::Role::Slider, "Samples");
    let commits = h.state().look.commits;
    let depth = h.state().session().undo_depth();
    let from = egui::pos2(r.left() + 10.0, r.center().y);
    h.event(egui::Event::PointerMoved(from));
    h.step();
    press(&mut h, from, true);
    for i in 1..=10 {
        h.event(egui::Event::PointerMoved(from + vec2(r.width() * 0.6 * i as f32 / 10.0, 0.0)));
        h.step();
    }
    assert_eq!(h.state().look.commits, commits, "nothing commits while dragging");
    press(&mut h, from + vec2(r.width() * 0.6, 0.0), false);
    h.run_steps(2);
    assert_eq!(h.state().look.commits, commits + 1, "one set_render_look call");
    assert_eq!(h.state().session().undo_depth(), depth + 1);
    assert!(h.state().session().render_look().path_samples > 64);
}

#[test]
fn samples_hidden_unless_path_traced() {
    if !bm::metal_available() {
        return;
    }
    let mut h = app();
    open_look(&mut h);
    assert!(h.query_by_label("Samples").is_none());
}

#[test]
#[ignore = "writes a screenshot for review"]
fn look_screenshot() {
    let mut h = app();
    open_look(&mut h);
    h.run_steps(10);
    let image = h.render().expect("render");
    image.save(std::env::var("LOOK_SHOT").unwrap_or("/tmp/look.png".into())).unwrap();
}
