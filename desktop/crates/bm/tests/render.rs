// The safe engine wrappers against the real engine.
use std::path::Path;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

#[test]
fn opens_and_renders() {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    assert!(s.piece_count() > 100);
    let mut doc = bm::Document::new(s);
    let v = doc.viewport().expect("metal");
    v.set_background([0.1, 0.1, 0.12]);
    v.resize(320, 240, 1.0);
    v.fit_all();
    for _ in 0..30 {
        if !v.draw() {
            break;
        }
    }
    let mut f = bm::Frame::default();
    v.read_frame(&mut f);
    assert_eq!((f.width, f.height), (320, 240));
    assert!(f.rgba.chunks(4).filter(|p| p[0] > 60 || p[1] > 60 || p[2] > 60).count() > 1000);
    assert!(v.pick(160.0, 120.0).is_some());
    assert_eq!(v.pick(2.0, 2.0), None);
}

#[test]
fn open_error_names_file() {
    let e = bm::Session::new().open(Path::new("/no/such/thing.mpd")).unwrap_err();
    assert!(e.to_string().starts_with("thing.mpd: "), "{e}");
}

#[test]
fn replace_swaps_document_and_viewport() {
    let mut doc = bm::Document::new(bm::Session::new());
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    let n = s.piece_count();
    doc.replace(s);
    assert_eq!(doc.session().piece_count(), n);
    assert!(doc.viewport().is_some());
}

#[test]
fn selection_round_trips() {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    s.select(&[3, 5], bm::SelectMode::Replace);
    assert_eq!(s.selection(), vec![3, 5]);
    s.select(&[5], bm::SelectMode::Toggle);
    assert_eq!(s.selection(), vec![3]);
}

#[test]
fn header_and_rust_decls_agree() {
    // Every BMFFI_API name in bmffi.h is declared in bm-sys.
    let h = include_str!("../../../bmffi/include/bmffi.h");
    let names: Vec<&str> = h
        .lines()
        .filter_map(|l| l.strip_prefix("BMFFI_API "))
        .filter_map(|t| t.split('(').next()?.split_whitespace().last())
        .map(|n| n.trim_start_matches('*'))
        .collect();
    assert_eq!(names.len(), 63);
    for name in names {
        assert!(bm_sys::DECLARED.contains(&name), "missing {name}");
    }
}

#[test]
fn document_built_on_worker_draws_on_this_thread() {
    // The renderer is built where the Document is made; the window then owns it.
    let mut doc = std::thread::spawn(|| {
        let mut s = bm::Session::new();
        s.open(Path::new(HELI)).unwrap();
        bm::Document::new(s)
    })
    .join()
    .unwrap();
    let v = doc.viewport().expect("metal");
    v.resize(320, 240, 1.0);
    v.fit_all();
    for _ in 0..30 {
        if !v.draw() {
            break;
        }
    }
    let mut f = bm::Frame::default();
    v.read_frame(&mut f);
    assert_eq!((f.width, f.height), (320, 240));
    assert!(v.pick(160.0, 120.0).is_some());
    drop(doc);
}
