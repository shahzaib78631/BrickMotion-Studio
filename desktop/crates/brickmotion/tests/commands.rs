// The command registry, its single dispatcher, and keyboard shortcuts.
use std::collections::HashSet;

use brickmotion::commands::{Shortcut, When, enabled, find, registry, run, title};
use brickmotion::BrickMotionApp;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn heli_app() -> BrickMotionApp {
    let mut app = BrickMotionApp::new_for_test(Some(HELI.into()));
    app.wait_loaded();
    assert!(app.piece_count() > 100);
    app
}

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

#[test]
fn every_shortcut_parses_and_is_unique() {
    let mut seen = HashSet::new();
    for c in registry() {
        if let Some(k) = c.keys {
            let s = Shortcut::parse(k).unwrap_or_else(|| panic!("{} has unparseable keys {k}", c.id));
            assert!(seen.insert((s.key, s.mods.command, s.mods.shift, s.mods.alt, s.mods.ctrl)), "{} shares {k}", c.id);
            assert_eq!(s.label(), k, "label round-trips for {}", c.id);
        }
    }
    assert!(Shortcut::parse("⇧⌘Z").is_some_and(|s| s.mods.shift && s.mods.command && s.key == egui::Key::Z));
    assert!(Shortcut::parse("⌫").is_some_and(|s| s.key == egui::Key::Backspace));
    assert!(Shortcut::parse("Esc").is_some_and(|s| s.key == egui::Key::Escape));
    assert!(Shortcut::parse("⌘").is_none());
}

#[test]
fn every_enabled_command_runs() {
    let mut app = heli_app();
    app.dialogs_off();
    for c in registry().iter().filter(|c| c.when != When::Soon) {
        // Each command starts from the helicopter with one piece selected.
        let mut fresh = heli_app();
        fresh.dialogs_off();
        fresh.doc.session_mut().select(&[0], bm::SelectMode::Replace);
        let ctx = fresh.ctx();
        if enabled(c, &ctx) {
            assert!(run(&mut fresh, c.id), "{} did not run", c.id);
        }
    }
    assert!(!run(&mut app, "no.such.command"));
}

#[test]
fn undo_title_names_the_edit() {
    let mut app = heli_app();
    let n = app.piece_count();
    app.doc.session_mut().select(&[0], bm::SelectMode::Replace);
    assert!(run(&mut app, "edit.delete"));
    assert_eq!(app.piece_count(), n - 1);
    let undo = find("edit.undo").unwrap();
    assert!(title(undo, &app.ctx()).starts_with("Undo "), "{}", title(undo, &app.ctx()));
    assert!(run(&mut app, "edit.undo"));
    assert_eq!(app.piece_count(), n);
    assert_eq!(title(find("edit.redo").unwrap(), &app.ctx()).split(' ').next(), Some("Redo"));
}

#[test]
fn delete_with_nothing_selected_is_disabled() {
    let mut app = heli_app();
    let n = app.piece_count();
    assert!(!enabled(find("edit.delete").unwrap(), &app.ctx()));
    assert!(!run(&mut app, "edit.delete"));
    assert_eq!(app.piece_count(), n);
}

#[test]
fn single_key_shortcut_ignored_while_typing() {
    let mut h = heli_harness();
    let before = h.state().viewport.queued_total;
    key(&mut h, egui::Key::F, egui::Modifiers::NONE);
    h.run_steps(2);
    assert_eq!(h.state().viewport.queued_total, before + 1, "F fits when nothing has focus");
    // The Browser's filter field takes the key instead.
    h.get_by_label("Filter models and parts").click();
    h.run_steps(2);
    h.get_by_label("Filter models and parts").type_text("f");
    key(&mut h, egui::Key::F, egui::Modifiers::NONE);
    h.run_steps(2);
    assert_eq!(h.state().viewport.queued_total, before + 1, "F fitted while typing");
}

#[test]
fn cmd_z_undoes() {
    let mut h = heli_harness();
    let n = h.state().piece_count();
    h.state_mut().doc.session_mut().select(&[0], bm::SelectMode::Replace);
    h.run_steps(1);
    key(&mut h, egui::Key::Backspace, egui::Modifiers::NONE);
    h.run_steps(2);
    assert_eq!(h.state().piece_count(), n - 1);
    key(&mut h, egui::Key::Z, egui::Modifiers::COMMAND);
    h.run_steps(2);
    assert_eq!(h.state().piece_count(), n);
    key(&mut h, egui::Key::Z, egui::Modifiers::COMMAND | egui::Modifiers::SHIFT);
    h.run_steps(2);
    assert_eq!(h.state().piece_count(), n - 1, "⇧⌘Z redoes, not undoes");
}

// ---- Palette ----

use brickmotion::commands::Ctx;
use brickmotion::palette::rank;

#[test]
fn palette_rank_prefers_prefix() {
    assert_eq!(rank("und", &Ctx::default())[0].id, "edit.undo");
    assert_eq!(rank("SAVE", &Ctx::default())[0].id, "file.save");
}

#[test]
fn palette_rank_subsequence() {
    assert!(rank("svas", &Ctx::default()).iter().any(|c| c.id == "file.save_as"));
    assert!(rank("zzzq", &Ctx::default()).is_empty());
}

#[test]
fn palette_empty_query_lists_all() {
    let all = rank("", &Ctx::default());
    assert_eq!(all.len(), registry().len());
    // Commands not built yet come after the rest.
    let first_soon = all.iter().position(|c| c.when == When::Soon).unwrap();
    assert!(all[first_soon..].iter().all(|c| c.when == When::Soon));
}

#[test]
fn palette_enter_runs() {
    let mut h = heli_harness();
    key(&mut h, egui::Key::K, egui::Modifiers::COMMAND);
    h.run_steps(2);
    assert!(h.state().palette.open);
    h.event(egui::Event::Text("select all".into()));
    h.run_steps(2);
    key(&mut h, egui::Key::Enter, egui::Modifiers::NONE);
    h.run_steps(3);
    assert!(!h.state().palette.open);
    assert_eq!(h.state().session().selection().len(), h.state().piece_count());
}

#[test]
fn palette_disabled_row_says_why() {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| BrickMotionApp::new_for_test_cc(cc, None));
    h.run();
    h.get_by_label("Search commands").click();
    h.run_steps(2);
    assert!(h.state().palette.open);
    h.event(egui::Event::Text("delete".into()));
    h.run_steps(2);
    assert!(h.query_all_by_label("Needs a selection").next().is_some());
    key(&mut h, egui::Key::Escape, egui::Modifiers::NONE);
    h.run_steps(2);
    assert!(!h.state().palette.open);
}
