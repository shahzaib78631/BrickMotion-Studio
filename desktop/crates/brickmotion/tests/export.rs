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

// ---- Export Movie (Task 8) ----

use bm::export::{MovieCamera, MovieQuality, MovieSource, VideoTarget, movie_arguments, movie_summary};
use brickmotion::chrome::export_movie::{self, CameraPick};
use brickmotion::render_queue::{Helpers, RenderQueue};

/// Swaps the app's queue for one that runs `body` as both helpers.
fn script_queue(h: &mut Harness<'static, BrickMotionApp>, dir: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("helper.sh");
    std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    h.state_mut().queue = RenderQueue::load(dir.join("queue.json"), Helpers { still: script.clone(), movie: script });
}

fn settle_queue(h: &mut Harness<'static, BrickMotionApp>) {
    let start = std::time::Instant::now();
    while h.state_mut().queue.poll() {
        assert!(start.elapsed() < std::time::Duration::from_secs(30), "{:?}", h.state().queue.jobs());
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    h.run_steps(2);
}

/// The helper writes its options (everything after `--out <file>`), one a line.
const ARGS: &str = "out=\"$4\"\nshift 4\nprintf '%s\\n' \"$@\" > \"$out\"";

fn click_label(h: &mut Harness<'static, BrickMotionApp>, label: &str) {
    h.get_by_label(label).scroll_to_me();
    h.run_steps(20);
    h.get_by_label(label).click();
    h.run_steps(3);
}

#[test]
fn export_movie_queues_build_job() {
    let mut h = app();
    let dir = temp("movie-build");
    script_queue(&mut h, &dir, ARGS);
    assert!(run(h.state_mut(), "output.export_movie"));
    h.run_steps(3);
    assert!(h.query_by_label("Export Video panel").is_some());
    {
        let m = &mut h.state_mut().movie;
        m.source = MovieSource::Build;
        m.quality = MovieQuality::High;
        m.fps = 24;
    }
    h.run_steps(2);
    let choice = export_movie::choice(h.state(), &[]);
    assert_eq!(choice.fps, 24);
    click_label(&mut h, "Continue…");
    let req = h.state().dialog_requests.last().cloned().expect("a save panel");
    assert_eq!(req.kind, "movie");
    assert_eq!(req.suggested.as_deref(), Some("helicopter – Build.mp4"));
    let dest = dir.join("film.mp4");
    h.state_mut().finish_movie(dest.clone());
    h.run_steps(2);
    settle_queue(&mut h);
    let lines: Vec<String> = std::fs::read_to_string(&dest).unwrap().lines().map(str::to_owned).collect();
    assert_eq!(lines, movie_arguments(&choice));
    assert_eq!(h.state().queue.jobs()[0].summary, movie_summary(&choice));
    assert!(h.query_by_label("Video Exported").is_some(), "the panel follows its job");
}

#[test]
fn camera_choice_is_remembered() {
    if !bm::metal_available() {
        return;
    }
    let mut h = app();
    h.run_steps(5);
    let dir = temp("movie-camera");
    script_queue(&mut h, &dir, ARGS);
    assert!(run(h.state_mut(), "output.export_movie"));
    h.run_steps(3);
    assert!(h.state().movie.angles.present, "the viewport has an angle");
    h.state_mut().movie.camera = CameraPick::Viewport;
    h.state_mut().finish_movie(dir.join("a.mp4"));
    settle_queue(&mut h);
    assert_eq!(h.state().session().export_camera(), "buildView");
    // Opened again, the panel starts on the remembered camera.
    h.state_mut().movie.open = false;
    assert!(run(h.state_mut(), "output.export_movie"));
    h.run_steps(3);
    assert_eq!(h.state().movie.camera, CameraPick::Viewport);
}

#[test]
fn track_disabled_for_batch() {
    if !bm::metal_available() {
        return;
    }
    let mut h = app();
    h.run_steps(5);
    let view = h.state_mut().doc.viewport().unwrap().capture_scene_camera();
    let c = h.state_mut().doc.session().add_camera_key(bm::camera::CameraClock::Build, 0.0, &view, 30.0, 10.0);
    assert!(c.refused.is_none());
    assert!(run(h.state_mut(), "output.export_movie"));
    h.run_steps(3);
    h.state_mut().movie.source = MovieSource::Build;
    assert!(export_movie::allows_track(h.state()), "one video of a keyed build may use its track");
    h.state_mut().movie.open = false;
    assert!(run(h.state_mut(), "file.export_submodels"));
    h.run_steps(3);
    assert!(!h.state().movie.targets.is_empty(), "submodel videos are a batch");
    h.state_mut().movie.camera = CameraPick::Track;
    assert!(!export_movie::allows_track(h.state()));
    assert_eq!(export_movie::choice(h.state(), &[]).camera, MovieCamera::Director);
}

#[test]
fn batch_names_never_replace_files() {
    let mut h = app();
    let dir = temp("movie-batch");
    script_queue(&mut h, &dir, "printf x > \"$4\"");
    std::fs::write(dir.join("Wing L – Build.mp4"), "keep").unwrap();
    assert!(run(h.state_mut(), "file.export_submodels"));
    h.run_steps(3);
    h.state_mut().movie.source = MovieSource::Build;
    h.state_mut().movie.targets = vec![
        VideoTarget { title: "Wing/L".into(), path: vec![SUB.into()] },
        VideoTarget { title: "Wing:L".into(), path: vec![SUB.into()] },
    ];
    h.run_steps(2);
    click_label(&mut h, "Choose Folder…");
    assert_eq!(h.state().dialog_requests.last().map(|r| r.kind), Some("movie_folder"));
    h.state_mut().finish_movie(dir.clone());
    settle_queue(&mut h);
    let mut names: Vec<String> =
        h.state().queue.jobs().iter().map(|j| j.destination.file_name().unwrap().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["Wing L – Build 2.mp4", "Wing L – Build 3.mp4"]);
    assert_eq!(std::fs::read_to_string(dir.join("Wing L – Build.mp4")).unwrap(), "keep");
    assert!(h.query_by_label("Render Queue panel").is_some(), "a batch shows the queue");
}

#[test]
fn queued_job_ignores_later_edits() {
    let mut h = app();
    let dir = temp("movie-snapshot");
    script_queue(&mut h, &dir, "sleep 0.3\ncp \"$2\" \"$4\"");
    let pieces = h.state().session().piece_count();
    assert!(run(h.state_mut(), "output.export_movie"));
    h.run_steps(3);
    let dest = dir.join("film.mp4");
    h.state_mut().finish_movie(dest.clone());
    assert!(run(h.state_mut(), "edit.select_all"));
    assert!(run(h.state_mut(), "edit.delete"));
    h.run_steps(2);
    assert_ne!(h.state().session().piece_count(), pieces, "the document changed");
    settle_queue(&mut h);
    let copy = dir.join("queued.brickmotion");
    std::fs::rename(&dest, &copy).unwrap();
    let mut s = bm::Session::new();
    s.open(&copy).expect("the queued project opens");
    assert_eq!(s.piece_count(), pieces, "the job has the project as it was when queued");
}

#[test]
fn include_in_exports_switch_sets_default() {
    let mut h = app();
    let was = h.state().session().snap_mix().enabled;
    h.state_mut().properties_page = brickmotion::chrome::properties::Page::SnapSound;
    h.run_steps(3);
    let r = h.get_by_role_and_label(egui::accesskit::Role::Switch, "Include in exports");
    r.scroll_to_me();
    h.run_steps(20);
    h.get_by_role_and_label(egui::accesskit::Role::Switch, "Include in exports").click();
    h.run_steps(3);
    assert_eq!(h.state().session().snap_mix().enabled, !was);
    h.state_mut().properties_page = brickmotion::chrome::properties::Page::Inspector;
    assert!(run(h.state_mut(), "output.export_movie"));
    h.run_steps(3);
    assert_eq!(h.state().movie.include_snap_audio, !was);
}

#[test]
fn logo_copy_survives_source_delete() {
    let mut h = app();
    let dir = temp("logo");
    let src = dir.join("mark.png");
    image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 0, 255])).save(&src).unwrap();
    let copy = h.state_mut().choose_logo(&src).expect("the logo is copied");
    std::fs::remove_file(&src).unwrap();
    assert!(copy.exists());
    assert!(copy.starts_with(h.state().support.dir.join("Video Logos")));
    assert!(copy.file_name().unwrap().to_string_lossy().starts_with("Logo-"));
    assert!(h.state().prefs.video_logo_enabled);
    let choice = export_movie::choice(h.state(), &[]);
    assert_eq!(choice.logo, copy.to_string_lossy());
    std::fs::write(dir.join("bad.png"), "not an image").unwrap();
    assert_eq!(
        h.state_mut().choose_logo(&dir.join("bad.png")),
        Err("The image could not be read. Choose a PNG, JPEG, HEIC or TIFF file.".to_owned())
    );
    assert_eq!(brickmotion::logo::current(&h.state().support, &h.state().prefs), Some(copy), "a failed choice keeps the logo");
}

#[test]
fn row_menu_exports_submodel_video() {
    let mut h = app();
    let row = h.get_by_label(SUB).rect();
    h.event(egui::Event::PointerMoved(row.center()));
    h.step();
    h.event(egui::Event::PointerButton { pos: row.center(), button: egui::PointerButton::Secondary, pressed: true, modifiers: egui::Modifiers::NONE });
    h.step();
    h.event(egui::Event::PointerButton { pos: row.center(), button: egui::PointerButton::Secondary, pressed: false, modifiers: egui::Modifiers::NONE });
    h.run_steps(3);
    h.get_by_label("Export Submodel Video…").click();
    h.run_steps(3);
    let m = &h.state().movie;
    assert!(m.open);
    assert_eq!(m.targets.len(), 1);
    assert_eq!(m.targets[0].title, "helicopter - underside 1");
    assert_eq!(m.targets[0].path.last().map(String::as_str), Some(SUB));
}

#[test]
#[ignore = "writes a screenshot for review"]
fn movie_screenshot() {
    let mut h = app();
    assert!(run(h.state_mut(), "output.export_movie"));
    h.run_steps(10);
    let image = h.render().expect("render");
    image.save(std::env::var("MOVIE_SHOT").unwrap_or("/tmp/movie.png".into())).unwrap();
}

// ---- Export Still (Task 9) ----

use bm::export::{still_arguments, still_summary};
use brickmotion::chrome::export_still::{self, StillCamera};
use brickmotion::render_queue::{JobStatus, Operation};

#[test]
fn export_still_queues_bmexport() {
    let mut h = app();
    let dir = temp("still");
    script_queue(&mut h, &dir, "out=\"$4\"\nop=\"$1\"\nshift 4\n{ echo \"$op\"; printf '%s\\n' \"$@\"; } > \"$out\"");
    assert!(run(h.state_mut(), "output.export_still"));
    h.run_steps(3);
    assert!(h.query_by_label("Export Still panel").is_some());
    h.state_mut().still.quality = bm::export::StillQuality::Draft;
    h.run_steps(2);
    click_label(&mut h, "Continue…");
    let req = h.state().dialog_requests.last().cloned().expect("a save panel");
    assert_eq!(req.kind, "still");
    assert_eq!(req.suggested.as_deref(), Some("helicopter – Landscape.png"));
    let choice = export_still::choice(h.state());
    let dest = dir.join("cover.png");
    h.state_mut().finish_still(dest.clone());
    h.run_steps(3);
    assert!(h.query_by_label("Render Queue panel").is_some(), "queueing shows the queue");
    assert!(h.query_by_label("Export Still panel").is_none());
    settle_queue(&mut h);
    let lines: Vec<String> = std::fs::read_to_string(&dest).unwrap().lines().map(str::to_owned).collect();
    assert_eq!(lines[0], "still", "bmexport's still command");
    assert_eq!(lines[1..], still_arguments(&choice, &h.state().session().render_look())[..]);
    assert_eq!(h.state().queue.jobs()[0].summary, still_summary(&choice, false));
    let _ = Operation::Still;
}

#[test]
fn still_logo_stamps_before_move() {
    let mut h = app();
    let dir = temp("still-logo");
    let white = dir.join("white.png");
    image::RgbaImage::from_pixel(640, 360, image::Rgba([255, 255, 255, 255])).save(&white).unwrap();
    let mark = dir.join("mark.png");
    image::RgbaImage::from_pixel(64, 64, image::Rgba([255, 0, 0, 255])).save(&mark).unwrap();
    h.state_mut().choose_logo(&mark).unwrap();
    script_queue(&mut h, &dir, &format!("cp '{}' \"$4\"", white.display()));
    assert!(run(h.state_mut(), "output.export_still"));
    h.run_steps(3);
    assert!(h.state().still.show_logo, "a chosen logo starts on");
    let dest = dir.join("cover.png");
    h.state_mut().finish_still(dest.clone());
    settle_queue(&mut h);
    assert_eq!(h.state().queue.jobs()[0].status, JobStatus::Complete);
    assert!(h.state().queue.jobs()[0].summary.ends_with(" · Logo"));
    let out = image::open(&dest).unwrap().to_rgba8();
    assert_eq!(out.dimensions(), (640, 360));
    assert!(out.pixels().any(|p| p[0] > 200 && p[1] < 80 && p[2] < 80), "the logo is drawn over the still");
}

#[test]
fn automatic_framing_drops_angles() {
    if !bm::metal_available() {
        return;
    }
    let mut h = app();
    h.run_steps(5);
    assert!(run(h.state_mut(), "output.export_still"));
    h.run_steps(3);
    assert_eq!(h.state().still.camera, StillCamera::Viewport, "the viewport's angle is the default");
    let look = h.state().session().render_look();
    assert!(still_arguments(&export_still::choice(h.state()), &look).iter().any(|a| a == "--azimuth"));
    h.state_mut().still.camera = StillCamera::Automatic;
    let args = still_arguments(&export_still::choice(h.state()), &look);
    assert!(!args.iter().any(|a| a == "--azimuth" || a == "--elevation" || a == "--fov"), "{args:?}");
}

/// The real still helper: `bmexport still` path traces a Draft picture.
#[test]
fn still_helper_renders_a_png() {
    if std::env::var("BM_SLOW").as_deref() != Ok("1") {
        return;
    }
    let dir = temp("still-real");
    let helpers = Helpers::locate();
    assert!(helpers.still.exists(), "build bmexport first: {}", helpers.still.display());
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).expect("the helicopter opens");
    let choice = bm::export::StillChoice { quality: bm::export::StillQuality::Draft, ..Default::default() };
    let mut args = still_arguments(&choice, &s.render_look());
    let at = args.iter().position(|a| a == "--size").unwrap();
    args[at + 1] = "192x108".into();
    let mut q = RenderQueue::load(dir.join("queue.json"), helpers);
    let dest = dir.join("still.png");
    let library = bm::ldraw_directory().unwrap_or_default();
    q.enqueue(s.project_bytes(), Operation::Still, args, &library, dest.clone(), "Still".into(), None).unwrap();
    let start = std::time::Instant::now();
    while q.poll() {
        assert!(start.elapsed() < std::time::Duration::from_secs(300));
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert_eq!(q.jobs()[0].status, JobStatus::Complete);
    assert_eq!(image::open(&dest).unwrap().to_rgba8().dimensions(), (192, 108));
}
