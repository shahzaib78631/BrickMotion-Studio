// Build settings, staging, waiting parts and snap sound settings through `bm`.
use std::path::Path;
use std::time::{Duration, Instant};

use bm::playback::PlanState;
use bm::settings::{BuildOrder, SnapExample, SnapSource, snap_mix_preset, write_snap_preview};

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");
const SNAPS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../public/sounds/snaps");

fn heli_doc() -> bm::Document {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    bm::Document::new(s)
}

fn plan(doc: &mut bm::Document) {
    let ver = doc.session().version();
    let v = doc.viewport().expect("metal");
    v.resize(320, 240, 1.0);
    v.request_plan();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        v.draw();
        let st = v.playback_state();
        if st.plan == PlanState::Ready && v.planned_version() == ver {
            return;
        }
        assert!(Instant::now() < deadline, "plan timed out: {st:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn build_settings_round_trip_and_replan() {
    if !bm::metal_available() {
        return;
    }
    let mut doc = heli_doc();
    plan(&mut doc);
    let mut b = doc.session().build_settings();
    b.pieces_per_second = 4.0;
    b.order = BuildOrder::BottomUp;
    let c = doc.session().set_build_settings(&b);
    assert_eq!(c.refused, None);
    let got = doc.session().build_settings();
    assert!((got.pieces_per_second - 4.0).abs() < 1e-6);
    assert_eq!(got.order, BuildOrder::BottomUp);
    assert_ne!(doc.viewport().unwrap().planned_version(), doc.session().version());
}

#[test]
fn staging_apply_and_waiting_shift_round_trip() {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    let depth = s.undo_depth();
    let mut st = s.staging_settings();
    st.layout = "grid".into();
    st.group = "colour".into();
    let c = s.apply_staging(&st, 30.0, false);
    assert_eq!(c.refused, None);
    assert_eq!(s.undo_depth(), depth + 1);
    assert_eq!(s.staging_settings().layout, "grid");
    assert!((s.staging_turn() - 30.0).abs() < 1e-6);

    let c = s.shift_waiting_part(0, bm::Vec3::new(20.0, 0.0, -40.0));
    assert_eq!(c.refused, None);
    let sh = s.waiting_shift(0);
    assert!((sh.x - 20.0).abs() < 1e-6 && (sh.z + 40.0).abs() < 1e-6);
    assert!(s.moved_waiting_parts() >= 1);
    let c = s.put_back_waiting_parts();
    assert_eq!(c.refused, None);
    assert_eq!(s.moved_waiting_parts(), 0);
}

#[test]
fn snap_mix_presets_and_track() {
    if !bm::metal_available() {
        return;
    }
    let mut doc = heli_doc();
    let tmp = std::env::temp_dir().join(format!("bm-rs-snap-track-{}.wav", std::process::id()));
    let _ = std::fs::remove_file(&tmp);

    // Before planning, write_snap_track refuses with an explanation.
    assert!(doc.viewport().unwrap().write_snap_track(&tmp, Path::new(SNAPS)).is_err());

    let mut mix = doc.session().snap_mix();
    mix.enabled = true;
    mix.source = SnapSource::Synthesised;
    mix.volume = 0.8;
    assert_eq!(doc.session().set_snap_mix(&mix).refused, None);
    assert!((doc.session().snap_mix().volume - 0.8).abs() < 1e-6);
    assert_ne!(snap_mix_preset("click").click, snap_mix_preset("soft").click);

    plan(&mut doc);
    doc.viewport().unwrap().write_snap_track(&tmp, Path::new(SNAPS)).expect("snap track");
    let bytes = std::fs::read(&tmp).unwrap();
    assert!(bytes.len() > 44 && &bytes[..4] == b"RIFF");
    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn write_snap_preview_on_a_worker() {
    let tmp = std::env::temp_dir().join(format!("bm-rs-snap-prev-{}.wav", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let dst = tmp.clone();
    let ok = std::thread::spawn(move || {
        let mut mix = snap_mix_preset("physical");
        mix.enabled = true;
        write_snap_preview(&mix, SnapExample::Plate, Path::new(SNAPS), &dst)
    })
    .join()
    .unwrap();
    assert!(ok);
    let bytes = std::fs::read(&tmp).unwrap();
    assert!(bytes.len() > 44 && &bytes[..4] == b"RIFF");
    let _ = std::fs::remove_file(&tmp);
}
