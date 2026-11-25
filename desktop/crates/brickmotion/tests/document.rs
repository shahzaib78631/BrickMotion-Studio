// The document lifecycle: New, Save, Save As, the "Save changes?" guard, and recents.
use std::path::{Path, PathBuf};

use brickmotion::commands::run;
use brickmotion::{Answer, BrickMotionApp, DialogRequest, Notice};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("bm-doc-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn opened(path: &Path) -> BrickMotionApp {
    let mut app = BrickMotionApp::new_for_test(Some(path.to_path_buf()));
    app.wait_loaded();
    app.dialogs_off();
    app
}

fn delete_first(app: &mut BrickMotionApp) {
    app.doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(run(app, "edit.delete"));
}

fn errors(app: &BrickMotionApp) -> Vec<String> {
    app.notices().iter().filter(|n| matches!(n, Notice::Error { .. })).map(|n| format!("{}: {}", n.title(), n.detail())).collect()
}

#[test]
fn new_document_is_untitled_and_clean() {
    let mut app = BrickMotionApp::new_for_test(None);
    assert!(run(&mut app, "file.new"));
    assert_eq!(app.title(), "Untitled");
    assert!(!app.session().dirty());
    assert!(app.has_document);
    assert_eq!(app.piece_count(), 0);
}

#[test]
fn empty_project_round_trips() {
    let d = tmp("empty");
    let mut app = BrickMotionApp::new_for_test(None);
    run(&mut app, "file.new");
    app.save_as_path(d.join("e.brickmotion"));
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    app.open(d.join("e.brickmotion"));
    app.wait_loaded();
    assert!(errors(&app).is_empty(), "{:?}", errors(&app));
    assert_eq!(app.title(), "e");
}

#[test]
fn save_never_overwrites_imported_source() {
    let d = tmp("imported");
    let src = d.join("helicopter.mpd");
    std::fs::copy(HELI, &src).unwrap();
    let before = std::fs::read(&src).unwrap();
    let mut app = opened(&src);
    delete_first(&mut app);
    assert!(run(&mut app, "file.save"));
    assert_eq!(
        app.dialog_requests.last(),
        Some(&DialogRequest { kind: "save_as", suggested: Some("helicopter.brickmotion".into()) })
    );
    assert_eq!(std::fs::read(&src).unwrap(), before);
    assert!(app.session().dirty());
}

#[test]
fn save_clears_dirty_and_writes_project() {
    let d = tmp("save");
    let mut app = opened(Path::new(HELI));
    let n = app.piece_count();
    delete_first(&mut app);
    let out = d.join("x.brickmotion");
    app.save_as_path(out.clone());
    assert!(!app.session().dirty());
    assert_eq!(app.title(), "x");
    assert_eq!(std::fs::read(&out).unwrap().first(), Some(&b'{'));
    assert_eq!(app.recents.0.first(), Some(&out));
    // Saving again goes in place, with no dialog.
    delete_first(&mut app);
    let asked = app.dialog_requests.len();
    assert!(run(&mut app, "file.save"));
    assert_eq!(app.dialog_requests.len(), asked);
    assert!(!app.session().dirty());
    let mut back = opened(&out);
    back.wait_loaded();
    assert_eq!(back.piece_count(), n - 2);
}

#[test]
fn failed_save_keeps_dirty_and_no_partial_file() {
    use std::os::unix::fs::PermissionsExt;
    let d = tmp("readonly");
    let ro = d.join("ro");
    std::fs::create_dir_all(&ro).unwrap();
    std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).unwrap();
    let mut app = opened(Path::new(HELI));
    delete_first(&mut app);
    app.save_as_path(ro.join("x.brickmotion"));
    let left: Vec<_> = std::fs::read_dir(&ro).unwrap().map(|e| e.unwrap().file_name()).collect();
    std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(app.notices().last(), Some(Notice::Error { title, .. }) if title == "Couldn't save x.brickmotion"));
    assert!(app.session().dirty());
    assert!(left.is_empty(), "left {left:?}");
}

#[test]
fn dirty_document_asks_before_replace() {
    let d = tmp("replace");
    let other = d.join("other.mpd");
    std::fs::copy(HELI, &other).unwrap();
    let mut app = opened(Path::new(HELI));
    delete_first(&mut app);
    let n = app.piece_count();
    app.open(other.clone());
    assert!(app.confirm.is_some());
    assert!(app.opening().is_none(), "no load starts before the answer");
    app.answer_confirm(Answer::Cancel);
    assert!(app.confirm.is_none());
    assert!(app.opening().is_none());
    assert_eq!(app.piece_count(), n);
    assert!(app.session().dirty());

    app.open(other.clone());
    app.answer_confirm(Answer::DontSave);
    app.wait_loaded();
    assert!(app.confirm.is_none(), "the load the person agreed to arrives without asking again");
    assert_eq!(app.title(), "other");
    assert!(!app.session().dirty());
}

#[test]
fn new_on_dirty_asks() {
    let mut app = opened(Path::new(HELI));
    delete_first(&mut app);
    assert!(run(&mut app, "file.new"));
    assert!(app.confirm.is_some());
    app.answer_confirm(Answer::DontSave);
    assert_eq!(app.title(), "Untitled");
}

#[test]
fn quit_with_changes_asks() {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
        app.wait_loaded();
        app.dialogs_off();
        app
    });
    h.run_steps(2);
    delete_first(h.state_mut());
    h.run_steps(2);
    // The close a window gets from its red button or ⌘Q (kittest does not turn
    // ViewportCommand::Close into one).
    h.input_mut().viewports.entry(egui::ViewportId::ROOT).or_default().events.push(egui::ViewportEvent::Close);
    h.run_steps(3);
    assert!(h.query_by_label("Save changes to helicopter?").is_some(), "the confirm dialog shows");
    assert!(h.state().confirm.is_some());
    h.get_by_label("Cancel").click();
    h.run_steps(2);
    assert!(h.state().confirm.is_none());
    assert!(h.state().session().dirty());
}

#[test]
fn app_autosaves_backups_and_warns_once() {
    let mut app = opened(Path::new(HELI));
    app.prefs.autosave_seconds = 0;
    delete_first(&mut app);
    let t0 = std::time::Instant::now();
    app.autosave(t0);
    app.autosave(t0 + std::time::Duration::from_secs(1));
    app.wait_autosaved();
    let dir = app.support.backups().join("helicopter");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    assert!(app.session().dirty(), "an imported document stays edited");

    // A backup folder that cannot be written warns once, however often it fails.
    std::fs::remove_dir_all(&dir).unwrap();
    std::fs::write(&dir, b"not a folder").unwrap();
    for i in 2..5u64 {
        delete_first(&mut app);
        app.autosave(t0 + std::time::Duration::from_secs(i));
        app.wait_autosaved();
    }
    let warnings = app.notices().iter().filter(|n| n.title() == "Couldn't autosave").count();
    assert_eq!(warnings, 1);
}

#[test]
fn relative_open_is_remembered_absolute() {
    // Tests run in the crate folder; this is HELI written relative to it.
    let rel = PathBuf::from("../../../samples/helicopter/helicopter.mpd");
    assert!(rel.exists());
    let mut app = BrickMotionApp::new_for_test(None);
    app.open(rel);
    app.wait_loaded();
    assert!(app.state.path.as_ref().is_some_and(|p| p.is_absolute()), "{:?}", app.state.path);
    assert!(app.recents.0[0].is_absolute(), "{:?}", app.recents.0);
}

#[test]
fn load_finishing_after_an_edit_asks() {
    let d = tmp("adopt");
    let other = d.join("other.mpd");
    std::fs::copy(HELI, &other).unwrap();
    let mut app = opened(Path::new(HELI));
    app.open(other);
    // Edited while the other file loads.
    delete_first(&mut app);
    let n = app.piece_count();
    app.wait_loaded();
    assert!(matches!(app.confirm, Some(brickmotion::Pending::Adopt(_))));
    assert_eq!(app.piece_count(), n, "the edited document stays until the answer");
    app.answer_confirm(Answer::DontSave);
    assert_eq!(app.title(), "other");
}

#[test]
fn commands_wait_while_asking() {
    let mut app = opened(Path::new(HELI));
    delete_first(&mut app);
    let n = app.piece_count();
    assert!(run(&mut app, "file.new"));
    assert!(app.confirm.is_some());
    app.doc.session().select(&[0], bm::SelectMode::Replace);
    assert!(!run(&mut app, "edit.delete"), "nothing runs behind Save changes?");
    assert!(!run(&mut app, "edit.select_none"));
    assert_eq!(app.piece_count(), n);
    assert_eq!(app.doc.session().selection().len(), 1);
}

fn close_window(h: &mut Harness<'_, BrickMotionApp>) {
    h.input_mut().viewports.entry(egui::ViewportId::ROOT).or_default().events.push(egui::ViewportEvent::Close);
}

fn dirty_harness() -> Harness<'static, BrickMotionApp> {
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
        app.wait_loaded();
        app.dialogs_off();
        app
    });
    h.run_steps(2);
    delete_first(h.state_mut());
    h.run_steps(2);
    h
}

#[test]
fn closing_while_asking_about_an_open_quits_after_the_answer() {
    let mut h = dirty_harness();
    h.state_mut().open(HELI.into());
    assert!(matches!(h.state().confirm, Some(brickmotion::Pending::Open(_))));
    close_window(&mut h);
    h.run_steps(2);
    assert!(h.state().confirm.is_some(), "still asking");
    h.state_mut().answer_confirm(Answer::DontSave);
    assert!(h.state().quitting(), "the close was remembered");
}

#[test]
fn cancel_forgets_the_close() {
    let mut h = dirty_harness();
    h.state_mut().open(HELI.into());
    close_window(&mut h);
    h.run_steps(2);
    h.state_mut().answer_confirm(Answer::Cancel);
    assert!(!h.state().quitting());
    // A later Open answered with Don't Save does not quit.
    h.state_mut().open(HELI.into());
    h.state_mut().answer_confirm(Answer::DontSave);
    assert!(!h.state().quitting());
}

#[test]
fn agreement_to_replace_belongs_to_one_document() {
    let mut a = bm::Session::new();
    a.new_blank().unwrap();
    let mut b = bm::Session::new();
    b.new_blank().unwrap();
    assert_eq!(a.version(), b.version(), "same version, different documents");
    let ok = brickmotion::ReplaceOk::of(&a);
    assert!(ok.covers(&a));
    assert!(!ok.covers(&b));
}

#[test]
fn app_autosave_writes_off_the_ui_thread_and_keeps_newer_edits() {
    let d = tmp("bg-autosave");
    let project = d.join("p.brickmotion");
    let mut app = opened(Path::new(HELI));
    app.save_as_path(project.clone());
    app.prefs.autosave_seconds = 0;
    delete_first(&mut app);
    let t0 = std::time::Instant::now();
    app.autosave(t0);
    app.autosave(t0 + std::time::Duration::from_secs(1));
    delete_first(&mut app); // edited while the autosave writes
    app.wait_autosaved();
    assert!(app.session().dirty(), "the second edit is not saved yet");
    let n = app.piece_count();
    let mut back = bm::Session::new();
    back.open(&project).unwrap();
    assert_eq!(back.piece_count(), n + 1, "the file has the first edit only");
}

#[test]
fn save_during_an_autosave_keeps_the_newest() {
    let d = tmp("save-race");
    let project = d.join("p.brickmotion");
    let mut app = opened(Path::new(HELI));
    app.save_as_path(project.clone());
    app.prefs.autosave_seconds = 0;
    delete_first(&mut app);
    let t0 = std::time::Instant::now();
    app.autosave(t0);
    app.autosave(t0 + std::time::Duration::from_secs(1)); // writes the first edit
    delete_first(&mut app);
    app.save(); // must not be overwritten by the older autosave
    std::thread::sleep(std::time::Duration::from_millis(200));
    let mut back = bm::Session::new();
    back.open(&project).unwrap();
    assert_eq!(back.piece_count(), app.piece_count());
    assert!(!app.session().dirty());
}
