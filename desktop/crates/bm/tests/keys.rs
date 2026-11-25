// Keyframes through `bm`: keys, key objects, the key scene and the shared key maths.
use std::path::Path;

use bm::Vec3;
use bm::keys::{GizmoTool, KeyChannel, KeyScene, Keyframe, adjacent_key_frame, auto_key_target, auto_key_values, clamp_offset, key_offset_limits};

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn open_heli() -> bm::Session {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    s
}

fn first_part(s: &bm::Session) -> u32 {
    (0..s.steps().len())
        .flat_map(|step| s.step_items(step))
        .find(|item| !item.submodel && !item.pieces.is_empty())
        .map(|item| item.pieces[0])
        .expect("a part")
}

#[test]
fn keys_round_trip() {
    let s = open_heli();
    let p = first_part(&s);
    let keys = [
        Keyframe::new(KeyChannel::PositionX, 10, 1.0),
        Keyframe::new(KeyChannel::PositionY, 10, 2.0),
        Keyframe::new(KeyChannel::PositionX, 20, 3.0),
    ];
    assert!(s.set_keys(p, &keys, false, false).refused.is_none());
    let objects = s.key_objects();
    let o = &objects[0];
    assert_eq!(o.piece, p);
    assert!(o.keyed);
    assert_eq!(o.keys.len(), 3);
    assert_eq!(o.markers.iter().map(|m| (m.frame, m.channels)).collect::<Vec<_>>(), vec![(10, 2), (20, 1)]);
    assert!(o.keys.contains(&keys[2]));
    assert!((s.key_value(p, KeyChannel::PositionX, 20.0, false) - 3.0).abs() < 1e-9);
    assert!(s.remove_keys(p, &keys[..1], false).refused.is_none());
    assert_eq!(s.key_objects()[0].keys.len(), 2);
}

#[test]
fn key_objects_keyed_first() {
    let s = open_heli();
    let before = s.key_objects();
    assert!(before.iter().all(|o| !o.keyed));
    let last = before.last().unwrap();
    let (piece, submodel) = (last.piece, last.submodel);
    if submodel {
        return;
    }
    assert!(s.set_keys(piece, &[Keyframe::new(KeyChannel::RotationY, 5, 90.0)], false, false).refused.is_none());
    let after = s.key_objects();
    assert_eq!(after[0].piece, piece);
    assert_eq!(after.len(), before.len());
    assert!(after[1..].iter().all(|o| !o.keyed));
}

#[test]
fn key_scene_round_trip() {
    let s = open_heli();
    assert_eq!(s.key_scene(), KeyScene::default());
    let scene = KeyScene { fps: 30, first: 5, last: 95, build_linked: true, build_start: 10, build_speed: 1.5 };
    assert!(s.set_key_scene(scene).refused.is_none());
    assert_eq!(s.key_scene(), scene);
    assert_eq!(scene.frame_at(1.0), 35);
    assert!((scene.length() - 3.0).abs() < 1e-12);
}

#[test]
fn offset_limits_match_c() {
    let scene = KeyScene::default();
    assert_eq!(key_offset_limits(scene, 10, 40), (-9, 210));
    assert_eq!(clamp_offset((-9, 210), 300), 210);
    assert_eq!(key_offset_limits(scene, 41, 40), (0, 0));
}

#[test]
fn auto_key_values_move() {
    let keys = auto_key_values(GizmoTool::Move, Vec3::new(1.0, 2.0, 3.0), Vec3::new(20.0, 40.0, -60.0), 12);
    assert_eq!(keys.len(), 3);
    assert_eq!(keys[0].channel, KeyChannel::PositionX);
    assert_eq!(keys.iter().map(|k| k.value).collect::<Vec<_>>(), vec![2.0, 0.0, 6.0]);
    assert!(keys.iter().all(|k| k.frame == 12));
    let rotate = auto_key_values(GizmoTool::Rotate, Vec3::new(0.0, 10.0, 0.0), Vec3::new(0.0, 30.0, 0.0), 1);
    assert_eq!(rotate[1].channel, KeyChannel::RotationY);
    assert!((rotate[1].value + 20.0).abs() < 1e-9);
}

#[test]
fn auto_key_target_one_part() {
    let s = open_heli();
    let p = first_part(&s);
    assert_eq!(auto_key_target(&s, &[p], true, None), Some((p, false)));
    assert_eq!(auto_key_target(&s, &[p], false, None), None);
}

#[test]
fn set_keys_continuing_is_one_undo_step() {
    let s = open_heli();
    let p = first_part(&s);
    let depth = s.undo_depth();
    s.end_gesture();
    for i in 0..3 {
        assert!(s.set_keys(p, &[Keyframe::new(KeyChannel::PositionX, 12, f64::from(i))], true, false).refused.is_none());
    }
    s.end_gesture();
    assert_eq!(s.undo_depth(), depth + 1);
}

#[test]
fn adjacent_frames() {
    let s = open_heli();
    let p = first_part(&s);
    s.set_keys(p, &[Keyframe::new(KeyChannel::PositionX, 10, 0.0), Keyframe::new(KeyChannel::PositionX, 20, 1.0)], false, false);
    let objects = s.key_objects();
    assert_eq!(adjacent_key_frame(&objects[..1], 15, true), Some(20));
    assert_eq!(adjacent_key_frame(&objects[..1], 15, false), Some(10));
    assert_eq!(adjacent_key_frame(&objects[..1], 20, true), None);
}
