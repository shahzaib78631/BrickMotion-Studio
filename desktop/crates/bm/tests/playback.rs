// Playback, planning, timeline, lanes, arrival moves and timeline-view maths through `bm`.
use std::path::Path;
use std::time::{Duration, Instant};

use bm::playback::{AssemblyPreview, PlanState, Segment, ViewportPreferences};
use bm::timeline::{BuildTimeline, TimelineView, pack_lane, tick_interval};

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn open_heli() -> bm::Document {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    bm::Document::new(s)
}

fn plan(doc: &mut bm::Document) -> bm::playback::PlaybackState {
    let ver = doc.session().version();
    let v = doc.viewport().expect("metal");
    v.resize(640, 480, 1.0);
    v.request_plan();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        v.draw();
        let st = v.playback_state();
        if (st.plan == PlanState::Ready && v.planned_version() == ver) || st.plan == PlanState::Failed {
            return st;
        }
        assert!(Instant::now() < deadline, "plan timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn plan_timeline_and_lanes() {
    if !bm::metal_available() {
        return;
    }
    let mut doc = open_heli();
    let st = plan(&mut doc);
    assert_eq!(st.plan, PlanState::Ready);
    assert!(st.duration > 0.0);
    let v = doc.viewport().unwrap();
    assert!(v.plan_error().is_empty());

    let timeline: BuildTimeline = v.build_timeline().expect("timeline");
    assert!(timeline.duration > 0.0);
    assert!(timeline.fps > 0.0);
    assert!(!timeline.flights.is_empty());

    let lanes = timeline.lanes(Some(doc.session()));
    assert!(!lanes.runs.is_empty());
    assert!(!lanes.steps.is_empty());
    assert_eq!(lanes.run_index_at(0.0), Some(0));
    assert!(lanes.travel(0.0, timeline.duration, true) > 0.0);

    let first = lanes.runs[0];
    let target = lanes
        .arrival_target(&timeline, Some(doc.session()), first.start, &[])
        .expect("arrival target");
    assert_eq!(target.step, first.step);
    assert!(target.time >= first.start);

    // Arrange, show_rest and build_order all round-trip cleanly.
    let v = doc.viewport().unwrap();
    v.set_preferences(ViewportPreferences { auto_plan: false, ..Default::default() });
    v.arrange(Some(0), AssemblyPreview::Exploded);
    v.draw();
    v.show_rest();
    v.draw();
    assert!(v.playback_state().at_rest);
    assert!(!v.build_order().is_empty());
}

#[test]
fn arrival_pins_sequence_and_undo_depth() {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    assert_eq!(s.undo_depth(), 0);

    let step = (0..s.steps().len())
        .find(|&i| s.step_items(i).len() >= 3)
        .expect("step with >=3 items");
    let items = s.step_items(step);
    let moved_id = items.last().unwrap().item;
    let moved_pieces = items.last().unwrap().pieces.clone();

    let c = s.move_arrival(&moved_pieces, step, 0, true);
    assert_eq!(c.refused, None);
    assert_eq!(s.undo_depth(), 1);
    let after = s.step_items(step);
    assert_eq!(after[0].item, moved_id);
    assert!(s.arrival_pins().contains(&after[0].pieces[0]));

    let c = s.set_arrival_pinned(&after[0].pieces, false);
    assert_eq!(c.refused, None);
    assert!(!s.arrival_pins().contains(&after[0].pieces[0]));

    let c = s.set_sequence_duration(Segment::Intro, 1.5);
    assert_eq!(c.refused, None);
    assert_eq!(s.undo_depth(), 3);
    s.undo();
    assert_eq!(s.undo_depth(), 2);

    let c = s.move_to_new_step(&after[1].pieces, step + 1);
    assert_eq!(c.refused, None);
}

#[test]
fn pack_lane_and_tick_interval() {
    let (rows, count) = pack_lane(&[(0.0, 10.0), (5.0, 10.0), (12.0, 3.0)]);
    assert_eq!(count, 2);
    assert_eq!(rows, vec![0, 1, 0]);
    assert_eq!(tick_interval(100.0, 760.0), 10.0);
}

#[test]
fn timeline_view_x_matches_c() {
    // Rust's `x` / `screen_x` must invert C++'s `bm_timeline_view_time_at` across zoom and offset.
    let mut view = TimelineView { viewport_width: 600.0, ..Default::default() };
    assert!((view.time_at(300.0, 100.0) - 50.0).abs() < 1e-9);
    assert!(view.magnify(4.0, 300.0));
    assert!((view.zoom - 4.0).abs() < 1e-9);
    for t in [0.0, 12.5, 50.0, 75.0, 100.0] {
        let sx = view.screen_x(t, 100.0);
        if (0.0..=view.viewport_width).contains(&sx) {
            let round = view.time_at(sx, 100.0);
            assert!((round - t).abs() < 1e-9, "t={t} sx={sx} round={round}");
        }
    }
    assert!(view.pan_at_edge(599.0));
    assert!(view.reveal(0.0, 100.0, false));
    assert!(view.zoom_by(2.0, 0.0, 100.0));
    assert!(view.fit());
    assert_eq!(view.zoom, 1.0);
}
