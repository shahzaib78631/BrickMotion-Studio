// Safe wrappers for submodels, groups, scale and import-into.
use bm::{Mat3, Pose, Vec3};

fn three_bricks() -> bm::Session {
    let mut s = bm::Session::new();
    s.new_blank().unwrap();
    for x in [0.0, 80.0, 160.0] {
        let pose = Pose { rotation: Mat3::IDENTITY, position: Vec3::new(x, -24.0, 0.0) };
        assert_eq!(s.place_part("3001.dat", 4, &pose, Some(0), None, s.generation(), s.version()).refused, None);
    }
    s
}

#[test]
fn make_extract_rename_delete_submodels() {
    let s = three_bricks();
    assert_eq!(s.free_submodel_name("Wing"), "Wing");
    assert_eq!(s.make_submodel(&[0, 1], "Wing").refused, None);
    assert_eq!(s.undo_name(), "Make Submodel");
    assert_eq!(s.free_submodel_name("Wing"), "Wing 2");
    assert!(s.delete_submodel("Wing").refused.is_some(), "still used");
    let sel = s.selection();
    assert_eq!(s.extract(sel[0]).refused, None);
    assert_eq!(s.rename_submodel("Wing", "Fin").refused, None);
    assert_eq!(s.delete_submodel("Fin").refused, None);
    assert_eq!(s.free_submodel_name("Fin"), "Fin");
    assert_eq!(s.new_submodel("Empty").refused, None);
    assert_eq!(s.free_submodel_name("Empty"), "Empty 2");
}

#[test]
fn move_to_model_and_make_unique() {
    let s = three_bricks();
    assert_eq!(s.make_submodel(&[0, 1], "Pod").refused, None);
    let sel = s.selection();
    let other = (0..3).find(|p| !sel.contains(p)).unwrap();
    assert_eq!(s.move_to_model(&[other], "Pod").refused, None);
    assert_eq!(s.piece_count(), 3);
    assert_eq!(s.duplicate(&[sel[0]], Vec3::new(0.0, 0.0, 200.0)).refused, None);
    assert_eq!(s.make_unique(sel[0]).refused, None);
    assert_eq!(s.free_submodel_name("Pod 2"), "Pod 2 2");
}

#[test]
fn groups_and_scale() {
    let s = three_bricks();
    assert!(s.group_names().is_empty());
    assert_eq!(s.set_group(&[1, 2], "Wheels").refused, None);
    assert_eq!(s.group_names(), vec!["Wheels".to_owned()]);
    assert_eq!(s.groups_of(&[1]), vec!["Wheels".to_owned()]);
    s.select_group("Wheels");
    assert_eq!(s.selection(), vec![1, 2]);
    assert_eq!(s.set_group(&[1], "").refused, None);
    assert!(s.groups_of(&[1]).is_empty());

    assert_eq!(s.scale(&[0], Vec3::new(2.0, 2.0, 2.0), Mat3::IDENTITY, Vec3::ZERO, false).refused, None);
    assert_eq!(s.undo_name(), "Scale Piece");
    assert!(s.scale(&[0], Vec3::new(-1.0, 1.0, 1.0), Mat3::IDENTITY, Vec3::ZERO, false).refused.is_some());
}

#[test]
fn import_a_model_into_the_open_one() {
    let dir = std::env::temp_dir().join(format!("bm-import-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("two.ldr");
    std::fs::write(&file, "0 Two\n1 1 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 2 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat\n").unwrap();

    assert!(bm::ModelImport::read(std::path::Path::new("/no/such/file.ldr")).is_err());
    let imp = bm::ModelImport::read(&file).expect("reads");
    let s = three_bricks();
    assert_eq!(s.import_model(&imp, "", s.generation()).refused, None);
    assert_eq!(s.piece_count(), 5);
    let _ = std::fs::remove_dir_all(dir);
}
