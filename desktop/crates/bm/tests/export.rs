// Look, file exports, export options and the viewport recorder through `bm`.
use std::path::Path;

use bm::export::{
    self, FrameShape, LogoCorner, MovieCamera, MovieChoice, MovieQuality, MovieResolution, MovieSource, Shading,
    StillChoice, StillQuality,
};
use bm::recorder::{self, Recorder};

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn heli() -> bm::Session {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    s
}

#[test]
fn look_round_trips_with_one_undo_step() {
    let s = heli();
    let mut look = s.render_look();
    assert!(look.edges);
    let depth = s.undo_depth();
    look.scene = "slate-blue".into();
    look.edges = false;
    look.shading = Shading::Studio;
    look.path_samples = 256;
    assert_eq!(s.set_render_look(&look).refused, None);
    assert_eq!(s.render_look(), look);
    assert_eq!(s.undo_depth(), depth + 1);
}

#[test]
fn rounding_switches_round_trip_and_reach_the_still_arguments() {
    let s = heli();
    let mut look = s.render_look();
    assert!(look.smooth_curves && look.rounded_edges && look.soft_stud_roots, "all on by default");
    look.rounded_edges = false;
    assert_eq!(s.set_render_look(&look).refused, None);
    assert_eq!(s.render_look(), look);
    let args = export::still_arguments(&StillChoice::default(), &look);
    assert!(args.iter().any(|a| a == "--no-rounded-edges"), "{args:?}");
    assert!(!args.iter().any(|a| a == "--no-smooth-curves"), "{args:?}");
}

#[test]
fn scenes_are_listed() {
    let scenes = export::scenes();
    assert_eq!(scenes.len(), 34);
    assert!(scenes.iter().any(|p| p.id == "slate-blue" && p.label == "Slate blue"));
}

#[test]
fn file_bytes() {
    let s = heli();
    assert!(s.plan_bytes().contains("\"brickmotion-plan\""));
    assert!(s.mpd_bytes().starts_with("0 FILE"));
    assert!(s.submodel_mpd_bytes("helicopter - underside 1.ldr").starts_with("0 FILE"));
    assert!(s.submodel_project_bytes("helicopter - underside 1.ldr").starts_with('{'));
}

#[test]
fn export_options_match_bmapp() {
    assert_eq!(export::movie_size(FrameShape::Portrait, MovieResolution::Small), (720, 900));
    assert_eq!(export::still_size(FrameShape::Landscape, true), (3840, 2160));
    assert_eq!(export::movie_bit_rate(1920, 1080, 30, MovieQuality::Standard), 12_441_600);
    let movie = MovieChoice {
        camera: MovieCamera::Track,
        snap_audio: true,
        model_path: vec!["sub.ldr".into()],
        logo: "/tmp/l.png".into(),
        logo_corner: LogoCorner::TopLeft,
        ..MovieChoice::default()
    };
    assert_eq!(
        export::movie_arguments(&movie).join(" "),
        "--size 1920x1080 --fps 30 --source build --snap-audio --camera-track --logo /tmp/l.png --logo-corner tl --model sub.ldr"
    );
    assert_eq!(export::movie_summary(&movie), "Build · 1920 × 1080 · 30 fps · Logo");
    let turntable = MovieChoice { source: MovieSource::Turntable, ..MovieChoice::default() };
    assert!(export::movie_arguments(&turntable).join(" ").ends_with("--duration 8"));
    let still = StillChoice { quality: StillQuality::Draft, ..StillChoice::default() };
    let look = export::RenderLook::default();
    assert_eq!(export::still_arguments(&still, &look).join(" "), "--size 1920x1080 --samples 32 --no-denoise --lights-fixed");
    assert_eq!(export::still_summary(&still, true), "Still · 1920 × 1080 · Draft · Logo");
    assert_eq!(export::safe_file_stem("..x.."), "x");

    let s = heli();
    assert_eq!(export::default_movie_camera(&s, true, false), MovieCamera::Director);
    assert!(!export::movie_allows_track(&s, &movie, false, false));
    let targets = export::submodel_video_targets(&s, None);
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].title, "helicopter - underside 1");
    assert_eq!(targets[0].path, vec!["helicopter - underside 1.ldr".to_string()]);
    assert!(export::submodel_video_targets(&s, Some(&[])).is_empty());
    assert_eq!(export::run_editor_movie(&[HELI.to_string()]), 1);
}

#[test]
fn stamp_logo_reports_a_missing_still() {
    assert_eq!(
        export::stamp_logo(Path::new("/nonexistent.png"), Path::new("/nonexistent-logo.png"), LogoCorner::BottomRight),
        Err("The rendered still could not be read.".to_string())
    );
}

#[test]
fn recorder_writes_the_frames_it_is_given() {
    let file = std::env::temp_dir().join("bm-recorder-test.mp4");
    let _ = std::fs::remove_file(&file);
    let mut r = Recorder::start(&file, 63, 47).expect("recorder");
    assert_eq!(r.size(), (64, 48));
    let rgba = vec![200u8; 63 * 47 * 4];
    for i in 0..4 {
        assert!(r.append(&rgba, 63, 47, f64::from(i) / 30.0));
    }
    r.finish().expect("finish");
    assert_eq!(recorder::frame_count(&file), Some(4));
    assert_eq!(recorder::frame_count(Path::new("/nonexistent.mp4")), None);
    assert_eq!(recorder::audio_seconds(&file), None, "a viewport recording has no sound");
    let _ = std::fs::remove_file(&file);
}

#[test]
fn recorder_moves_to_a_thread() {
    fn send<T: Send>() {}
    send::<Recorder>();
}
