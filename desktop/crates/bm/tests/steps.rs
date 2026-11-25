// Safe wrappers for build steps, step items and step edits.
use std::path::Path;

use bm::steps::StepFields;

const CAR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/8880-1.mpd");

fn car() -> bm::Session {
    let mut s = bm::Session::new();
    s.open(Path::new(CAR)).unwrap();
    s
}

#[test]
fn steps_and_items_match_piece_counts() {
    let s = car();
    let steps = s.steps();
    assert!(steps.len() >= 2);
    assert!(steps[0].pieces > 0);
    let items = s.step_items(0);
    let sum: usize = items.iter().map(|i| i.pieces.len()).sum();
    assert_eq!(sum, s.pieces_of_step(0).len());
}

#[test]
fn insert_delete_split_merge_and_move_to_step() {
    let s = car();
    let n = s.steps().len();
    assert_eq!(s.insert_step(1).refused, None);
    assert_eq!(s.steps().len(), n + 1);
    assert_eq!(s.delete_step(1).refused, None);
    assert_eq!(s.steps().len(), n);

    let (target_step, first_pieces) = (0..n)
        .find_map(|k| {
            let items = s.step_items(k);
            (items.len() >= 2).then(|| (k, items[0].pieces.clone()))
        })
        .expect("step with >= 2 items");
    assert_eq!(s.split_step(target_step, &first_pieces).refused, None);
    assert_eq!(s.steps().len(), n + 1);
    assert_eq!(s.merge_steps(target_step).refused, None);
    assert_eq!(s.steps().len(), n);

    let item1 = s.step_items(1)[0].pieces.clone();
    let before = s.pieces_of_step(0).len();
    assert_eq!(s.move_to_step(&item1, 0).refused, None);
    assert_eq!(s.pieces_of_step(0).len(), before + item1.len());

    let all0 = s.pieces_of_step(0);
    assert!(s.split_step(0, &all0).refused.is_some());
    assert_eq!(s.steps().len(), n);
}

#[test]
fn step_fields_typing_is_one_undo_step() {
    let s = car();
    let orig = s.steps()[0].title.clone();
    s.end_gesture();
    assert_eq!(s.set_step_fields(0, &StepFields { title: "A".into(), ..Default::default() }, true).refused, None);
    assert_eq!(s.set_step_fields(0, &StepFields { title: "AB".into(), ..Default::default() }, true).refused, None);
    s.end_gesture();
    assert_eq!(s.steps()[0].title, "AB");
    s.undo();
    assert!(!s.can_undo());
    assert_eq!(s.steps()[0].title, orig);
}
