// Camera tracks, Auto-direct and scene cameras through `bm`.
use std::path::Path;
use std::time::{Duration, Instant};

use bm::Vec3;
use bm::camera::{CameraClock, SceneCamera, add_camera_key_from_view, auto_direct, camera_presets, can_auto_direct, clock_info};
use bm::playback::PlanState;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn open_heli() -> bm::Document {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    bm::Document::new(s)
}

fn plan(doc: &mut bm::Document) -> f64 {
    let ver = doc.session().version();
    let v = doc.viewport().expect("metal");
    v.resize(320, 240, 1.0);
    v.request_plan();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        v.draw();
        let st = v.playback_state();
        if st.plan == PlanState::Ready && v.planned_version() == ver {
            return st.duration;
        }
        assert!(st.plan != PlanState::Failed && Instant::now() < deadline, "plan failed");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn presets_have_labels() {
    let presets = camera_presets();
    assert_eq!(presets.len(), 19);
    assert!(presets.iter().all(|p| !p.id.is_empty() && !p.label.is_empty()));
}

#[test]
fn scene_cameras_round_trip() {
    let doc = open_heli();
    let s = doc.session();
    let cam = SceneCamera {
        id: "cam-1".into(),
        name: "Camera 1".into(),
        position: Vec3::new(0.0, -60.0, -400.0),
        target: Vec3::new(0.0, -40.0, 0.0),
        field_of_view: 30.0,
        near_clip: 1.0,
        far_clip: 100000.0,
        orthographic: false,
    };
    assert!(s.save_scene_camera(&cam).refused.is_none());
    assert!(s.activate_scene_camera("cam-1").refused.is_none());
    let all = s.scene_cameras();
    assert_eq!(all.cameras, vec![cam.clone()]);
    assert_eq!(all.active_id, "cam-1");
    assert!(s.remove_scene_camera("cam-1").refused.is_none());
    assert!(s.scene_cameras().cameras.is_empty());
    assert_eq!(s.export_camera(), "track");
}

#[test]
fn camera_keys_round_trip() {
    if !bm::metal_available() {
        return;
    }
    let mut doc = open_heli();
    let duration = plan(&mut doc);
    let (s, v) = doc.parts();
    let v = v.unwrap();
    let info = clock_info(CameraClock::Build, s, 30.0, duration, true);
    let (c, id, added) = add_camera_key_from_view(s, v, CameraClock::Build, 1.0, info);
    assert!(c.refused.is_none() && added && !id.is_empty());
    assert_eq!(s.camera_key_at(CameraClock::Build, 1.01, 30.0), Some(id.clone()));
    let mut key = s.camera_keys(CameraClock::Build).remove(0);
    assert_eq!(key.id, id);
    key.lens_mm = 35.0;
    key.roll = 5.0;
    let depth = s.undo_depth();
    assert!(s.set_camera_key(CameraClock::Build, &key, false).refused.is_none());
    key.lens_mm = 28.0;
    assert!(s.set_camera_key(CameraClock::Build, &key, true).refused.is_none());
    s.end_gesture();
    assert_eq!(s.undo_depth(), depth + 1);
    let back = &s.camera_keys(CameraClock::Build)[0];
    assert_eq!(back.lens_mm, 28.0);
    assert_eq!(back.roll, 5.0);
    assert!(s.camera_keys(CameraClock::Timeline).is_empty());
}

#[test]
fn auto_direct_needs_a_plan() {
    if !bm::metal_available() {
        return;
    }
    let mut doc = open_heli();
    {
        let (s, v) = doc.parts();
        assert!(auto_direct(s, v.unwrap(), CameraClock::Build, "showcase").refused.is_some());
        assert!(!can_auto_direct(CameraClock::Build, s, false));
    }
    plan(&mut doc);
    let (s, v) = doc.parts();
    assert!(auto_direct(s, v.unwrap(), CameraClock::Build, "calm").refused.is_none());
    assert_eq!(s.camera_director_style(CameraClock::Build), "calm");
    assert!(!s.camera_moves(CameraClock::Build).is_empty());
}
