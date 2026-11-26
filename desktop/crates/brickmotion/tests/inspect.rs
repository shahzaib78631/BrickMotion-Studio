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
