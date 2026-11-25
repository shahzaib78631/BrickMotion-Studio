// Safe library catalog and worker-thread part preview tests.
use bm::library::{PartPreview, common_parts, library_parts, part_categories};

#[test]
fn library_search_ranks_exact_number_first() {
    let hits = library_parts("3001", "", 20);
    assert!(!hits.is_empty());
    assert_eq!(hits[0].name, "3001.dat");
    assert!(!hits[0].description.is_empty());
    assert!(part_categories().iter().any(|c| c == "Brick"));
    assert!(!common_parts().is_empty());
}

#[test]
fn preview_is_square() {
    if !bm::metal_available() {
        return;
    }
    let mut pv = PartPreview::new().expect("part preview");
    let frame = pv.render("3001.dat", 4, true).expect("3001 renders");
    assert!(frame.width > 0);
    assert_eq!(frame.width, frame.height);
    assert_eq!(frame.rgba.len(), frame.width as usize * frame.height as usize * 4);
    assert!(pv.render("no-such-part-999999.dat", 4, true).is_none());
}

#[test]
fn preview_moves_to_a_worker() {
    if !bm::metal_available() {
        return;
    }
    let frame = std::thread::spawn(|| {
        let mut pv = PartPreview::new().expect("part preview on worker");
        pv.render("3001.dat", 71, true)
    })
    .join()
    .unwrap()
    .expect("rendered on worker");
    assert!(frame.width > 0 && frame.width == frame.height);
}
