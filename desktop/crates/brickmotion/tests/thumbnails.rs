// Home sample thumbnails: drawn once off the UI thread, cached as PNGs, shown on the cards.
use std::time::{Duration, Instant};

use brickmotion::BrickMotionApp;
use brickmotion::support::Support;
use brickmotion::thumbnails::{self, Thumbnails, Thumb};
use egui_kittest::Harness;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn scratch(name: &str) -> Support {
    let dir = std::env::temp_dir().join(format!("bm-thumbs-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    Support::at(dir)
}

const BG: [u8; 3] = [40, 42, 46];

#[test]
fn a_model_draws_into_a_picture_of_the_asked_size() {
    if !bm::metal_available() {
        return;
    }
    let img = thumbnails::render(HELI.as_ref(), (240, 150), BG).expect("drawn");
    assert_eq!((img.width(), img.height()), (240, 150));
    let near = |p: &[u8]| p.iter().zip(BG).all(|(&a, b)| a.abs_diff(b) <= 3);
    assert!(near(&img.get_pixel(0, 0).0[..3]), "the corner is the card's colour: {:?}", img.get_pixel(0, 0));
    assert!(img.pixels().filter(|p| !near(&p.0[..3])).count() > 1000, "and the model is in it");
}

#[test]
fn a_thumbnail_is_drawn_once_then_read_from_the_cache() {
    if !bm::metal_available() {
        return;
    }
    let support = scratch("cache");
    let ctx = egui::Context::default();
    let mut thumbs = Thumbnails::default();
    assert!(matches!(thumbs.get(&ctx, &support, HELI.as_ref(), BG), Thumb::Pending), "drawn on a worker");
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match thumbs.get(&ctx, &support, HELI.as_ref(), BG) {
            Thumb::Ready(_) => break,
            Thumb::Pending => {}
            Thumb::Missing => panic!("the helicopter should draw"),
        }
        assert!(Instant::now() < deadline, "never finished");
        std::thread::sleep(Duration::from_millis(20));
    }
    let cached = thumbnails::cache_file(&support, HELI.as_ref(), BG).expect("a cache name");
    assert!(cached.is_file(), "saved as a PNG");

    // A fresh cache reads the PNG back at once: no worker.
    let mut again = Thumbnails::default();
    assert!(matches!(again.get(&ctx, &support, HELI.as_ref(), BG), Thumb::Ready(_)));
    // Another card colour is another picture.
    assert_ne!(thumbnails::cache_file(&support, HELI.as_ref(), [250, 250, 250]), Some(cached));
}

#[test]
fn a_missing_model_has_no_thumbnail() {
    let support = scratch("missing");
    let ctx = egui::Context::default();
    let mut thumbs = Thumbnails::default();
    let nowhere = std::path::Path::new("/nowhere/model.ldr");
    assert!(matches!(thumbs.get(&ctx, &support, nowhere, BG), Thumb::Missing));
}

#[test]
fn home_cards_show_the_samples_pictures() {
    if !bm::metal_available() {
        return;
    }
    let support = scratch("home");
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(move |cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, None);
        app.support = support.clone();
        app.dialogs_off();
        app
    });
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        h.run_steps(1);
        if h.state().home_thumbnails_ready() > 0 {
            break;
        }
        assert!(Instant::now() < deadline, "no sample thumbnail appeared");
        std::thread::sleep(Duration::from_millis(30));
    }
}
