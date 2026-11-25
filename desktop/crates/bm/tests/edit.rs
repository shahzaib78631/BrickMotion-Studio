// Safe wrappers for edits, camera and arrow axes.
use std::path::Path;

use bm::{Arrow, STUD, Vec3, arrow_axis};

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn heli() -> bm::Session {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    s
}

#[test]
fn translate_then_continuing_is_one_undo() {
    let s = heli();
    let before = s.copy(&[0]);
    s.end_gesture();
    let c1 = s.translate(&[0], Vec3::new(STUD, 0.0, 0.0), true);
    assert_eq!(c1.refused, None);
    let c2 = s.translate(&[0], Vec3::new(STUD, 0.0, 0.0), true);
    assert_eq!(c2.refused, None);
    s.end_gesture();
    assert_ne!(s.copy(&[0]), before);
    s.undo();
    assert!(!s.can_undo());
    assert_eq!(s.copy(&[0]), before);
}

#[test]
fn recolor_changes_the_snapshot_colour() {
    let s = heli();
    s.select(&[0], bm::SelectMode::Replace);
    let c = s.recolor(&[0], 4);
    assert_eq!(c.refused, None);
    assert_eq!(s.snapshot().described[0].color, 4);
}

#[test]
fn copy_paste_round_trip() {
    let s = heli();
    let n = s.piece_count();
    let text = s.copy(&[0, 1]);
    assert!(text.contains("1 "));
    let c = s.paste(&text, Vec3::ZERO);
    assert_eq!(c.refused, None);
    assert_eq!(s.piece_count(), n + 2);
}

#[test]
fn arrow_axis_lies_on_the_floor() {
    if !bm::metal_available() {
        return;
    }
    let mut doc = bm::Document::new(heli());
    let v = doc.viewport().expect("metal");
    v.resize(320, 240, 1.0);
    v.fit_all();
    let cam = v.camera();
    assert!(cam.distance > 0.0);
    let up = arrow_axis(&cam, Arrow::Up);
    assert_eq!(up.y, 0.0);
    assert!((up.x.hypot(up.z) - 1.0).abs() < 1e-9);
}
