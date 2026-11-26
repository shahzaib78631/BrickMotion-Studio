// File exports (LDraw, Plan, a submodel's project or LDraw) and Copy Viewport Image.
use std::path::{Path, PathBuf};

use brickmotion::{BrickMotionApp, FileExport, run};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");
const SUB: &str = "helicopter - underside 1.ldr";

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

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bm-export-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn finish(h: &mut Harness<'static, BrickMotionApp>, path: &Path) {
    h.state_mut().finish_export(path.to_path_buf());
    h.run_steps(2);
}

#[test]
fn export_ldraw_writes_mpd() {
    let mut h = app();
    assert!(run(h.state_mut(), "file.export_ldraw"));
    let req = h.state().dialog_requests.last().cloned().expect("a save panel");
    assert_eq!(req.kind, "export");
    assert_eq!(req.suggested.as_deref(), Some("helicopter.mpd"));
    let file = temp("ldraw").join("out.mpd");
    finish(&mut h, &file);
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.starts_with("0 FILE"));
    assert_eq!(text, h.state().session().mpd_bytes());
}

#[test]
fn export_plan_writes_json() {
    let mut h = app();
    assert!(run(h.state_mut(), "file.export_plan"));
    let req = h.state().dialog_requests.last().cloned().expect("a save panel");
    assert!(req.suggested.as_deref().is_some_and(|s| s.ends_with(".plan.json")), "{req:?}");
    let file = temp("plan").join("out.plan.json");
    finish(&mut h, &file);
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("\"brickmotion-plan\""));
}

#[test]
fn row_menu_exports_submodel_project() {
    let mut h = app();
    let row = h.get_by_label("helicopter - underside 1.ldr").rect();
    h.event(egui::Event::PointerMoved(row.center()));
    h.step();
    h.event(egui::Event::PointerButton { pos: row.center(), button: egui::PointerButton::Secondary, pressed: true, modifiers: egui::Modifiers::NONE });
    h.step();
    h.event(egui::Event::PointerButton { pos: row.center(), button: egui::PointerButton::Secondary, pressed: false, modifiers: egui::Modifiers::NONE });
    h.run_steps(3);
    assert!(h.query_by_label("Export LDraw…").is_some(), "the row menu offers LDraw");
    h.get_by_label("Export Project…").click();
    h.run_steps(3);
    let req = h.state().dialog_requests.last().cloned().expect("a save panel");
    assert_eq!(req.suggested.as_deref(), Some("helicopter - underside 1.brickmotion"));
    let file = temp("sub").join("sub.brickmotion");
    finish(&mut h, &file);
    let mut s = bm::Session::new();
    s.open(&file).expect("the submodel project opens");
    assert_eq!(s.piece_count(), 32);
}

#[test]
fn export_refused_after_document_changed() {
    let mut h = app();
    h.state_mut().export_bytes(FileExport::SubmodelLdraw, Some(SUB));
    let generation = h.state().session().generation();
    assert!(run(h.state_mut(), "file.new"));
    h.run_steps(3);
    assert_ne!(h.state().session().generation(), generation);
    let file = temp("changed").join("sub.mpd");
    finish(&mut h, &file);
    assert!(!file.exists(), "nothing is written");
    let notice = h.state().notices.last().expect("an error notice");
    assert_eq!(notice.detail(), "The submodel changed before the export finished.");
}

#[test]
fn copy_viewport_puts_png_on_clipboard() {
    if !bm::metal_available() {
        return;
    }
    let mut h = app();
    h.run_steps(10);
    assert!(run(h.state_mut(), "edit.copy_viewport"));
    let (w, hgt, rgba) = h.state().clipboard_image.clone().expect("an image on the clipboard");
    assert!(w > 100 && hgt > 100);
    assert_eq!(rgba.len(), w * hgt * 4);
}
