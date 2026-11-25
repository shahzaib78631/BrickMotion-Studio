// Motion fields, flight bake on a worker, joints and insertion direction through `bm`.
use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, Instant};

use bm::Vec3;
use bm::motion::{Inspection, MotionFields, MotionScope, effective_motion, flight_phases};
use bm::playback::PlanState;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn open_heli() -> bm::Document {
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
        assert!(st.plan != PlanState::Failed && Instant::now() < deadline, "plan failed");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// A flown part of the open model itself.
fn local_flown(doc: &mut bm::Document) -> u32 {
    let s = doc.session();
    let local: HashSet<u32> = (0..s.steps().len())
        .flat_map(|step| s.step_items(step))
        .filter(|i| !i.submodel && i.pieces.len() == 1)
        .map(|i| i.pieces[0])
        .collect();
    let timeline = doc.viewport().unwrap().build_timeline().expect("timeline");
    timeline.flights.iter().map(|f| f.piece).find(|p| local.contains(p)).expect("a local flight")
}

#[test]
fn motion_fields_round_trip() {
    let doc = open_heli();
    let s = doc.session();
    let fields = MotionFields { time: 1.5, landing: 0.4, ..MotionFields::default() };
    assert!(s.set_motion_fields(MotionScope::Project, 0, &[], fields).refused.is_none());
    assert_eq!(s.motion_fields(MotionScope::Project, 0, &[]), fields);
    let parts = effective_motion(s, MotionScope::Parts, 0, MotionFields::default());
    assert_eq!((parts.time, parts.landing, parts.hover, parts.ease), (1.5, 0.4, 0.0, 0));
    let phases = flight_phases(MotionFields { time: 1.0, landing: 0.25, hover: 0.9, ease: 0 });
    assert!((phases.hover - 0.7).abs() < 1e-12 && (phases.travel - 0.05).abs() < 1e-12);
}

#[test]
fn bake_on_worker_thread() {
    if !bm::metal_available() {
        return;
    }
    let mut doc = open_heli();
    plan(&mut doc);
    let p = local_flown(&mut doc);
    let mut bake = doc.viewport().unwrap().capture_flight_bake(&[p], false).expect("a bake");
    assert!(!bake.replaces_keys());
    let worker = std::thread::spawn(move || {
        let r = bake.prepare();
        (bake, r)
    });
    let (mut bake, result) = worker.join().unwrap();
    assert_eq!(result.error, None);
    assert_eq!(result.flights, 1);
    assert!(result.keys > 0);
    assert!(doc.session().apply_flight_bake(&mut bake).refused.is_none());
    assert!(doc.session().key_objects().iter().any(|o| o.piece == p && o.baked));
    let v = doc.viewport().unwrap();
    v.use_keyframes(true);
    v.draw();
    assert!(v.flight_path(p).is_some());
    let mut audit = v.audit_motion(p).expect("an audit");
    let report = std::thread::spawn(move || audit.check()).join().unwrap();
    assert!(report.tested_frames > 0);
}

#[test]
fn joint_turn_round_trip() {
    let doc = open_heli();
    let s = doc.session();
    let mut inspection = Inspection::capture(s).expect("inspection");
    let report = inspection.joints(&[], true, false);
    assert_eq!(report.error, None);
    let turning: Vec<_> = report.joints.iter().copied().filter(|j| j.kind.turns()).collect();
    assert!(!turning.is_empty());
    assert!(!turning[0].kind.title().is_empty());
    // On a worker, as the app does: the first joint that is free to turn.
    let (joint, edit) = std::thread::spawn(move || {
        turning
            .into_iter()
            .map(|j| (j, inspection.change_joint(j.a, j.b, 15.0, false)))
            .find(|(_, e)| e.error.is_none())
            .expect("a joint free to turn")
    })
    .join()
    .unwrap();
    assert!(!edit.pieces.is_empty());
    let (generation, version) = (s.generation(), s.version());
    assert!(s.place_moved(&edit.pieces, edit.pivot, edit.pose, generation, version + 1).refused.is_some());
    let depth = s.undo_depth();
    assert!(s.place_moved(&edit.pieces, edit.pivot, edit.pose, generation, version).refused.is_none());
    assert_eq!(s.undo_depth(), depth + 1);
    let mut again = Inspection::capture(s).unwrap();
    let after = again.joints(&[], true, false);
    let same = |j: &&bm::motion::JointRow| (j.a, j.b) == (joint.a, joint.b) || (j.a, j.b) == (joint.b, joint.a);
    let found: Vec<_> = after.joints.iter().filter(same).collect();
    let turned = found.first().expect("still joined");
    let mut delta = (turned.angle - joint.angle).abs() % 360.0;
    if delta > 180.0 {
        delta = 360.0 - delta;
    }
    assert!((delta - 15.0).abs() < 1.0, "turned {delta}°");
}

#[test]
fn insertion_direction_round_trip() {
    let doc = open_heli();
    let s = doc.session();
    assert!(s.set_insertion_direction(&[0], Vec3::new(0.0, -1.0, 0.0)).refused.is_none());
    assert_eq!(s.insertion_direction(0), Vec3::new(0.0, -1.0, 0.0));
}
