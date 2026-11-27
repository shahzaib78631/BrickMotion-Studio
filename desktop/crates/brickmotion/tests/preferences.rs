// BrickMotion › Settings…, About and Help: the shell sheets of P2.
use brickmotion::support::Prefs;
use brickmotion::{BrickMotionApp, run};
use egui::accesskit::Role;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

fn empty_app() -> Harness<'static, BrickMotionApp> {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, None);
        app.dialogs_off();
        app
    });
    h.run_steps(3);
    h
}

fn open_settings(h: &mut Harness<'static, BrickMotionApp>) {
    run(h.state_mut(), "app.settings");
    h.run_steps(3);
}

#[test]
fn command_comma_opens_settings_and_esc_closes_it() {
    let mut h = empty_app();
    h.key_press_modifiers(egui::Modifiers::COMMAND, egui::Key::Comma);
    h.run_steps(3);
    assert!(h.state().settings.open, "⌘, opens Settings");
    for s in ["General", "Appearance", "Building", "Animate", "Files"] {
        assert!(h.query_by_role_and_label(Role::Tab, s).is_some(), "section {s}");
    }
    h.key_press(egui::Key::Escape);
    h.run_steps(3);
    assert!(!h.state().settings.open);
}

#[test]
fn choosing_a_theme_applies_and_keeps_it() {
    let mut h = empty_app();
    open_settings(&mut h);
    h.get_by_role_and_label(Role::Tab, "Appearance").click();
    h.run_steps(3);
    // Match System, then every theme in the catalogue, as radio cards.
    let cards = h.query_all_by_role(Role::RadioButton).count();
    assert!(cards >= 28, "{cards} theme cards");
    // A card in the visible rows; the rest scroll.
    h.get_by_role_and_label(Role::RadioButton, "Mono Light").click();
    h.run_steps(3);
    let applied = brickmotion::theme::of(&h.ctx);
    let app = h.state();
    assert_eq!(app.prefs.theme, "mono-light");
    assert!(!app.theme.dark);
    assert_eq!(applied.bg1, app.theme.bg1, "applied to the context");
    let kept = Prefs::load(&app.support);
    assert_eq!(kept.theme, "mono-light", "kept in preferences.toml");
}

#[test]
fn search_finds_rows_in_every_section() {
    let mut h = empty_app();
    open_settings(&mut h);
    h.state_mut().settings.search = "backup".into();
    h.run_steps(3);
    assert!(h.query_by_label("Backups kept").is_some());
    assert!(h.query_by_label("Collision checks").is_none());
    h.state_mut().settings.search = "zzz-nothing".into();
    h.run_steps(3);
    assert!(h.query_by_label_contains("No settings match").is_some());
}

#[test]
fn building_switches_change_the_editor_and_are_kept() {
    let mut h = empty_app();
    open_settings(&mut h);
    h.get_by_role_and_label(Role::Tab, "Building").click();
    h.run_steps(3);
    assert!(!h.state().edit.smart_joints);
    h.get_by_role_and_label(Role::Switch, "Smart Joints").click();
    h.run_steps(3);
    assert!(h.state().edit.smart_joints);
    assert!(Prefs::load(&h.state().support).smart_joints, "kept for the next launch");
}

#[test]
fn about_lists_versions_and_credits() {
    let mut h = empty_app();
    run(h.state_mut(), "app.about");
    h.run_steps(3);
    assert!(h.query_all_by_label(env!("CARGO_PKG_VERSION")).count() >= 1, "app version");
    assert!(h.query_by_label("Engine").is_some());
    assert!(h.query_by_label_contains("Nord palette").is_some(), "public palettes are credited");
    h.get_by_label("Done").click();
    h.run_steps(3);
    assert!(!h.state().about_open);
}

#[test]
fn help_guide_is_written_with_its_four_sections() {
    let dir = std::env::temp_dir().join(format!("bm-help-{}", std::process::id()));
    let path = brickmotion::help::write_guide(&dir).unwrap();
    let text = std::fs::read_to_string(path).unwrap();
    for s in ["Basics", "Building", "Animating", "Exporting"] {
        assert!(text.contains(&format!("<h2>{s}</h2>")), "{s}");
    }
}

/// Writes screenshots of the P2 screens to $P2_SHOTS (ignored; run by hand).
#[test]
#[ignore]
fn p2_screenshots() {
    let out = std::path::PathBuf::from(std::env::var("P2_SHOTS").unwrap_or_else(|_| "/tmp".into()));
    const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");
    for theme in ["dark", "light", "nord", "kiln-light", "amber-terminal", "solarized-light"] {
        let mut h = Harness::builder().with_size([1440.0, 900.0]).wgpu().build_eframe(|cc| {
            let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
            app.wait_loaded();
            app.dialogs_off();
            app
        });
        h.run_steps(3);
        let ctx = h.ctx.clone();
        h.state_mut().set_theme(&ctx, theme);
        h.run_steps(6);
        h.render().unwrap().save(out.join(format!("p2-app-{theme}.png"))).unwrap();
        if theme == "dark" || theme == "light" {
            let mut home = Harness::builder().with_size([1440.0, 900.0]).wgpu().build_eframe(|cc| {
                let mut app = BrickMotionApp::new_for_test_cc(cc, None);
                app.dialogs_off();
                app.recents.add(HELI.into());
                app
            });
            home.run_steps(3);
            let ctx = home.ctx.clone();
            home.state_mut().set_theme(&ctx, theme);
            // Wait for the sample pictures (drawn on a worker, one after another).
            let want = brickmotion::chrome::home::samples().len();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
            while home.state().home_thumbnails_ready() < want && std::time::Instant::now() < deadline {
                home.run_steps(1);
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            home.run_steps(4);
            home.render().unwrap().save(out.join(format!("p2-home-{theme}.png"))).unwrap();
            run(h.state_mut(), "app.settings");
            h.run_steps(3);
            h.get_by_role_and_label(Role::Tab, "Appearance").click();
            h.run_steps(4);
            h.render().unwrap().save(out.join(format!("p2-settings-appearance-{theme}.png"))).unwrap();
            h.get_by_role_and_label(Role::Tab, "Building").click();
            h.run_steps(4);
            h.render().unwrap().save(out.join(format!("p2-settings-building-{theme}.png"))).unwrap();
            h.key_press(egui::Key::Escape);
            h.run_steps(3);
            run(h.state_mut(), "app.about");
            h.run_steps(4);
            h.render().unwrap().save(out.join(format!("p2-about-{theme}.png"))).unwrap();
        }
    }
}

#[test]
fn home_shows_with_no_document_and_new_project_leaves_it() {
    let mut h = empty_app();
    assert!(h.state().shows_home());
    for label in ["Start something", "Recent"] {
        assert!(h.query_by_label(label).is_some(), "{label}");
    }
    // The title bar has its own Open… button, so look for at least one of each.
    for card in ["New Project", "Open…", "Import Parts List…"] {
        assert!(h.query_all_by_role_and_label(Role::Button, card).count() >= 1, "{card}");
    }
    assert!(h.query_by_label("0 pieces").is_none(), "no piece count on Home");
    assert!(h.query_by_label("Files you open or save appear here.").is_some(), "empty recents");
    h.get_by_role_and_label(Role::Button, "New Project").click();
    h.run_steps(4);
    assert!(h.state().has_document, "New Project opens an empty model");
    assert!(!h.state().shows_home());
}

#[test]
fn home_lists_the_samples_that_exist() {
    let found = brickmotion::chrome::home::samples();
    assert!(found.iter().any(|(t, p)| *t == "Helicopter" && p.is_file()), "{found:?}");
    assert!(found.iter().all(|(_, p)| p.is_file()), "a folder sample opens a model file");
    let h = empty_app();
    assert!(h.query_by_role_and_label(Role::Button, "Helicopter").is_some());
}

#[test]
fn home_recent_row_opens_the_file() {
    const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, None);
        app.dialogs_off();
        app.recents.add(std::path::PathBuf::from(HELI));
        app
    });
    h.run_steps(3);
    // The Recent row and the sample card both say "helicopter"; the row shows the file name.
    h.get_by_role_and_label(Role::Button, "helicopter.mpd").click();
    h.run_steps(3);
    h.state_mut().wait_loaded();
    h.run_steps(3);
    assert!(h.state().has_document, "the recent file opened");
}
