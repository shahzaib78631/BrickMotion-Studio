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
fn selection_round_trips() {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    s.select(&[3, 5], bm::SelectMode::Replace);
    assert_eq!(s.selection(), vec![3, 5]);
    s.select(&[5], bm::SelectMode::Toggle);
    assert_eq!(s.selection(), vec![3]);
}

/// (name, number of parameters) for each `start`-prefixed declaration in `text`, read up to `end`.
fn signatures(text: &str, start: &str, end: char) -> Vec<(String, usize)> {
    text.split(start)
        .skip(1)
        .filter_map(|decl| {
            let decl = &decl[..decl.find(end)?];
            let open = decl.find('(')?;
            let name = decl[..open].split_whitespace().last()?.trim_start_matches('*').to_string();
            let params = decl[open + 1..decl.rfind(')')?].trim();
            let n = if params.is_empty() || params == "void" { 0 } else { params.split(',').count() };
            Some((name, n))
        })
        .collect()
}

#[test]
fn header_and_rust_decls_agree() {
    // Every BMFFI_API function in bmffi.h is declared in bm-sys, with as many parameters.
    let sample = "\nBMFFI_API void f(int* a,\n  int b);\nBMFFI_API BmString g(void);";
    assert_eq!(signatures(sample, "\nBMFFI_API ", ';'), vec![("f".into(), 2), ("g".into(), 0)]);
    let header = signatures(include_str!("../../../bmffi/include/bmffi.h"), "\nBMFFI_API ", ';');
    let rust = signatures(include_str!("../../bm-sys/src/lib.rs"), "\n    pub fn ", ';');
    assert_eq!(header.len(), 350);
    for (name, n) in &header {
        assert!(bm_sys::DECLARED.contains(&name.as_str()), "missing {name}");
        let r = rust.iter().find(|(r, _)| r == name).unwrap_or_else(|| panic!("no Rust fn {name}"));
        assert_eq!(r.1, *n, "{name}: header has {n} parameters, bm-sys {}", r.1);
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

#[test]
fn metal_is_available_when_a_viewport_can_be_made() {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    assert_eq!(bm::metal_available(), bm::Document::new(s).viewport().is_some());
}
