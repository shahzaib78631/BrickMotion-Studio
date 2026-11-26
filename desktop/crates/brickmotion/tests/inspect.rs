// Model Checks, Seat Loose Pieces, Compatible Parts and Import Parts Inventory UI tests.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use brickmotion::{BrickMotionApp, run};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bm-inspect-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_ldr(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    path
}

fn app_with(path: &Path) -> Harness<'static, BrickMotionApp> {
    let p = path.to_path_buf();
    let mut h = Harness::builder().with_size([1440.0, 900.0]).build_eframe(|cc| {
        let mut app = BrickMotionApp::new_for_test_cc(cc, Some(p));
        app.wait_loaded();
        app.dialogs_off();
        app.prefs.auto_plan = false;
        app
    });
    h.run_steps(3);
    h
}

fn step_until(h: &mut Harness<'static, BrickMotionApp>, mut done: impl FnMut(&Harness<'static, BrickMotionApp>) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !done(h) {
        assert!(Instant::now() < deadline, "timed out waiting for background job");
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    h.run_steps(2);
}

#[test]
fn model_checks_group_findings() {
    let dir = temp("checks-overlap");
    let model = write_ldr(
        &dir,
        "overlap.ldr",
        "0 Overlap\n\
         1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n\
         1 1 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n",
    );
    let mut h = app_with(&model);
    assert!(run(h.state_mut(), "inspect.model_checks"));
    step_until(&mut h, |h| h.query_by_label("Checking the model…").is_none() && h.state().checks.result.is_some());

    assert!(h.query_by_label("Overlaps").is_some(), "Overlaps heading shown");
    h.get_by_label_contains("Frame ").click();
    h.run_steps(3);

    let mut sel = h.state().session().selection();
    sel.sort();
    assert_eq!(sel, vec![0, 1]);
}

#[test]
fn model_checks_none() {
    let dir = temp("checks-clean");
    let model = write_ldr(&dir, "one.ldr", "0 Clean\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n");
    let mut h = app_with(&model);
    assert!(run(h.state_mut(), "inspect.model_checks"));
    step_until(&mut h, |h| h.query_by_label("Checking the model…").is_none() && h.state().checks.result.is_some());

    assert!(h.query_by_label("No Findings").is_some());
    assert!(h.query_by_label("The model passed the available geometry and connection checks.").is_some());
}

#[test]
fn checks_drop_a_stale_result() {
    let dir = temp("checks-stale");
    let model = write_ldr(
        &dir,
        "overlap.ldr",
        "0 Overlap\n\
         1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n\
         1 1 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n",
    );
    let mut h = app_with(&model);
    assert!(run(h.state_mut(), "inspect.model_checks"));
    // Add a third overlapping brick before polling the first check.
    let (generation, version) = {
        let s = h.state().session();
        (s.generation(), s.version())
    };
    let c = h.state().session().place_part("3001.dat", 14, &bm::Pose::default(), Some(0), None, generation, version);
    assert_eq!(c.refused, None);
    let new_ver = h.state().session().version();
    assert_ne!(new_ver, version);

    step_until(&mut h, |h| {
        h.state().checks.result.as_ref().is_some_and(|(k, _)| *k == (generation, new_ver))
            && h.query_by_label("Checking the model…").is_none()
    });
    let (res_key, report) = h.state().checks.result.as_ref().expect("fresh result");
    assert_eq!(*res_key, (generation, new_ver));
    let pieces: BTreeSet<u32> = report
        .findings
        .iter()
        .filter(|f| f.kind == bm::motion::CheckKind::Overlap)
        .flat_map(|f| f.pieces.iter().copied())
        .collect();
    assert_eq!(pieces, BTreeSet::from([0, 1, 2]));
}

#[test]
fn checks_close_with_the_document() {
    let dir = temp("checks-close");
    let a = write_ldr(&dir, "a.ldr", "0 A\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n");
    let b = write_ldr(&dir, "b.ldr", "0 B\n1 1 0 0 0 1 0 0 0 1 0 0 0 1 3003.dat\n");
    let mut h = app_with(&a);
    assert!(run(h.state_mut(), "inspect.model_checks"));
    h.run_steps(2);
    assert!(h.state().checks.open);

    h.state_mut().open(b);
    h.state_mut().wait_loaded();
    h.run_steps(3);
    assert!(!h.state().checks.open, "Model Checks closes when another document opens");
}

#[test]
fn last_refused_edit_shows_and_dismisses() {
    let dir = temp("checks-refusal");
    let model = write_ldr(&dir, "one.ldr", "0 Clean\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n");
    let mut h = app_with(&model);
    let (generation, version) = {
        let s = h.state().session();
        (s.generation(), s.version())
    };
    let refused = h.state().session().place_part("3001.dat", 4, &bm::Pose::default(), Some(0), None, generation, version + 99);
    assert!(refused.refused.is_some());
    let reason = refused.refused.clone().unwrap();
    // Simulate app handling the refused edit.
    h.state_mut().last_refusal = Some(reason.clone());

    assert!(run(h.state_mut(), "inspect.model_checks"));
    step_until(&mut h, |h| h.query_by_label("Checking the model…").is_none() && h.state().checks.result.is_some());

    assert!(h.query_by_label("Last Refused Edit").is_some());
    assert!(h.query_by_label(reason.as_str()).is_some());
    h.get_by_label("Dismiss").click();
    h.run_steps(3);
    assert_eq!(h.state().last_refusal, None);
    assert!(h.query_by_label("Last Refused Edit").is_none());
}

fn piece_pos(s: &bm::Session, piece: u32) -> (f64, f64, f64) {
    let line = s.copy(&[piece]);
    let tokens: Vec<&str> = line.split_whitespace().collect();
    assert!(tokens.len() >= 5, "unexpected LDraw line: {line:?}");
    (
        tokens[2].parse::<f64>().unwrap(),
        tokens[3].parse::<f64>().unwrap(),
        tokens[4].parse::<f64>().unwrap(),
    )
}

#[test]
fn seat_loose_seats_in_one_undo() {
    let dir = temp("loose-seat");
    let model = write_ldr(
        &dir,
        "loose.ldr",
        "0 Loose\n\
         1 1 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n\
         1 4 3 -24 0 1 0 0 0 1 0 0 0 1 3001.dat\n\
         1 14 200 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n",
    );
    let mut h = app_with(&model);
    assert!(run(h.state_mut(), "model.seat_loose"));
    step_until(&mut h, |h| h.query_by_label("Looking for loose pieces…").is_none() && h.state().loose.result.is_some());

    assert!(h.query_by_label("Seat Red Brick 2 x 4").is_some(), "checkbox label matches colour + display name");
    assert_eq!(h.state().loose.chosen, vec![1]);
    assert!(h.query_by_label("1 of 1 selected").is_some());
    assert!(h.query_by_label("Seat Piece").is_some());

    h.get_by_label("Seat Piece").click();
    h.run_steps(3);
    assert!(!h.state().loose.open);

    let (x, y, _z) = piece_pos(h.state().session(), 1);
    assert!((x - 0.0).abs() < 1e-4, "expected x=0, got {x}");
    assert!((y - (-24.0)).abs() < 1e-4, "expected y=-24, got {y}");

    assert!(run(h.state_mut(), "edit.undo"));
    h.run_steps(2);
    let (ux, _uy, _uz) = piece_pos(h.state().session(), 1);
    assert!((ux - 3.0).abs() < 1e-4, "expected x=3 after undo, got {ux}");
}

#[test]
fn seat_loose_none() {
    let dir = temp("loose-none");
    let model = write_ldr(
        &dir,
        "seated.ldr",
        "0 Seated\n\
         1 1 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n\
         1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat\n",
    );
    let mut h = app_with(&model);
    assert!(run(h.state_mut(), "model.seat_loose"));
    step_until(&mut h, |h| h.query_by_label("Looking for loose pieces…").is_none() && h.state().loose.result.is_some());

    assert!(h.query_by_label("Every Piece Is Seated").is_some());
}

#[test]
fn seat_loose_refuses_stale() {
    let dir = temp("loose-stale");
    let model = write_ldr(
        &dir,
        "loose.ldr",
        "0 Loose\n\
         1 1 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n\
         1 4 3 -24 0 1 0 0 0 1 0 0 0 1 3001.dat\n\
         1 14 200 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n",
    );
    let mut h = app_with(&model);
    assert!(run(h.state_mut(), "model.seat_loose"));
    step_until(&mut h, |h| h.query_by_label("Seat Piece").is_some());

    // Edit the document after the loose check finished.
    let c = h.state().session().recolor(&[2], 4);
    assert_eq!(c.refused, None);
    let new_ver = h.state().session().version();

    h.get_by_label("Seat Piece").click();
    h.run_steps(2);

    // Piece 1 did not move and the panel recomputes for the new version.
    let (x, _, _) = piece_pos(h.state().session(), 1);
    assert!((x - 3.0).abs() < 1e-4, "stale seat must not move piece, got x={x}");
    assert!(!h.state().notices().is_empty(), "stale seat shows a notice");
    step_until(&mut h, |h| h.state().loose.result.as_ref().is_some_and(|((_, v), _)| *v == new_ver));
}

static HABITS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct HabitsEnvGuard(Option<std::ffi::OsString>);
impl HabitsEnvGuard {
    fn set(val: &str) -> Self {
        let prev = std::env::var_os("BM_HABITS");
        unsafe { std::env::set_var("BM_HABITS", val) };
        HabitsEnvGuard(prev)
    }
}
impl Drop for HabitsEnvGuard {
    fn drop(&mut self) {
        match &self.0 {
            Some(v) => unsafe { std::env::set_var("BM_HABITS", v) },
            None => unsafe { std::env::remove_var("BM_HABITS") },
        }
    }
}

fn habits_lock() -> std::sync::MutexGuard<'static, ()> {
    HABITS_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn panel_add_part<'a>(h: &'a Harness<'static, BrickMotionApp>) -> Option<egui_kittest::Node<'a>> {
    h.query_all_by_label("Add Part").find(|n| n.rect().top() > 150.0)
}

#[test]
fn fits_lists_builders_and_free_connections() {
    let _guard = habits_lock();
    let dir = temp("fits-list");
    let model = write_ldr(&dir, "one.ldr", "0 One\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n");
    let mut h = app_with(&model);
    // Disabled with no selection.
    assert!(!run(h.state_mut(), "model.what_fits"));
    h.state_mut().session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.what_fits"));
    step_until(&mut h, |h| h.query_by_label("Checking free connections…").is_none() && h.state().fits.result.is_some());

    assert!(h.query_by_label("What Builders Put Here").is_some());
    assert!(h.query_by_label("Fits a Free Connection").is_some());
    let (_, _, _, res) = h.state().fits.result.as_ref().unwrap();
    assert!(!res.habits.is_empty() && res.habits.len() <= 8);
    assert!(res.habits.iter().all(|f| f.why.starts_with("In ")));
    assert!(!res.matches.is_empty());

    // Typing "3003" hides the builders' section.
    h.get_by_label("Search by part name or number").click();
    h.run_steps(2);
    h.get_by_label("Search by part name or number").type_text("3003");
    h.run_steps(2);
    std::thread::sleep(Duration::from_millis(160));
    step_until(&mut h, |h| {
        h.state().fits.result.as_ref().is_some_and(|(_, _, q, _)| q == "3003")
            && h.query_by_label("Checking free connections…").is_none()
    });
    assert!(h.query_by_label("What Builders Put Here").is_none());
    assert!(h.query_by_label("Fits a Free Connection").is_some());
}

#[test]
fn fit_adds_part_at_pose() {
    let _guard = habits_lock();
    let dir = temp("fits-add");
    let model = write_ldr(&dir, "one.ldr", "0 One\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n");
    let mut h = app_with(&model);
    h.state_mut().session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.what_fits"));
    step_until(&mut h, |h| h.state().fits.result.is_some() && panel_add_part(h).is_some());

    let before = h.state().piece_count();
    panel_add_part(&h).expect("panel Add Part button").click();
    h.run_steps(3);
    assert_eq!(h.state().piece_count(), before + 1);
    assert!(!h.state().fits.open);

    assert!(run(h.state_mut(), "edit.undo"));
    h.run_steps(2);
    assert_eq!(h.state().piece_count(), before);
}

#[test]
fn fit_refuses_a_stale_revision() {
    let _guard = habits_lock();
    let dir = temp("fits-stale");
    let model = write_ldr(&dir, "one.ldr", "0 One\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n");
    let mut h = app_with(&model);
    h.state_mut().session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.what_fits"));
    step_until(&mut h, |h| h.state().fits.result.is_some() && panel_add_part(h).is_some());

    // Edit the document after fits were computed.
    assert_eq!(h.state().session().recolor(&[0], 1).refused, None);
    let before = h.state().piece_count();

    panel_add_part(&h).expect("panel Add Part button").click();
    h.run_steps(3);
    assert_eq!(h.state().piece_count(), before, "stale Add Part must not add a piece");
    assert!(!h.state().notices().is_empty(), "stale Add Part shows a notice");
}

#[test]
fn fits_without_habits_table() {
    let _guard = habits_lock();
    let _env = HabitsEnvGuard::set("/nonexistent/brickmotion-missing-habits.json");
    let dir = temp("fits-no-habits");
    let model = write_ldr(&dir, "one.ldr", "0 One\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n");
    let mut h = app_with(&model);
    h.state_mut().session().select(&[0], bm::SelectMode::Replace);
    assert!(run(h.state_mut(), "model.what_fits"));
    step_until(&mut h, |h| h.query_by_label("Checking free connections…").is_none() && h.state().fits.result.is_some());

    assert!(h.query_by_label("What Builders Put Here").is_none());
    assert!(h.query_by_label("Fits a Free Connection").is_some());
    assert!(h.state().notices().is_empty(), "missing habits table must not produce a notice");
}
