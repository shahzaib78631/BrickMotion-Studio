// Documents through the safe wrappers: blank projects, undo, remove, lists.
use std::path::Path;

const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

fn heli() -> bm::Session {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    s
}

#[test]
fn blank_round_trip() {
    let mut s = bm::Session::new();
    s.new_blank().unwrap();
    assert!(!s.dirty());
    assert!(!s.imported());
    let dir = std::env::temp_dir().join(format!("bm-doc-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("blank.brickmotion");
    std::fs::write(&path, s.project_bytes()).unwrap();
    let mut t = bm::Session::new();
    assert!(t.open(&path).is_ok());
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn remove_undo_redo() {
    let s = heli();
    let n = s.piece_count();
    let c = s.remove(&[0]);
    assert_eq!(c.refused, None);
    assert!(c.structure);
    assert_eq!(s.piece_count(), n - 1);
    assert!(s.dirty());
    assert!(s.can_undo());
    assert!(!s.undo_name().is_empty());
    s.undo();
    assert_eq!(s.piece_count(), n);
    assert!(s.can_redo());
    assert!(!s.redo_name().is_empty());
    s.redo();
    assert_eq!(s.piece_count(), n - 1);
    s.mark_saved();
    assert!(!s.dirty());
}

#[test]
fn outline_root_row() {
    let s = heli();
    let rows = s.outline();
    assert_eq!(rows[0].id, "root");
    assert_eq!(rows[0].parent, None);
    assert_eq!(rows[0].depth, 0);
    assert_eq!(s.pieces_of_row("root").len(), s.piece_count());
}

#[test]
fn snapshot_describes_selection() {
    let s = heli();
    s.select(&[0, 1], bm::SelectMode::Replace);
    let snap = s.snapshot();
    assert_eq!(snap.selected, 2);
    assert_eq!(snap.described.len(), 2);
    assert!(!snap.described[0].part.is_empty());
    s.select_all();
    assert_eq!(s.selection().len(), s.piece_count());
    s.hide(&[0, 1]);
    assert_eq!(s.snapshot().hidden, 2);
    s.show_all();
    s.select_none();
    assert!(s.selection().is_empty());
}

#[test]
fn colors_listed() {
    let s = heli();
    let c = s.colors();
    assert!(c.len() > 10);
    assert!(!c[0].name.is_empty());
}

#[test]
fn struct_sizes_match() {
    use std::mem::size_of;
    let size = |n: &std::ffi::CStr| unsafe { bm_sys::bm_struct_size(n.as_ptr()) };
    assert_eq!(size(c"BmOutlineRow"), size_of::<bm_sys::BmOutlineRow>());
    assert_eq!(size(c"BmPieceInfo"), size_of::<bm_sys::BmPieceInfo>());
    assert_eq!(size(c"BmSnapshotInfo"), size_of::<bm_sys::BmSnapshotInfo>());
    assert_eq!(size(c"BmColor"), size_of::<bm_sys::BmColor>());
    assert_eq!(size(c"BmChange"), size_of::<bm_sys::BmChange>());
    assert_eq!(size(c"BmOpenResult"), size_of::<bm_sys::BmOpenResult>());
    assert_eq!(size(c"BmString"), size_of::<bm_sys::BmString>());
    assert_eq!(size(c"BmVec2"), size_of::<bm_sys::BmVec2>());
    assert_eq!(size(c"BmVec3"), size_of::<bm_sys::BmVec3>());
    assert_eq!(size(c"BmMat3"), size_of::<bm_sys::BmMat3>());
    assert_eq!(size(c"BmCamera"), size_of::<bm_sys::BmCamera>());
    assert_eq!(size(c"BmPartMatch"), size_of::<bm_sys::BmPartMatch>());
    assert_eq!(size(c"BmPlacementInput"), size_of::<bm_sys::BmPlacementInput>());
    assert_eq!(size(c"BmPlacementPreview"), size_of::<bm_sys::BmPlacementPreview>());
    assert_eq!(size(c"BmStepRow"), size_of::<bm_sys::BmStepRow>());
    assert_eq!(size(c"BmItemRow"), size_of::<bm_sys::BmItemRow>());
    assert_eq!(size(c"BmPlaybackState"), size_of::<bm_sys::BmPlaybackState>());
    assert_eq!(size(c"BmViewportPreferences"), size_of::<bm_sys::BmViewportPreferences>());
    assert_eq!(size(c"BmTimelineInfo"), size_of::<bm_sys::BmTimelineInfo>());
    assert_eq!(size(c"BmFlightRow"), size_of::<bm_sys::BmFlightRow>());
    assert_eq!(size(c"BmLaneRun"), size_of::<bm_sys::BmLaneRun>());
    assert_eq!(size(c"BmLaneStep"), size_of::<bm_sys::BmLaneStep>());
    assert_eq!(size(c"BmLaneSubmodel"), size_of::<bm_sys::BmLaneSubmodel>());
    assert_eq!(size(c"BmTimelineView"), size_of::<bm_sys::BmTimelineView>());
    assert_eq!(size(c"BmBuildSettings"), size_of::<bm_sys::BmBuildSettings>());
    assert_eq!(size(c"BmStagingSettings"), size_of::<bm_sys::BmStagingSettings>());
    assert_eq!(size(c"BmSnapMix"), size_of::<bm_sys::BmSnapMix>());
    assert_eq!(size(c"BmKeyframe"), size_of::<bm_sys::BmKeyframe>());
    assert_eq!(size(c"BmKeyScene"), size_of::<bm_sys::BmKeyScene>());
    assert_eq!(size(c"BmKeyRowPick"), size_of::<bm_sys::BmKeyRowPick>());
    assert_eq!(size(c"BmFlightPathPoint"), size_of::<bm_sys::BmFlightPathPoint>());
    assert_eq!(size(c"BmFlightPose"), size_of::<bm_sys::BmFlightPose>());
    assert_eq!(size(c"BmKeyObjectRow"), size_of::<bm_sys::BmKeyObjectRow>());
    assert_eq!(size(c"BmSceneCamera"), size_of::<bm_sys::BmSceneCamera>());
    assert_eq!(size(c"BmCameraKey"), size_of::<bm_sys::BmCameraKey>());
    assert_eq!(size(c"BmCameraMove"), size_of::<bm_sys::BmCameraMove>());
    assert_eq!(size(c"BmCameraPreset"), size_of::<bm_sys::BmCameraPreset>());
    assert_eq!(size(c"BmCameraClockInfo"), size_of::<bm_sys::BmCameraClockInfo>());
    assert_eq!(size(c"nope"), 0);
}
