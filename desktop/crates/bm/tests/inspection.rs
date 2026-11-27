// Model checks, loose pieces, habit fits, fitting parts, seating and inventory through `bm`.
use std::path::PathBuf;

use bm::inventory::Inventory;
use bm::motion::{CheckKind, Inspection};
use bm::{Mat3, Pose, Session, Vec3};

fn blank() -> Session {
    let mut s = Session::new();
    s.new_blank().unwrap();
    s
}

fn place(s: &Session, part: &str, color: i32, pos: Vec3) {
    let pose = Pose { position: pos, ..Pose::default() };
    let c = s.place_part(part, color, &pose, Some(0), None, s.generation(), s.version());
    assert_eq!(c.refused, None, "place {part}");
}

#[test]
fn loose_pieces_and_seat_in_one_undo() {
    let s = blank();
    place(&s, "3001.dat", 4, Vec3::new(0.0, 0.0, 0.0));
    place(&s, "3001.dat", 1, Vec3::new(3.0, -24.0, 0.0));
    place(&s, "3001.dat", 14, Vec3::new(200.0, 0.0, 0.0));

    assert_eq!(s.part_at(1).name, "3001.dat");
    assert_eq!(s.part_color(1), 1);

    let mut insp = Inspection::capture(&s).expect("inspection");
    let loose = insp.loose_pieces();
    assert_eq!(loose.error, None);
    assert_eq!(loose.rows.len(), 1);
    let row = &loose.rows[0];
    assert_eq!(row.piece, 1);
    assert_eq!(row.onto, 0);
    assert!(row.safe);
    assert_eq!(loose.initial_choice(), vec![1]);
    assert_eq!(loose.waiting_on(1, &[1]), None);
    assert!(loose.uncheck(1, &[1]).is_empty());
    assert!(loose.detail(0, "Red Brick 2 x 4").contains("on Red Brick 2 x 4"));

    let (generation, version) = (s.generation(), s.version());
    assert!(s.seat_pieces(&[(row.piece, row.pose)], generation, version + 1).refused.is_some());
    assert_eq!(s.seat_pieces(&[(row.piece, row.pose)], generation, version).refused, None);
    assert!(s.can_undo());

    let mut insp2 = Inspection::capture(&s).expect("inspection");
    assert!(insp2.loose_pieces().rows.is_empty());
}

#[test]
fn model_checks_overlap_and_titles() {
    assert_eq!(CheckKind::Overlap.title(), "Overlaps");
    assert_eq!(CheckKind::Unsupported.title(), "Unsupported Parts");
    assert_eq!(CheckKind::Tipping.title(), "Unstable Groups");
    assert_eq!(CheckKind::SingleConnector.title(), "Single-Connector Attachments");
    assert_eq!(CheckKind::MissingDefinition.title(), "Missing Definitions");
    assert_eq!(CheckKind::UnknownColour.title(), "Unknown Colours");
    assert_eq!(CheckKind::SubmodelLoop.title(), "Submodel Loops");

    let s = blank();
    place(&s, "3001.dat", 4, Vec3::new(0.0, 0.0, 0.0));
    place(&s, "3001.dat", 1, Vec3::new(0.0, 0.0, 0.0));

    let mut insp = Inspection::capture(&s).expect("inspection");
    let checks = insp.check_model();
    assert_eq!(checks.error, None);
    assert!(
        checks.findings.iter().any(|f| f.kind == CheckKind::Overlap && f.pieces == vec![0, 1]),
        "expected overlap finding for [0, 1], got {:?}",
        checks.findings
    );
}

#[test]
fn inventory_counts_rows() {
    let s = blank();
    place(&s, "3001.dat", 4, Vec3::new(0.0, 0.0, 0.0));
    let before = s.piece_count();

    let dir = std::env::temp_dir().join(format!("bm-inv-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let csv: PathBuf = dir.join("parts.csv");
    std::fs::write(
        &csv,
        "\"Quantity\",Color,Part,Is Spare\n\
         2,4,\"3001.DAT\",False\n\
         5,7,3022,yes\n\
         2,4,brickmotion_unknown_part,false\n\
         x,1,3001,false\n",
    )
    .unwrap();

    let mut inv = Inventory::capture(&s, Some(0)).expect("capture");
    let report = inv.prepare(&csv);
    assert_eq!(report.error, None);
    assert_eq!(report.pieces, 2);
    assert_eq!(report.spares, 5);
    assert_eq!(report.invalid_rows, 1);
    assert_eq!(report.missing, vec!["brickmotion_unknown_part.dat"]);

    let changed = s.import_inventory(&inv);
    assert_eq!(changed.refused, None);
    assert_eq!(s.piece_count(), before + 2);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn pose_of_reads_position_rotation_and_scale() {
    let s = blank();
    place(&s, "3001.dat", 4, Vec3::new(0.0, 0.0, 0.0));
    place(&s, "3001.dat", 1, Vec3::new(200.0, -96.0, 40.0));
    let p = s.pose_of(1);
    assert_eq!(p.position, Vec3::new(200.0, -96.0, 40.0));
    assert_eq!(p.rotation, Mat3::IDENTITY);
    assert!(s.scale(&[1], Vec3::new(1.0, 1.5, 1.0), Mat3::IDENTITY, p.position, false).refused.is_none());
    assert!((s.pose_of(1).rotation.m[4] - 1.5).abs() < 1e-9, "Y column is 1.5× long");
}

#[test]
fn fit_together_seats_one_brick_on_another() {
    let s = blank();
    place(&s, "3001.dat", 4, Vec3::new(0.0, 0.0, 0.0));
    place(&s, "3001.dat", 1, Vec3::new(300.0, -200.0, 0.0));
    let mut insp = Inspection::capture(&s).unwrap();
    let fits = insp.fits(1, 0);
    assert!(!fits.is_empty());
    assert!((fits[0].position.y.abs() - 24.0).abs() < 1e-6, "{:?}", fits[0]);
}

#[test]
fn reset_poses_is_one_named_undo_step() {
    let s = blank();
    place(&s, "3001.dat", 4, Vec3::new(0.0, 0.0, 0.0));
    assert_eq!(s.rotate(&[0], Vec3::new(0.0, 1.0, 0.0), 90.0, Vec3::new(0.0, 0.0, 0.0), false).refused, None);
    let turned = s.pose_of(0);
    let plain = Pose { rotation: Mat3::default(), position: turned.position };
    let (generation, version) = (s.generation(), s.version());
    assert!(s.reset_poses(&[(0, plain)], generation, version + 1).refused.is_some());
    assert_eq!(s.reset_poses(&[(0, plain)], generation, version).refused, None);
    assert_eq!(s.undo_name(), "Reset Transform");
    assert!((s.pose_of(0).rotation.m[0] - 1.0).abs() < 1e-9);
}
