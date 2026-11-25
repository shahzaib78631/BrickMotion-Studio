// Snap sound: transport sync, audio device failure notice, sample preview, mix slider, and
// big-model write_snap_track benchmark.
use std::time::{Duration, Instant};

use bm::settings::{SnapExample, SnapMix};
use brickmotion::sound::{FakeSink, SnapSound};
use brickmotion::support::snap_recordings;
use brickmotion::{BrickMotionApp, Notice, run};
use egui::{Event, Modifiers, PointerButton, pos2};
use egui::accesskit::Role;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn heli_harness() -> Harness<'static, BrickMotionApp> {
    let mut h = Harness::builder()
        .with_size([1440.0, 900.0])
        .build_eframe(|cc| {
            let mut app = BrickMotionApp::new_for_test_cc(cc, Some(HELI.into()));
            app.wait_loaded();
            app.dialogs_off();
            app
        });
    h.run_steps(3);
    h
}

fn plan_ready(h: &mut Harness<'static, BrickMotionApp>, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        h.step();
        let ver = h.state().session().version();
        let tr = &h.state().transport;
        if tr.ready() && tr.version == Some(ver) && !tr.state.stale {
            return;
        }
        assert!(Instant::now() < deadline, "plan never became ready (state={:?})", tr.state);
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn sound_follows_transport() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    let rec = snap_recordings();
    // Enable snap sound on the document.
    let mut mix = h.state().session().snap_mix();
    mix.enabled = true;
    h.state_mut().doc.session().set_snap_mix(&mix);

    assert!(run(h.state_mut(), "video.plan_build"));
    plan_ready(&mut h, Duration::from_secs(60));
    assert!(run(h.state_mut(), "transport.start"));
    h.run_steps(2);

    let mut sound = SnapSound::new(FakeSink::default());

    // While paused, stays silent.
    {
        let app = h.state_mut();
        let (session, vp) = app.doc.parts();
        let n = sound.follow(session, vp, &app.transport, true, true, &rec);
        assert!(n.is_none());
        assert_eq!(sound.sink.loads, 0);
        assert!(!sound.sink.playing);
    }

    // Start playing -> loads track once, seeks, sets speed, plays.
    assert!(run(h.state_mut(), "transport.play"));
    h.run_steps(2);
    {
        let app = h.state_mut();
        let (session, vp) = app.doc.parts();
        let n = sound.follow(session, vp, &app.transport, true, true, &rec);
        assert!(n.is_none());
        assert_eq!(sound.sink.loads, 1);
        assert!(sound.sink.playing);
        assert!(sound.sink.dur > 0.0);
        assert_eq!(sound.sink.speeds, vec![1.0]);
    }

    // Change rate -> updates sink speed without reloading track.
    {
        let app = h.state_mut();
        if let Some(vp) = app.doc.viewport() {
            app.transport.set_rate(vp, 2.0);
        }
        let (session, vp) = app.doc.parts();
        let _ = sound.follow(session, vp, &app.transport, true, true, &rec);
        assert_eq!(sound.sink.loads, 1);
        assert_eq!(sound.sink.speeds, vec![1.0, 2.0]);
    }

    // Drift > 80 ms -> seeks to transport time.
    sound.sink.pos = 10.0;
    let seeks_before = sound.sink.seeks.len();
    {
        let app = h.state_mut();
        let (session, vp) = app.doc.parts();
        let _ = sound.follow(session, vp, &app.transport, true, true, &rec);
        assert!(sound.sink.seeks.len() > seeks_before);
    }

    // Leaving Build tab pauses audio.
    {
        let app = h.state_mut();
        let (session, vp) = app.doc.parts();
        let _ = sound.follow(session, vp, &app.transport, true, false, &rec);
        assert!(!sound.sink.playing);
    }

    // Returning resumes; muting via pref pauses.
    {
        let app = h.state_mut();
        let (session, mut vp) = app.doc.parts();
        let _ = sound.follow(session, vp.as_deref_mut(), &app.transport, true, true, &rec);
        assert!(sound.sink.playing);
        let _ = sound.follow(session, vp, &app.transport, false, true, &rec);
        assert!(!sound.sink.playing);
    }

    // Pause transport -> pauses audio.
    assert!(run(h.state_mut(), "transport.play"));
    h.run_steps(2);
    {
        let app = h.state_mut();
        let (session, vp) = app.doc.parts();
        let _ = sound.follow(session, vp, &app.transport, true, true, &rec);
        assert!(!sound.sink.playing);
    }
}

#[test]
fn no_audio_device_is_one_notice() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    let rec = snap_recordings();
    let mut mix = h.state().session().snap_mix();
    mix.enabled = true;
    h.state_mut().doc.session().set_snap_mix(&mix);

    assert!(run(h.state_mut(), "video.plan_build"));
    plan_ready(&mut h, Duration::from_secs(60));
    assert!(run(h.state_mut(), "transport.start"));
    assert!(run(h.state_mut(), "transport.play"));
    h.run_steps(2);

    let mut sound = SnapSound::new(FakeSink {
        fail_with: Some("no output audio device".into()),
        ..FakeSink::default()
    });
    let mut notices = Vec::new();
    for _ in 0..5 {
        let app = h.state_mut();
        let (session, vp) = app.doc.parts();
        if let Some(n) = sound.follow(session, vp, &app.transport, true, true, &rec) {
            notices.push(n);
        }
    }
    assert_eq!(notices.len(), 1, "expected exactly one audio warning notice");
    assert!(matches!(notices[0], Notice::Warning { .. }));
    assert_eq!(sound.track_writes, 1, "a track the sink refused is not rewritten every frame");
}

#[test]
fn sample_plays_without_a_plan() {
    let mut sound = SnapSound::new(FakeSink::default());
    let mix = SnapMix::default();
    let rec = snap_recordings();
    sound.request_sample(mix, SnapExample::Brick, rec);
    let deadline = Instant::now() + Duration::from_secs(10);
    while sound.preview_pending() {
        assert!(Instant::now() < deadline, "sample preview timed out");
        let _ = sound.poll_preview();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(sound.last_example, Some(SnapExample::Brick));
    assert_eq!(sound.sink.previews, 1);
    assert!(sound.waveform(SnapExample::Brick).is_some_and(|w| !w.is_empty()));

    // Also verify clicking the Hear it tile in the Snap Sound page works without a plan.
    let mut h = heli_harness();
    assert!(!h.state().transport.ready());
    assert!(run(h.state_mut(), "video.snap_sound"));
    h.run_steps(2);
    assert!(h.state().sound.waveform(SnapExample::Plate).is_none());
    h.get_by_role_and_label(Role::Button, "Play Plate sample").click();
    let deadline = Instant::now() + Duration::from_secs(10);
    while h.state().sound.waveform(SnapExample::Plate).is_none() {
        assert!(Instant::now() < deadline, "UI sample preview never finished");
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(h.state().sound.last_example, Some(SnapExample::Plate));
}

#[test]
fn mix_slider_commits_once() {
    let mut h = heli_harness();
    assert!(run(h.state_mut(), "video.snap_sound"));
    h.run_steps(2);

    let before_undo = h.state().session().undo_depth();
    let before_vol = h.state().session().snap_mix().volume;
    let rect = h.get_by_role_and_label(Role::Slider, "Volume").rect();
    let p0 = pos2(rect.left() + rect.width() * 0.65, rect.center().y);
    let p1 = pos2(rect.left() + rect.width() * 0.35, rect.center().y);
    let p2 = pos2(rect.left() + rect.width() * 0.20, rect.center().y);

    h.event(Event::PointerMoved(p0));
    h.event(Event::PointerButton { pos: p0, button: PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE });
    h.step();
    h.event(Event::PointerMoved(p1));
    h.step();
    assert_eq!(h.state().session().undo_depth(), before_undo, "mid-drag must not push undo");

    h.event(Event::PointerMoved(p2));
    h.step();
    h.event(Event::PointerButton { pos: p2, button: PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE });
    h.run_steps(2);
    assert_eq!(h.state().session().undo_depth(), before_undo + 1, "mix slider drag must be one undo step");
    let after_vol = h.state().session().snap_mix().volume;
    assert!((after_vol - before_vol).abs() > 0.2, "volume did not change: {before_vol} -> {after_vol}");
}

#[test]
fn recordings_dir_resolves() {
    let dir = snap_recordings();
    assert!(dir.is_dir(), "snap recordings dir not found: {}", dir.display());
    let wavs = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "wav"))
        .count();
    assert!(wavs > 0, "expected .wav files in {}", dir.display());
}

#[test]
#[ignore]
fn write_snap_track_time() {
    let Some(big) = std::env::var_os("BM_BIG_MODEL") else { return };
    if !bm::metal_available() {
        return;
    }
    let mut h = Harness::builder()
        .with_size([1440.0, 900.0])
        .build_eframe(move |cc| {
            let mut app = BrickMotionApp::new_for_test_cc(cc, Some(big.into()));
            app.wait_loaded();
            app.dialogs_off();
            app
        });
    h.run_steps(3);
    let mut mix = h.state().session().snap_mix();
    mix.enabled = true;
    h.state_mut().doc.session().set_snap_mix(&mix);
    assert!(run(h.state_mut(), "video.plan_build"));
    plan_ready(&mut h, Duration::from_secs(300));

    let rec = snap_recordings();
    let out = std::env::temp_dir().join(format!("bm-big-snap-track-{}.wav", std::process::id()));
    let t0 = Instant::now();
    let res = h.state_mut().doc.viewport().unwrap().write_snap_track(&out, &rec);
    let elapsed = t0.elapsed();
    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    let _ = std::fs::remove_file(&out);
    eprintln!("write_snap_track_time (10294-1): res={res:?}, elapsed={elapsed:?}, wav_bytes={size}");
    assert!(res.is_ok(), "write_snap_track failed: {res:?}");
    assert!(size > 44, "empty snap track WAV");
}

#[test]
fn failed_track_write_never_plays_the_previous_track() {
    if !bm::metal_available() {
        return;
    }
    let mut h = heli_harness();
    let rec = snap_recordings();
    let mut mix = h.state().session().snap_mix();
    mix.enabled = true;
    h.state_mut().doc.session().set_snap_mix(&mix);
    assert!(run(h.state_mut(), "video.plan_build"));
    plan_ready(&mut h, Duration::from_secs(60));
    assert!(run(h.state_mut(), "transport.start"));
    assert!(run(h.state_mut(), "transport.play"));
    h.run_steps(2);

    let mut sound = SnapSound::new(FakeSink::default());
    {
        let app = h.state_mut();
        let (session, vp) = app.doc.parts();
        let _ = sound.follow(session, vp, &app.transport, true, true, &rec);
    }
    assert_eq!(sound.sink.loads, 1);
    assert!(sound.sink.playing);

    // A new plan whose track cannot be written (the recordings path has a NUL byte).
    mix.volume *= 0.5;
    h.state_mut().doc.session().set_snap_mix(&mix);
    assert!(run(h.state_mut(), "video.plan_build"));
    plan_ready(&mut h, Duration::from_secs(60));
    assert!(run(h.state_mut(), "transport.start"));
    assert!(run(h.state_mut(), "transport.play"));
    h.run_steps(2);
    let bad = std::path::PathBuf::from("bad\0recordings");
    for _ in 0..2 {
        let app = h.state_mut();
        let (session, vp) = app.doc.parts();
        let _ = sound.follow(session, vp, &app.transport, true, true, &bad);
        assert!(!sound.sink.playing, "the previous plan's track must not play");
    }
    assert_eq!(sound.track_writes, 2, "one write per plan, not one a frame");
}
