// Safe wrappers for placement preview, commit and stale-version guard.
use std::path::Path;
use std::time::{Duration, Instant};

use bm::placement::{PlacementInput, PlacementState};
use bm::{Pose, Vec2};

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn heli() -> bm::Session {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    s
}

#[test]
fn preview_answers_and_places_one_piece() {
    if !bm::metal_available() {
        return;
    }
    let mut doc = bm::Document::new(heli());
    let vp = doc.viewport().expect("metal");
    vp.resize(640, 480, 1.0);
    vp.fit_all();
    vp.draw();
    vp.show_rest();

    let input = PlacementInput { part: "3001.dat".into(), color: 4, ..Default::default() };
    let req = vp.preview_part(&input, Vec2::new(320.0, 240.0));
    assert!(req > 0);

    let deadline = Instant::now() + Duration::from_secs(5);
    let preview = loop {
        vp.draw();
        let p = vp.placement_preview();
        if p.request == req && !matches!(p.state, PlacementState::Inactive | PlacementState::Preparing) {
            break p;
        }
        assert!(Instant::now() < deadline, "placement preview never settled: {p:?}");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(matches!(preview.state, PlacementState::Free | PlacementState::Snapped | PlacementState::Blocked));

    if preview.state.is_placeable() {
        let n = doc.session().piece_count();
        let c = doc.session().place_part("3001.dat", 4, &preview.pose, None, None, preview.generation, preview.version);
        assert_eq!(c.refused, None);
        assert_eq!(doc.session().piece_count(), n + 1);
        doc.session().undo();
        assert_eq!(doc.session().piece_count(), n);
    }

    doc.viewport().unwrap().clear_placement_preview();
}

#[test]
fn stale_version_is_refused() {
    let s = heli();
    let generation = s.generation();
    let old_ver = s.version();
    s.remove(&[0]);
    let n = s.piece_count();
    let c = s.place_part("3001.dat", 4, &Pose::default(), None, None, generation, old_ver);
    assert!(c.refused.is_some());
    assert_eq!(s.piece_count(), n);
}
