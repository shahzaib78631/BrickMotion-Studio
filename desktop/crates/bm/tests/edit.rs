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

#[test]
fn gizmo_hit_matches_line_handle() {
    use bm::gizmo::{GizmoKind, GizmoShape, Handle};
    let cam = bm::Camera { yaw: 0.6, pitch: 0.45, distance: 400.0, target: Vec3::ZERO, orthographic: false, vertical_fov: 0.6 };
    let view = bm::Vec2::new(800.0, 600.0);
    let shape = GizmoShape::new(&cam, view, Vec3::ZERO, bm::Mat3::IDENTITY, GizmoKind::Move);
    assert_eq!(shape.lines.len(), 3);
    assert_eq!(shape.rings.len(), 3);
    let (_, tip, h) = shape.lines[0];
    assert_ne!(h, Handle::None);
    assert_eq!(shape.hit(tip, 6.0), h);
    assert_eq!(shape.hit(bm::Vec2::new(-1000.0, -1000.0), 6.0), Handle::None);
}

#[test]
fn rotate_drag_snaps_to_15_degrees() {
    use bm::gizmo::{GizmoKind, GizmoShape, Handle, drag_rotate};
    let cam = bm::Camera { yaw: 0.6, pitch: 0.45, distance: 400.0, target: Vec3::ZERO, orthographic: false, vertical_fov: 0.6 };
    let view = bm::Vec2::new(800.0, 600.0);
    let shape = GizmoShape::new(&cam, view, Vec3::ZERO, bm::Mat3::IDENTITY, GizmoKind::Rotate);
    let (pts, _) = shape.rings.iter().find(|(_, h)| *h == Handle::Y).expect("Y ring");
    assert!(pts.len() >= 8);
    let a = pts[0];
    let b = pts[pts.len() / 4];
    let deg = drag_rotate(&cam, view, Vec3::ZERO, bm::Mat3::IDENTITY, Handle::Y, a, b, false);
    assert!(deg.abs() >= 15.0, "expected quarter-turn drag >= 15 deg, got {deg}");
    assert!((deg % 15.0).abs() < 1e-6, "expected multiple of 15, got {deg}");
}
