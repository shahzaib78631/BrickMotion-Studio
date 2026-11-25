// Opening documents off the UI thread, failures, and the headless snapshot.
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use brickmotion::{BrickMotionApp, Loader, Notice, snapshot};

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn wait(l: &mut Loader) -> Result<(bm::Document, bm::OpenInfo), bm::OpenError> {
    let t0 = Instant::now();
    loop {
        if let Some(r) = l.poll() {
            break r;
        }
        assert!(t0.elapsed() < Duration::from_secs(60), "open never finished");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn open_runs_off_ui_thread() {
    let mut l = Loader::default();
    let ui = std::thread::current().id();
    l.start(HELI.into());
    assert_eq!(l.loading(), Some(Path::new(HELI)));
    let t0 = Instant::now();
    assert!(l.poll().is_none() || t0.elapsed() < Duration::from_millis(50), "poll blocked");
    let (d, _) = wait(&mut l).unwrap();
    assert!(d.session().piece_count() > 100);
    assert_eq!(std::thread::current().id(), ui);
    assert_eq!(l.loading(), None);
}

#[test]
fn newer_request_wins() {
    let mut l = Loader::default();
    l.start(PathBuf::from("/no/such/first.mpd"));
    l.start(HELI.into());
    let (d, _) = wait(&mut l).expect("the helicopter, not the missing file");
    assert!(d.session().piece_count() > 100);
    assert!(l.poll().is_none(), "the replaced request must not report later");
}

#[test]
fn open_failure_keeps_previous_document() {
    let mut app = BrickMotionApp::new_for_test(Some(HELI.into()));
    app.wait_loaded();
    let n = app.session().piece_count();
    assert!(n > 100);
    app.open(PathBuf::from("/no/such/file.mpd"));
    app.wait_loaded();
    assert_eq!(app.session().piece_count(), n);
    assert!(matches!(app.notices().last(), Some(Notice::Error { title, .. }) if title == "Couldn't open file.mpd"));
}

#[test]
fn snapshot_writes_png() {
    let out = std::env::temp_dir().join("bm-m1-snap.png");
    snapshot(Path::new(HELI), &out, (640, 400)).unwrap();
    let img = image::open(&out).unwrap();
    assert_eq!((img.width(), img.height()), (640, 400));
}

#[test]
fn snapshot_reports_bad_file() {
    let out = std::env::temp_dir().join("bm-m1-snap-bad.png");
    let e = snapshot(Path::new("/no/such/thing.mpd"), &out, (64, 64)).unwrap_err();
    assert!(e.starts_with("thing.mpd: "), "{e}");
}

fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bm-open-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

#[test]
fn unsupported_file_is_refused_and_keeps_document() {
    let junk = temp_file("junk.stl", b"solid cube\nfacet normal 0 0 1\nendsolid\n");
    let mut app = BrickMotionApp::new_for_test(Some(HELI.into()));
    app.wait_loaded();
    let n = app.session().piece_count();
    app.open(junk.clone());
    app.wait_loaded();
    assert_eq!(app.session().piece_count(), n);
    assert!(matches!(app.notices().last(), Some(Notice::Error { title, .. }) if title == "Couldn't open junk.stl"));
    assert!(snapshot(&junk, &std::env::temp_dir().join("bm-junk.png"), (64, 64)).is_err());
}

#[test]
fn ldraw_without_pieces_is_refused() {
    let empty = temp_file("empty.ldr", b"0 Nothing here\n");
    let mut l = Loader::default();
    l.start(empty);
    let err = wait(&mut l).err().expect("a file with no pieces is an error");
    assert_eq!(err.message, "No pieces were found in this file.");
}

#[test]
fn warm_start_arrives_drawn_at_the_view_size() {
    let mut l = Loader::default();
    l.start_warm(HELI.into(), Some(brickmotion::Warm { size: (320, 240, 1.0), background: [0.1, 0.1, 0.12] }));
    let (mut d, _) = wait(&mut l).unwrap();
    let mut f = bm::Frame::default();
    d.viewport().expect("metal").read_frame(&mut f);
    assert_eq!((f.width, f.height), (320, 240));
}
